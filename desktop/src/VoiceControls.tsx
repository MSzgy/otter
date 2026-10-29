import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import "./types";

const PHASE: Record<string, string> = {
  recording: "正在录音，松开转写",
  permission: "正在打开麦克风…",
  transcribing: "正在转写…",
};

// Hold-to-talk for the composer: a round mic that names its phase while busy.
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
  return (
    <div className="voice-controls">
      <button
        type="button"
        className={`voice-button ${phase}`}
        aria-label="按住说话"
        title="按住说话，最多 30 秒；松开后转成文字，改好再发。第一次要先允许麦克风。"
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
        <Icon name="mic" />
        {PHASE[phase] && <span>{PHASE[phase]}</span>}
      </button>
      {speaking && (
        <button
          type="button"
          className="voice-stop"
          onClick={() => window.otter.action("voice.stop")}
        >
          停止朗读
        </button>
      )}
      {error && <small role="status">{error}</small>}
    </div>
  );
}

// Transcription model and read-aloud, kept in settings.
export function VoiceSettings() {
  const [config, setConfig] = useState({
    model: "whisper-1",
    autoSpeak: false,
  });
  const [note, setNote] = useState("");
  useEffect(() => {
    void window.otter
      .action<typeof config>("voice.settings")
      .then(setConfig)
      .catch(() => {});
  }, []);
  async function save() {
    try {
      await window.otter.action("voice.configure", config);
      setNote("语音设置已保存。");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="voice-settings">
      <h2>语音</h2>
      <p>按住麦克风说话，或者让它把回复读出来。</p>
      <label className="setting-line">
        <span>
          转写模型
          <small>录音交给当前模型服务转成文字，可能收费</small>
        </span>
        <input
          aria-label="语音转写模型"
          value={config.model}
          onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
        />
      </label>
      <label className="setting-line">
        <span>
          自动朗读新回复
          <small>用 macOS 系统声音</small>
        </span>
        <input
          type="checkbox"
          className="toggle"
          aria-label="自动朗读回复"
          checked={config.autoSpeak}
          onChange={(e) =>
            setConfig((c) => ({ ...c, autoSpeak: e.target.checked }))
          }
        />
      </label>
      <button type="button" onClick={save}>
        保存语音设置
      </button>
      {note && <p role="status">{note}</p>}
    </div>
  );
}
