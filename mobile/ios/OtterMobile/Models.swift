import Foundation

// The topics the Mac sends (syncSources in desktop/electron/main.cjs), decoded
// from their JSON after every change. All small, so decoding is cheap.
struct StatusTopic: Decodable {
  struct Job: Decodable {
    let status: String
    let date: String?
  }
  let mac: String
  let version: String
  let online: Bool
  let message: String
  let quiet: Bool
  let theme: String
  let job: Job?
}

struct TodayTopic: Decodable {
  struct Reminder: Decodable, Identifiable {
    let id: String
    let title: String
    let kind: String?
    let dueAt: Double
  }
  struct Todo: Decodable, Identifiable {
    let id: String
    let title: String
    let done: Bool
    let createdAt: Double?
  }
  struct Focus: Decodable {
    let id: String
    let dueAt: Double
  }
  let reminders: [Reminder]
  let todos: [Todo]
  let focus: Focus?
}

struct ChatTopic: Decodable {
  struct Session: Decodable, Identifiable {
    let id: String
    let title: String
    let updated: Double
  }
  struct Turn: Decodable {
    let id: String
    let session: String
    let status: String
    let content: String
    let error: String
  }
  let sessions: [Session]
  let turn: Turn?
}

struct AgentsTopic: Decodable {
  struct Task: Decodable, Identifiable {
    let id: String
    let agent: String
    let title: String
    let status: String
    let statusText: String
    let progress: String
    let created: Double
    let ended: Double?
    let folder: String
    let access: String
    let result: String
    let changes: [String]
    let error: String
  }
  let tasks: [Task]
}

struct OtterTopic: Decodable {
  struct Body: Decodable {
    let enabled: Bool
    let status: String
    let message: String
  }
  let mood: String
  let caption: String
  let asleep: Bool
  let body: Body
}

struct ChatMessage: Decodable, Identifiable {
  let id: String
  let role: String
  let content: String
  let status: String
  let agent: String
}

struct TaskDetail: Decodable {
  let prompt: String
  let result: String
  let changes: [String]
}

func decodeJSON<T: Decodable>(_ type: T.Type, _ value: Any?) -> T? {
  guard let value, !(value is NSNull),
    let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
  else { return nil }
  return try? JSONDecoder().decode(type, from: data)
}
