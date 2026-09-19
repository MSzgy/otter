import AppKit
import ApplicationServices
import Foundation

func output(_ result: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: result),
       let text = String(data: data, encoding: .utf8) { print(text) }
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
if CommandLine.arguments.contains("--permission-status") {
    output(["status": AXIsProcessTrusted() ? "ready" : "permission_required"])
    exit(0)
}
guard AXIsProcessTrusted() else { output(["status":"permission_required"]); exit(0) }
guard let front = NSWorkspace.shared.frontmostApplication else { output(["status":"no_app"]); exit(0) }
let application = AXUIElementCreateApplication(front.processIdentifier)
AXUIElementSetMessagingTimeout(application, 2)
guard let focusedValue = attribute(application, kAXFocusedUIElementAttribute),
      CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else { output(["status":"unsupported"]); exit(0) }
let focused = unsafeBitCast(focusedValue, to: AXUIElement.self)
let subrole = attribute(focused, kAXSubroleAttribute) as? String
if subrole == kAXSecureTextFieldSubrole { output(["status":"protected"]); exit(0) }
guard let selected = attribute(focused, kAXSelectedTextAttribute) as? String,
      !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { output(["status":"empty"]); exit(0) }
output(["status":"ready", "text":String(selected.prefix(3500)), "truncated":selected.count>3500,
        "app":front.localizedName ?? "Unknown", "bundleId":front.bundleIdentifier ?? ""])
