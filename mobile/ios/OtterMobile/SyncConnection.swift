import Foundation
import Network

// One link to the Mac. Every way to reach it (each address from pairing and
// its Bonjour name) is tried at once and the first to connect wins, so the
// phone takes the quickest path and still finds the Mac when its address
// moves. Then: hello / welcome in the clear, everything after sealed.
@MainActor
final class SyncConnection {
  // Which way this connection reached the Mac.
  enum Path: String {
    case local, relay
  }

  enum Event {
    case ready([String: Any], Path)
    case message([String: Any])
    case closed(code: Int?, reason: String)
  }

  private let mac: MacRecord
  private let phone: PrivateKey
  private let code: String?
  private let auth: [String: Any]
  private let onEvent: (Event) -> Void
  private var candidates: [NWConnection] = []
  private var relayCandidate: NWConnection?
  private var relayWork: DispatchWorkItem?
  private var connection: NWConnection?
  private var channel: SyncChannel?
  private var ephemeral = PrivateKey()
  private var hello = ""
  private var ready = false
  private var done = false
  private var deadline: DispatchWorkItem?

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
            guard let self, self.connection == nil, !self.done else { return }
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
        self.finish(code: nil, reason: "连不上 Mac：确认它开着 Otter、打开了“允许手机连接”，并且和手机在同一个 Wi-Fi。")
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
    switch state {
    case .ready:
      guard connection == nil else {
        if connection !== candidate { candidate.cancel() }
        return
      }
      connection = candidate
      relayWork?.cancel()
      for other in candidates where other !== candidate { other.cancel() }
      candidates = [candidate]
      sendHello()
      receive(candidate)
    case .failed(let error), .waiting(let error):
      if connection === candidate {
        finish(code: nil, reason: error.localizedDescription)
      } else {
        candidate.cancel()
        candidates.removeAll { $0 === candidate }
        // Everything local failed; wait for the relay if it has yet to start.
        if candidates.isEmpty && connection == nil && (relayWork == nil || relayCandidate != nil) {
          finish(code: nil, reason: "连不上 Mac：确认它开着 Otter、打开了“允许手机连接”，并且和手机在同一个 Wi-Fi。")
        }
      }
    case .cancelled:
      if connection === candidate { finish(code: nil, reason: "连接已断开") }
    default:
      break
    }
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
          self.finish(code: nil, reason: error.localizedDescription)
          return
        }
        let meta =
          context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
          as? NWProtocolWebSocket.Metadata
        if meta?.opcode == .close {
          var code: Int?
          if case .privateCode(let value) = meta?.closeCode { code = Int(value) }
          self.finish(code: code, reason: "Mac 关闭了连接")
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
      if message["t"] as? String == "ready" {
        ready = true
        deadline?.cancel()
        onEvent(.ready(message, connection === relayCandidate ? .relay : .local))
      } else {
        onEvent(.message(message))
      }
    } catch {
      finish(code: nil, reason: "和 Mac 的加密握手失败")
    }
  }

  private func finish(code: Int?, reason: String) {
    guard !done else { return }
    done = true
    deadline?.cancel()
    relayWork?.cancel()
    for c in candidates { c.cancel() }
    candidates = []
    connection?.cancel()
    connection = nil
    onEvent(.closed(code: code, reason: reason))
  }

  func close() {
    guard !done else { return }
    done = true
    deadline?.cancel()
    relayWork?.cancel()
    for c in candidates { c.cancel() }
    connection?.cancel()
    connection = nil
  }
}
