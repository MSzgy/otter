# D 像素水獭素材（pixel_game）

21 种表情，每种 4 个关键姿态、各自有帧时长，无限循环。2026-10-24 从 iCloud `Documents/Playground/otter-style-pack/pixel-companion` 复制进仓库，避免素材只存在于云端；复制后 GIF 和设备帧都与 `manifest.json` 的 SHA-256 逐一核对一致。

| 路径 | 内容 |
|---|---|
| `manifest.json` | 每种表情的编号、名称、触发说明，以及每帧的路径、时长和 SHA-256 |
| `animation-profiles.json` | 每种表情的动作说明和 4 帧时长 |
| `expressions.json` | 可编辑的表情定义，区分已有 Mood 和新增状态 |
| `animations/gif/` | 21 个 240×320 循环 GIF，给浏览器 / 桌面 App 预览用 |
| `device-animation/otter/pixel_game/<表情>/NN.565.gz` | 84 帧 gzip 压缩的 RGB565（高字节在前）全屏帧，设备用的就是这些 |

原始 atlas、PNG 关键帧、网页原型和制作脚本仍在原素材包里，这里只放重建设备数据和预览所需的部分。

## 生成设备数据并写入

    cd /Users/zouguoyang/Developer/otter/hardware
    python3 scripts/build-pixel-skin.py assets/pixel_game output/pixel_skin/pixel_game.bin
    .tools/arduino-data/packages/esp32/tools/esptool_py/5.3.0-cn/esptool --chip esp32s3 -p /dev/cu.usbmodem3101 --after watchdog-reset write-flash 0x610000 output/pixel_skin/pixel_game.bin

打包脚本会用 SHA-256 检查每一帧。用这份素材生成的 `pixel_game.bin` 为 1,811,220 字节，SHA-256 以 `1d6da8bd52cb6824` 开头。
