import Foundation
import Network
import os

private let log = Logger(subsystem: "dev.otter.mobile", category: "link")

// One link to the Mac. Every way to reach it (each address from pairing, its
// Bonjour name, then its relay) is opened at once and tried in the order they
// connect, so the phone takes the quickest path and still finds the Mac when
// its address moves. Each try is hello / welcome in the clear, everything
// after sealed; the first that proves to be this Mac wins. One that leads
// elsewhere (another Otter, a stale address) only moves on to the next.
@MainActor
final class SyncConnection {
  // Which way this connection reached the Mac.
  enum Path: String {
    case local, relay
  }

  // The way in, for 我的: path, the address reached, and the phone's network.
  struct Route: Equatable {
    var path: Path
    var address: String
    var network: String
  }

  enum Event {
    case ready([String: Any], Route)
    case message([String: Any])
    case closed(code: Int?, reason: String)
  }

  private let mac: MacRecord
  private let phone: PrivateKey
  private let code: String?
  private let auth: [String: Any]
  private let onEvent: (Event) -> Void
  private var candidates: [NWConnection] = []
  // Connected, waiting for their turn while another way in is being tried.
  private var spare: [NWConnection] = []
  // What a Mac said when it closed a way in (say, pairing closed), told if
  // none works; otherwise the plain "can't reach the Mac".
  private var refusal: (code: Int?, reason: String)?
  private var relayCandidate: NWConnection?
  private var relayWork: DispatchWorkItem?
  private var unusable: DispatchWorkItem?
  private var connection: NWConnection?
  private var channel: SyncChannel?
  private var ephemeral = PrivateKey()
  private var hello = ""
  private var ready = false
  private var done = false
  private var deadline: DispatchWorkItem?
  private static let unreachable =
    "连不上 Mac：确认它开着 Otter、打开了“允许手机连接”，并且和手机在同一个 Wi-Fi。"

  init(
    mac: MacRecord, phone: PrivateKey, code: String?, auth: [String: Any],
    onEvent: @escaping (Event) -> Void
  ) {
    self.mac = mac
    self.phone = phone
    self.code = code
    self.auth = auth
    self.onEvent = onEvent
  }

  private static func parameters() -> NWParameters {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.connectionTimeout = 5
    let parameters = NWParameters(tls: nil, tcp: tcp)
    let ws = NWProtocolWebSocket.Options()
    ws.autoReplyPing = true
    ws.maximumMessageSize = 4 << 20
    parameters.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
    return parameters
  }

