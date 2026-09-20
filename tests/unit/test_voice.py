import httpx
import pytest
import respx

from otter.companion.voice import transcribe
from otter.core.config import Config
from otter.core.llm import LLMError


def config():
    return Config.model_validate(
        {
            "identity": {"primary": "test@local"},
            "llm": {
                "provider": "openai",
                "openai": {"base_url": "http://localhost:9000/v1", "model": "chat"},
            },
        }
    )


@respx.mock
def test_transcription_uploads_only_managed_audio(tmp_path):
    file_id = "a" * 32
    (tmp_path / (file_id + ".webm")).write_bytes(b"webm fixture")
    route = respx.post("http://localhost:9000/v1/audio/transcriptions").mock(
        return_value=httpx.Response(200, json={"text": "转写测试"})
    )
    assert (
        transcribe(config(), tmp_path, {"file_id": file_id, "model": "whisper-1"})["text"]
        == "转写测试"
    )
    assert b"whisper-1" in route.calls.last.request.content
    assert b"webm fixture" in route.calls.last.request.content
    assert "authorization" not in route.calls.last.request.headers


def test_arbitrary_paths_and_symlinks_are_rejected(tmp_path):
    with pytest.raises(LLMError):
        transcribe(config(), tmp_path, {"file_id": "../../secret"})
    (tmp_path / "secret").write_text("private")
    (tmp_path / ("a" * 32 + ".webm")).symlink_to(tmp_path / "secret")
    with pytest.raises(LLMError):
        transcribe(config(), tmp_path, {"file_id": "a" * 32})


@respx.mock
def test_transcription_error_does_not_echo_server_body(tmp_path):
    (tmp_path / ("a" * 32 + ".webm")).write_bytes(b"fixture")
    respx.post("http://localhost:9000/v1/audio/transcriptions").mock(
        return_value=httpx.Response(401, text="secret echoed")
    )
    with pytest.raises(LLMError) as exc:
        transcribe(config(), tmp_path, {"file_id": "a" * 32})
    assert "secret" not in str(exc.value)
