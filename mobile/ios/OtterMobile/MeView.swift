import SwiftUI

// 我的: which Mac, how the link is doing (and how fast), the physical otter,
// and un-pairing.
struct MeView: View {
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette
  @State private var confirming = false

  var body: some View {
    NavigationStack {
      List {
        Section("Mac") {
          row("名字", store.mac?.name ?? "—")
          row("连接", linkText)
          if let latency = store.latency {
            row("推送延迟", "中位 \(Int(latency.p50.rounded())) ms · 95% ≤ \(Int(latency.p95.rounded())) ms")
          }
          if let rtt = store.rtt { row("往返", "\(Int(rtt.rounded())) ms") }
          if let version = store.status?.version { row("Otter 版本", version) }
          if store.status?.quiet == true { row("安静模式", "开") }
          row("这台手机", store.control ? "可以操作" : "只能看")
        }
        if let body = store.otter?.body, body.enabled {
          Section("实体水獭") {
            row("状态", body.message.isEmpty ? body.status : body.message)
          }
        }
        Section {
          Button("重新连接") {
            store.disconnect()
            store.connect()
          }
          Button("取消配对", role: .destructive) { confirming = true }
        } footer: {
          Text("取消后这台手机不再接收 Mac 的内容；要再连，在 Mac 上 设置 → 手机 里重新添加。")
        }
      }
      .scrollContentBackground(.hidden)
      .background(palette.background.ignoresSafeArea())
      .navigationTitle("我的")
      .confirmationDialog("取消和这台 Mac 的配对？", isPresented: $confirming, titleVisibility: .visible) {
        Button("取消配对", role: .destructive) { store.unpair() }
      }
    }
  }

  private var linkText: String {
    switch store.link {
    case .online: return "在线（局域网直连，端到端加密）"
    case .connecting: return "连接中…"
    case .offline(let reason): return reason.isEmpty ? "离线" : "离线：\(reason)"
    case .revoked: return "配对已在 Mac 上撤销"
    case .unpaired: return "未配对"
    }
  }

  private func row(_ title: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title).font(.rounded(15)).foregroundStyle(palette.ink)
      Spacer(minLength: 16)
      Text(value).font(.rounded(15)).foregroundStyle(palette.muted).multilineTextAlignment(.trailing)
    }
    .listRowBackground(palette.card)
  }
}
