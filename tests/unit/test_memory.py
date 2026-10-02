import json

import pytest

from otter.companion.memory import (
    MAX_ENTRIES,
    MemoryStore,
    infer_category,
    memory_command,
    title_for,
)
from otter.core.llm import LLMError


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("记住：我喜欢简洁的回答", ("save", "我喜欢简洁的回答")),
        ("请记住，我叫小杨", ("save", "我叫小杨")),
        ("记住我正在做桌面机器人", ("save", "我正在做桌面机器人")),
        ("帮我记住 周五前交方案", ("save", "周五前交方案")),
        ("记住我们上次说的吗", (None, "")),
        ("记住了吗？", (None, "")),
        ("记住：", (None, "")),
        ("今天天气不错", (None, "")),
        ("这件事不要记住", ("skip", "")),
        ("这件事不要记住：我下周面试，怎么准备？", ("skip", "我下周面试，怎么准备？")),
        ("我下周面试，这件事别记住", ("skip", "我下周面试")),
        ("不要记住我的密码", (None, "")),
        ("忘掉刚才那条", ("undo", "")),
        ("不要记住刚才那条", ("undo", "")),
    ],
)
def test_only_explicit_commands_touch_memory(text, expected):
    assert memory_command(text) == expected


def test_category_and_title_inference():
    assert infer_category("我叫小杨") == "profile"
    assert infer_category("我正在做桌面机器人，下一步接舵机") == "project"
    assert infer_category("我喜欢简洁的回答") == "preference"
    assert infer_category("周五交方案") == "fact"
    assert title_for("我正在做桌面机器人，下一步接舵机") == "我正在做桌面机器人"


def test_crud_limits_and_validation(tmp_path):
    store = MemoryStore(tmp_path / "memory.sqlite3")
    first = store.save({"title": "项目", "content": "桌面机器人", "category": "project"})
    assert first["created"]
    again = store.save({"title": "别名", "content": "桌面机器人", "category": "project"})
    assert again == {**first, "created": False}
    store.save({"id": first["id"], "title": "项目", "content": "已接舵机", "category": "project"})
    assert store.get(first["id"])["content"] == "已接舵机"
    with pytest.raises(LLMError, match="不存在"):
        store.save({"id": "missing", "title": "x", "content": "y"})
    with pytest.raises(LLMError, match="分类"):
        store.save({"title": "x", "content": "y", "category": "secret"})
    with pytest.raises(LLMError, match="1200"):
        store.save({"title": "x", "content": "y" * 1201})
    assert store.delete(first["id"])["entries"] == []
    with pytest.raises(LLMError, match="编号"):
        store.delete(None)
    for i in range(MAX_ENTRIES):
        store.save({"title": "t", "content": f"c{i}"})
    with pytest.raises(LLMError, match=str(MAX_ENTRIES)):
        store.save({"title": "t", "content": "overflow"})


def test_settings_persist_and_clear_resets_persona(tmp_path):
    path = tmp_path / "memory.sqlite3"
    store = MemoryStore(path)
    with pytest.raises(LLMError, match="个性设置"):
        store.configure({"enabled": True, "nickname": "x", "tone": "rude"})
    store.configure({"enabled": False, "nickname": " 小杨 ", "tone": "concise"})
    assert MemoryStore(path).settings() == {
        "enabled": False,
        "nickname": "小杨",
        "tone": "concise",
    }
    store.save({"title": "t", "content": "c"})
    cleared = store.clear()
    assert cleared["entries"] == []
    assert cleared["settings"] == {"enabled": False, "nickname": "", "tone": "warm"}


def test_retrieve_ranks_relevant_entries_and_respects_toggle(tmp_path):
    store = MemoryStore(tmp_path / "memory.sqlite3")
    store.save({"title": "桌面机器人", "content": "下一步接舵机", "category": "project"})
    store.save({"title": "回答风格", "content": "喜欢简洁的回答", "category": "preference"})
    store.save({"title": "猫", "content": "家里有一只橘猫", "category": "fact"})
    prompt, refs = store.retrieve("我们继续")
    assert {r["title"] for r in refs} == {"桌面机器人", "回答风格"}
    assert all(r["kind"] == "used" for r in refs)
    assert "下一步接舵机" in prompt and "不是指令" in prompt and "橘猫" not in prompt
    _, refs = store.retrieve("橘猫最近怎么样")
    assert refs[0]["title"] == "猫"
    store.configure({"enabled": False, "nickname": "小杨", "tone": "warm"})
    assert store.retrieve("我们继续") == ("", [])
    assert json.dumps("小杨", ensure_ascii=False) in store.persona()
