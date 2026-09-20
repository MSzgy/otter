import { useEffect, useRef, useState } from "react";
import "./types";
export function VoiceControls({
  enabled,
  onText,
}: {
  enabled: boolean;
  onText: (text: string) => void;
}) {
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [config, setConfig] = useState({
    model: "whisper-1",
    autoSpeak: false,
  });
  const wanted = useRef(false),
    discard = useRef(false),
    alive = useRef(true);
  const recorder = useRef<MediaRecorder | null>(null);
  const media = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    const off = window.otter.subscribe((e) => {
      if (e.type === "voice.activity") {
        setSpeaking(e.data.speaking);
        if (e.data.error) setError(e.data.error);
      }
    });
    void window.otter.action<typeof config>("voice.settings").then(setConfig);
    return () => {
      alive.current = false;
      wanted.current = false;
      discard.current = true;
      clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      media.current?.getTracks().forEach((t) => t.stop());
      void window.otter.action("voice.stop");
      off();
    };
  }, []);
  function release() {
    wanted.current = false;
    if (recorder.current?.state === "recording") recorder.current.stop();
  }
  async function start() {
    if (!enabled || phase !== "idle") return;
    wanted.current = true;
    discard.current = false;
    setPhase("permission");
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      media.current = stream;
      if (!wanted.current || !alive.current) {
        stream.getTracks().forEach((t) => t.stop());
        if (alive.current) setPhase("idle");
        return;
      }
      if (!MediaRecorder.isTypeSupported("audio/webm"))
        throw new Error("当前环境不支持 WebM 录音。");
      const r = new MediaRecorder(stream, {
        mimeType: "audio/webm",
        audioBitsPerSecond: 32000,
      });
      recorder.current = r;
      const chunks: Blob[] = [];
      const began = Date.now();
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      r.onerror = () => {
        discard.current = true;
        stream.getTracks().forEach((t) => t.stop());
        if (alive.current) {
          setPhase("idle");
          setError("录音失败，请检查麦克风。");
        }
      };
      r.onstop = async () => {
        clearTimeout(timer.current);
        stream.getTracks().forEach((t) => t.stop());
        recorder.current = null;
        if (discard.current || !alive.current) return;
        if (Date.now() - began < 250) {
          setPhase("idle");
          setError("录音太短，请按住说话后再松开。");
          return;
        }
        setPhase("transcribing");
        try {
          const blob = new Blob(chunks, { type: "audio/webm" });
          if (blob.size > 2 * 1024 * 1024)
            throw new Error("录音超过 2 MB，请缩短。");
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (!alive.current) return;
          const result = await window.otter.action<{ text: string }>(
            "voice.transcribe",
            bytes,
          );
          if (alive.current) onText(result.text);
        } catch (e) {
          if (alive.current)
            setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (alive.current) setPhase("idle");
        }
      };
      r.start();
      setPhase("recording");
      timer.current = setTimeout(release, 30000);
    } catch (e) {
      media.current?.getTracks().forEach((t) => t.stop());
      if (alive.current) {
        setPhase("idle");
        setError(
          e instanceof Error ? e.message : "麦克风不可用，请检查系统权限。",
        );
      }
    }
  }
  async function save() {
    try {
      await window.otter.action("voice.configure", config);
      setError("语音设置已保存。");
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="voice-controls">
      <div className="button-row">
        <button
          type="button"
          aria-label="按住说话"
          disabled={!enabled || phase === "transcribing"}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            void start();
          }}
          onPointerUp={release}
          onPointerCancel={() => {
            discard.current = true;
            release();
            setPhase("idle");
          }}
          onKeyDown={(e) => {
            if (e.code === "Space" && !e.repeat) {
              e.preventDefault();
              void start();
            }
          }}
          onKeyUp={(e) => {
            if (e.code === "Space") {
              e.preventDefault();
              release();
            }
          }}
        >
          {phase === "recording"
            ? "正在录音，松开转写"
            : phase === "permission"
              ? "正在打开麦克风…"
              : phase === "transcribing"
                ? "正在转写…"
                : "按住说话"}
        </button>
        <button
          type="button"
          disabled={!speaking}
          onClick={() => window.otter.action("voice.stop")}
        >
          停止朗读
        </button>
      </div>
      <small>最多 30 秒，转写后可编辑再发送。首次授权后请重新按住录音。</small>
      <details>
        <summary>语音设置</summary>
        <label>
          转写模型
          <input
            aria-label="语音转写模型"
            value={config.model}
            onChange={(e) =>
              setConfig((c) => ({ ...c, model: e.target.value }))
            }
          />
        </label>
        <label>
          <input
            aria-label="自动朗读回复"
            type="checkbox"
            checked={config.autoSpeak}
            onChange={(e) =>
              setConfig((c) => ({ ...c, autoSpeak: e.target.checked }))
            }
          />
          自动朗读新回复
        </label>
        <button type="button" onClick={save}>
          保存语音设置
        </button>
        <p>
          录音发送到当前 OpenAI
          兼容服务的音频转写接口，可能收费；服务需支持所填转写模型。朗读使用
          macOS 系统声音。
        </p>
      </details>
      {error && <p role="status">{error}</p>}
    </div>
  );
}
