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
export type Snapshot = {
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
