import { useEffect, useState } from "react";
import "./types";
export function AmbientSettings() {
  const [config, setConfig] = useState({
    enabled: false,
    cooldownMinutes: 15,
    dailyLimit: 6,
  });
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void window.otter
      .action<{ config: typeof config }>("ambient.get")
      .then((s) => {
        if (active) setConfig(s.config);
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    try {
      await window.otter.action("ambient.configure", config);
      setMessage("陪伴设置已保存。");
    } catch (e) {
      setMessage(String(e));
    }
  }
  return (
    <section className="settings-section quick-access">
      <h2>主动陪伴</h2>
      <p>
        根据编程场景、简报完成和专注结束，偶尔给你一句回应或一个动作。不调用模型，不主动说话。
      </p>
      <label className="check">
        <input
          aria-label="开启主动陪伴"
          type="checkbox"
          checked={config.enabled}
          onChange={(e) =>
            setConfig((c) => ({ ...c, enabled: e.target.checked }))
          }
        />
        开启主动陪伴
      </label>
      <label>
        最短间隔（分钟）
        <input
          aria-label="陪伴间隔"
          type="number"
          min={1}
          max={120}
          value={config.cooldownMinutes}
          onChange={(e) =>
            setConfig((c) => ({
              ...c,
              cooldownMinutes: Number(e.target.value),
            }))
          }
        />
      </label>
      <label>
        每日最多次数
        <input
          aria-label="陪伴每日上限"
          type="number"
          min={1}
          max={30}
          value={config.dailyLimit}
          onChange={(e) =>
            setConfig((c) => ({ ...c, dailyLimit: Number(e.target.value) }))
          }
        />
      </label>
      <button onClick={save}>保存陪伴设置</button>
      <p>
        安静模式、专注中、聊天回复中、手动动作中和水獭睡眠时不会触发。编程场景需要开启应用感知。
      </p>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
