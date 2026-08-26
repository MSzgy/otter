"""GitHubCollector 单元测试(用 respx 拦截 httpx)。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
import respx

from otter.collectors.github import (
    GitHubCollector,
    GitHubError,
    _split_pr_url,
)

BASE = "https://github.tools.sap/api/v3"
USER = "I568963"


class _FakeResolver:
    def __init__(self, value: str = "ghp_fake_token") -> None:
        self.value = value
        self.calls: list[str] = []

    def resolve(self, ref: str) -> str:
        self.calls.append(ref)
        return self.value


def _make_collector(
    resolver: _FakeResolver | None = None,
    **overrides,
) -> GitHubCollector:
    config = {
        "username": USER,
        "api_key_ref": "keychain:otter/github",
        "base_url": BASE,
        **overrides,
    }
    return GitHubCollector(
        config=config,
        resolver=resolver or _FakeResolver(),
        identity=USER,
    )


def _dt(hours: int = 0) -> datetime:
    return datetime(2026, 8, 25, 10, 0, tzinfo=UTC) + timedelta(hours=hours)


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# ────────── 构造与错误 ──────────


class TestConstruction:
    def test_missing_username_raises(self) -> None:
        with pytest.raises(GitHubError, match="username 未配置"):
            GitHubCollector(
                config={"api_key_ref": "keychain:otter/github"},
                resolver=_FakeResolver(),
                identity=USER,
            )

    def test_missing_api_key_raises(self) -> None:
        with pytest.raises(GitHubError, match="api_key_ref 未配置"):
            GitHubCollector(
                config={"username": USER},
                resolver=_FakeResolver(),
                identity=USER,
            )

    def test_secret_resolved_at_init(self) -> None:
        r = _FakeResolver()
        _make_collector(resolver=r)
        assert r.calls == ["keychain:otter/github"]

    def test_default_base_url(self) -> None:
        c = GitHubCollector(
            config={"username": USER, "api_key_ref": "env:X"},
            resolver=_FakeResolver(),
            identity=USER,
        )
        assert c._base_url == "https://api.github.com"

    def test_event_types_must_be_list(self) -> None:
        with pytest.raises(GitHubError, match="event_types 应为列表"):
            _make_collector(event_types="PushEvent")


# ────────── 事件解析 ──────────


class TestEventParsing:
    @respx.mock
    def test_push_event(self) -> None:
        events_payload = [
            {
                "id": "1001",
                "type": "PushEvent",
                "created_at": _iso(_dt(0)),
                "actor": {"login": USER},
                "repo": {"name": "org/repo"},
                "payload": {
                    "ref": "refs/heads/main",
                    "size": 2,
                    "commits": [
                        {"sha": "abc", "message": "fix: X"},
                        {"sha": "def", "message": "feat: Y\nlong body"},
                    ],
                },
            }
        ]
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=events_payload)
        )
        # search 返回空,不产生 reviews_received
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(200, json={"items": []})
        )

        # skip_own_pushes 默认 True,这里关掉以断言 push 解析本身
        events = list(
            _make_collector(skip_own_pushes=False).collect(_dt(-1), _dt(1))
        )
        push = [e for e in events if e.type == "push"]
        assert len(push) == 1
        e = push[0]
        assert e.source == "github"
        assert "Push 2 commit(s) to org/repo@main" in e.title
        assert e.body is not None and "fix: X" in e.body
        # refs 里应有 repo + 两个 commit
        commit_refs = [r for r in e.refs if r.kind == "commit"]
        assert {r.id for r in commit_refs} == {"abc", "def"}
        assert e.metadata["branch"] == "main"
        assert e.metadata["size"] == 2

    @respx.mock
    def test_review_given(self) -> None:
        payload = [
            {
                "id": "2001",
                "type": "PullRequestReviewEvent",
                "created_at": _iso(_dt(0)),
                "actor": {"login": USER},
                "repo": {"name": "org/repo"},
                "payload": {
                    "review": {
                        "id": 555,
                        "state": "approved",
                        "body": "LGTM",
                        "html_url": "https://gh/pr/1#pullrequestreview-555",
                        "submitted_at": _iso(_dt(0)),
                        "user": {"login": USER},
                    },
                    "pull_request": {"number": 42, "title": "Add feature"},
                },
            }
        ]
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=payload)
        )
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(200, json={"items": []})
        )

        events = [
            e
            for e in _make_collector().collect(_dt(-1), _dt(1))
            if e.type == "pr_review_given"
        ]
        assert len(events) == 1
        e = events[0]
        assert e.actor == USER
        assert "Reviewed" in e.title and "#42" in e.title
        assert e.body == "LGTM"
        assert e.url == "https://gh/pr/1#pullrequestreview-555"

    @respx.mock
    def test_issue_comment_vs_pr_comment(self) -> None:
        base = {
            "id": "",
            "type": "IssueCommentEvent",
            "created_at": _iso(_dt(0)),
            "actor": {"login": USER},
            "repo": {"name": "org/repo"},
        }
        pr_evt = {
            **base,
            "id": "3001",
            "payload": {
                "issue": {
                    "number": 7,
                    "title": "PR title",
                    "pull_request": {"url": "..."},
                },
                "comment": {
                    "id": 900,
                    "body": "nice",
                    "html_url": "https://gh/c/900",
                    "created_at": _iso(_dt(0)),
                },
            },
        }
        issue_evt = {
            **base,
            "id": "3002",
            "payload": {
                "issue": {"number": 8, "title": "Issue title"},
                "comment": {
                    "id": 901,
                    "body": "hmm",
                    "created_at": _iso(_dt(0)),
                },
            },
        }
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=[pr_evt, issue_evt])
        )
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(200, json={"items": []})
        )

        types = {e.type for e in _make_collector().collect(_dt(-1), _dt(1))}
        assert types == {"pr_comment", "issue_comment"}


# ────────── 过滤 ──────────


class TestFilters:
    @respx.mock
    def test_time_window_stops_pagination(self) -> None:
        """按时间倒序返回,遇到旧事件应停下不再翻页。"""
        page1 = [
            {
                "id": "1",
                "type": "PushEvent",
                "created_at": _iso(_dt(0)),  # 在窗口内
                "actor": {"login": USER},
                "repo": {"name": "o/r"},
                "payload": {"ref": "refs/heads/main", "size": 1, "commits": []},
            },
            {
                "id": "2",
                "type": "PushEvent",
                "created_at": _iso(_dt(-24)),  # 太旧,应触发退出
                "actor": {"login": USER},
                "repo": {"name": "o/r"},
                "payload": {"ref": "refs/heads/main", "size": 1, "commits": []},
            },
        ]
        route = respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=page1)
        )
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(200, json={"items": []})
        )

        events = list(
            _make_collector(skip_own_pushes=False).collect(_dt(-1), _dt(1))
        )
        pushes = [e for e in events if e.type == "push"]
        assert len(pushes) == 1
        # 只应请求第 1 页
        assert route.call_count == 1

    @respx.mock
    def test_unknown_type_skipped(self) -> None:
        payload = [
            {
                "id": "1",
                "type": "WatchEvent",   # 不在白名单
                "created_at": _iso(_dt(0)),
                "actor": {"login": USER},
                "repo": {"name": "o/r"},
                "payload": {},
            }
        ]
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=payload)
        )
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        assert list(_make_collector().collect(_dt(-1), _dt(1))) == []

    @respx.mock
    def test_include_reviews_received_off(self) -> None:
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=[])
        )
        search_route = respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        list(
            _make_collector(include_reviews_received=False).collect(
                _dt(-1), _dt(1)
            )
        )
        assert search_route.call_count == 0

    @respx.mock
    def test_skip_own_pushes_default_true(self) -> None:
        """默认过滤自己的 PushEvent(避免和本地 git collector 重复)。"""
        payload = [
            {
                "id": "1", "type": "PushEvent",
                "created_at": _iso(_dt(0)),
                "actor": {"login": USER},
                "repo": {"name": "o/r"},
                "payload": {"ref": "refs/heads/main", "size": 1, "commits": []},
            }
        ]
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=payload)
        )
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        # 默认 skip_own_pushes=True → 应该过滤掉
        assert list(_make_collector().collect(_dt(-1), _dt(1))) == []
        # 关掉后又能拿到
        assert (
            len(
                list(
                    _make_collector(skip_own_pushes=False).collect(
                        _dt(-1), _dt(1)
                    )
                )
            )
            == 1
        )

    @respx.mock
    def test_bot_review_filtered_from_reviews_received(self) -> None:
        """reviews_received 路径过滤 bot reviewer。这是 bot 过滤的主战场
        (user events 里 actor 永远是自己,那条路径过滤 bot 是防御性代码)。"""
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=[])
        )
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "title": "My PR",
                            "pull_request": {
                                "url": f"{BASE}/repos/o/r/pulls/42",
                            },
                        }
                    ]
                },
            )
        )
        respx.get(f"{BASE}/repos/o/r/pulls/42/reviews").mock(
            return_value=httpx.Response(
                200,
                json=[
                    {
                        "id": 1,
                        "state": "COMMENTED",
                        "body": "bot review",
                        "user": {"login": "hyperspace-pr-bot[bot]"},
                        "submitted_at": _iso(_dt(0)),
                        "html_url": "https://gh/review/1",
                    },
                    {
                        "id": 2,
                        "state": "APPROVED",
                        "body": "human review",
                        "user": {"login": "alice"},
                        "submitted_at": _iso(_dt(0)),
                        "html_url": "https://gh/review/2",
                    },
                ],
            )
        )
        events = list(_make_collector().collect(_dt(-1), _dt(1)))
        # 只有 alice 的 review 通过
        received = [e for e in events if e.type == "pr_review_received"]
        assert len(received) == 1
        assert received[0].actor == "alice"


# ────────── Auth header / base_url ──────────


class TestHttp:
    @respx.mock
    def test_auth_header_and_base_url(self) -> None:
        route = respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=[])
        )
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        list(_make_collector().collect(_dt(-1), _dt(1)))
        req = route.calls[0].request
        assert req.headers["Authorization"] == "token ghp_fake_token"
        assert str(req.url).startswith(BASE)

    @respx.mock
    def test_401_raises(self) -> None:
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(401, json={"message": "Bad creds"})
        )
        with pytest.raises(GitHubError, match="拉取用户事件失败"):
            list(_make_collector().collect(_dt(-1), _dt(1)))


# ────────── 别人对我 PR 的 Review ──────────


class TestReviewsReceived:
    @respx.mock
    def test_reviews_from_others_emitted(self) -> None:
        # 用户事件流为空
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=[])
        )
        # search 找到 1 个我作者的 PR
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "title": "My PR",
                            "pull_request": {
                                "url": f"{BASE}/repos/org/repo/pulls/42",
                            },
                        }
                    ]
                },
            )
        )
        # 该 PR 的 reviews:一个是别人的,一个是我自己的(应过滤)
        respx.get(f"{BASE}/repos/org/repo/pulls/42/reviews").mock(
            return_value=httpx.Response(
                200,
                json=[
                    {
                        "id": 111,
                        "state": "APPROVED",
                        "body": "looks good",
                        "html_url": "https://gh/r/111",
                        "submitted_at": _iso(_dt(0)),
                        "user": {"login": "reviewer-a"},
                    },
                    {
                        "id": 112,
                        "state": "COMMENTED",
                        "submitted_at": _iso(_dt(0)),
                        "user": {"login": USER},  # 自评,应被过滤
                    },
                ],
            )
        )

        events = list(_make_collector().collect(_dt(-1), _dt(1)))
        received = [e for e in events if e.type == "pr_review_received"]
        assert len(received) == 1
        e = received[0]
        assert e.actor == "reviewer-a"
        assert "reviewer-a" in e.title and "#42" in e.title
        assert e.body == "looks good"
        assert any(r.kind == "person" and r.id == "reviewer-a" for r in e.refs)

    @respx.mock
    def test_reviews_outside_window_skipped(self) -> None:
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=[])
        )
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "title": "Old PR",
                            "pull_request": {
                                "url": f"{BASE}/repos/o/r/pulls/1",
                            },
                        }
                    ]
                },
            )
        )
        respx.get(f"{BASE}/repos/o/r/pulls/1/reviews").mock(
            return_value=httpx.Response(
                200,
                json=[
                    {
                        "id": 999,
                        "state": "approved",
                        "submitted_at": _iso(_dt(-48)),  # 早于窗口
                        "user": {"login": "reviewer-b"},
                    }
                ],
            )
        )
        events = list(_make_collector().collect(_dt(-1), _dt(1)))
        assert events == []

    @respx.mock
    def test_pr_reviews_fetch_error_isolated(self) -> None:
        """单个 PR reviews 拉失败,不应炸掉整个 collect。"""
        respx.get(f"{BASE}/users/{USER}/events").mock(
            return_value=httpx.Response(200, json=[])
        )
        respx.get(f"{BASE}/search/issues").mock(
            return_value=httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "title": "PR",
                            "pull_request": {
                                "url": f"{BASE}/repos/o/r/pulls/1",
                            },
                        }
                    ]
                },
            )
        )
        respx.get(f"{BASE}/repos/o/r/pulls/1/reviews").mock(
            return_value=httpx.Response(500)
        )
        # 不抛,只是没事件
        assert list(_make_collector().collect(_dt(-1), _dt(1))) == []


# ────────── 工具函数 ──────────


class TestSplitPrUrl:
    def test_valid_url(self) -> None:
        assert _split_pr_url(
            "https://github.tools.sap/api/v3/repos/org/repo/pulls/42"
        ) == ("org", "repo", "42")

    def test_none(self) -> None:
        assert _split_pr_url(None) == (None, None, None)

    def test_malformed(self) -> None:
        assert _split_pr_url("https://example.com/nope") == (None, None, None)


# ────────── 契约与注册 ──────────


class TestContract:
    def test_satisfies_protocol(self) -> None:
        from otter.core.collector import Collector

        assert isinstance(_make_collector(), Collector)

    def test_registered(self) -> None:
        from otter.collectors.github import GitHubCollector as C
        from otter.core.registry import COLLECTORS

        assert "github" in COLLECTORS.names()
        assert COLLECTORS.get("github") is C