  func start() {
    // A ws:// URL, not host and port: Network.framework's WebSocket client
    // aborts the upgrade without one.
    var endpoints: [NWEndpoint] = mac.addresses.compactMap { address in
      URL(string: "ws://\(address):\(mac.port)/").map { .url($0) }
    }
    endpoints.append(.service(name: mac.service, type: "_otter._tcp", domain: "local.", interface: nil))
    for endpoint in endpoints { begin(endpoint) }
    // The relay a moment later, so at home the local network wins; away,
    // where nothing local answers, the relay does.
    if let relay = mac.relay, var url = URLComponents(string: relay.u + "/join") {
      url.queryItems = [URLQueryItem(name: "room", value: relay.i)]
      if let endpoint = url.url.map({ NWEndpoint.url($0) }) {
        let work = DispatchWorkItem { [weak self] in
          MainActor.assumeIsolated {
            guard let self, !self.ready, !self.done else { return }
            self.relayCandidate = self.begin(endpoint)
          }
        }
        relayWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
      }
    }
    let deadline = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self, !self.ready else { return }
        self.giveUp()
      }
    }
    self.deadline = deadline
    DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: deadline)
  }

  @discardableResult
  private func begin(_ endpoint: NWEndpoint) -> NWConnection {
    let candidate = NWConnection(to: endpoint, using: Self.parameters())
    candidate.stateUpdateHandler = { [weak self] state in
      MainActor.assumeIsolated { self?.update(candidate, state) }
    }
    candidates.append(candidate)
    candidate.start(queue: .main)
    return candidate
  }

  private func update(_ candidate: NWConnection, _ state: NWConnection.State) {
    guard !done else { return }
    switch state {
    case .ready:
      if ready || connection === candidate || spare.contains(where: { $0 === candidate }) { return }
      if connection == nil { attempt(candidate) } else { spare.append(candidate) }
    case .failed(let error), .waiting(let error):
      if connection === candidate {
        fail(code: nil, reason: error.localizedDescription)
      } else {
        drop(candidate)
        if connection == nil { next() }
      }
    case .cancelled:
      if connection === candidate { fail(code: nil, reason: "连接已断开") }
    default:
      break
    }
  }

  // Say hello on this way in; its answer decides whether it is the Mac.
  private func attempt(_ c: NWConnection) {
    connection = c
    channel = nil
    ephemeral = PrivateKey()
    sendHello()
    receive(c)
  }

  private func drop(_ c: NWConnection) {
    c.cancel()
    candidates.removeAll { $0 === c }
    spare.removeAll { $0 === c }
  }

  // The way being tried failed. Linked, that ends the link; still trying,
  // it only rules this way out.
  private func fail(code: Int?, reason: String) {
    guard !ready, let c = connection else { return finish(code: code, reason: reason) }
    log.info("way in fell through (\(String(describing: c.endpoint))): \(reason)")
    if code != nil { refusal = (code, reason) }
    connection = nil
    drop(c)
    next()
  }

  // The next way in that has connected; with none left (and the relay not
  // still to come), give up.
  private func next() {
    if !spare.isEmpty { return attempt(spare.removeFirst()) }
    if candidates.isEmpty && (relayWork == nil || relayCandidate != nil) { giveUp() }
  }

  private func giveUp() {
    finish(code: refusal?.code, reason: refusal?.reason ?? Self.unreachable)
  }

  private func linked() {
    ready = true
    deadline?.cancel()
    relayWork?.cancel()
    guard let connection else { return }
    for other in candidates where other !== connection { other.cancel() }
    candidates = [connection]
    spare = []
    watch(connection)
  }

  // iOS says when a connection stops being usable (its network went away)
  // or when a better one appeared (Wi-Fi came back): either way, end it and
  // let the store race the ways in again.
  private func watch(_ c: NWConnection) {
    c.viabilityUpdateHandler = { [weak self] viable in
      MainActor.assumeIsolated {
        guard let self, self.connection === c else { return }
        self.unusable?.cancel()
        guard !viable else { return }
        let work = DispatchWorkItem { [weak self] in
          MainActor.assumeIsolated { self?.finish(code: nil, reason: "网络断了，正在重连") }
        }
        self.unusable = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
      }
    }
    c.betterPathUpdateHandler = { [weak self] better in
      MainActor.assumeIsolated {
        guard let self, better, self.connection === c else { return }
        self.finish(code: nil, reason: "换到更好的网络")
      }
    }
  }

  private func route() -> Route {
    let path: Path = connection === relayCandidate ? .relay : .local
    var address = ""
    switch connection?.endpoint {
    case .url(let url): address = url.host ?? url.absoluteString
    case .service(let name, _, _, _): address = name
    case .hostPort(let host, _): address = "\(host)"
    default: break
    }
    let current = connection?.currentPath
    let network =
      current?.usesInterfaceType(.wifi) == true ? "Wi-Fi"
      : current?.usesInterfaceType(.cellular) == true ? "蜂窝网络"
      : current?.usesInterfaceType(.wiredEthernet) == true ? "有线网络"
      : current?.usesInterfaceType(.loopback) == true ? "本机"
      : "VPN 或其他"
    return Route(path: path, address: address, network: network)
  }

  private func sendHello() {
    let text = String(
      data: try! JSONSerialization.data(withJSONObject: [
        "t": "hello", "v": 1, "kind": code == nil ? "resume" : "pair",
        "k": phone.publicText, "e": ephemeral.publicText,
      ]), encoding: .utf8)!
    hello = text
    send(Data(text.utf8), text: true)
  }

  private func send(_ data: Data, text: Bool) {
    let meta = NWProtocolWebSocket.Metadata(opcode: text ? .text : .binary)
    let context = NWConnection.ContentContext(identifier: "frame", metadata: [meta])
    connection?.send(
      content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
  }

  func send(_ message: [String: Any]) {
    guard let channel, !done, let frame = try? channel.seal(message) else { return }
    send(frame, text: false)
  }

  private func receive(_ c: NWConnection) {
    c.receiveMessage { [weak self] data, context, _, error in
      MainActor.assumeIsolated {
        guard let self, self.connection === c, !self.done else { return }
        if let error {
          self.fail(code: nil, reason: error.localizedDescription)
          return
        }
        let meta =
          context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
          as? NWProtocolWebSocket.Metadata
        if meta?.opcode == .close {
          var code: Int?
          if case .privateCode(let value) = meta?.closeCode { code = Int(value) }
          // Anyone can send a bare 4003; only a sealed "revoked" means it.
          if code == 4003 {
            self.fail(code: nil, reason: "这条路上的 Otter 不认识这台手机")
          } else {
            self.fail(code: code, reason: "Mac 关闭了连接")
          }
          return
        }
        if let data, !data.isEmpty { self.handle(data, text: meta?.opcode == .text) }
        if !self.done { self.receive(c) }
      }
    }
  }

  private func handle(_ data: Data, text: Bool) {
    do {
      guard let channel else {
        guard text, let welcomeText = String(data: data, encoding: .utf8),
          let welcome = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let macEphemeral = welcome["e"] as? String
        else { throw SyncCryptoError.badKey }
        let derived = try SyncChannel.derive(
          phone: phone, ephemeral: ephemeral, mac: mac.key, macEphemeral: macEphemeral,
          hello: hello, welcome: welcomeText, code: code)
        self.channel = derived
        send(auth)
        return
      }
      let message = try channel.open(data)
      switch message["t"] as? String {
      case "ready":
        linked()
        onEvent(.ready(message, route()))
      case "revoked":
        finish(code: 4003, reason: "配对已在 Mac 上撤销")
      default:
        onEvent(.message(message))
      }
    } catch {
      // Not this Mac's keys: another Otter, or something in the way.
      fail(code: nil, reason: "和 Mac 的加密握手失败")
    }
  }

  private func finish(code: Int?, reason: String) {
    guard !done else { return }
    done = true
    deadline?.cancel()
    relayWork?.cancel()
    unusable?.cancel()
    for c in candidates { c.cancel() }
    candidates = []
    spare = []
    connection?.cancel()
    connection = nil
    onEvent(.closed(code: code, reason: reason))
  }

  func close() {
    guard !done else { return }
    done = true
    deadline?.cancel()
    relayWork?.cancel()
    unusable?.cancel()
    for c in candidates { c.cancel() }
    connection?.cancel()
    connection = nil
  }
}
