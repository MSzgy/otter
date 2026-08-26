-- 001_initial.sql · Otter 初始 schema
-- 见 docs/ARCHITECTURE.md §6:宽表 + JSON 逃生舱,新数据源不用建新表。

CREATE TABLE IF NOT EXISTS events (
    id             TEXT PRIMARY KEY,           -- "{source}:{source_id}"
    source         TEXT NOT NULL,
    type           TEXT NOT NULL,
    timestamp      INTEGER NOT NULL,           -- unix seconds UTC
    actor          TEXT,
    title          TEXT NOT NULL,
    body           TEXT,
    url            TEXT,
    refs_json      TEXT NOT NULL DEFAULT '[]',
    metadata_json  TEXT NOT NULL DEFAULT '{}',
    collected_at   INTEGER NOT NULL,
    content_hash   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_src_ts ON events(source, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_hash   ON events(content_hash);

CREATE TABLE IF NOT EXISTS collector_state (
    source        TEXT PRIMARY KEY,
    last_run_at   INTEGER,
    last_cursor   TEXT,
    last_error    TEXT,
    last_ok_at    INTEGER
);

CREATE TABLE IF NOT EXISTS reports (
    date               TEXT PRIMARY KEY,       -- YYYY-MM-DD (本地日)
    content_md         TEXT NOT NULL,
    llm_provider       TEXT,
    llm_model          TEXT,
    generated_at       INTEGER NOT NULL,
    event_count        INTEGER NOT NULL DEFAULT 0,
    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    trace_path         TEXT
);

CREATE TABLE IF NOT EXISTS llm_traces (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    provider      TEXT,
    model         TEXT,
    prompt_hash   TEXT,
    prompt        TEXT,
    response      TEXT,
    duration_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_llm_traces_ts ON llm_traces(ts);
