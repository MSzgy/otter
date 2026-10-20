"""Evaluate the configured desktop model on synthetic data without executing actions.

Only model settings are read. User conversations, memories and tasks are never opened.
Credentials stay in the resolver; reports contain no endpoint or credential values.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import statistics
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from otter.companion.chat import openai_stream
from otter.companion.project_ai import ProjectAI
from otter.companion.tasks import TaskPlanner
from otter.core.config import LLMCfg
from otter.core.keychain import DefaultSecretResolver


def settings():
    base = Path.home() / "Library/Application Support/otter-desktop"
    prefs = json.loads((base / "desktop.json").read_text())
    selected = prefs.get("selection") or {
        "config": str(base / "demo/config.toml"),
        "root": str(base / "demo"),
    }
    identity = json.dumps(
        [selected["config"], selected["root"]], ensure_ascii=False, separators=(",", ":")
    )
    file = base / "models" / (hashlib.sha256(identity.encode()).hexdigest() + ".json")
    llm = LLMCfg.model_validate(json.loads(file.read_text()))
    if llm.provider != "openai":
        raise RuntimeError("No configured compatible model")
    return llm


async def evaluate(output):
    llm, resolver = settings(), DefaultSecretResolver()
    planner, summarizer = TaskPlanner(openai_stream, resolver), ProjectAI(openai_stream, resolver)
    now = datetime.now(ZoneInfo("Asia/Shanghai")).replace(microsecond=0)
    stamp = now.timestamp() * 1000
    tomorrow = (now + timedelta(days=1)).replace(hour=10, minute=0, second=0).timestamp() * 1000
    state = {
        "reminders": [
            {"id": "r-review", "title": "测试评审", "dueAt": stamp + 7200000, "status": "pending"}
        ],
        "todos": [{"id": "t-port", "title": "检查串口连接", "done": False}],
        "recent_target": {"id": "r-review", "kind": "reminder"},
        "projects": [
            {"id": "p-otter", "name": "桌面机器人", "links": [{"id": "l-doc", "label": "项目文档"}]}
        ],
        "current_project": "p-otter",
    }
    cases = [
        ("半小时后叫我喝水", "reminder_create", {"dueAt": stamp + 1800000}),
        ("明天上午十点提醒我检查机器人", "reminder_create", {"dueAt": tomorrow}),
        ("昨天早上八点提醒我开会", "clarify", {}),
        ("过会儿提醒我一下", "clarify", {}),
        ("每天早上八点提醒我喝水", "clarify", {}),
        (
            "把测试评审的提醒往后推半小时",
            "reminder_update",
            {"id": "r-review", "dueAt": stamp + 9000000},
        ),
        ("取消测试评审的提醒", "reminder_cancel", {"id": "r-review"}),
        ("今天有哪些提醒", "reminder_list", {"date": now.date().isoformat()}),
        ("记一条待办：检查串口连接", "todo_add", {}),
        ("串口连接已经检查好了，把那个待办标为完成", "todo_complete", {"id": "t-port"}),
        ("有哪些未完成的待办", "todo_list", {"status": "active"}),
        ("帮我把计算器打开", "open_app", {"target": "com.apple.calculator"}),
        ("打开 https://example.com/project", "open_url", {"target": "https://example.com/project"}),
        ("帮我删除桌面上所有文件", "clarify", {}),
        ("帮我解释这句话：明天上午十点提醒我开会", "none", {}),
        ("今天有点累", "none", {}),
        ("继续做桌面机器人", "project_resume", {"project_id": "p-otter"}),
        ("这个项目今天先做到这里，整理一下进度", "project_capture", {"project_id": "p-otter"}),
        ("把项目下一步放进待办", "project_todo", {"project_id": "p-otter"}),
        ("回到桌面机器人的工作页面", "project_open", {"project_id": "p-otter", "link_id": "l-doc"}),
    ]
    rows = []
    for index, (query, expected, fields) in enumerate(cases):
        start = time.monotonic()
        try:
            result = await planner.plan(llm, query, state, [], stamp, "Asia/Shanghai")
            passed = result.get("kind") == expected and all(
                result.get(k) == v for k, v in fields.items()
            )
            row = {
                "case": index + 1,
                "input": query,
                "expected": expected,
                "actual": result.get("kind"),
                "passed": passed,
                "field_match": all(result.get(k) == v for k, v in fields.items()),
            }
        except Exception as e:
            row = {
                "case": index + 1,
                "input": query,
                "expected": expected,
                "actual": "error",
                "passed": False,
                "error_type": type(e).__name__,
            }
        row["latency_ms"] = round((time.monotonic() - start) * 1000)
        rows.append(row)
        print(
            f"Case {index + 1}/{len(cases)}: {'PASS' if row['passed'] else 'FAIL'} "
            f"({row['latency_ms']} ms)",
            flush=True,
        )
        # Stop early when the service is unavailable; do not spend repeated calls on an outage.
        if len(rows) >= 3 and all(r["actual"] == "error" for r in rows[-3:]):
            break
    summary_rows = []
    if any(r["actual"] != "error" for r in rows):
        for label, sources, expected_kinds in [
            (
                "explicit_progress",
                [
                    {
                        "id": "s-user",
                        "role": "user",
                        "content": "串口通信已经验证通过。现在卡在舵机抖动问题。"
                        "下一步是调整舵机供电。",
                    }
                ],
                {"completed", "blocker", "next"},
            ),
            (
                "proposal_is_not_completion",
                [
                    {
                        "id": "s-assistant",
                        "role": "assistant",
                        "content": "建议下一步实现语音唤醒，再测试识别效果。",
                    },
                    {
                        "id": "s-user",
                        "role": "user",
                        "content": "这只是计划，还没有开始实现。下一步先研究语音方案。",
                    },
                ],
                {"next"},
            ),
        ]:
            start = time.monotonic()
            try:
                items = await summarizer.summarize(
                    llm, {"name": "桌面机器人", "goal": "先完成软件端，再连接硬件"}, sources
                )
                kinds = {i["kind"] for i in items}
                passed = expected_kinds <= kinds and (
                    label != "proposal_is_not_completion" or "completed" not in kinds
                )
                row = {"case": label, "passed": passed, "kinds": sorted(kinds)}
            except Exception as e:
                row = {"case": label, "passed": False, "error_type": type(e).__name__}
            row["latency_ms"] = round((time.monotonic() - start) * 1000)
            summary_rows.append(row)
            print(f"Snapshot {label}: {'PASS' if row['passed'] else 'FAIL'}", flush=True)
    latencies = sorted(r["latency_ms"] for r in rows)
    report = {
        "tested_at": now.isoformat(),
        "model": llm.provider_config().get("model"),
        "synthetic_data_only": True,
        "actions_executed": False,
        "task_cases": rows,
        "snapshot_cases": summary_rows,
        "passed": sum(r["passed"] for r in rows + summary_rows),
        "total": len(rows) + len(summary_rows),
        "task_median_ms": round(statistics.median(latencies)),
        "task_max_ms": max(latencies),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(
        f"Result: {report['passed']}/{report['total']}; "
        f"median {report['task_median_ms']} ms; max {report['task_max_ms']} ms",
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(evaluate(args.output))
