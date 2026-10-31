import Foundation
import Observation
import UIKit

// Everything the app shows. Topics live as the Mac's JSON (patched in place)
// and are decoded for the views after each change; the last state is cached
// on disk so the app opens straight onto it while it reconnects.
@MainActor
@Observable
final class SyncStore {
  enum Link: Equatable {
    case unpaired
    case connecting
    case online
    case offline(String)
    case revoked
  }

  private(set) var mac: MacRecord?
  private(set) var link: Link = .unpaired
  private(set) var status: StatusTopic?
  private(set) var today: TodayTopic?
  private(set) var chat: ChatTopic?
  private(set) var agents: AgentsTopic?
  private(set) var otter: OtterTopic?
  private(set) var updated: Date?
  private(set) var latency: (p50: Double, p95: Double)?
  private(set) var rtt: Double?
  var pairingError: String?
  private(set) var pairing = false

  @ObservationIgnored private var topics: [String: Any] = [:]
  @ObservationIgnored private var seqs: [String: Int] = [:]
  @ObservationIgnored private var epoch: String?
  @ObservationIgnored private var connection: SyncConnection?
  @ObservationIgnored private var latencies: [Double] = []
  @ObservationIgnored private var offset: Double?
  @ObservationIgnored private var waiting: [String: CheckedContinuation<Any?, Error>] = [:]
  @ObservationIgnored private var heartbeat: Timer?
  @ObservationIgnored private var retryWork: DispatchWorkItem?
  @ObservationIgnored private var saveWork: DispatchWorkItem?
  @ObservationIgnored private var retries = 0
  @ObservationIgnored private var active = true

