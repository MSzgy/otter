import SwiftUI

@main
struct OtterMobileApp: App {
  @State private var store = SyncStore()
  @Environment(\.scenePhase) private var phase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(store)
        // otter://pair?d=… from the camera or a pasted link.
        .onOpenURL { store.pair($0.absoluteString) }
        // Connected only while on screen; the cache covers the rest.
        .onChange(of: phase, initial: true) { _, phase in
          store.setActive(phase == .active)
        }
    }
  }
}

struct RootView: View {
  @Environment(SyncStore.self) private var store

  var body: some View {
    let palette = Palette.named(store.status?.theme)
    Group {
      if store.mac == nil {
        PairView()
      } else {
        MainTabs()
      }
    }
    .environment(\.palette, palette)
    .tint(palette.accent)
    .preferredColorScheme(palette.dark ? .dark : .light)
  }
}

struct MainTabs: View {
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette

  var body: some View {
    TabView {
      TodayView().tabItem { Label("今天", systemImage: "sun.max") }
      ChatListView().tabItem { Label("聊天", systemImage: "bubble.left.and.bubble.right") }
      TasksView().tabItem { Label("任务", systemImage: "hammer") }
      MeView().tabItem { Label("我的", systemImage: "person.crop.circle") }
    }
    .overlay(alignment: .top) {
      if store.link == .revoked {
        Text("这台手机的配对已在 Mac 上撤销，请到“我的”里重新配对。")
          .font(.rounded(13, .medium))
          .padding(10)
          .frame(maxWidth: .infinity)
          .background(palette.accentSoft)
      }
    }
  }
}

// Online and how fast, connecting, or offline with how old the view is.
struct LinkPill: View {
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(text).font(.rounded(12, .medium)).foregroundStyle(palette.muted)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(palette.card.opacity(0.8), in: Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("连接：\(text)")
  }

  private var color: Color {
    switch store.link {
    case .online: return .green
    case .connecting: return .orange
    default: return palette.muted
    }
  }

  private var text: String {
    switch store.link {
    case .online:
      if let p50 = store.latency?.p50 { return "在线 · \(Int(p50.rounded())) ms" }
      return "在线"
    case .connecting: return "连接中…"
    case .revoked: return "已撤销"
    case .unpaired: return "未配对"
    case .offline:
      if let updated = store.updated {
        return "离线 · \(updated.formatted(date: .omitted, time: .shortened)) 的内容"
      }
      return "离线"
    }
  }
}
