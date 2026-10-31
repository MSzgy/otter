import CryptoKit
import Foundation

// The phone side of desktop/electron/sync-crypto.cjs; both must agree byte
// for byte. One round trip (hello / welcome) gives two AES-256-GCM keys
// from three X25519 agreements; the pairing code salts the derivation when
// pairing. Each frame's nonce is its position in that direction, so a
// dropped, reordered or replayed frame fails to open.
enum Base64URL {
  static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
  static func decode(_ text: String) -> Data? {
    var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    return Data(base64Encoded: s)
  }
}

enum SyncCryptoError: Error {
  case badKey, shortFrame
}

typealias PrivateKey = Curve25519.KeyAgreement.PrivateKey

extension PrivateKey {
  var publicText: String { Base64URL.encode(publicKey.rawRepresentation) }
}

func publicKey(_ text: String) throws -> Curve25519.KeyAgreement.PublicKey {
  guard let raw = Base64URL.decode(text), raw.count == 32 else { throw SyncCryptoError.badKey }
  return try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw)
}

final class SyncChannel {
  private let sendKey: SymmetricKey
  private let receiveKey: SymmetricKey
  private var sent: UInt64 = 0
  private var received: UInt64 = 0

  init(send: SymmetricKey, receive: SymmetricKey) {
    sendKey = send
    receiveKey = receive
  }

  // Phone side of deriveKeys: DH(e,E) ‖ DH(k,E) ‖ DH(e,K).
  static func derive(
    phone: PrivateKey, ephemeral: PrivateKey, mac: String, macEphemeral: String,
    hello: String, welcome: String, code: String?
  ) throws -> SyncChannel {
    let macKey = try publicKey(mac)
    let macEph = try publicKey(macEphemeral)
    var ikm = Data()
    for secret in [
      try ephemeral.sharedSecretFromKeyAgreement(with: macEph),
      try phone.sharedSecretFromKeyAgreement(with: macEph),
      try ephemeral.sharedSecretFromKeyAgreement(with: macKey),
    ] {
      secret.withUnsafeBytes { ikm.append(contentsOf: $0) }
    }
    var hash = SHA256()
    hash.update(data: Data(hello.utf8))
    hash.update(data: Data("\n".utf8))
    hash.update(data: Data(welcome.utf8))
    let info = Data("otter-sync v1".utf8) + Data(hash.finalize())
    let salt = code.flatMap(Base64URL.decode) ?? Data(count: 32)
    let okm = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: 64)
    let bytes = okm.withUnsafeBytes { Data($0) }
    return SyncChannel(
      send: SymmetricKey(data: bytes.prefix(32)), receive: SymmetricKey(data: bytes.suffix(32)))
  }

  private static func nonce(_ counter: UInt64) -> AES.GCM.Nonce {
    var data = Data(count: 4)
    withUnsafeBytes(of: counter.bigEndian) { data.append(contentsOf: $0) }
    return try! AES.GCM.Nonce(data: data)
  }

  func seal(_ message: [String: Any]) throws -> Data {
    var plain = Data([0])
    plain.append(try JSONSerialization.data(withJSONObject: message))
    let box = try AES.GCM.seal(plain, using: sendKey, nonce: Self.nonce(sent))
    sent += 1
    return box.ciphertext + box.tag
  }

  func open(_ frame: Data) throws -> [String: Any] {
    guard frame.count >= 17 else { throw SyncCryptoError.shortFrame }
    let data = Data(frame)
    let box = try AES.GCM.SealedBox(
      nonce: Self.nonce(received), ciphertext: data.prefix(data.count - 16), tag: data.suffix(16))
    let plain = try AES.GCM.open(box, using: receiveKey)
    received += 1
    var body = Data(plain.dropFirst())
    // Flag 1: raw deflate, which is what Apple calls zlib.
    if plain.first == 1 { body = try (body as NSData).decompressed(using: .zlib) as Data }
    return try JSONSerialization.jsonObject(with: body) as? [String: Any] ?? [:]
  }
}
