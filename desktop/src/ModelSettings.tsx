import { useEffect, useRef, useState } from "react";
import "./types";
type ModelInfo = {
  provider: string;
  model: string;
  base_url: string;
  has_api_key: boolean;
  max_tokens: number;
  timeout_sec: number;
  token_limit_field: string;
  overridden: boolean;
};
const defaults: ModelInfo = {
  provider: "mock",
  model: "",
  base_url: "https://api.openai.com/v1",
  has_api_key: false,
  max_tokens: 4096,
  timeout_sec: 60,
  token_limit_field: "max_tokens",
  overridden: false,
};
export function ModelSettings({
  connected,
  blocked,
}: {
  connected: boolean;
  blocked: boolean;
}) {
  const [config, setConfig] = useState(defaults);
  const [key, setKey] = useState("");
  const [useKey, setUseKey] = useState(true);
  const [pending, setPending] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function apply(value: ModelInfo) {
    setConfig(value);
    setKey("");
    setUseKey(value.has_api_key || !value.model);
  }
  useEffect(() => {
    if (!connected) return;
    let active = true;
    setLoaded(false);
    window.otter
      .call<ModelInfo>("models.get")
      .then((value) => {
        if (active) {
          apply(value);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError(String(e.message));
      });
    return () => {
      active = false;
    };
  }, [connected]);
  function update<K extends keyof ModelInfo>(name: K, value: ModelInfo[K]) {
    setConfig((c) => ({ ...c, [name]: value }));
    setNotice("");
    setError("");
  }
  async function run(kind: "test" | "save" | "reset") {
    setPending(kind);
    setError("");
    setNotice("");
    try {
      const result = await window.otter.call<ModelInfo & { message: string }>(
        `models.${kind}`,
        kind === "reset"
          ? {}
          : {
              base_url: config.base_url,
              model: config.model,
              api_key: key,
              use_api_key: useKey,
              max_tokens: config.max_tokens,
              timeout_sec: config.timeout_sec,
              token_limit_field: config.token_limit_field,
            },
      );
      if (!alive.current) return;
      if (kind === "test")
        setNotice(result.message + " 当前设置尚未自动保存。");
      else {
        apply(result);
        setNotice(
          kind === "save"
            ? "已保存并启用。下一次生成简报将使用这个模型。"
            : "已恢复原配置文件中的模型。",
        );
      }
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error
            ? e.message.replace(
                /^Error invoking remote method '[^']+': Error: /,
                "",
              )
            : String(e),
        );
    } finally {
      if (alive.current) setPending("");
    }
  }
  const disabled = blocked || !connected || !!pending || !loaded;
  return (
    <section className="settings-section model-settings" aria-label="模型配置">
      <div className="model-title">
        <h2>模型配置</h2>
        <span>OpenAI 兼容接口</span>
      </div>
      <p>
        使用 Chat Completions
        协议。设置仅应用于当前桌面工作空间，原配置文件保持不变。
      </p>
      <fieldset disabled={disabled}>
        <label>
          API Base URL
          <input
            type="url"
            aria-label="API Base URL"
            value={config.base_url}
            onChange={(e) => update("base_url", e.target.value)}
            placeholder="https://你的服务地址/v1"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <small>
          填写服务商提供的基础地址（通常以 /v1 结尾），无需重复添加
          /chat/completions。
        </small>
        <label>
          模型名称
          <input
            aria-label="模型名称"
            value={config.model}
            onChange={(e) => update("model", e.target.value)}
            placeholder="服务端提供的模型 ID"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="auth-check">
          <input
            type="checkbox"
            aria-label="使用 API Key"
            checked={useKey}
            onChange={(e) => {
              setUseKey(e.target.checked);
              setNotice("");
            }}
          />
          使用 API Key 认证
        </label>
        {useKey && (
          <label>
            API Key
            <input
              type="password"
              aria-label="API Key"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setNotice("");
              }}
              placeholder={
                config.has_api_key
                  ? "已配置；留空保留，更换服务地址需重新输入"
                  : "输入服务商提供的密钥"
              }
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>
        )}
        <small>
          {useKey
            ? "密钥存入 macOS 钥匙串，不在配置文件中明文保存，也不回显。"
            : "不发送 Authorization 头，适用于无需认证的本机服务。"}
        </small>
        <details>
          <summary>高级参数</summary>
          <div className="model-advanced">
            <label>
              最大输出长度
              <input
                type="number"
                aria-label="最大输出长度"
                min={1}
                max={131072}
                value={config.max_tokens}
                onChange={(e) => update("max_tokens", Number(e.target.value))}
              />
            </label>
            <label>
              超时（秒）
              <input
                type="number"
                aria-label="超时（秒）"
                min={1}
                max={300}
                value={config.timeout_sec}
                onChange={(e) => update("timeout_sec", Number(e.target.value))}
              />
            </label>
            <label>
              输出限制参数
              <select
                aria-label="输出限制参数"
                value={config.token_limit_field}
                onChange={(e) => update("token_limit_field", e.target.value)}
              >
                <option value="max_tokens">max_tokens（常见兼容服务）</option>
                <option value="max_completion_tokens">
                  max_completion_tokens
                </option>
              </select>
            </label>
          </div>
        </details>
      </fieldset>
      <div className="button-row">
        <button
          disabled={disabled || !config.model.trim() || !config.base_url.trim()}
          onClick={() => run("test")}
        >
          {pending === "test" ? "正在测试…" : "测试连接"}
        </button>
        <button
          className="primary"
          disabled={disabled || !config.model.trim() || !config.base_url.trim()}
          onClick={() => run("save")}
        >
          {pending === "save" ? "正在保存…" : "保存并启用"}
        </button>
        {config.overridden && (
          <button disabled={disabled} onClick={() => run("reset")}>
            恢复原模型
          </button>
        )}
      </div>
      <p className="model-hint">
        测试会发送一条固定短消息，可能产生少量费用，不包含你的工作记录。通过后请点击保存并启用。
      </p>
      {notice && (
        <div className="model-success" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
