// Makes the app's images from the desktop otter GIFs (first frame), scaled
// with no smoothing so the pixel art stays sharp: the app icon on the warm
// cream, and one image per mood. Run: swift tools/make-assets.swift
import AppKit
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let gifs = root.appendingPathComponent("../../desktop/src/assets/otter")
let assets = root.appendingPathComponent("OtterMobile/Assets.xcassets")

func frame(_ name: String) -> CGImage {
  let source = CGImageSourceCreateWithURL(gifs.appendingPathComponent("\(name).gif") as CFURL, nil)!
  return CGImageSourceCreateImageAtIndex(source, 0, nil)!
}
func png(_ image: CGImage, size: Int, background: CGColor?, scale: CGFloat) -> Data {
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  if let background { ctx.setFillColor(background); ctx.fill(CGRect(x: 0, y: 0, width: size, height: size)) }
  ctx.interpolationQuality = .none
  let w = CGFloat(image.width) * scale, h = CGFloat(image.height) * scale
  ctx.draw(image, in: CGRect(x: (CGFloat(size) - w) / 2, y: (CGFloat(size) - h) / 2, width: w, height: h))
  let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
  return rep.representation(using: .png, properties: [:])!
}
func write(_ data: Data, set: String, file: String, contents: String) throws {
  let dir = assets.appendingPathComponent(set)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  try data.write(to: dir.appendingPathComponent(file))
  try contents.write(to: dir.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
}
// The part of a frame that is not transparent, so the icon can centre it.
func trimmed(_ image: CGImage) -> CGImage {
  let w = image.width, h = image.height
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  let px = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h * 4)
  var (x0, y0, x1, y1) = (w, h, 0, 0)
  for y in 0..<h { for x in 0..<w where px[(y * w + x) * 4 + 3] > 24 {
    x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
  } }
  return ctx.makeImage()!.cropping(to: CGRect(x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1))!
}
let cream = CGColor(red: 0xfb / 255, green: 0xf5 / 255, blue: 0xec / 255, alpha: 1)
let face = trimmed(frame("waving"))
try write(png(face, size: 1024, background: cream,
              scale: floor(780 / CGFloat(max(face.width, face.height)))), set: "AppIcon.appiconset", file: "icon.png",
          contents: #"{"images":[{"filename":"icon.png","idiom":"universal","platform":"ios","size":"1024x1024"}],"info":{"author":"xcode","version":1}}"#)
for mood in ["idle", "happy", "sleeping", "working", "waving", "offline", "speaking", "playing"] {
  try write(png(frame(mood), size: 454, background: nil, scale: 2), set: "otter-\(mood).imageset", file: "\(mood).png",
            contents: #"{"images":[{"filename":"\#(mood).png","idiom":"universal","scale":"2x"}],"info":{"author":"xcode","version":1},"properties":{"preserves-vector-representation":false,"template-rendering-intent":"original"}}"#)
}
try #"{"info":{"author":"xcode","version":1}}"#.write(to: assets.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
try write(Data(), set: "AccentColor.colorset", file: ".keep",
          contents: #"{"colors":[{"color":{"color-space":"srgb","components":{"alpha":"1.000","blue":"0x3F","green":"0x74","red":"0xE8"}},"idiom":"universal"}],"info":{"author":"xcode","version":1}}"#)
try? FileManager.default.removeItem(at: assets.appendingPathComponent("AccentColor.colorset/.keep"))
print("assets written")
