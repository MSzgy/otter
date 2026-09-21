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
export type ChatTurn = {
  id: string;
  session_id: string;
  status: string;
  content: string;
  error: string;
  model: string;
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
