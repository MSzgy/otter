"""OutlookCollector 单元测试(用 respx 拦截 Graph API)。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
import respx

from otter.collectors.outlook import (
    OutlookCollector,
    OutlookError,
    _addr,
    _parse_graph_dt,
)

BASE = "https://graph.microsoft.com/v1.0"
IDENTITY = "me@example.com"


class _FakeResolver:
    def __init__(self, value: str = "fake_refresh_token") -> None:
        self.value = value
        self.calls: list[str] = []

    def resolve(self, ref: str) -> str:
        self.calls.append(ref)
        return self.value


def _make_collector(
    resolver: _FakeResolver | None = None,
    **overrides,
) -> OutlookCollector:
    config = {
        "refresh_token_ref": "keychain:otter/outlook",
        **overrides,
    }
    coll = OutlookCollector(
        config=config,
        resolver=resolver or _FakeResolver(),
        identity=IDENTITY,
    )
    # 绕开真的 msal 调用,固定返回一个假 access_token
    coll._acquire_access_token = lambda: "fake_access_token"  # type: ignore[method-assign]
    return coll


def _dt(hours: int = 0) -> datetime:
    return datetime(2026, 8, 25, 10, 0, tzinfo=UTC) + timedelta(hours=hours)


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# ────────── 构造与错误 ──────────


class TestConstruction:
    def test_missing_refresh_ref_raises(self):
        with pytest.raises(OutlookError, match="refresh_token_ref 未配置"):
            OutlookCollector(
                config={},
                resolver=_FakeResolver(),
                identity=IDENTITY,
            )

    def test_refresh_token_resolved_at_init(self):
        r = _FakeResolver()
        _make_collector(resolver=r)
        assert r.calls == ["keychain:otter/outlook"]

    def test_scopes_must_be_list(self):
        with pytest.raises(OutlookError, match="scopes 应为列表"):
            _make_collector(scopes="Mail.Read")


# ────────── Sent 邮件 ──────────


class TestSent:
    @respx.mock
    def test_sent_email_parsed(self):
        payload = {
            "value": [
                {
                    "id": "AAMkAG1",
                    "subject": "Weekly sync notes",
                    "bodyPreview": "Attaching the notes …",
                    "sentDateTime": _iso(_dt(0)),
                    "toRecipients": [
                        {"emailAddress": {"address": "alice@x.com", "name": "Alice"}},
                        {"emailAddress": {"address": "bob@x.com"}},
                    ],
                    "ccRecipients": [
                        {"emailAddress": {"address": "carol@x.com"}},
                    ],
                    "webLink": "https://outlook/mail/AAMkAG1",
                    "conversationId": "conv1",
                    "importance": "normal",
                }
            ]
        }
        respx.get(f"{BASE}/me/mailFolders/sentitems/messages").mock(
            return_value=httpx.Response(200, json=payload)
        )
        # 关掉另外两段
        events = list(
            _make_collector(
                include_received_focused=False, include_meetings=False,
            ).collect(_dt(-1), _dt(1))
        )
        assert len(events) == 1
        e = events[0]
        assert e.type == "email_sent"
        assert e.actor == IDENTITY
        assert "Weekly sync notes" in e.title
        assert "alice@x.com" in e.title
        assert "(+1)" in e.title  # 3 收件人显示头 2 + (+1)
        assert e.url == "https://outlook/mail/AAMkAG1"
        # refs 里应包含 3 个 person + 1 个 thread
        assert any(r.kind == "thread" and r.id == "conv1" for r in e.refs)
        persons = [r for r in e.refs if r.kind == "person"]
        assert {"alice@x.com", "bob@x.com", "carol@x.com"} <= {r.id for r in persons}


# ────────── Received focused ──────────


class TestReceived:
    @respx.mock
    def test_focused_received_parsed(self):
        payload = {
            "value": [
                {
                    "id": "AAMkAG2",
                    "subject": "Need your review on RFC",
                    "bodyPreview": "Hey, can you look?",
                    "receivedDateTime": _iso(_dt(0)),
                    "from": {
                        "emailAddress": {"address": "eve@x.com", "name": "Eve"}
                    },
                    "webLink": "https://outlook/mail/AAMkAG2",
                    "conversationId": "conv2",
                    "importance": "high",
                }
            ]
        }
        route = respx.get(f"{BASE}/me/messages").mock(
            return_value=httpx.Response(200, json=payload)
        )
        events = list(
            _make_collector(
                include_sent=False, include_meetings=False,
            ).collect(_dt(-1), _dt(1))
        )
        assert len(events) == 1
        e = events[0]
        assert e.type == "email_received"
        assert e.actor == "eve@x.com"
        assert "Need your review" in e.title
        # $filter 必须带上 focused 分类
        req_url = str(route.calls[0].request.url)
        assert "inferenceClassification+eq+%27focused%27" in req_url or \
               "inferenceClassification eq 'focused'" in req_url


# ────────── Meetings ──────────


class TestMeetings:
    @respx.mock
    def test_meeting_parsed(self):
        payload = {
            "value": [
                {
                    "id": "AAMkAG3",
                    "subject": "1:1 with manager",
                    "bodyPreview": "Agenda: OKR review",
                    "start": {"dateTime": "2026-08-25T09:00:00.0000000", "timeZone": "UTC"},
                    "end":   {"dateTime": "2026-08-25T09:30:00.0000000", "timeZone": "UTC"},
                    "organizer": {
                        "emailAddress": {"address": "boss@x.com", "name": "Boss"}
                    },
                    "attendees": [
                        {"emailAddress": {"address": IDENTITY}},
                        {"emailAddress": {"address": "boss@x.com"}},
                    ],
                    "webLink": "https://outlook/cal/AAMkAG3",
                    "isCancelled": False,
                    "onlineMeeting": {"joinUrl": "https://teams/x"},
                    "showAs": "busy",
                }
            ]
        }
        respx.get(f"{BASE}/me/calendarView").mock(
            return_value=httpx.Response(200, json=payload)
        )
        events = list(
            _make_collector(
                include_sent=False, include_received_focused=False,
            ).collect(_dt(-1), _dt(1))
        )
        assert len(events) == 1
        e = events[0]
        assert e.type == "meeting"
        assert e.actor == "boss@x.com"
        assert "1:1 with manager" in e.title
        assert "30 min" in e.title
        assert e.metadata["duration_min"] == 30
        assert e.metadata["is_online"] is True
        assert e.metadata["is_cancelled"] is False

    @respx.mock
    def test_cancelled_meeting_prefixed(self):
        payload = {
            "value": [
                {
                    "id": "M1",
                    "subject": "Old sync",
                    "start": {"dateTime": "2026-08-25T09:00:00.0000000", "timeZone": "UTC"},
                    "end":   {"dateTime": "2026-08-25T09:30:00.0000000", "timeZone": "UTC"},
                    "organizer": {"emailAddress": {"address": "boss@x.com"}},
                    "attendees": [],
                    "isCancelled": True,
                }
            ]
        }
        respx.get(f"{BASE}/me/calendarView").mock(
            return_value=httpx.Response(200, json=payload)
        )
        events = list(
            _make_collector(
                include_sent=False, include_received_focused=False,
            ).collect(_dt(-1), _dt(1))
        )
        assert len(events) == 1
        assert "cancelled" in events[0].title.lower()


# ────────── 失败隔离 / 翻页 / 429 ──────────


class TestResilience:
    @respx.mock
    def test_section_failure_isolated(self):
        """calendar 403 时,sent/received 仍应产出。"""
        respx.get(f"{BASE}/me/mailFolders/sentitems/messages").mock(
            return_value=httpx.Response(200, json={"value": [
                {
                    "id": "S1", "subject": "hi", "sentDateTime": _iso(_dt(0)),
                    "toRecipients": [], "webLink": None, "conversationId": None,
                }
            ]}),
        )
        respx.get(f"{BASE}/me/messages").mock(
            return_value=httpx.Response(200, json={"value": []})
        )
        respx.get(f"{BASE}/me/calendarView").mock(
            return_value=httpx.Response(403, text="forbidden")
        )
        events = list(_make_collector().collect(_dt(-1), _dt(1)))
        # 只应有 sent 那一条,calendar 段被 warn 吃掉
        assert len(events) == 1
        assert events[0].type == "email_sent"

    @respx.mock
    def test_pagination_follows_next_link(self):
        page1 = {
            "value": [
                {
                    "id": "S1", "subject": "one",
                    "sentDateTime": _iso(_dt(0)),
                    "toRecipients": [{"emailAddress": {"address": "a@x.com"}}],
                }
            ],
            "@odata.nextLink": f"{BASE}/me/mailFolders/sentitems/messages?$skip=1",
        }
        page2 = {
            "value": [
                {
                    "id": "S2", "subject": "two",
                    "sentDateTime": _iso(_dt(0)),
                    "toRecipients": [{"emailAddress": {"address": "b@x.com"}}],
                }
            ]
        }
        # 使用 mock 的 side_effect 依次返回
        route = respx.get(f"{BASE}/me/mailFolders/sentitems/messages").mock(
            side_effect=[
                httpx.Response(200, json=page1),
                httpx.Response(200, json=page2),
            ]
        )
        events = list(
            _make_collector(
                include_received_focused=False, include_meetings=False,
            ).collect(_dt(-1), _dt(1))
        )
        assert len(events) == 2
        assert route.call_count == 2

    @respx.mock
    def test_429_retry_once(self, monkeypatch):
        # 别真睡
        monkeypatch.setattr("otter.collectors.outlook.time.sleep", lambda _: None)
        payload = {"value": [
            {
                "id": "S1", "subject": "ok",
                "sentDateTime": _iso(_dt(0)),
                "toRecipients": [],
            }
        ]}
        route = respx.get(f"{BASE}/me/mailFolders/sentitems/messages").mock(
            side_effect=[
                httpx.Response(429, headers={"Retry-After": "0"}),
                httpx.Response(200, json=payload),
            ]
        )
        events = list(
            _make_collector(
                include_received_focused=False, include_meetings=False,
            ).collect(_dt(-1), _dt(1))
        )
        assert len(events) == 1
        assert route.call_count == 2


# ────────── HTTP header ──────────


class TestHttp:
    @respx.mock
    def test_bearer_header(self):
        route = respx.get(f"{BASE}/me/mailFolders/sentitems/messages").mock(
            return_value=httpx.Response(200, json={"value": []})
        )
        respx.get(f"{BASE}/me/messages").mock(
            return_value=httpx.Response(200, json={"value": []})
        )
        respx.get(f"{BASE}/me/calendarView").mock(
            return_value=httpx.Response(200, json={"value": []})
        )
        list(_make_collector().collect(_dt(-1), _dt(1)))
        req = route.calls[0].request
        assert req.headers["Authorization"] == "Bearer fake_access_token"


# ────────── 工具函数 ──────────


class TestHelpers:
    def test_addr_nested(self):
        assert _addr({"emailAddress": {"address": "x@y", "name": "X"}}) == "x@y"

    def test_addr_flat(self):
        assert _addr({"address": "z@y"}) == "z@y"

    def test_addr_none(self):
        assert _addr(None) is None
        assert _addr({}) is None

    def test_parse_graph_dt(self):
        dt = _parse_graph_dt("2026-08-25T09:00:00.0000000", "UTC")
        assert dt is not None
        assert dt.tzinfo is not None


# ────────── 契约与注册 ──────────


class TestContract:
    def test_satisfies_protocol(self):
        from otter.core.collector import Collector
        assert isinstance(_make_collector(), Collector)

    def test_registered(self):
        from otter.collectors.outlook import OutlookCollector as C
        from otter.core.registry import COLLECTORS

        assert "outlook" in COLLECTORS.names()
        assert COLLECTORS.get("outlook") is C
