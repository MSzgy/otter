import CryptoKit
import Foundation
import Security

// What the QR code on the Mac says: otter://pair?d=<base64url JSON>.
struct PairingInfo: Decodable {
  // The Mac's relay (外网访问): its address and this Mac's room there.
  struct Relay: Codable, Equatable {
    let u: String
    let i: String
  }
  let v: Int
  let n: String
  let k: String
  let c: String
  let a: [String]
  let p: Int
  let s: String
  let r: Relay?

  static func parse(_ text: String) -> PairingInfo? {
    guard
      let url = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
      url.scheme == "otter", url.host == "pair",
      let d = url.queryItems?.first(where: { $0.name == "d" })?.value,
      let data = Base64URL.decode(d),
      let info = try? JSONDecoder().decode(PairingInfo.self, from: data), info.v == 1
    else { return nil }
    return info
  }
}

// The Mac this phone follows: its key, where it was, its Bonjour name.
struct MacRecord: Codable, Equatable {
  var name: String
  var key: String
  var addresses: [String]
  var port: Int
  var service: String
  var relay: PairingInfo.Relay?

  init(_ info: PairingInfo) {
    name = info.n
    key = info.k
    addresses = info.a
    port = info.p
    service = info.s
    relay = info.r
  }

  private static let defaultsKey = "otter.mac"
  static func load() -> MacRecord? {
    guard let data = UserDefaults.standard.data(forKey: defaultsKey) else { return nil }
    return try? JSONDecoder().decode(MacRecord.self, from: data)
  }
  func save() {
    UserDefaults.standard.set(try? JSONEncoder().encode(self), forKey: Self.defaultsKey)
  }
  static func forget() { UserDefaults.standard.removeObject(forKey: defaultsKey) }
}

// This phone's own key, kept in the Keychain and never leaving the device.
enum PhoneKey {
  private static let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "dev.otter.mobile",
    kSecAttrAccount as String: "phone-key",
  ]

  static func load() -> PrivateKey {
    var item: CFTypeRef?
    var lookup = query
    lookup[kSecReturnData as String] = true
    if SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data, let key = try? PrivateKey(rawRepresentation: data)
    {
      return key
    }
    let key = PrivateKey()
    var add = query
    add[kSecValueData as String] = key.rawRepresentation
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemDelete(query as CFDictionary)
    SecItemAdd(add as CFDictionary, nil)
    return key
  }

  static func reset() { SecItemDelete(query as CFDictionary) }
}
