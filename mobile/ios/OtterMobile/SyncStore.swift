import Foundation
import Observation
import UIKit
import os

private let log = Logger(subsystem: "dev.otter.mobile", category: "link")

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
  private(set) var cards: CardsTopic?
  // Whether the Mac lets this phone act (设置 → 手机 → 可以操作).
  private(set) var control = true
  // How this phone reached the Mac: the local network or the relay.
  private(set) var path: SyncConnection.Path?
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
    guard let mac, connection == nil, active, link != .revoked else {
      log.info("connect skipped: mac \(self.mac != nil) connection \(self.connection != nil) active \(self.active) link \(String(describing: self.link))")
      return
    }
    log.info("connecting")
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
    case .ready(let message, let via):
      retries = 0
      path = via
      if pairing {
        mac = record
        record.save()
        self.pairing = false
        topics = [:]
        seqs = [:]
      }
      if let e = message["epoch"] as? String, e != epoch { epoch = e }
      if let device = message["device"] as? [String: Any] {
        control = device["control"] as? Bool ?? true
      }
      if message.keys.contains("relay") { learnRelay(message["relay"]) }
      link = .online
      startHeartbeat()
    case .message(let message):
      receive(message)
    case .closed(let code, let reason):
      log.info("closed \(code ?? 0) \(reason) pairing \(pairing)")
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
      // Short and capped: the Mac is usually back within seconds.
      let delay = [0.3, 1, 2, 3][min(retries, 3)]
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
    case "device":
      control = message["control"] as? Bool ?? control
    case "relay":
      learnRelay(message["relay"])
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

  // The Mac says where its relay is (or that it has none): remember it for
  // the times this phone is away from home.
  private func learnRelay(_ value: Any?) {
    guard var record = mac else { return }
    let relay = decodeJSON(PairingInfo.Relay.self, value)
    guard relay != record.relay else { return }
    record.relay = relay
    record.save()
    mac = record
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
    case "cards": cards = decodeJSON(CardsTopic.self, topics[topic])
    default: break
    }
  }
  private func decodeAll() {
    for topic in ["status", "today", "chat", "agents", "otter", "cards"] { decode(topic) }
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

  // MARK: Actions (each runs the desktop's own code on the Mac)

  func send(session: String?, text: String) async throws -> SendResult {
    var params: [String: Any] = ["text": text]
    if let session { params["session"] = session }
    let value = try await request("send", params)
    guard let result = decodeJSON(SendResult.self, value) else {
      throw RequestError.failed("Mac 的回答看不懂")
    }
    return result
  }

  func confirm(_ proposal: SendResult) async throws -> ConfirmResult {
    let value = try await request(
      "confirm", ["id": proposal.id ?? "", "session": proposal.session ?? ""])
    return decodeJSON(ConfirmResult.self, value) ?? ConfirmResult(ok: false, message: "没有结果")
  }

  func dismiss(_ proposal: SendResult) async {
    _ = try? await request("dismiss", ["requestId": proposal.requestId ?? ""])
  }

  func perform(_ method: String, _ params: [String: Any]) async throws {
    _ = try await request(method, params)
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
