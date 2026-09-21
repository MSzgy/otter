import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit
import Vision

func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) { print(text) }
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    return attribute(element, name) as? [AXUIElement] ?? []
}
func readAX(_ pid: pid_t) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["status":"permission_required", "permission":"accessibility"] }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    var windowValue: CFTypeRef?
    let windowError = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowValue)
    if windowError == .apiDisabled { return ["status":"permission_required","permission":"accessibility"] }
    if windowError != .success { return ["status":"read_failed","windows":[]] }
    let windows = windowValue as? [AXUIElement] ?? []
    if windows.isEmpty { return ["status":"no_windows", "windows":[]] }
    let deadline = Date().addingTimeInterval(7)
    var results: [[String: Any]] = [], total = 0, documentCharacters = 0, truncated = windows.count > 8
    for (index, window) in windows.prefix(8).enumerated() {
        var queue = [(window,0)], visited = Set<CFHashCode>(), lines: [String] = [], prior = "", nodes = 0, secure = false
        while !queue.isEmpty && nodes < 2500 && total < 20000 && Date() < deadline {
            let (node, depth) = queue.removeLast()
            let key = CFHash(node)
            if visited.contains(key) { continue }; visited.insert(key); nodes += 1
            let role = string(node, kAXRoleAttribute), subrole = string(node, kAXSubroleAttribute)
            if subrole == kAXSecureTextFieldSubrole || (attribute(node,"AXProtectedContent") as? Bool == true) { secure = true; continue }
            if attribute(node,"AXHidden") as? Bool == true { continue }
            var candidates: [String] = []
            if ["AXStaticText","AXTextArea","AXTextField","AXComboBox","AXCell"].contains(role) {
                let value = string(node,kAXValueAttribute)
                documentCharacters += value.count
                candidates.append(value)
            }
            candidates.append(string(node,kAXTitleAttribute))
            if candidates.allSatisfy({$0.isEmpty}) && ["AXButton","AXLink","AXImage"].contains(role) { candidates.append(string(node,kAXDescriptionAttribute)) }
            for raw in candidates {
                let value = raw.trimmingCharacters(in:.whitespacesAndNewlines)
                if value.isEmpty || value == prior { continue }
                let limit = max(0,20000-total); let text = String(value.prefix(limit))
                if !text.isEmpty { lines.append(text); total += text.count + 1; prior = value }
                if value.count > limit { truncated = true }
            }
            if depth < 32 { for child in elements(node,kAXChildrenAttribute).reversed() { queue.append((child,depth+1)) } }
        }
        if !queue.isEmpty { truncated = true }
        let title = string(window,kAXTitleAttribute)
        results.append(["id":index,"title":title.isEmpty ? "窗口 \(index+1)" : title,
                        "text":lines.joined(separator:"\n"),"nodes":nodes,"protectedFieldsSkipped":secure])
        if total >= 20000 || Date() >= deadline { truncated = true; break }
    }
    let hasText = results.contains { !($0["text"] as? String ?? "").isEmpty }
    return ["status":hasText ? (documentCharacters > 0 ? "ready" : "labels_only") : "empty", "method":"ax", "windows":results,"truncated":truncated]
}
func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans","en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage:image,options:[:]).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator:"\n")
}
@available(macOS 14.0, *)
@MainActor
func readOCR(_ pid: pid_t) async -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { return ["status":"permission_required","permission":"screen_recording"] }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
        let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 30 && $0.frame.height > 30 }
        if windows.isEmpty { return ["status":"no_windows","windows":[]] }
        var results: [[String:Any]] = [], total = 0
        for window in windows.prefix(3) {
            let filter = SCContentFilter(desktopIndependentWindow:window)
            let configuration = SCStreamConfiguration()
            let scale = min(2.0, 2560.0 / max(window.frame.width,window.frame.height))
            configuration.width = max(1,Int(window.frame.width*scale)); configuration.height = max(1,Int(window.frame.height*scale))
            configuration.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:configuration)
            let text = String(try recognize(image).prefix(max(0,20000-total)))
            total += text.count
            results.append(["id":Int(window.windowID),"title":window.title ?? "窗口","text":text])
            if total >= 20000 { break }
        }
        return ["status":total > 0 ? "ready" : "empty","method":"ocr","windows":results,"truncated":windows.count>3 || total>=20000]
    } catch { return ["status":"capture_failed","method":"ocr"] }
}
func selfTestOCR() -> [String:Any] {
    let image=NSImage(size:NSSize(width:600,height:120)); image.lockFocus()
    NSColor.white.setFill();NSRect(x:0,y:0,width:600,height:120).fill()
    ("OTTER CONTENT CHECK" as NSString).draw(at:NSPoint(x:20,y:40),withAttributes:[.font:NSFont.systemFont(ofSize:36),.foregroundColor:NSColor.black])
    image.unlockFocus();var rect=NSRect(x:0,y:0,width:600,height:120)
    guard let cg=image.cgImage(forProposedRect:&rect,context:nil,hints:nil), let text=try? recognize(cg) else {return ["status":"failed"]}
    return ["status":"ready","text":text]
}
let args=CommandLine.arguments
if args.contains("--request-accessibility") {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let allowed = AXIsProcessTrustedWithOptions(options)
    output(["accessibility":allowed,"screenRecording":CGPreflightScreenCaptureAccess()]);exit(0)
}
if args.contains("--request-screen") {
    let allowed = CGRequestScreenCaptureAccess()
    output(["accessibility":AXIsProcessTrusted(),"screenRecording":allowed]);exit(0)
}
if args.contains("--permissions") { output(["accessibility":AXIsProcessTrusted(),"screenRecording":CGPreflightScreenCaptureAccess()]);exit(0) }
if args.contains("--ocr-self-test") { output(selfTestOCR());exit(0) }
guard args.count >= 4, let pid=Int32(args[1]), pid>0, let app=NSRunningApplication(processIdentifier:pid), !app.isTerminated,
      (app.bundleIdentifier ?? "") == args[2] else { output(["status":"not_running"]);exit(0) }
let method=args[3]
if method == "ax" { output(readAX(pid));exit(0) }
if method == "ocr" {
    if #available(macOS 14.0, *) {
        // ScreenCaptureKit window filters require an initialized AppKit display connection.
        _ = NSApplication.shared
        Task { @MainActor in output(await readOCR(pid));exit(0) }
        RunLoop.main.run()
    } else { output(["status":"unsupported_os"]);exit(0) }
}
output(["status":"invalid_request"])
