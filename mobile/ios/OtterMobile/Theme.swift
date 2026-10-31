import SwiftUI

// The desktop's themes (desktop/src/themes.css), so the phone wears whatever
// the Mac is wearing: 暖阳小窝 by default.
struct Palette {
  let background: Color
  let card: Color
  let ink: Color
  let muted: Color
  let accent: Color
  let accentSoft: Color
  let dark: Bool

  static func named(_ theme: String?) -> Palette {
    switch theme {
    case "mint":
      return Palette(
        background: Color(hex: 0xEFF7F2), card: .white, ink: Color(hex: 0x1F2D27),
        muted: Color(hex: 0x84958C), accent: Color(hex: 0x2F9E78), accentSoft: Color(hex: 0xD8F1E6),
        dark: false)
    case "bay":
      return Palette(
        background: Color(hex: 0xEDF3FA), card: .white, ink: Color(hex: 0x1D2A3A),
        muted: Color(hex: 0x8595AA), accent: Color(hex: 0x3A7BD5), accentSoft: Color(hex: 0xDCE8F8),
        dark: false)
    case "night":
      return Palette(
        background: Color(hex: 0x1D1713), card: Color(hex: 0x2F2621), ink: Color(hex: 0xF3E9DF),
        muted: Color(hex: 0xA8968A), accent: Color(hex: 0xF08A50), accentSoft: Color(hex: 0x4A3226),
        dark: true)
    default:
      return Palette(
        background: Color(hex: 0xFBF5EC), card: .white, ink: Color(hex: 0x2B2420),
        muted: Color(hex: 0x9A8B80), accent: Color(hex: 0xE8743F), accentSoft: Color(hex: 0xFBE3D4),
        dark: false)
    }
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255)
  }
}

private struct PaletteKey: EnvironmentKey {
  static let defaultValue = Palette.named(nil)
}
extension EnvironmentValues {
  var palette: Palette {
    get { self[PaletteKey.self] }
    set { self[PaletteKey.self] = newValue }
  }
}

// A rounded card on the theme's surface.
struct Card<Content: View>: View {
  @Environment(\.palette) private var palette
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 10) { content }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(16)
      .background(palette.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      .shadow(color: .black.opacity(palette.dark ? 0 : 0.05), radius: 10, y: 4)
  }
}

extension Font {
  static func rounded(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .rounded)
  }
}

// Reply text with the Markdown a chat uses inline: bold, code, links.
func markdown(_ text: String) -> AttributedString {
  (try? AttributedString(
    markdown: text,
    options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
  )) ?? AttributedString(text)
}

func relative(_ ms: Double) -> String {
  let date = Date(timeIntervalSince1970: ms / 1000)
  let formatter = RelativeDateTimeFormatter()
  formatter.locale = Locale(identifier: "zh_CN")
  formatter.unitsStyle = .short
  return formatter.localizedString(for: date, relativeTo: Date())
}

func clock(_ ms: Double) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "zh_CN")
  formatter.dateFormat = Calendar.current.isDateInToday(Date(timeIntervalSince1970: ms / 1000)) ? "HH:mm" : "M月d日 HH:mm"
  return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
}
