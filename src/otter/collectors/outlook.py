"""Outlook / Microsoft Graph Collector —— 邮件(Sent + Focused inbox) + 日历。

设计要点:
    - 授权走 MSAL device flow(见 `otter outlook auth` CLI),refresh_token 存
      Keychain;每次 collect 用 refresh_token 换 access_token,msal 内部有
      token cache,一次 collect 只换一次。
    - Graph API 有三段独立采集:
        1) `/me/mailFolders/sentitems/messages` —— 我发出的邮件
        2) `/me/messages` + `inferenceClassification eq 'focused'` —— Focused 收件
        3) `/me/calendarView` —— 日历(会展开 recurring)
      任意一段 4xx/5xx 只 warn 跳过,不炸整个 collect。
    - 事件全部 `source="outlook"`,type 分别为 `email_sent` / `email_received`
      / `meeting`;Renderer 按 source 分组,不需要改模板。
    - body 用 Graph 返回的 `bodyPreview`(~255 字),再由 Renderer 二次截断。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable, Iterator
from datetime import datetime
from typing import Any, ClassVar

import httpx

from otter.core.event import Event, Ref
from otter.core.keychain import SecretResolver

logger = logging.getLogger(__name__)

_GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"   # Microsoft Graph CLI
_DEFAULT_TENANT_ID = "common"
_DEFAULT_SCOPES = ("Mail.Read", "Calendars.Read")
_MAX_PAGES = 5
_PAGE_SIZE = 50

_SENT_SELECT = (
    "id,subject,bodyPreview,sentDateTime,toRecipients,ccRecipients,"
    "webLink,conversationId,importance"
)
_RECEIVED_SELECT = (
    "id,subject,bodyPreview,receivedDateTime,from,webLink,conversationId,importance"
)
_MEETING_SELECT = (
    "id,subject,start,end,organizer,attendees,bodyPreview,webLink,"
    "isCancelled,onlineMeeting,showAs"
)


class OutlookError(Exception):
    """Outlook / Graph 相关错误。"""


class OutlookCollector:
    """从 Microsoft Graph 拉取邮件与日历,产出 `source="outlook"` 的 Event。"""

    name: ClassVar[str] = "outlook"

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,
        identity: str,
    ) -> None:
        ref = config.get("refresh_token_ref")
        if not ref:
            raise OutlookError("collectors.outlook.refresh_token_ref 未配置")
        self._refresh_token: str = resolver.resolve(str(ref))
        self._identity: str = identity
        self._client_id: str = str(config.get("client_id") or _DEFAULT_CLIENT_ID)
        self._tenant_id: str = str(config.get("tenant_id") or _DEFAULT_TENANT_ID)
        raw_scopes = config.get("scopes") or list(_DEFAULT_SCOPES)
        if not isinstance(raw_scopes, list):
            raise OutlookError("collectors.outlook.scopes 应为列表")
        self._scopes: list[str] = [str(s) for s in raw_scopes]

        self._include_sent: bool = bool(config.get("include_sent", True))
        self._include_received: bool = bool(
            config.get("include_received_focused", True)
        )
        self._include_meetings: bool = bool(config.get("include_meetings", True))
        self._timeout: float = float(config.get("timeout_sec", 15.0))

    # ────────── 主流程 ──────────

    def collect(self, since: datetime, until: datetime) -> Iterable[Event]:
        access_token = self._acquire_access_token()
        with self._make_client(access_token) as client:
            if self._include_sent:
                yield from self._safe(self._collect_sent, client, since, until, label="sent")
            if self._include_received:
                yield from self._safe(
                    self._collect_received_focused, client, since, until,
                    label="received_focused",
                )
            if self._include_meetings:
                yield from self._safe(
                    self._collect_meetings, client, since, until, label="meetings",
                )

    # 三段之间失败隔离:让单段 raise 不影响其他两段
    def _safe(
        self,
        fn,
        client: httpx.Client,
        since: datetime,
        until: datetime,
        *,
        label: str,
    ) -> Iterator[Event]:
        try:
            yield from fn(client, since, until)
        except OutlookError as e:
            logger.warning("outlook collector: %s 段失败:%s", label, e)
        except httpx.HTTPError as e:
            logger.warning("outlook collector: %s 段 HTTP 失败:%s", label, e)

    # ────────── Token ──────────

    def _acquire_access_token(self) -> str:
        """用 refresh_token 换 access_token(msal 内部处理 token 缓存与刷新)。"""
        try:
            import msal
        except ImportError as e:  # pragma: no cover — msal 已在 dependencies
            raise OutlookError("依赖 msal 未安装:uv sync 一下") from e
        app = msal.PublicClientApplication(
            self._client_id,
            authority=f"https://login.microsoftonline.com/{self._tenant_id}",
        )
        result = app.acquire_token_by_refresh_token(
            self._refresh_token, scopes=self._scopes,
        )
        if not isinstance(result, dict) or "access_token" not in result:
            desc = result.get("error_description") if isinstance(result, dict) else result
            raise OutlookError(f"MSAL refresh 失败:{desc}")
        return str(result["access_token"])

    def _make_client(self, access_token: str) -> httpx.Client:
        return httpx.Client(
            base_url=_GRAPH_BASE,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
                "User-Agent": "otter-assistant",
            },
            timeout=httpx.Timeout(self._timeout),
        )

    # ────────── HTTP 抓取(带翻页 + 429) ──────────

    def _paged_get(
        self, client: httpx.Client, path: str, params: dict[str, Any] | None = None,
    ) -> Iterator[dict[str, Any]]:
        """跟 @odata.nextLink 翻页,单个 429 睡一次重试;失败抛 OutlookError。"""
        url: str | None = path
        query: dict[str, Any] | None = params
        for _page in range(_MAX_PAGES):
            if url is None:
                return
            resp = self._get_with_retry(client, url, query)
            if resp is None:
                return
            data = resp.json()
            yield from (data.get("value", []) or [])
            url = data.get("@odata.nextLink")
            query = None  # nextLink 里已经带上了所有参数

    def _get_with_retry(
        self, client: httpx.Client, url: str, params: dict[str, Any] | None,
    ) -> httpx.Response | None:
        for attempt in (0, 1):
            resp = client.get(url, params=params)
            if resp.status_code == 429 and attempt == 0:
                delay = _parse_retry_after(resp.headers.get("Retry-After"))
                logger.info("outlook: 429,%.1fs 后重试(%s)", delay, url)
                time.sleep(delay)
                continue
            if resp.status_code >= 400:
                raise OutlookError(
                    f"Graph {resp.status_code} @ {url}:{resp.text[:200]}"
                )
            return resp
        return None

    # ────────── 1) Sent ──────────

    def _collect_sent(
        self, client: httpx.Client, since: datetime, until: datetime,
    ) -> Iterator[Event]:
        params = {
            "$filter": (
                f"sentDateTime ge {_iso(since)} and sentDateTime lt {_iso(until)}"
            ),
            "$select": _SENT_SELECT,
            "$top": _PAGE_SIZE,
            "$orderby": "sentDateTime desc",
        }
        for msg in self._paged_get(
            client, "/me/mailFolders/sentitems/messages", params,
        ):
            ev = self._sent_event(msg)
            if ev is not None:
                yield ev

    def _sent_event(self, msg: dict[str, Any]) -> Event | None:
        ts = _parse_iso(msg.get("sentDateTime"))
        if ts is None:
            return None
        subject = str(msg.get("subject") or "(无主题)")
        to = _recipient_addresses(msg.get("toRecipients"))
        cc = _recipient_addresses(msg.get("ccRecipients"))
        recipients = to + cc
        title = f"Sent: {subject}"
        if recipients:
            head = ", ".join(recipients[:2])
            more = f" (+{len(recipients) - 2})" if len(recipients) > 2 else ""
            title = f"Sent: {subject} → {head}{more}"
        conv = msg.get("conversationId")
        refs: list[Ref] = [Ref(kind="person", id=r) for r in recipients[:5]]
        if conv:
            refs.append(Ref(kind="thread", id=str(conv)))
        return Event.build(
            source=self.name,
            source_id=f"email:{msg['id']}",
            type="email_sent",
            timestamp=ts,
            actor=self._identity,
            title=title,
            body=msg.get("bodyPreview") or None,
            url=msg.get("webLink"),
            refs=refs,
            metadata={"importance": msg.get("importance") or "normal"},
        )

    # ────────── 2) Received focused ──────────

    def _collect_received_focused(
        self, client: httpx.Client, since: datetime, until: datetime,
    ) -> Iterator[Event]:
        params = {
            "$filter": (
                f"receivedDateTime ge {_iso(since)} and "
                f"receivedDateTime lt {_iso(until)} and "
                "inferenceClassification eq 'focused'"
            ),
            "$select": _RECEIVED_SELECT,
            "$top": _PAGE_SIZE,
            "$orderby": "receivedDateTime desc",
        }
        for msg in self._paged_get(client, "/me/messages", params):
            ev = self._received_event(msg)
            if ev is not None:
                yield ev

    def _received_event(self, msg: dict[str, Any]) -> Event | None:
        ts = _parse_iso(msg.get("receivedDateTime"))
        if ts is None:
            return None
        subject = str(msg.get("subject") or "(无主题)")
        sender = _addr(msg.get("from")) or "?"
        conv = msg.get("conversationId")
        refs: list[Ref] = [Ref(kind="person", id=sender)]
        if conv:
            refs.append(Ref(kind="thread", id=str(conv)))
        return Event.build(
            source=self.name,
            source_id=f"email:{msg['id']}",
            type="email_received",
            timestamp=ts,
            actor=sender,
            title=f"Received: {subject}",
            body=msg.get("bodyPreview") or None,
            url=msg.get("webLink"),
            refs=refs,
            metadata={"importance": msg.get("importance") or "normal"},
        )

    # ────────── 3) Meetings ──────────

    def _collect_meetings(
        self, client: httpx.Client, since: datetime, until: datetime,
    ) -> Iterator[Event]:
        params = {
            "startDateTime": _iso(since),
            "endDateTime": _iso(until),
            "$select": _MEETING_SELECT,
            "$top": _PAGE_SIZE,
            "$orderby": "start/dateTime desc",
        }
        for evt in self._paged_get(client, "/me/calendarView", params):
            e = self._meeting_event(evt)
            if e is not None:
                yield e

    def _meeting_event(self, evt: dict[str, Any]) -> Event | None:
        start_iso = (evt.get("start") or {}).get("dateTime")
        end_iso = (evt.get("end") or {}).get("dateTime")
        start = _parse_graph_dt(start_iso, (evt.get("start") or {}).get("timeZone"))
        end = _parse_graph_dt(end_iso, (evt.get("end") or {}).get("timeZone"))
        if start is None:
            return None
        duration_min = (
            int((end - start).total_seconds() // 60) if end is not None else None
        )
        subject = str(evt.get("subject") or "(无主题)")
        cancelled = bool(evt.get("isCancelled", False))
        prefix = "Meeting (cancelled)" if cancelled else "Meeting"
        title = (
            f"{prefix}: {subject} ({duration_min} min)"
            if duration_min is not None
            else f"{prefix}: {subject}"
        )
        organizer = _addr((evt.get("organizer") or {}).get("emailAddress")) or "?"
        attendees = [
            _addr(a.get("emailAddress"))
            for a in (evt.get("attendees") or [])
            if _addr(a.get("emailAddress"))
        ]
        refs: list[Ref] = [Ref(kind="person", id=organizer)]
        refs.extend(Ref(kind="person", id=a) for a in attendees[:5] if a != organizer)
        online = bool(evt.get("onlineMeeting"))
        return Event.build(
            source=self.name,
            source_id=f"meeting:{evt['id']}",
            type="meeting",
            timestamp=start,
            actor=organizer,
            title=title,
            body=evt.get("bodyPreview") or None,
            url=evt.get("webLink"),
            refs=refs,
            metadata={
                "duration_min": duration_min,
                "is_online": online,
                "is_cancelled": cancelled,
                "show_as": evt.get("showAs") or "busy",
            },
        )


# ────────── 工具函数 ──────────


def _iso(dt: datetime) -> str:
    """Graph 期待 ISO 8601 Z 结尾(UTC)。"""
    from datetime import UTC
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _parse_graph_dt(s: str | None, tz: str | None) -> datetime | None:
    """Graph 的 calendarView 返回 `start.dateTime`(无 tz 后缀)+ `timeZone` 字符串。
    默认 UTC(除非请求里带 Prefer 头改变了这点)。"""
    if not s:
        return None
    from datetime import UTC
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        # Graph 默认返回 UTC —— tz 字符串一般是 "UTC",不做额外解析
        return dt.replace(tzinfo=UTC)
    return dt


def _parse_retry_after(v: str | None) -> float:
    if not v:
        return 1.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 1.0


def _addr(email_field: Any) -> str | None:
    """Graph 里 recipient 结构:{ "emailAddress": {"address": "x@y", "name": "X"} }
    或直接 {"address": ..., "name": ...}(from 字段等)。都容错拆掉。"""
    if not isinstance(email_field, dict):
        return None
    inner = email_field.get("emailAddress")
    addr = inner.get("address") if isinstance(inner, dict) else email_field.get("address")
    return str(addr) if addr else None


def _recipient_addresses(items: Any) -> list[str]:
    if not isinstance(items, list):
        return []
    out: list[str] = []
    for it in items:
        a = _addr(it)
        if a:
            out.append(a)
    return out
