"""Event 模型 —— 所有 Collector 归一化的统一事件类型。

设计要点(见 ../docs/ARCHITECTURE.md §5):
    - 宽表 + JSON 逃生舱:新增 source 时不用改核心 schema,source-specific
      字段进 `metadata`;只有 `refs`(跳转、聚类要用)保持结构化。
    - id 全局唯一,格式 `{source}:{source_id}`,便于跨源引用。
    - 所有 datetime 强制 tz-aware 并归一到 UTC,存 SQLite 时转 unix seconds。
    - content_hash 用于跨源去重(见 EnricherPipeline)。
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Ref(BaseModel):
    """事件关联的外部资源引用。用于跳转、聚类、脱敏。"""

    model_config = ConfigDict(extra="forbid")

    kind: str  # "repo", "pr", "issue", "commit", "url", "file", "person" ...
    id: str
    label: str | None = None


def _to_utc(v: datetime) -> datetime:
    if v.tzinfo is None:
        raise ValueError("Event datetime 必须是 timezone-aware")
    return v.astimezone(UTC)


def compute_content_hash(
    source: str,
    type_: str,
    timestamp: datetime,
    title: str,
    body: str | None,
) -> str:
    """基于关键字段计算内容指纹,用于跨源去重。"""
    h = hashlib.sha256()
    ts = timestamp.astimezone(UTC).isoformat()
    for part in (source, type_, ts, title, body or ""):
        h.update(part.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:16]


class Event(BaseModel):
    """归一化的工作事件。请通过 `Event.build(...)` 构造。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    source: str
    type: str
    timestamp: datetime
    actor: str | None = None
    title: str
    body: str | None = None
    url: str | None = None
    refs: list[Ref] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    collected_at: datetime
    content_hash: str

    @field_validator("timestamp", "collected_at")
    @classmethod
    def _ensure_utc(cls, v: datetime) -> datetime:
        return _to_utc(v)

    @classmethod
    def build(
        cls,
        *,
        source: str,
        source_id: str,
        type: str,
        timestamp: datetime,
        title: str,
        actor: str | None = None,
        body: str | None = None,
        url: str | None = None,
        refs: list[Ref] | None = None,
        metadata: dict[str, Any] | None = None,
        collected_at: datetime | None = None,
    ) -> Event:
        """构造 Event,自动生成 `id` 与 `content_hash`。"""
        ts = _to_utc(timestamp)
        return cls(
            id=f"{source}:{source_id}",
            source=source,
            type=type,
            timestamp=ts,
            actor=actor,
            title=title,
            body=body,
            url=url,
            refs=refs or [],
            metadata=metadata or {},
            collected_at=collected_at or datetime.now(UTC),
            content_hash=compute_content_hash(source, type, ts, title, body),
        )
