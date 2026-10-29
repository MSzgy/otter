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
    <section className="settings-section">
      <div className="setting-row">
        <div>
          <h2>主动陪伴</h2>
          <p>偶尔根据你在做的事回应一句或做个动作，不调用模型。</p>
        </div>
        <input
          aria-label="开启主动陪伴"
          type="checkbox"
          className="toggle"
          checked={config.enabled}
          onChange={(e) =>
            setConfig((c) => ({ ...c, enabled: e.target.checked }))
          }
        />
      </div>
      <label className="setting-line">
        <span>最短间隔</span>
        <span className="unit-field">
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
          分钟
        </span>
      </label>
      <label className="setting-line">
        <span>每天最多</span>
        <span className="unit-field">
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
          次
        </span>
      </label>
      <div className="section-foot">
        <button onClick={save}>保存陪伴设置</button>
        <small>
          安静模式、专注、聊天回复和水獭睡觉时不打扰；编程场景要先开应用感知。
        </small>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
