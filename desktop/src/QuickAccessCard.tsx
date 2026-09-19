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
  return (
    <section className="settings-section quick-access">
      <h2>快捷呼出与选区提问</h2>
      <p>
        先在其他应用选中文字，再按选区快捷键。内容只进入可编辑预览，点击发送后才交给模型。
      </p>
      <label className="check">
        <input
          aria-label="开启全局快捷键"
          type="checkbox"
          checked={keys.enabled}
          onChange={(e) =>
            setKeys((k) => ({ ...k, enabled: e.target.checked }))
          }
        />
        开启全局快捷键
      </label>
      <label>
        呼出聊天
        <input
          aria-label="聊天快捷键"
          value={keys.chat}
          onChange={(e) => setKeys((k) => ({ ...k, chat: e.target.value }))}
        />
      </label>
      <label>
        选中文字提问
        <input
          aria-label="选区快捷键"
          value={keys.selection}
          onChange={(e) =>
            setKeys((k) => ({ ...k, selection: e.target.value }))
          }
        />
      </label>
      <p>
        Mac 上 CommandOrControl 表示 ⌘；默认分别是 ⌘⇧Space 和
        ⌘⇧E。快捷键冲突时可以更换。
      </p>
      <div className="button-row">
        <button onClick={save} disabled={busy}>
          保存快捷键
        </button>
        <button onClick={() => window.otter.action("context.permissions")}>
          打开辅助功能权限
        </button>
        <button onClick={check}>重新检查权限</button>
      </div>
      <p>
        选区读取：
        {status === "ready"
          ? "权限可用"
          : status === "permission_required"
            ? "需要系统辅助功能权限"
            : status === "unavailable"
              ? "原生助手不可用，请重新构建或更新安装包"
              : "检查中…"}
        。部分应用不提供可读选区，受保护输入框不会读取。
      </p>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
