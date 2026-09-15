"""Build a self-contained, host-architecture Python sidecar for Electron."""

import os
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
desktop = root / "desktop"
python = root / ".venv/bin/python"
subprocess.run(
    [
        str(python),
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "otter-runtime",
        "--distpath",
        str(desktop / "build/backend"),
        "--workpath",
        str(desktop / "build/pyinstaller"),
        "--specpath",
        str(desktop / "build"),
        "--collect-all",
        "otter",
        "--copy-metadata",
        "otter-assistant",
        "--collect-submodules",
        "langgraph",
        "--collect-submodules",
        "keyring.backends",
        "--collect-submodules",
        "langchain_core",
        str(desktop / "scripts/runtime_entry.py"),
    ],
    cwd=root,
    env={
        **os.environ,
        "PYINSTALLER_CONFIG_DIR": str(desktop / "build/cache"),
        "PYTHONPATH": str(root / "src"),
    },
    check=True,
)
