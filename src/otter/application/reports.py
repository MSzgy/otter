"""Application assembly without terminal UI or cross-thread connections."""
from __future__ import annotations

from collections.abc import Callable

from otter.core.config import Config
from otter.core.keychain import DefaultSecretResolver
from otter.core.paths import project_root
from otter.core.store import Report, Store


def open_store(config: Config) -> Store:
    store = Store(config.data_path() / "otter.db")
    try:
        store.migrate()
    except Exception:
        store.close()
        raise
    return store


def make_orchestrator(config: Config, store: Store):
    from otter.core.orchestrator import Orchestrator
    from otter.summarizer.renderer import Renderer

    return Orchestrator(
        config=config, store=store, resolver=DefaultSecretResolver(),
        renderer=Renderer(config=config.prompts, project_root=project_root()),
    )


def notify_report(config: Config, report: Report, warn: Callable[[str], None]) -> None:
    from otter.core.registry import NOTIFIERS

    resolver = DefaultSecretResolver()
    for name in config.notifiers.pipeline:
        try:
            cls = NOTIFIERS.get(name)
            cls(config=config.notifiers.config_for(name), resolver=resolver).notify(report)
        except Exception:
            # Plugin errors can contain credentials; do not forward their repr to a UI.
            warn(f"notifier {name} 失败，请检查配置。")
