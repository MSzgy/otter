import { useEffect, useState } from "react";
import "./types";
type Shortcuts = {
  enabled: boolean;
  chat: string;
  selection: string;
  chatRegistered: boolean;
  selectionRegistered: boolean;
};
export function QuickAccessCard() {
  const [keys, setKeys] = useState<Shortcuts>({
    enabled: true,
    chat: "CommandOrControl+Shift+Space",
    selection: "CommandOrControl+Shift+E",
    chatRegistered: false,
    selectionRegistered: false,
  });
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function check() {
    try {
      const value = await window.otter.action<{ status: string }>(
        "context.permission-status",
      );
      setStatus(value.status);
    } catch {
      setStatus("unavailable");
    }
  }
  useEffect(() => {
    let active = true;
    void window.otter.action<Shortcuts>("shortcuts.get").then((v) => {
      if (active) setKeys(v);
    });
    void check();
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    setBusy(true);
    try {
      const result = await window.otter.action<Shortcuts>(
        "shortcuts.save",
        keys,
      );
      setKeys(result);
      setNotice(
        result.enabled &&
          (!result.chatRegistered || !result.selectionRegistered)
          ? "部分快捷键未注册成功，可能已被其他应用占用，请换一个组合。"
          : "快捷键设置已保存。",
      );
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  const ready = status === "ready";
  return (
    <section className="settings-section">
      <div className="setting-row">
        <div>
          <h2>快捷键</h2>
          <p>在任何应用里呼出聊天，或选中文字直接提问。</p>
        </div>
        <input
          aria-label="开启全局快捷键"
          type="checkbox"
          className="toggle"
          checked={keys.enabled}
          onChange={(e) =>
            setKeys((k) => ({ ...k, enabled: e.target.checked }))
          }
        />
      </div>
      <label className="setting-line">
        <span>呼出聊天</span>
        <input
          aria-label="聊天快捷键"
          value={keys.chat}
          onChange={(e) => setKeys((k) => ({ ...k, chat: e.target.value }))}
        />
      </label>
      <label className="setting-line">
        <span>
          选中文字提问
          <small>文字先进预览，你点发送才交给模型</small>
        </span>
        <input
          aria-label="选区快捷键"
          value={keys.selection}
          onChange={(e) =>
            setKeys((k) => ({ ...k, selection: e.target.value }))
          }
        />
      </label>
      <div className="setting-line">
        <span>
          读取选中文字
          <small>
            {ready
              ? "权限可用；受保护的输入框不会读取"
              : status === "permission_required"
                ? "需要在系统设置里允许辅助功能"
                : status === "unavailable"
                  ? "原生助手不可用，请重新构建或更新安装包"
                  : "检查中…"}
          </small>
        </span>
        {!ready && (
          <span className="button-row">
            <button onClick={() => window.otter.action("context.permissions")}>
              打开辅助功能权限
            </button>
            <button onClick={check}>重新检查权限</button>
          </span>
        )}
      </div>
      <div className="section-foot">
        <button onClick={save} disabled={busy}>
          保存快捷键
        </button>
        <small>CommandOrControl 就是 ⌘；和别的应用冲突时换一个组合。</small>
      </div>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
