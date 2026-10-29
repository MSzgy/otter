import { useEffect, useRef, useState, type ReactNode } from "react";

export type SettingsSection =
  "general" | "model" | "tools" | "privacy" | "handoff" | "body" | "workspace";

// Everything set once and then left alone lives here, out of the main places.
// All groups sit in one scrolling column; the list on the left jumps to a group
// and follows the scroll, so nothing hides behind a second level of tabs.
export function SettingsSheet({
  section,
  sections,
  alert,
  onClose,
}: {
  section: SettingsSection;
  sections: {
    id: SettingsSection;
    label: string;
    badge?: number;
    content: ReactNode;
  }[];
  alert?: ReactNode;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [current, setCurrent] = useState(section);
  function jump(id: SettingsSection, smooth = true) {
    setCurrent(id);
    body.current?.querySelector(`#settings-${id}`)?.scrollIntoView({
      block: "start",
      behavior: smooth ? "smooth" : "auto",
    });
  }
  useEffect(() => {
    jump(section, false);
    close.current?.focus();
  }, [section]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  // The highlighted group is the last one whose top has scrolled past the top.
  function follow() {
    const el = body.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + 48;
    let seen = sections[0].id;
    for (const s of sections) {
      const node = el.querySelector(`#settings-${s.id}`);
      if (node && node.getBoundingClientRect().top <= top) seen = s.id;
    }
    setCurrent(seen);
  }
  return (
    <div
      className="settings-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <aside>
          <h2>设置</h2>
          <nav aria-label="设置分组">
            {sections.map((s) => (
              <button
                key={s.id}
                className={current === s.id ? "active" : ""}
                onClick={() => jump(s.id)}
              >
                {s.label}
                {!!s.badge && (
                  <em className="nav-badge" aria-label={`${s.badge} 个待批准`}>
                    {s.badge}
                  </em>
                )}
              </button>
            ))}
          </nav>
        </aside>
        <div className="settings-body" ref={body} onScroll={follow}>
          {alert}
          {sections.map((s) => (
            <section
              key={s.id}
              id={`settings-${s.id}`}
              className="settings-group"
              aria-label={s.label}
            >
              <h2 className="group-title">{s.label}</h2>
              {s.content}
            </section>
          ))}
        </div>
        <button
          ref={close}
          className="settings-close"
          aria-label="关闭设置"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  );
}
