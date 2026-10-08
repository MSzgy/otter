"""Build a self-contained, host-architecture Python sidecar outside synced folders."""

import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

root = Path(__file__).resolve().parents[2]
desktop = root / "desktop"
python = Path(os.environ.get("OTTER_BUILD_PYTHON", root / ".venv/bin/python"))
with tempfile.TemporaryDirectory(prefix="otter-backend-") as temporary:
    staging = Path(temporary)
    subprocess.run(
        [
            str(python),
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--onedir",
            "--name",
            "otter-runtime",
            "--distpath",
            str(staging / "dist"),
            "--workpath",
            str(staging / "work"),
            "--specpath",
            str(staging),
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
            "PYINSTALLER_CONFIG_DIR": str(staging / "cache"),
            "PYTHONPATH": str(root / "src"),
        },
        check=True,
    )
    output = Path(os.environ.get("OTTER_BACKEND_OUTPUT", desktop / "build/backend/otter-runtime"))
    output.parent.mkdir(parents=True, exist_ok=True)
    backup = output.with_name("otter-runtime-previous-" + uuid.uuid4().hex[:8])
    if output.exists():
        output.rename(backup)
    try:
        shutil.copytree(
            staging / "dist/otter-runtime", output, symlinks=True, copy_function=shutil.copy
        )
    except Exception:
        shutil.rmtree(output, ignore_errors=True)
        if backup.exists():
            backup.rename(output)
        raise
    print(f"Backend built: {output}")
    if backup.exists():
        print(f"Previous build retained: {backup}")
