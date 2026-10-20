export type Health = {
  protocol_version: number;
  provider: string;
  model: string;
  demo: boolean;
  timezone: string;
  today: string;
  yesterday: string;
  collectors: string[];
};
export type Job = {
  id: string;
  date: string;
  status: "queued" | "running" | "finished" | "failed";
  message: string;
  warnings?: string[];
};
export type Report = {
  date: string;
  content_md?: string;
  event_count: number;
  llm_provider: string;
  llm_model: string;
  generated_at: string;
};
export type Prefs = {
  quiet: boolean;
  hidden: boolean;
  config: string;
  envConfig?: boolean;
};
export type MemoryRef = {
  id: string;
  title: string;
  kind: "used" | "saved" | "removed";
};
export type ChatTurn = {
  memory_mode?: "keyword" | "semantic" | "keyword_fallback";
  id: string;
  session_id: string;
  status: string;
  content: string;
  error: string;
  model: string;
  memory_refs?: MemoryRef[];
};
export type PetSnapshot = {
  asleep: boolean;
  interactions: number;
  lastAction: string | null;
  lastAt: number;
  mood: import("./Otter").Mood;
  caption: string;
  effect: {
    id: string;
    action: string;
    mood: import("./Otter").Mood;
    caption: string;
    expiresAt: number;
  } | null;
};
export type Snapshot = {
  version?: string;
  pet: PetSnapshot;
  chat: ChatTurn | null;
  view?: string;
  health: Health | null;
  job: Job | null;
  preferences: Prefs;
  message: string;
  switching: boolean;
};
export type OtterEvent = { type: string; data: any };
declare global {
  interface Window {
    otter: {
      call<T = unknown>(
        method: string,
        params?: Record<string, unknown>,
      ): Promise<T>;
      action<T = unknown>(name: string, value?: unknown): Promise<T>;
      subscribe(callback: (event: OtterEvent) => void): () => void;
    };
  }
}
export type ProjectSource = {
  id: string;
  label: string;
  created: number;
  content: string;
  attachment: boolean;
  truncated: boolean;
  session_id: string;
  message_id: string;
  role: string;
};
export type ProjectItem = {
  id: string;
  kind: "completed" | "blocker" | "next";
  content: string;
  source_ids: string[];
  evidence?: { source_id: string; quote: string }[];
  edited?: boolean;
};
export type ProjectSnapshot = {
  id: string;
  created: number;
  items: ProjectItem[];
  sources: ProjectSource[];
};
export type ProjectInfo = {
  id: string;
  name: string;
  goal: string;
  archived: boolean;
  revision: number;
  created: number;
  updated: number;
};
export type Project = ProjectInfo & {
  links: { id: string; label: string; url: string }[];
  snapshots: ProjectSnapshot[];
};
export type ProjectDraft = {
  id: string;
  project_id: string;
  items: ProjectItem[];
  sources: ProjectSource[];
  created: number;
};
