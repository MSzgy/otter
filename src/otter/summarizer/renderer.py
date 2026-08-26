"""Prompt Renderer —— 把 Event 列表 + 元信息渲染成 system / user 两个 prompt。

设计要点(见 docs/ARCHITECTURE.md §8):
    - 输出两段:system(角色 / 输出规范)+ user(事件数据)。分开传给 LLM
      Provider,与 Anthropic Messages API 的 `system` / `messages` 结构一致,
      OpenAI 兼容后端可以在 Provider 侧合并为 `messages[0]`。
    - 模板文件可覆盖:默认走 `otter.summarizer.prompts` 包内的 daily.*.md.j2,
      config [prompts] 里指向自定义路径时改从磁盘加载。
    - 事件先做**呈现层归一化**:合成 `local_time`、把 refs 折成一行、body
      截断 —— 模板只做拼装,不做逻辑判断。
    - Body 截断上限走配置(`body_maxlen`),防止 LLM 上下文被单条巨型
      commit message 撑爆。
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from importlib.resources import files
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from jinja2 import Environment, StrictUndefined, Template

from otter.core.event import Event

_WEEKDAYS_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


class RenderError(Exception):
    """模板缺失、渲染错误。"""


@dataclass
class RenderedPrompt:
    """渲染好的 prompt 对。"""

    system: str
    user: str

    def combined_char_count(self) -> int:
        """粗估 token 上限的替代品(汉字/英文一视同仁按字符算)。"""
        return len(self.system) + len(self.user)


class Renderer:
    """Jinja2 驱动的 Prompt 渲染器。"""

    def __init__(
        self,
        *,
        config: dict[str, Any] | None = None,
        project_root: Path | None = None,
    ) -> None:
        cfg = config or {}
        self._project_root = project_root or Path.cwd()
        self._body_maxlen: int = int(cfg.get("body_maxlen", 400))
        self._per_event_refs_max: int = int(cfg.get("refs_per_event_max", 4))
        self._daily_system_path: str | None = cfg.get("daily_system")
        self._daily_user_path: str | None = cfg.get("daily_user")

        self._env = Environment(
            autoescape=False,
            undefined=StrictUndefined,
            trim_blocks=True,
            lstrip_blocks=True,
            keep_trailing_newline=False,
        )

    # ────────── 公开入口 ──────────

    def render_daily(
        self,
        *,
        date: str,
        timezone: str,
        identity: str,
        since: datetime,
        until: datetime,
        events: list[Event],
    ) -> RenderedPrompt:
        """渲染日报 prompt。events 应已按 [since, until) 过滤,顺序不重要。"""
        try:
            tz = ZoneInfo(timezone)
        except Exception as e:
            raise RenderError(f"未知的时区 {timezone!r}") from e

        system_tmpl = self._load_template("daily.system.md.j2", self._daily_system_path)
        user_tmpl = self._load_template("daily.user.md.j2", self._daily_user_path)

        group_blocks = self._group_and_format(events, tz, identity)
        weekday = _WEEKDAYS_ZH[
            datetime.fromisoformat(date).weekday()
        ]
        ctx = {
            "date": date,
            "weekday": weekday,
            "timezone": timezone,
            "window_start": since.astimezone(tz).strftime("%Y-%m-%d %H:%M"),
            "window_end": until.astimezone(tz).strftime("%Y-%m-%d %H:%M"),
            "identity": identity,
            "event_count": len(events),
            "group_blocks": group_blocks,
        }
        system = system_tmpl.render(identity=identity).strip()
        user = user_tmpl.render(**ctx).strip()
        return RenderedPrompt(system=system, user=user)

    # ────────── 内部 ──────────

    def _load_template(self, package_name: str, override_path: str | None) -> Template:
        """override_path 优先(相对路径基于 project_root),没配就用包内模板。"""
        if override_path:
            p = Path(override_path).expanduser()
            if not p.is_absolute():
                p = self._project_root / p
            if not p.exists():
                raise RenderError(f"prompt 模板不存在:{p}")
            src = p.read_text(encoding="utf-8")
        else:
            try:
                src = files("otter.summarizer.prompts").joinpath(
                    package_name
                ).read_text(encoding="utf-8")
            except FileNotFoundError as e:
                raise RenderError(f"内置模板缺失:{package_name}") from e
        return self._env.from_string(src)

    def _group_and_format(
        self, events: list[Event], tz: ZoneInfo, identity: str
    ) -> list[str]:
        """按 source 分组,每组渲染为一整段字符串(header + 若干事件行)。"""
        buckets: dict[str, list[tuple[datetime, str]]] = defaultdict(list)
        for e in events:
            local = e.timestamp.astimezone(tz)
            buckets[e.source].append((local, self._format_event_line(e, local, identity)))

        blocks: list[str] = []
        for src in sorted(buckets.keys()):
            arr = sorted(buckets[src], key=lambda x: x[0])
            lines = [f"## 来源:{src}({len(arr)} 条)", ""]
            lines.extend(line for _, line in arr)
            blocks.append("\n".join(lines))
        return blocks

    def _format_event_line(
        self, e: Event, local: datetime, identity: str
    ) -> str:
        """一个事件渲染为 1~2 行(主行 + 可选 body 引用)。"""
        parts: list[str] = [
            f"- [{local.strftime('%H:%M')}] `{e.type}` {e.title}",
        ]
        if e.actor and e.actor != identity:
            parts.append(f"by **{e.actor}**")
        refs = e.refs[: self._per_event_refs_max]
        if refs:
            refs_str = ", ".join(
                f"{r.kind}={r.id}" + (f" ({r.label})" if r.label else "")
                for r in refs
            )
            parts.append(refs_str)
        main = "  ·  ".join(parts)
        body = e.body
        if body:
            if len(body) > self._body_maxlen:
                body = body[: self._body_maxlen].rstrip() + " …(略)"
            # 折成引用形式,单行(去掉内部换行,避免破坏 markdown 列表)
            body_one_line = body.replace("\n", " ").strip()
            return f"{main}\n    > {body_one_line}"
        return main
