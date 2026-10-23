"""Install the official macOS ARM64 Arduino CLI into this project only.

The binary is verified against the release checksum before extraction.
This does not flash any board or change the system PATH.
"""

import hashlib
import json
import shutil
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".tools"
DOWNLOADS = TOOLS / "downloads"
BIN = TOOLS / "bin"


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Otter-Hardware-Lab-Setup"})
    return urllib.request.urlopen(request, timeout=60)


def main():
    for directory in [DOWNLOADS, BIN, TOOLS / "arduino-data", TOOLS / "sketchbook"]:
        directory.mkdir(parents=True, exist_ok=True)
    with fetch("https://api.github.com/repos/arduino/arduino-cli/releases/latest") as response:
        release = json.load(response)
    assets = release["assets"]
    asset = next(item for item in assets if item["name"].endswith("_macOS_ARM64.tar.gz"))
    name = asset["name"]
    if Path(name).name != name:
        raise RuntimeError("Invalid release filename")
    expected = (asset.get("digest") or "").removeprefix("sha256:")
    if len(expected) != 64:
        checksums = next(item for item in assets if item["name"].endswith("checksums.txt"))
        with fetch(checksums["browser_download_url"]) as response:
            lines = response.read().decode().splitlines()
        expected = next(line.split()[0] for line in lines if line.split()[-1].lstrip("*") == name)
    archive = DOWNLOADS / name
    print("Downloading official Arduino CLI", release["tag_name"], flush=True)
    with fetch(asset["browser_download_url"]) as response, archive.open("wb") as target:
        shutil.copyfileobj(response, target)
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != expected:
        raise RuntimeError("Checksum mismatch; refusing to install")
    target = BIN / "arduino-cli"
    with tarfile.open(archive) as bundle:
        member = bundle.getmember("arduino-cli")
        if not member.isfile():
            raise RuntimeError("Release binary is not a regular file")
        with bundle.extractfile(member) as source, target.open("wb") as output:
            shutil.copyfileobj(source, output)
    target.chmod(0o755)
    config = (
        "board_manager:\n"
        "  additional_urls:\n"
        "    - https://espressif.github.io/arduino-esp32/package_esp32_index.json\n"
        "directories:\n"
        "  data: " + json.dumps(str(TOOLS / "arduino-data")) + "\n"
        "  downloads: " + json.dumps(str(DOWNLOADS)) + "\n"
        "  user: " + json.dumps(str(TOOLS / "sketchbook")) + "\n"
        "updater:\n"
        "  enable_notification: false\n"
    )
    (TOOLS / "arduino-cli.yaml").write_text(config)
    (TOOLS / "arduino-cli-install.json").write_text(json.dumps({
        "version": release["tag_name"], "url": asset["browser_download_url"],
        "sha256": actual, "checksum_verified": True,
    }, indent=2) + "\n")
    print("Checksum verified. Installed:", target, flush=True)
    print("Board support package and display libraries are not installed yet.", flush=True)


if __name__ == "__main__":
    main()
