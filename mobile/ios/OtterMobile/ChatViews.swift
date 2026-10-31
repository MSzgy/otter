import SwiftUI

enum ChatRoute: Hashable {
  case session(String)
  case new
}

// 聊天: the Mac's conversations, newest first; a reply being written shows
// as it streams, and a conversation waiting on a card says so.
struct ChatListView: View {
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette

  var body: some View {
    NavigationStack {
      List {
        ForEach(store.chat?.sessions ?? []) { session in
          NavigationLink(value: ChatRoute.session(session.id)) {
            HStack {
              VStack(alignment: .leading, spacing: 3) {
                Text(session.title).font(.rounded(16, .medium)).foregroundStyle(palette.ink).lineLimit(1)
                Text(relative(session.updated * 1000)).font(.rounded(12)).foregroundStyle(palette.muted)
              }
              Spacer()
              if store.cards?.tools.contains(where: { $0.session == session.id }) == true {
                Text("等你确认").font(.rounded(12, .semibold)).foregroundStyle(palette.accent)
              } else if store.chat?.turn?.session == session.id && store.chat?.turn?.status == "streaming" {
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
      .navigationDestination(for: ChatRoute.self) { route in
        switch route {
        case .session(let id): ChatDetailView(session: id)
        case .new: ChatDetailView(session: nil)
        }
      }
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          if store.control && store.link == .online {
            NavigationLink(value: ChatRoute.new) {
              Image(systemName: "square.and.pencil")
            }
            .accessibilityLabel("新对话")
          }
        }
        ToolbarItem(placement: .topBarTrailing) { LinkPill() }
      }
    }
  }
}

struct ChatDetailView: View {
  @State var session: String?
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette
  @State private var messages: [ChatMessage] = []
  @State private var error: String?
  @State private var loading = true
  @State private var draft = ""
  @State private var sending: String?
  @State private var proposal: SendResult?
  @State private var notice: String?
  @FocusState private var typing: Bool

  private var live: ChatTopic.Turn? {
    guard let turn = store.chat?.turn, turn.session == session else { return nil }
    return turn
  }
  private var streaming: Bool { live?.status == "streaming" }
  private var title: String {
    store.chat?.sessions.first { $0.id == session }?.title ?? "新对话"
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if loading && messages.isEmpty && session != nil { ProgressView().frame(maxWidth: .infinity) }
          if let error { Text(error).font(.rounded(14)).foregroundStyle(palette.muted) }
          // The reply being written arrives as appended text over the link;
          // once stored, the history copy takes over.
          let shown = live.flatMap { turn in
            turn.status == "streaming" || !messages.contains(where: { $0.id == turn.id }) ? turn : nil
          }
          ForEach(messages.filter { $0.id != shown?.id }) { m in
            Bubble(role: m.role, content: m.content, agent: m.agent, streaming: false)
          }
          // What this phone just sent, until the Mac's history has it.
          if let sending, !messages.contains(where: { $0.role == "user" && $0.content == sending }) {
            Bubble(role: "user", content: sending, agent: "", streaming: false).opacity(0.6)
          }
          if let shown {
            Bubble(role: "assistant", content: shown.content.isEmpty ? "让我想想…" : shown.content,
                   agent: "", streaming: shown.status == "streaming")
          }
          ForEach(store.cards?.tools.filter { $0.session == session } ?? []) { card in
            ToolCardView(card: card)
          }
          if let proposal { ProposalCard(proposal: proposal, onDone: finish) }
          if let notice {
            Text(notice).font(.rounded(13)).foregroundStyle(palette.muted)
              .padding(10).frame(maxWidth: .infinity, alignment: .leading)
              .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: 12))
          }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(16)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(palette.background.ignoresSafeArea())
      .onChange(of: live?.content) { proxy.scrollTo("end", anchor: .bottom) }
      .onChange(of: messages.count) { proxy.scrollTo("end", anchor: .bottom) }
      .onChange(of: proposal?.id) { proxy.scrollTo("end", anchor: .bottom) }
      .onChange(of: store.cards?.tools.count) { proxy.scrollTo("end", anchor: .bottom) }
    }
    .safeAreaInset(edge: .bottom) { composer }
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .task(id: "\(session ?? "")-\(store.link == .online)-\(live?.status ?? "")-\(store.chat?.sessions.first { $0.id == session }?.updated ?? 0)") {
      await load()
    }
  }

