import SwiftUI

// 今天: the otter's mood, a running focus session, reminders and to-dos.
struct TodayView: View {
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          header
          if let focus = store.today?.focus { FocusCard(dueAt: focus.dueAt) }
          remindersCard
          todosCard
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 24)
      }
      .background(palette.background.ignoresSafeArea())
      .refreshable { store.disconnect(); store.connect() }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { LinkPill() }
      }
      .navigationTitle(greeting)
    }
  }

  private var greeting: String {
    let hour = Calendar.current.component(.hour, from: Date())
    return hour < 11 ? "早上好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好"
  }

  private var header: some View {
    HStack(spacing: 14) {
      Image(OtterArt.image(for: store.otter?.mood, online: store.status?.online))
        .interpolation(.none)
        .resizable()
        .scaledToFit()
        .frame(width: 84, height: 84)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(store.status?.mac ?? store.mac?.name ?? "Mac")
          .font(.rounded(13, .medium))
          .foregroundStyle(palette.muted)
        Text(store.otter.map { $0.caption.isEmpty ? "水獭醒着，在 Mac 上陪你" : $0.caption } ?? "水獭在 Mac 上陪你")
          .font(.rounded(17, .semibold))
          .foregroundStyle(palette.ink)
        if let job = store.status?.job, job.status == "running" {
          Text("正在写今天的简报…").font(.rounded(13)).foregroundStyle(palette.accent)
        }
      }
    }
    .padding(.top, 4)
  }

  private var remindersCard: some View {
    Card {
      Label("提醒", systemImage: "bell").font(.rounded(15, .semibold)).foregroundStyle(palette.ink)
      let reminders = (store.today?.reminders ?? []).filter { $0.kind != "focus" }
      if reminders.isEmpty {
        Text("没有提醒。").font(.rounded(14)).foregroundStyle(palette.muted)
      }
      ForEach(reminders.prefix(12)) { r in
        HStack(alignment: .firstTextBaseline) {
          Text(clock(r.dueAt))
            .font(.system(size: 15, weight: .semibold, design: .rounded).monospacedDigit())
            .foregroundStyle(palette.accent)
            .frame(width: 92, alignment: .leading)
          VStack(alignment: .leading, spacing: 2) {
            Text(r.title).font(.rounded(15)).foregroundStyle(palette.ink)
            Text(relative(r.dueAt)).font(.rounded(12)).foregroundStyle(palette.muted)
          }
        }
        .accessibilityElement(children: .combine)
      }
    }
  }

  private var todosCard: some View {
    Card {
      let todos = store.today?.todos ?? []
      let open = todos.filter { !$0.done }
      HStack {
        Label("待办", systemImage: "checklist").font(.rounded(15, .semibold)).foregroundStyle(palette.ink)
        Spacer()
        if !todos.isEmpty {
          Text("\(todos.count - open.count)/\(todos.count)").font(.rounded(13)).foregroundStyle(palette.muted)
        }
      }
      if todos.isEmpty {
        Text("没有待办。").font(.rounded(14)).foregroundStyle(palette.muted)
      }
      ForEach((open + todos.filter(\.done)).prefix(20)) { t in
        HStack(spacing: 10) {
          Image(systemName: t.done ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(t.done ? palette.accent : palette.muted)
          Text(t.title)
            .font(.rounded(15))
            .strikethrough(t.done)
            .foregroundStyle(t.done ? palette.muted : palette.ink)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(t.done ? "已完成" : "未完成")：\(t.title)")
      }
    }
  }
}

struct FocusCard: View {
  let dueAt: Double
  @Environment(\.palette) private var palette

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let left = max(0, dueAt / 1000 - context.date.timeIntervalSince1970)
      Card {
        HStack {
          Label("专注中", systemImage: "timer").font(.rounded(15, .semibold)).foregroundStyle(palette.accent)
          Spacer()
          Text(String(format: "%02d:%02d", Int(left) / 60, Int(left) % 60))
            .font(.system(size: 28, weight: .bold, design: .rounded).monospacedDigit())
            .foregroundStyle(palette.ink)
        }
      }
    }
  }
}

enum OtterArt {
  static func image(for mood: String?, online: Bool?) -> String {
    if online == false { return "otter-offline" }
    switch mood {
    case "sleeping": return "otter-sleeping"
    case "happy", "tickled", "eating": return "otter-happy"
    case "working", "thinking": return "otter-working"
    case "speaking": return "otter-speaking"
    case "playing", "dancing": return "otter-playing"
    case "waving", "waking": return "otter-waving"
    default: return "otter-idle"
    }
  }
}
