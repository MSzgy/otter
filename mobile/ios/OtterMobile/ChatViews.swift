import SwiftUI

// 聊天: the Mac's conversations, newest first; a reply being written shows
// as it streams.
struct ChatListView: View {
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette

  var body: some View {
    NavigationStack {
      List {
        ForEach(store.chat?.sessions ?? []) { session in
          NavigationLink(value: session.id) {
            HStack {
              VStack(alignment: .leading, spacing: 3) {
                Text(session.title).font(.rounded(16, .medium)).foregroundStyle(palette.ink).lineLimit(1)
                Text(relative(session.updated * 1000)).font(.rounded(12)).foregroundStyle(palette.muted)
              }
              Spacer()
              if store.chat?.turn?.session == session.id && store.chat?.turn?.status == "streaming" {
                Text("回复中…").font(.rounded(12, .medium)).foregroundStyle(palette.accent)
              }
            }
          }
          .listRowBackground(palette.card)
        }
      }
      .scrollContentBackground(.hidden)
      .background(palette.background.ignoresSafeArea())
      .overlay {
        if store.chat?.sessions.isEmpty ?? true {
          Text("Mac 上还没有对话。").font(.rounded(15)).foregroundStyle(palette.muted)
        }
      }
      .navigationTitle("聊天")
      .navigationDestination(for: String.self) { id in
        ChatDetailView(session: id, title: store.chat?.sessions.first { $0.id == id }?.title ?? "对话")
      }
      .toolbar { ToolbarItem(placement: .topBarTrailing) { LinkPill() } }
    }
  }
}

struct ChatDetailView: View {
  let session: String
  let title: String
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette
  @State private var messages: [ChatMessage] = []
  @State private var error: String?
  @State private var loading = true

  private var live: ChatTopic.Turn? {
    guard let turn = store.chat?.turn, turn.session == session else { return nil }
    return turn
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if loading && messages.isEmpty { ProgressView().frame(maxWidth: .infinity) }
          if let error { Text(error).font(.rounded(14)).foregroundStyle(palette.muted) }
          // The reply being written arrives as appended text over the link;
          // once stored, the history copy takes over.
          let shown = live.flatMap { turn in
            turn.status == "streaming" || !messages.contains(where: { $0.id == turn.id }) ? turn : nil
          }
          ForEach(messages.filter { $0.id != shown?.id }) { m in
            Bubble(role: m.role, content: m.content, agent: m.agent, streaming: false)
          }
          if let shown {
            Bubble(role: "assistant", content: shown.content.isEmpty ? "让我想想…" : shown.content,
                   agent: "", streaming: shown.status == "streaming")
          }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(16)
      }
      .background(palette.background.ignoresSafeArea())
      .onChange(of: live?.content) { proxy.scrollTo("end", anchor: .bottom) }
      .onChange(of: messages.count) { proxy.scrollTo("end", anchor: .bottom) }
    }
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .task(id: "\(store.link == .online)-\(live?.status ?? "")-\(store.chat?.sessions.first { $0.id == session }?.updated ?? 0)") {
      await load()
    }
  }

  private func load() async {
    guard store.link == .online else {
      loading = false
      return
    }
    do {
      let value = try await store.request("history", ["session": session])
      messages = decodeJSON([ChatMessage].self, value) ?? []
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loading = false
  }
}

struct Bubble: View {
  let role: String
  let content: String
  let agent: String
  let streaming: Bool
  @Environment(\.palette) private var palette

  var body: some View {
    let mine = role == "user"
    VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
      if !agent.isEmpty {
        Text("\(agent == "codex" ? "Codex" : agent) · 任务回报")
          .font(.rounded(12, .semibold))
          .foregroundStyle(palette.accent)
      }
      Text(markdown(content) + (streaming ? AttributedString(" ●") : AttributedString("")))
        .font(.rounded(15))
        .foregroundStyle(palette.ink)
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
          mine ? palette.accentSoft : palette.card,
          in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay(alignment: .leading) {
          if !agent.isEmpty {
            RoundedRectangle(cornerRadius: 2).fill(palette.accent).frame(width: 3).padding(.vertical, 8)
          }
        }
    }
    .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    .padding(mine ? .leading : .trailing, 36)
  }
}
