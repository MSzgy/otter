// The Skill card in 工具与扩展: skills grouped by where they come from (自带,
// Otter's own folder, and other tools' folders read in place), a switch for
// each other tool's folder and one for each skill.
export type Skills = {
  dir: string;
  sources: {
    id: string;
    label: string;
    dir: string;
    fixed: boolean;
    exists: boolean;
    enabled: boolean;
    count: number;
  }[];
  items: {
    name: string;
    description: string;
    folder: string;
    source: string;
    alsoIn: string[];
    builtin?: boolean;
    enabled: boolean;
    active: boolean;
  }[];
  problems: { source?: string; folder: string; message: string }[];
};

const home = (dir: string) => dir.replace(/^\/Users\/[^/]+/, "~");

export function SkillsCard({
  skills,
  onChange,
  run,
}: {
  skills: Skills;
  onChange: (next: Skills) => void;
  run: <T>(name: string, value?: unknown) => Promise<T | null>;
}) {
  // Switches flip at once and settle on the answer.
  async function change(name: string, value: unknown, optimistic: Skills) {
    onChange(optimistic);
    const next = await run<Skills>(name, value);
    if (next) onChange(next);
    else {
      const fresh = await run<Skills>("skills.rescan");
      if (fresh) onChange(fresh);
    }
  }
  const groups = skills.sources.filter(
    (s) => s.fixed || s.exists || s.count > 0,
  );
  const outside = skills.problems.filter(
    (p) => p.source && !["builtin", "otter"].includes(p.source),
  );
  return (
    <section className="settings-section skill-section" aria-label="Skill">
      <h2>Skill</h2>
      <p>
        skill 是写着“什么时候用、怎么做”的文件夹，和 Claude 的 Agent Skills
        同一格式。水獭需要时会读；里面的脚本不会运行。Codex、Claude Code
        和共享文件夹里的 skill 会自动出现，原地读取，不复制也不修改。
      </p>
      {groups.map((source) => {
        const items = skills.items.filter((i) => i.source === source.id);
        const on = items.filter((i) => i.active).length;
        return (
          <div
            key={source.id}
            className={`skill-source${source.enabled ? "" : " off"}`}
            aria-label={`${source.label} 的 skill`}
          >
            <div className="setting-line">
              <span>
                <strong>{source.label}</strong>
                <small>
                  {source.fixed && source.id === "builtin"
                    ? "随 Otter 一起安装"
                    : home(source.dir)}
                  {" · "}
                  {items.length
                    ? `${items.length} 个，启用 ${on} 个`
                    : source.exists
                      ? "还没有"
                      : "文件夹不存在"}
                </small>
              </span>
              {!source.fixed && (
                <input
                  type="checkbox"
                  className="toggle"
                  aria-label={`使用 ${source.label} 的 skill`}
                  checked={source.enabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    void change(
                      "skills.source",
                      { id: source.id, enabled },
                      {
                        ...skills,
                        sources: skills.sources.map((s) =>
                          s.id === source.id ? { ...s, enabled } : s,
                        ),
                      },
                    );
                  }}
                />
              )}
            </div>
            {!!items.length && (
              <details className="settings-more" open={source.fixed}>
                <summary>
                  {source.fixed ? "查看" : `查看这 ${items.length} 个`}
                </summary>
                {items.map((k) => (
                  <label
                    className={`setting-line${k.active ? "" : " muted-line"}`}
                    key={k.name}
                  >
                    <span>
                      {k.name}
                      {k.builtin && <em className="tag">自带</em>}
                      <small>
                        {k.description}
                        {k.alsoIn.length
                          ? `（也在 ${k.alsoIn.join("、")}）`
                          : ""}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      className="toggle"
                      aria-label={`启用 skill ${k.name}`}
                      checked={k.enabled}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        void change(
                          "skills.toggle",
                          { name: k.name, enabled },
                          {
                            ...skills,
                            items: skills.items.map((x) =>
                              x.name === k.name ? { ...x, enabled } : x,
                            ),
                          },
                        );
                      }}
                    />
                  </label>
                ))}
              </details>
            )}
            {source.id === "otter" && !items.length && (
              <p className="card-empty">
                还没有自己的 skill。把 skill 放进 skill 文件夹，或者导入一个。
              </p>
            )}
            {skills.problems
              .filter((p) => (p.source || "otter") === source.id)
              .filter(() => source.fixed)
              .map((p) => (
                <p className="skill-problem" key={p.folder}>
                  {p.folder}：{p.message}
                </p>
              ))}
          </div>
        );
      })}
      {!!outside.length && (
        <details className="settings-more">
          <summary>有 {outside.length} 个 skill 读不出来</summary>
          {outside.map((p) => (
            <p className="skill-problem" key={`${p.source}/${p.folder}`}>
              {skills.sources.find((s) => s.id === p.source)?.label} ·{" "}
              {p.folder}：{p.message}
            </p>
          ))}
        </details>
      )}
      <div className="section-foot">
        <button onClick={() => void run("skills.open")}>
          打开 skill 文件夹
        </button>
        <button
          onClick={async () => {
            const next = await run<Skills>("skills.import");
            if (next) onChange(next);
          }}
        >
          导入文件夹…
        </button>
        <button
          className="chat-link"
          onClick={async () => {
            const next = await run<Skills>("skills.rescan");
            if (next) onChange(next);
          }}
        >
          重新扫描
        </button>
      </div>
    </section>
  );
}
