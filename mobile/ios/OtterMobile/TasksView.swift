import SwiftUI

// 任务: what Codex (and later other agents) is doing for you on the Mac.
struct TasksView: View {
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 12) {
          ForEach(store.agents?.tasks ?? []) { task in
            NavigationLink(value: task.id) { TaskRow(task: task) }
              .buttonStyle(.plain)
          }
        }
        .padding(16)
      }
      .background(palette.background.ignoresSafeArea())
      .overlay {
        if store.agents?.tasks.isEmpty ?? true {
          Text("还没有派给 AI 代理的任务。\n在 Mac 上的聊天里说“让 Codex……”就行。")
            .font(.rounded(15))
            .foregroundStyle(palette.muted)
            .multilineTextAlignment(.center)
        }
      }
      .navigationTitle("任务")
      .navigationDestination(for: String.self) { id in TaskDetailView(id: id) }
      .toolbar { ToolbarItem(placement: .topBarTrailing) { LinkPill() } }
    }
  }
}

struct StatusBadge: View {
  let status: String
  let text: String
  @Environment(\.palette) private var palette

  var body: some View {
    Text(text)
      .font(.rounded(12, .semibold))
      .padding(.horizontal, 9)
      .padding(.vertical, 3)
      .foregroundStyle(color)
      .background(color.opacity(0.14), in: Capsule())
  }

  private var color: Color {
    switch status {
    case "done": return .green
    case "running": return palette.accent
    case "failed": return .red
    default: return palette.muted
    }
  }
}

struct TaskRow: View {
  let task: AgentsTopic.Task
  @Environment(\.palette) private var palette

  var body: some View {
    Card {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 4) {
          Text(task.title).font(.rounded(16, .semibold)).foregroundStyle(palette.ink)
          Text("\(task.agent) · \(task.folder)").font(.rounded(12)).foregroundStyle(palette.muted).lineLimit(1)
        }
        Spacer()
        StatusBadge(status: task.status, text: task.statusText)
      }
      if task.status == "running" {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          HStack {
            Text(task.progress.isEmpty ? "进行中" : task.progress)
              .font(.system(size: 12, design: .monospaced))
              .foregroundStyle(palette.muted)
              .lineLimit(1)
            Spacer()
            Text(elapsed(from: task.created, to: context.date.timeIntervalSince1970 * 1000))
              .font(.system(size: 12, design: .rounded).monospacedDigit())
              .foregroundStyle(palette.muted)
          }
        }
      } else if !task.error.isEmpty {
        Text(task.error).font(.rounded(13))
          .foregroundStyle(task.status == "failed" ? Color.red : palette.muted).lineLimit(2)
      } else if !task.result.isEmpty {
        Text(task.result).font(.rounded(13)).foregroundStyle(palette.muted).lineLimit(2)
      }
    }
  }
}

func elapsed(from start: Double, to end: Double) -> String {
  let s = max(0, Int((end - start) / 1000))
  return s >= 3600
    ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
    : String(format: "%d:%02d", s / 60, s % 60)
}

struct TaskDetailView: View {
  let id: String
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette
  @State private var detail: TaskDetail?

  var body: some View {
    let task = store.agents?.tasks.first { $0.id == id }
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if let task {
          TaskRow(task: task)
          let result = detail?.result ?? task.result
          if !result.isEmpty {
            Card {
              Text("结果").font(.rounded(13, .semibold)).foregroundStyle(palette.muted)
              Text(markdown(result)).font(.rounded(15)).foregroundStyle(palette.ink).textSelection(.enabled)
            }
          }
          let changes = detail?.changes ?? task.changes
          if !changes.isEmpty {
            Card {
              Text("改动的文件（\(changes.count) 个）").font(.rounded(13, .semibold)).foregroundStyle(palette.muted)
              ForEach(changes, id: \.self) { file in
                Text(file).font(.system(size: 13, design: .monospaced)).foregroundStyle(palette.ink)
              }
            }
          }
          if let prompt = detail?.prompt {
            Card {
              Text("交给 \(task.agent) 的任务").font(.rounded(13, .semibold)).foregroundStyle(palette.muted)
              Text(prompt).font(.system(size: 13, design: .monospaced)).foregroundStyle(palette.ink)
                .textSelection(.enabled)
            }
          }
        }
      }
      .padding(16)
    }
    .background(palette.background.ignoresSafeArea())
    .navigationTitle(task?.title ?? "任务")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: "\(task?.status ?? "")-\(store.link == .online)") {
      if let value = try? await store.request("task", ["id": id]) {
        detail = decodeJSON(TaskDetail.self, value)
      }
    }
  }
}