  private static var cacheURL: URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("sync-cache.json")
  }
  private static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

  init() {
    mac = MacRecord.load()
    if mac != nil {
      loadCache()
      link = .offline("")
    }
  }

  // MARK: Pairing

  func pair(_ text: String) {
    guard let info = PairingInfo.parse(text) else {
      pairingError = "这不是 Otter 的配对码。请扫 Mac 上 设置 → 手机 里的二维码。"
      return
    }
    pairingError = nil
    pairing = true
    disconnect()
    let record = MacRecord(info)
    open(record, code: info.c)
  }

  func unpair() {
    disconnect()
    MacRecord.forget()
    PhoneKey.reset()
    try? FileManager.default.removeItem(at: Self.cacheURL)
    mac = nil
    topics = [:]
    seqs = [:]
    epoch = nil
    decodeAll()
    link = .unpaired
  }

  // MARK: Connection

  func setActive(_ on: Bool) {
    active = on
    if on { connect() } else { disconnect() }
  }

  func connect() {
    guard let mac, connection == nil, active, link != .revoked else { return }
    open(mac, code: nil)
  }

  private func open(_ record: MacRecord, code: String?) {
    retryWork?.cancel()
    if link != .online { link = .connecting }
    let auth: [String: Any] = [
      "t": "auth", "name": UIDevice.current.name,
      // A new pairing starts clean; a resume says what it already has.
      "since": code == nil ? ["epoch": (epoch as Any?) ?? NSNull(), "seqs": seqs] : [String: Any](),
    ]
    let c = SyncConnection(mac: record, phone: PhoneKey.load(), code: code, auth: auth) {
      [weak self] event in self?.handle(event, record: record, pairing: code != nil)
    }
    connection = c
    c.start()
  }

  func disconnect() {
    retryWork?.cancel()
    heartbeat?.invalidate()
    heartbeat = nil
    connection?.close()
    connection = nil
    failWaiting("已断开")
    if mac != nil, link == .online || link == .connecting { link = .offline("") }
  }

  private func handle(_ event: SyncConnection.Event, record: MacRecord, pairing: Bool) {
    switch event {
    case .ready(let message):
      retries = 0
      if pairing {
        mac = record
        record.save()
        self.pairing = false
        topics = [:]
        seqs = [:]
      }
      if let e = message["epoch"] as? String, e != epoch { epoch = e }
      link = .online
      startHeartbeat()
    case .message(let message):
      receive(message)
    case .closed(let code, let reason):
      connection = nil
      heartbeat?.invalidate()
      heartbeat = nil
      failWaiting(reason)
      if pairing {
        self.pairing = false
        pairingError =
          code == 4004 || code == 4002
          ? "配对码已经用过或过期了，请在 Mac 上重新点“添加手机”。"
          : reason
        if mac == nil { link = .unpaired }
        return
      }
      if code == 4003 {
        link = .revoked
        return
      }
      link = .offline(reason)
      guard active else { return }
      let delay = [0.3, 1, 2, 4, 8][min(retries, 4)]
      retries += 1
      let work = DispatchWorkItem { [weak self] in
        MainActor.assumeIsolated { self?.connect() }
      }
      retryWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
  }

  private func startHeartbeat() {
    heartbeat?.invalidate()
    ping()
    heartbeat = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.ping()
        self?.report()
      }
    }
  }

  private func ping() { connection?.send(["t": "ping", "t0": Self.nowMs]) }

  private func report() {
    guard let latency else { return }
    connection?.send([
      "t": "stats", "p50": latency.p50, "p95": latency.p95, "rtt": rtt ?? 0, "n": latencies.count,
    ])
  }

  // MARK: Messages

  private func receive(_ message: [String: Any]) {
    let now = Self.nowMs
    switch message["t"] as? String {
    case "snap":
      guard let topic = message["topic"] as? String else { return }
      epoch = message["epoch"] as? String ?? epoch
      topics[topic] = message["value"]
      seqs[topic] = message["seq"] as? Int ?? 0
      changed(topic)
    case "patch":
      guard let topic = message["topic"] as? String, let seq = message["seq"] as? Int,
        let ops = message["ops"] as? [[String: Any]]
      else { return }
      // A gap means something was missed: start over from a snapshot.
      guard seq == (seqs[topic] ?? 0) + 1 else {
        seqs = [:]
        epoch = nil
        connection?.close()
        connection = nil
        connect()
        return
      }
      topics[topic] = Patch.apply(topics[topic], ops)
      seqs[topic] = seq
      if let at = message["at"] as? Double, let offset { record(now - (at - offset)) }
      changed(topic)
    case "pong":
      guard let t0 = message["t0"] as? Double, let tm = message["tm"] as? Double else { return }
      let trip = now - t0
      rtt = trip
      offset = tm - (t0 + trip / 2)
    case "res":
      guard let id = message["id"] as? String, let w = waiting.removeValue(forKey: id) else { return }
      if message["ok"] as? Bool == true {
        w.resume(returning: message["value"])
      } else {
        w.resume(throwing: RequestError.failed(message["error"] as? String ?? "没有成功"))
      }
    default:
      break
    }
  }

  private func record(_ ms: Double) {
    latencies.append(max(0, ms))
    if latencies.count > 200 { latencies.removeFirst(latencies.count - 200) }
    let sorted = latencies.sorted()
    let at = { (q: Double) in sorted[min(sorted.count - 1, Int(q * Double(sorted.count)))] }
    latency = (at(0.5), at(0.95))
  }

  private func changed(_ topic: String) {
    decode(topic)
    updated = Date()
    saveWork?.cancel()
    let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.saveCache() } }
    saveWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
  }

  private func decode(_ topic: String) {
    switch topic {
    case "status": status = decodeJSON(StatusTopic.self, topics[topic])
    case "today": today = decodeJSON(TodayTopic.self, topics[topic])
    case "chat": chat = decodeJSON(ChatTopic.self, topics[topic])
    case "agents": agents = decodeJSON(AgentsTopic.self, topics[topic])
    case "otter": otter = decodeJSON(OtterTopic.self, topics[topic])
    default: break
    }
  }
  private func decodeAll() {
    for topic in ["status", "today", "chat", "agents", "otter"] { decode(topic) }
  }

  // MARK: Requests

  enum RequestError: LocalizedError {
    case failed(String)
    var errorDescription: String? {
      if case .failed(let text) = self { return text }
      return nil
    }
  }

  func request(_ method: String, _ params: [String: Any]) async throws -> Any? {
    guard link == .online, let connection else { throw RequestError.failed("还没连上 Mac") }
    let id = UUID().uuidString
    return try await withCheckedThrowingContinuation { continuation in
      waiting[id] = continuation
      connection.send(["t": "req", "id": id, "m": method, "p": params])
    }
  }

  private func failWaiting(_ reason: String) {
    for (_, w) in waiting { w.resume(throwing: RequestError.failed(reason)) }
    waiting = [:]
  }

  // MARK: Cache

  private func saveCache() {
    let cache: [String: Any] = [
      "epoch": (epoch as Any?) ?? NSNull(), "seqs": seqs, "topics": topics,
      "updated": (updated ?? Date()).timeIntervalSince1970,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: cache) {
      try? data.write(to: Self.cacheURL, options: .atomic)
    }
  }

  private func loadCache() {
    guard let data = try? Data(contentsOf: Self.cacheURL),
      let cache = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return }
    topics = cache["topics"] as? [String: Any] ?? [:]
    seqs = cache["seqs"] as? [String: Int] ?? [:]
    epoch = cache["epoch"] as? String
    if let t = cache["updated"] as? Double { updated = Date(timeIntervalSince1970: t) }
    decodeAll()
  }
}
