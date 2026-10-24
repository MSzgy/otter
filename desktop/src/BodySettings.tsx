import { useEffect, useState } from "react";
import "./types";

type BodyState = {
  enabled: boolean;
  status: "off" | "searching" | "handshake" | "connected" | "unavailable";
  message: string;
  device: { path: string; firmware: string; skin: string } | null;
  expression: string;
};

const STATUS: Record<BodyState["status"], string> = {
  off: "未开启",
  searching: "正在寻找",
  handshake: "正在连接",
  connected: "已连接",
  unavailable: "不可用",
};

// The physical otter is optional hardware; this section only switches the bridge
// on or off and shows its status. Without the device the app works as before.
export function BodySettings() {
  const [state, setState] = useState<BodyState | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void window.otter.action<BodyState>("body.get").then((s) => {
      if (active) setState(s);
    });
    const unsubscribe = window.otter.subscribe((event) => {
      if (event.type === "body.changed") setState(event.data as BodyState);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  async function toggle(enabled: boolean) {
    try {
      setState(
        await window.otter.action<BodyState>("body.configure", { enabled }),
      );
      setMessage("");
    } catch (e) {
      setMessage(String(e));
    }
  }
  if (!state) return null;
  return (
    <section className="settings-section quick-access">
      <h2>实体水獭</h2>
      <p>
        用 USB 连接 ESP32
        水獭后，它会跟着桌面状态换表情：聊天时思考、朗读时说话、生成简报时忙碌、提醒到点时摇铃。没有设备时不影响任何功能。
      </p>
      <label className="check">
        <input
          aria-label="连接实体水獭"
          type="checkbox"
          checked={state.enabled}
          onChange={(e) => void toggle(e.target.checked)}
        />
        连接实体水獭
      </label>
      <p role="status">
        {STATUS[state.status]}
        {state.message && state.message !== STATUS[state.status]
          ? ` · ${state.message}`
          : ""}
        {state.status === "connected" ? ` · 当前表情：${state.expression}` : ""}
      </p>
      <p>
        只把表情名称和提醒铃声发给设备，不发送聊天、提醒内容或记忆。点一下设备屏幕：有到点提醒时等于“知道了”，否则等于摸摸头；不会完成或删除任务。
      </p>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