  @ViewBuilder private var composer: some View {
    if !store.control {
      Text("这台手机只能看。要在手机上发消息，请在 Mac 的 设置 → 手机 里打开“可以操作”。")
        .font(.rounded(12)).foregroundStyle(palette.muted)
        .padding(12).frame(maxWidth: .infinity)
        .background(palette.background)
    } else {
      HStack(alignment: .bottom, spacing: 10) {
        TextField("跟水獭说…", text: $draft, axis: .vertical)
          .font(.rounded(16))
          .lineLimit(1...5)
          .focused($typing)
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .background(palette.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
          .accessibilityLabel("消息")
        if streaming, let live {
          Button {
            Task { try? await store.perform("stop", ["turn": live.id]) }
          } label: {
            Image(systemName: "stop.circle.fill").font(.system(size: 34))
          }
          .accessibilityLabel("停止回复")
        } else {
          Button(action: send) {
            Image(systemName: "arrow.up.circle.fill").font(.system(size: 34))
          }
          .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending != nil
                    || proposal != nil || store.link != .online)
          .accessibilityLabel("发送")
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(palette.background.opacity(0.96))
    }
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    draft = ""
    sending = text
    notice = nil
    error = nil
    Task {
      do {
        let result = try await store.send(session: session, text: text)
        if session == nil, let id = result.session { session = id }
        switch result.kind {
        case "proposal": proposal = result
        case "result":
          notice = result.message
          sending = nil
        default: break
        }
        await load()
      } catch {
        self.error = error.localizedDescription
        draft = text
        sending = nil
      }
    }
  }

  private func finish(_ message: String?) {
    proposal = nil
    sending = nil
    notice = message
    Task { await load() }
  }

  private func load() async {
    guard let session, store.link == .online else {
      loading = false
      return
    }
    do {
      let value = try await store.request("history", ["session": session])
      messages = decodeJSON([ChatMessage].self, value) ?? []
      error = nil
      if let sending, messages.contains(where: { $0.role == "user" && $0.content == sending }) {
        self.sending = nil
      }
      // A receipt the Mac wrote into the conversation needs no banner too.
      if let notice, messages.contains(where: { $0.content == notice }) { self.notice = nil }
    } catch {
      self.error = error.localizedDescription
    }
    loading = false
  }
}

// A card the planner made (add a reminder, change a setting…): confirm or not.
struct ProposalCard: View {
  let proposal: SendResult
  let onDone: (String?) -> Void
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette
  @State private var busy = false

  var body: some View {
    Card {
      Text(proposal.title ?? "确认操作").font(.rounded(15, .semibold)).foregroundStyle(palette.ink)
      if let detail = proposal.detail, !detail.isEmpty {
        Text(detail).font(.rounded(14)).foregroundStyle(palette.ink)
      }
      HStack {
        Button("确认") {
          busy = true
          Task {
            let result = try? await store.confirm(proposal)
            onDone(result?.message ?? "没有确认成功，请再试一次。")
          }
        }
        .buttonStyle(.borderedProminent)
        Button("取消") {
          Task {
            await store.dismiss(proposal)
            onDone(nil)
          }
        }
        .buttonStyle(.bordered)
      }
      .disabled(busy)
      .font(.rounded(15, .semibold))
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("办事确认")
  }
}

// A tool the chat wants to use on the Mac; the same three answers as there.
struct ToolCardView: View {
  let card: CardsTopic.ToolCard
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette
  @State private var busy = false

  var body: some View {
    Card {
      Text("水獭想用「\(card.label)」").font(.rounded(15, .semibold)).foregroundStyle(palette.ink)
      if !card.origin.isEmpty {
        Text("来自 \(card.origin)").font(.rounded(12)).foregroundStyle(palette.muted)
      }
      Text(card.detail).font(.system(size: 13, design: .monospaced)).foregroundStyle(palette.ink)
        .lineLimit(14)
      if store.control {
        HStack {
          Button("允许一次") { decide("once") }.buttonStyle(.borderedProminent)
          if !card.alwaysAsk { Button("这段对话都允许") { decide("session") }.buttonStyle(.bordered) }
          Button("拒绝") { decide("deny") }.buttonStyle(.bordered)
        }
        .font(.rounded(14, .semibold))
        .disabled(busy)
      } else {
        Text("在 Mac 上确认，或者在 Mac 上给这台手机打开“可以操作”。")
          .font(.rounded(12)).foregroundStyle(palette.muted)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("工具请求：\(card.label)")
  }

  private func decide(_ decision: String) {
    busy = true
    Task { try? await store.perform("tool", ["id": card.id, "decision": decision]) }
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
