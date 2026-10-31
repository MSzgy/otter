import Foundation

// Applies the Mac's patches (desktop/electron/sync-hub.cjs) to a topic kept as
// plain JSON: "s" sets (no "v" deletes), "a" appends text, "l" upserts and
// removes {id} items, with "i" the new order when it changed.
enum Patch {
  static func apply(_ value: Any?, _ ops: [[String: Any]]) -> Any? {
    var root = value
    for op in ops {
      let path = (op["p"] as? [Any] ?? []).map { "\($0)" }
      root = apply(root, path[...], op)
    }
    return root
  }

  private static func apply(_ value: Any?, _ path: ArraySlice<String>, _ op: [String: Any]) -> Any? {
    guard let key = path.first else { return leaf(value, op) }
    var dict = value as? [String: Any] ?? [:]
    let rest = path.dropFirst()
    if rest.isEmpty, op["o"] as? String == "s", op["v"] == nil {
      dict.removeValue(forKey: key)
    } else {
      dict[key] = apply(dict[key], rest, op)
    }
    return dict
  }

  private static func leaf(_ value: Any?, _ op: [String: Any]) -> Any? {
    switch op["o"] as? String {
    case "a": return ((value as? String) ?? "") + ((op["t"] as? String) ?? "")
    case "l": return list(value as? [[String: Any]] ?? [], op)
    default: return op["v"]
    }
  }

  private static func id(_ item: [String: Any]) -> String { "\(item["id"] ?? "")" }

  private static func list(_ items: [[String: Any]], _ op: [String: Any]) -> [[String: Any]] {
    var map = Dictionary(items.map { (id($0), $0) }, uniquingKeysWith: { _, b in b })
    for removed in op["r"] as? [Any] ?? [] { map.removeValue(forKey: "\(removed)") }
    let explicit = (op["i"] as? [Any])?.map { "\($0)" }
    var order = explicit ?? items.map(id).filter { map[$0] != nil }
    for item in op["u"] as? [[String: Any]] ?? [] {
      let key = id(item)
      if explicit == nil && map[key] == nil { order.append(key) }
      map[key] = item
    }
    return order.compactMap { map[$0] }
  }
}
