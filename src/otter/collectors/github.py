"""GitHub(Enterprise)Collector —— 通过 Events API + Search 拉取活动。

设计要点:
    - 兼容 github.com 与 Enterprise(SAP 用的是 github.tools.sap)。base_url 走
      config,默认 `https://api.github.com`。
    - 两路数据源:
        1) `/users/{u}/events` —— 用户自己的活动(Push / 给别人的 Review / 评论)
        2) `/search/issues` + `/repos/.../reviews` —— 别人对我 PR 的 Review
    - PAT 通过 SecretResolver 读,不落盘、不出现在日志。
    - GitHub Events API 只保留 ~90 天、~300 条,MVP 场景(lookback 1-2 天)
      够用;我们边翻页边看 created_at,一旦跌出窗口就停。
    - HTTP 失败不炸掉整批:单个 PR 拉 review 失败仅记日志。
    - httpx.Client(内部 mount transport)方便测试用 respx 拦截。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator
from datetime import datetime
from typing import Any, ClassVar

import httpx

from otter.core.event import Event, Ref
from otter.core.keychain import SecretResolver

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://api.github.com"
_DEFAULT_EVENT_TYPES = (
    "PushEvent",
    "PullRequestReviewEvent",
    "IssueCommentEvent",
)
_MAX_EVENTS_PAGES = 3        # ~90 条,GH Events API 上限 ~300
_MAX_REVIEWED_PRS = 30       # 一次 collect 最多深挖多少个 PR


class GitHubError(Exception):
    """GitHub API 相关错误。"""


class GitHubCollector:
    """从 GitHub / GHE 拉取用户相关活动,产出 `source="github"` 的 Event。"""

    name: ClassVar[str] = "github"

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,
        identity: str,  # noqa: ARG002 — 契约要求,github 用 username 而不是 email
    ) -> None:
        username = config.get("username")
        if not username:
            raise GitHubError("collectors.github.username 未配置")
        api_key_ref = config.get("api_key_ref")
        if not api_key_ref:
            raise GitHubError("collectors.github.api_key_ref 未配置")

        self._username: str = str(username)
        self._token: str = resolver.resolve(str(api_key_ref))
        self._base_url: str = str(
            config.get("base_url") or _DEFAULT_BASE_URL
        ).rstrip("/")
        raw_types = config.get("event_types") or list(_DEFAULT_EVENT_TYPES)
        if not isinstance(raw_types, list):
            raise GitHubError("collectors.github.event_types 应为列表")
        self._event_types: set[str] = set(raw_types)
        self._include_reviews_received: bool = bool(
            config.get("include_reviews_received", True)
        )
        # 默认过滤自己的 push(通常本地 git collector 已经采过同一批 commit,
        # 保留 github push 只会重复)。想看部署机器人代推的场景再关掉。
        self._skip_own_pushes: bool = bool(config.get("skip_own_pushes", True))
        # 默认过滤 bot(auto-review、CI 评论、机器人 merge 通知等)。想看 bot
        # 的 review 意见时再关掉。
        self._exclude_bot_actors: bool = bool(
            config.get("exclude_bot_actors", True)
        )
        self._timeout: float = float(config.get("timeout_sec", 15.0))

    # ────────── 主流程 ──────────

    def collect(self, since: datetime, until: datetime) -> Iterable[Event]:
        with self._make_client() as client:
            yield from self._collect_user_events(client, since, until)
            if self._include_reviews_received:
                yield from self._collect_reviews_received(client, since, until)

    # ────────── HTTP client ──────────

    def _make_client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self._base_url,
            headers={
                "Authorization": f"token {self._token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "otter-assistant",
            },
            timeout=httpx.Timeout(self._timeout),
        )

    # ────────── 1) 用户事件流 ──────────

    def _collect_user_events(
        self,
        client: httpx.Client,
        since: datetime,
        until: datetime,
    ) -> Iterator[Event]:
        path = f"/users/{self._username}/events"
        params = {"per_page": 30}
        for page in range(1, _MAX_EVENTS_PAGES + 1):
            try:
                r = client.get(path, params={**params, "page": page})
                r.raise_for_status()
            except httpx.HTTPError as e:
                raise GitHubError(f"拉取用户事件失败:{e}") from e
            batch = r.json()
            if not batch:
                return
            stop = False
            for raw in batch:
                created_at = _parse_iso(raw.get("created_at"))
                if created_at is None:
                    continue
                if created_at < since:
                    # events API 返回按时间倒序,可以提前退出
                    stop = True
                    break
                if created_at >= until:
                    continue
                if raw.get("type") not in self._event_types:
                    continue
                if raw["type"] == "PushEvent" and self._skip_own_pushes:
                    continue
                event = self._event_from_raw(raw)
                if event is None:
                    continue
                if self._exclude_bot_actors and _looks_like_bot(event.actor):
                    continue
                yield event
            if stop or len(batch) < params["per_page"]:
                return

    def _event_from_raw(self, raw: dict[str, Any]) -> Event | None:
        etype = raw["type"]
        if etype == "PushEvent":
            return self._push_event(raw)
        if etype == "PullRequestReviewEvent":
            return self._review_event(raw, received=False)
        if etype == "IssueCommentEvent":
            return self._issue_comment_event(raw)
        # 兜底:其他类型未处理,交给 event_types 白名单先拦
        return None

    def _push_event(self, raw: dict[str, Any]) -> Event | None:
        repo_full = raw.get("repo", {}).get("name", "?")
        payload = raw.get("payload", {})
        ref = payload.get("ref", "").replace("refs/heads/", "")
        commits = payload.get("commits") or []
        size = payload.get("size") or len(commits)
        subjects = [c.get("message", "").splitlines()[0] for c in commits]
        title = f"Push {size} commit(s) to {repo_full}@{ref}"
        body = "\n".join(f"- {s}" for s in subjects) or None
        ts = _parse_iso(raw["created_at"])
        assert ts is not None
        return Event.build(
            source=self.name,
            source_id=f"push:{raw['id']}",
            type="push",
            timestamp=ts,
            actor=self._username,
            title=title,
            body=body,
            url=None,
            refs=[
                Ref(kind="repo", id=repo_full),
                *[Ref(kind="commit", id=c.get("sha", "?")) for c in commits[:10]],
            ],
            metadata={"branch": ref, "size": size},
        )

    def _review_event(
        self, raw: dict[str, Any], *, received: bool
    ) -> Event | None:
        payload = raw.get("payload", {})
        review = payload.get("review", {})
        pr = payload.get("pull_request", {})
        repo_full = raw.get("repo", {}).get("name", "?")
        state = review.get("state", "commented")
        pr_number = pr.get("number", "?")
        pr_title = pr.get("title", "")
        reviewer = review.get("user", {}).get("login") or self._username
        actor = reviewer if received else self._username
        title = (
            f"{reviewer} {state} PR #{pr_number}: {pr_title}"
            if received
            else f"Reviewed ({state}) PR #{pr_number}: {pr_title}"
        )
        ts = _parse_iso(review.get("submitted_at") or raw["created_at"])
        assert ts is not None
        return Event.build(
            source=self.name,
            source_id=f"review:{review.get('id', raw['id'])}",
            type="pr_review_received" if received else "pr_review_given",
            timestamp=ts,
            actor=actor,
            title=title,
            body=review.get("body") or None,
            url=review.get("html_url"),
            refs=[
                Ref(kind="repo", id=repo_full),
                Ref(kind="pr", id=f"{repo_full}#{pr_number}", label=pr_title),
            ],
            metadata={"state": state, "reviewer": reviewer},
        )

    def _issue_comment_event(self, raw: dict[str, Any]) -> Event | None:
        payload = raw.get("payload", {})
        issue = payload.get("issue", {})
        comment = payload.get("comment", {})
        repo_full = raw.get("repo", {}).get("name", "?")
        number = issue.get("number", "?")
        issue_title = issue.get("title", "")
        is_pr = "pull_request" in issue
        kind = "pr" if is_pr else "issue"
        title = f"Commented on {kind.upper()} #{number}: {issue_title}"
        ts = _parse_iso(comment.get("created_at") or raw["created_at"])
        assert ts is not None
        return Event.build(
            source=self.name,
            source_id=f"comment:{comment.get('id', raw['id'])}",
            type="pr_comment" if is_pr else "issue_comment",
            timestamp=ts,
            actor=self._username,
            title=title,
            body=comment.get("body") or None,
            url=comment.get("html_url"),
            refs=[
                Ref(kind="repo", id=repo_full),
                Ref(kind=kind, id=f"{repo_full}#{number}", label=issue_title),
            ],
            metadata={},
        )

    # ────────── 2) 别人对我 PR 的 Review ──────────

    def _collect_reviews_received(
        self,
        client: httpx.Client,
        since: datetime,
        until: datetime,
    ) -> Iterator[Event]:
        # 找出窗口内被更新过的、我作为 author 的 PR
        since_date = since.date().isoformat()
        q = f"is:pr author:{self._username} updated:>={since_date}"
        try:
            r = client.get(
                "/search/issues",
                params={"q": q, "per_page": _MAX_REVIEWED_PRS, "sort": "updated"},
            )
            r.raise_for_status()
        except httpx.HTTPError as e:
            logger.warning("github collector: 搜索 PR 失败:%s", e)
            return

        items = r.json().get("items", [])
        for item in items[:_MAX_REVIEWED_PRS]:
            pr_url = item.get("pull_request", {}).get("url")
            # pr_url 形如 https://<host>/api/v3/repos/o/r/pulls/N;
            # 拆出 owner/repo/number 以避免直接混用 base_url。
            owner, repo, number = _split_pr_url(pr_url)
            if owner is None:
                continue
            try:
                rr = client.get(f"/repos/{owner}/{repo}/pulls/{number}/reviews")
                rr.raise_for_status()
            except httpx.HTTPError as e:
                logger.warning(
                    "github collector: 拉 %s/%s#%s reviews 失败:%s",
                    owner, repo, number, e,
                )
                continue
            for review in rr.json():
                yield from self._maybe_emit_received_review(
                    review, owner, repo, number, item.get("title", ""),
                    since, until,
                )

    def _maybe_emit_received_review(
        self,
        review: dict[str, Any],
        owner: str,
        repo: str,
        number: int | str,
        pr_title: str,
        since: datetime,
        until: datetime,
    ) -> Iterator[Event]:
        submitted_at = _parse_iso(review.get("submitted_at"))
        if submitted_at is None:
            return
        if submitted_at < since or submitted_at >= until:
            return
        reviewer = review.get("user", {}).get("login") or "?"
        if reviewer == self._username:
            return  # 自评过滤
        if self._exclude_bot_actors and _looks_like_bot(reviewer):
            return
        repo_full = f"{owner}/{repo}"
        state = review.get("state", "COMMENTED").lower()
        yield Event.build(
            source=self.name,
            source_id=f"review:{review['id']}",
            type="pr_review_received",
            timestamp=submitted_at,
            actor=reviewer,
            title=f"{reviewer} {state} PR #{number}: {pr_title}",
            body=review.get("body") or None,
            url=review.get("html_url"),
            refs=[
                Ref(kind="repo", id=repo_full),
                Ref(kind="pr", id=f"{repo_full}#{number}", label=pr_title),
                Ref(kind="person", id=reviewer),
            ],
            metadata={"state": state, "reviewer": reviewer},
        )


# ────────── 工具函数 ──────────


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        # GitHub 返回 "2026-08-25T10:00:00Z" 这种,fromisoformat 从 3.11 起支持 Z
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _looks_like_bot(actor: str | None) -> bool:
    """粗判 actor 是不是机器人:`[bot]` 后缀是 GitHub 官方标记,`-bot` 是惯例。"""
    if not actor:
        return False
    a = actor.lower()
    return a.endswith("[bot]") or a.endswith("-bot")


def _split_pr_url(url: str | None) -> tuple[str | None, str | None, str | None]:
    """从 `.../repos/{owner}/{repo}/pulls/{number}` 拆出三段。"""
    if not url:
        return (None, None, None)
    parts = url.rstrip("/").split("/")
    try:
        i = parts.index("repos")
        owner = parts[i + 1]
        repo = parts[i + 2]
        # parts[i+3] == "pulls"
        number = parts[i + 4]
    except (ValueError, IndexError):
        return (None, None, None)
    return (owner, repo, number)
