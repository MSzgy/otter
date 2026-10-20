import { useEffect, useState } from "react";
import { ProjectCapture } from "./ProjectCapture";
import type { Project, ProjectInfo, ProjectSnapshot } from "./types";
const api = window.otter;
export function ProjectsPane({ focusId }: { focusId?: string | null }) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]),
    [project, setProject] = useState<Project | null>(null);
  const [form, setForm] = useState({
    name: "",
    goal: "",
    links: [] as { label: string; url: string }[],
  });
  const [creating, setCreating] = useState(false),
    [editing, setEditing] = useState(false);
  const [capture, setCapture] = useState<"chat" | "manual" | null>(null);
  const [todos, setTodos] = useState<
    { id: string; title: string; done: boolean; projectId?: string }[]
  >([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<string | null>(null),
    [operation, setOperation] = useState<{
      id: string;
      description: string;
    } | null>(null);
  const fail = (e: unknown) =>
    setError(
      e instanceof Error
        ? e.message.replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          )
        : String(e),
    );
  async function load(id?: string) {
    const rows = await api.call<ProjectInfo[]>("projects.list");
    setProjects(rows);
    const requested = id || project?.id || focusId;
    const target = rows.some((r) => r.id === requested)
      ? requested
      : rows.find((r) => !r.archived)?.id || rows[0]?.id;
    if (target)
      setProject(
        await api.call<Project>("projects.get", { project_id: target }),
      );
    setTodos(
      (await api.action<{ todos: typeof todos }>("assistant.get")).todos,
    );
  }
  useEffect(() => {
    void load(focusId || undefined).catch(fail);
    const off = api.subscribe((e) => {
      if (e.type === "assistant.changed") setTodos(e.data.todos);
    });
    return off;
  }, [focusId]);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function edit(value?: Project) {
    setForm(
      value
        ? {
            name: value.name,
            goal: value.goal,
            links: value.links.map(({ label, url }) => ({ label, url })),
          }
        : { name: "", goal: "", links: [] },
    );
    setCreating(!value);
    setEditing(true);
    setCapture(null);
    setOperation(null);
    setError("");
  }
  function snapshotView(snapshot: ProjectSnapshot, latest: boolean) {
    return (
      <article className="project-snapshot" key={snapshot.id}>
        <div className="section-title">
          <strong>{latest ? "最近确认的进度" : "历史进度"}</strong>
          <small>{new Date(snapshot.created * 1000).toLocaleString()}</small>
        </div>
        {(
          [
            ["completed", "已完成"],
            ["blocker", "当前卡点"],
            ["next", "下一步"],
          ] as const
        ).map(([kind, label]) => (
          <section key={kind}>
            <h3>{label}</h3>
            {snapshot.items.filter((i) => i.kind === kind).length ? (
              snapshot.items
                .filter((i) => i.kind === kind)
                .map((item) => (
                  <div className="project-fact" key={item.id}>
                    <p className="project-text">{item.content}</p>
                    {item.source_ids.length ? (
                      <details>
                        <summary>
                          {item.edited
                            ? "已由你修改确认 · 查看原始来源"
                            : "查看来源"}
                        </summary>
                        {item.source_ids.map((id) => {
                          const source = snapshot.sources.find(
                            (s) => s.id === id,
                          );
                          return (
                            source && (
                              <div key={id}>
                                <small>
                                  {source.label} ·{" "}
                                  {new Date(
                                    source.created * 1000,
                                  ).toLocaleString()}
                                  {source.truncated ? " · 摘录" : ""}
                                </small>
                                <p className="project-text">{source.content}</p>
                              </div>
                            )
                          );
                        })}
                      </details>
                    ) : (
                      <small>手动记录</small>
                    )}
                    {latest && kind === "next" && !project?.archived && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const result = await api.action<{ done: boolean }>(
                              "projects.todo",
                              { projectId: project!.id, itemId: item.id },
                            );
                            setNotice(
                              result.done
                                ? "这条下一步已经完成，无需重复添加。"
                                : "已加入本项目待办，同一条下一步不会重复添加。",
                            );
                            await load(project!.id);
                          })
                        }
                      >
                        加入待办
                      </button>
                    )}
                  </div>
                ))
            ) : (
              <p className="muted">尚未记录</p>
            )}
          </section>
        ))}
        {remove === snapshot.id ? (
          <div className="button-row">
            <span>删除这份快照？项目和待办会保留。</span>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.call("projects.delete-snapshot", {
                    project_id: project!.id,
                    snapshot_id: snapshot.id,
                    confirm: true,
                  });
                  setRemove(null);
                  await load(project!.id);
                })
              }
            >
              确认删除快照
            </button>
            <button onClick={() => setRemove(null)}>保留</button>
          </div>
        ) : (
          <button disabled={busy} onClick={() => setRemove(snapshot.id)}>
            删除快照
          </button>
        )}
      </article>
    );
  }
  return (
    <section className="projects-pane">
      <div className="heading">
        <p className="eyebrow">接上昨天的思路</p>
        <h1>每个项目，都有下一步。</h1>
        <p className="muted">保存你确认的进度，再从这里继续工作。</p>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="model-success" role="status">
          {notice}
        </div>
      )}
      <div className="section-title">
        <h2>我的项目</h2>
        <button disabled={busy || !!capture} onClick={() => edit()}>
          新建项目
        </button>
      </div>
      <div className="project-cards">
        {projects.map((p) => (
          <button
            key={p.id}
            className={project?.id === p.id && !creating ? "selected" : ""}
            aria-label={`选择项目 ${p.name}`}
            disabled={busy || !!capture}
            onClick={() =>
              run(async () => {
                setEditing(false);
                setCreating(false);
                setOperation(null);
                await load(p.id);
              })
            }
          >
            <strong>
              {p.name}
              {p.archived ? " · 已归档" : ""}
            </strong>
            <span>{p.goal || "还没有填写目标"}</span>
            <small>
              更新于 {new Date(p.updated * 1000).toLocaleDateString()}
            </small>
          </button>
        ))}
      </div>
      {!projects.length && !editing && (
        <p className="empty">
          先创建一个项目，例如“桌面机器人”，把目标和进度放在一起。
        </p>
      )}
      {editing && (
        <form
          className="project-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const value = await api.call<Project>("projects.save", {
                ...form,
                ...(creating
                  ? {}
                  : { id: project!.id, revision: project!.revision }),
              });
              setEditing(false);
              setCreating(false);
              await load(value.id);
            });
          }}
        >
          <h2>{creating ? "创建项目" : "编辑项目"}</h2>
          <label>
            项目名称
            <input
              aria-label="项目名称"
              maxLength={80}
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <label>
            项目目标
            <textarea
              aria-label="项目目标"
              maxLength={1200}
              value={form.goal}
              onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))}
            />
          </label>
          <h3>资料链接</h3>
          {form.links.map((link, index) => (
            <div className="project-link-edit" key={index}>
              <input
                aria-label={`资料名称 ${index + 1}`}
                placeholder="资料名称"
                value={link.label}
                maxLength={120}
                required
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    links: f.links.map((l, i) =>
                      i === index ? { ...l, label: e.target.value } : l,
                    ),
                  }))
                }
              />
              <input
                aria-label={`资料网址 ${index + 1}`}
                placeholder="https://…"
                value={link.url}
                maxLength={2000}
                required
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    links: f.links.map((l, i) =>
                      i === index ? { ...l, url: e.target.value } : l,
                    ),
                  }))
                }
              />
              <button
                type="button"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    links: f.links.filter((_, i) => i !== index),
                  }))
                }
              >
                移除链接
              </button>
            </div>
          ))}
          <div className="button-row">
            <button
              type="button"
              disabled={form.links.length >= 12}
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  links: [...f.links, { label: "", url: "" }],
                }))
              }
            >
              添加资料链接
            </button>
            <button
              className="primary"
              disabled={busy || !form.name.trim()}
              type="submit"
            >
              保存项目
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setCreating(false);
              }}
            >
              取消编辑
            </button>
          </div>
        </form>
      )}
      {project && !creating && !editing && (
        <>
          <section className="project-overview">
            <div className="section-title">
              <h2>{project.name}</h2>
              <button
                disabled={busy || !!capture}
                onClick={() => edit(project)}
              >
                编辑项目
              </button>
            </div>
            <p className="project-text">{project.goal || "还没有填写目标。"}</p>
            <div className="button-row">
              <button
                className="primary"
                disabled={busy || !!capture || !!project.archived}
                onClick={() =>
                  run(async () => {
                    await api.action("projects.continue", {
                      projectId: project.id,
                    });
                  })
                }
              >
                继续这个项目
              </button>
              <button
                disabled={busy || !!capture || !!project.archived}
                onClick={() => setCapture("chat")}
              >
                从聊天整理进度
              </button>
              <button
                disabled={busy || !!capture || !!project.archived}
                onClick={() => setCapture("manual")}
              >
                手动记录进度
              </button>
              <button
                disabled={busy || !!capture}
                onClick={() =>
                  run(async () => {
                    await api.call("projects.archive", {
                      project_id: project.id,
                      archived: !project.archived,
                    });
                    await load(project.id);
                  })
                }
              >
                {project.archived ? "恢复项目" : "归档项目"}
              </button>
            </div>
          </section>
          {capture && (
            <ProjectCapture
              key={project.id + capture}
              projectId={project.id}
              manual={capture === "manual"}
              onSaved={() => {
                setCapture(null);
                setNotice("进度快照已保存。");
                void load(project.id).catch(fail);
              }}
              onClose={() => setCapture(null)}
            />
          )}
          {project.snapshots[0] ? (
            snapshotView(project.snapshots[0], true)
          ) : (
            <p className="empty">
              还没有进度快照。先记录一次，水獭就能帮你接续工作。
            </p>
          )}
          <section className="project-resources">
            <h2>项目资料</h2>
            {project.links.length ? (
              project.links.map((link) => (
                <div key={link.id}>
                  <strong>{link.label}</strong>
                  <span>{link.url}</span>
                  <button
                    disabled={busy || !!operation}
                    onClick={() =>
                      run(async () =>
                        setOperation(
                          await api.action("actions.prepare", {
                            kind: "open_url",
                            target: link.url,
                          }),
                        ),
                      )
                    }
                  >
                    打开资料
                  </button>
                </div>
              ))
            ) : (
              <p className="muted">编辑项目后可以添加资料链接。</p>
            )}
            {operation && (
              <div className="context-preview">
                <strong>确认打开资料</strong>
                <p>{operation.description}</p>
                <div className="button-row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const result = await api.action<{ message: string }>(
                          "actions.confirm",
                          operation.id,
                        );
                        setNotice(result.message);
                        setOperation(null);
                      })
                    }
                  >
                    确认打开资料
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      void api.action("actions.cancel", operation.id);
                      setOperation(null);
                    }}
                  >
                    取消打开
                  </button>
                </div>
              </div>
            )}
          </section>
          <section>
            <h2>本项目待办</h2>
            {todos
              .filter((t) => t.projectId === project.id)
              .map((todo) => (
                <label className="project-todo" key={todo.id}>
                  <input
                    type="checkbox"
                    checked={todo.done}
                    disabled={busy}
                    onChange={() =>
                      run(async () => {
                        await api.action("assistant.todo-toggle", todo.id);
                        await load(project.id);
                      })
                    }
                  />
                  {todo.title}
                </label>
              ))}
            {!todos.some((t) => t.projectId === project.id) && (
              <p className="muted">可以将下面的“下一步”加入待办。</p>
            )}
          </section>
          {project.snapshots.length > 1 && (
            <details>
              <summary>
                查看历史快照（最近 {project.snapshots.length - 1} 份）
              </summary>
              {project.snapshots.slice(1).map((s) => snapshotView(s, false))}
            </details>
          )}
        </>
      )}
      <p className="chat-privacy">
        项目与快照保存在当前工作空间。选择关联项目后，其目标和最近确认的进度会用于后续聊天；可以在聊天页取消关联。保存的来源摘录会随快照保留，删除原对话不会删除这些摘录。
      </p>
    </section>
  );
}
