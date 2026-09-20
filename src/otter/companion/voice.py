"""Transcribe only a main-process-created temporary recording; never arbitrary files."""

import re
from pathlib import Path

import httpx

from otter.core.keychain import DefaultSecretResolver
from otter.core.llm import LLMError
from otter.llm.openai_compatible import OpenAICompatibleProvider


def transcribe(config, audio_dir: Path | None, params):
    file_id = params.get("file_id", "")
    model = params.get("model", "whisper-1")
    if not audio_dir or not isinstance(file_id, str) or not re.fullmatch(r"[0-9a-f]{32}", file_id):
        raise LLMError("录音标识无效。")
    if not isinstance(model, str) or not model.strip() or len(model) > 200:
        raise LLMError("请填写语音转写模型名称。")
    path = audio_dir / (file_id + ".webm")
    if path.is_symlink() or not path.is_file() or not 1 <= path.stat().st_size <= 2 * 1024 * 1024:
        raise LLMError("录音为空、过大或已清理，请重录。")
    if config.llm.provider != "openai":
        raise LLMError("语音转写需要配置 OpenAI 兼容服务及其音频转写模型。")
    provider = OpenAICompatibleProvider(
        config=config.llm.provider_config(), resolver=DefaultSecretResolver()
    )
    headers = {"Authorization": f"Bearer {provider.api_key}"} if provider.api_key else {}
    try:
        with path.open("rb") as audio, httpx.Client(timeout=45, follow_redirects=False) as client:
            response = client.post(
                provider.base_url + "/audio/transcriptions",
                headers=headers,
                data={"model": model.strip(), "response_format": "json"},
                files={"file": ("recording.webm", audio, "audio/webm")},
            )
        if response.status_code != 200:
            raise LLMError(
                f"语音转写 HTTP {response.status_code}，请检查服务是否支持音频转写及模型配置。"
            )
        text = response.json().get("text")
        if not isinstance(text, str) or not text.strip():
            raise LLMError("没有识别到文字，请重录。")
        return {"text": text[:6000], "truncated": len(text) > 6000}
    except httpx.TimeoutException:
        raise LLMError("语音转写超时，请重试。") from None
    except (httpx.HTTPError, ValueError, AttributeError):
        raise LLMError("语音服务不可用或返回格式不兼容。") from None
