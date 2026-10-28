# 进化形态的板子帧（evolution）

桌面“任务进化”的工匠、深潜两种形态，在 ESP32 屏幕上用的帧。2026-10-28 从 `~/Developer/otter-assets/otter-evolution-cinematic-v2/` 复制进仓库，复制后 72 帧都按 `manifest.json` 的 SHA-256 核对一致。

| 路径 | 内容 |
|---|---|
| `manifest.json` | 原素材包的清单：每个片段的帧路径、时长、是否循环、SHA-256；完整演出在 `cinematic.forms` |
| `device/<片段>/N.565.gz` | 8 个片段各 4 帧：`artisan_work / waiting / success`、`to_artisan`，深潜同理 |
| `cinematic/device/<形态>/NN.565.gz` | 完整进化演出，每种形态 20 帧，每帧 120 ms |

每帧解压后 153,600 字节：240×320，RGB565，高字节在前，从左上角逐行。`from_<形态>`（回到陪伴）是 `to_<形态>` 倒着放，不单独存帧。原图、桌面 GIF 和预览在原素材包里，这里只放板子需要的。

## 生成并写入

    cd /Users/zouguoyang/Developer/otter/hardware
    python3 scripts/build-evolution-pack.py assets/evolution output/pixel_skin/evolution.bin
    .tools/arduino-data/packages/esp32/tools/esptool_py/5.3.0-cn/esptool --chip esp32s3 -p /dev/cu.usbmodem3101 --after watchdog-reset write-flash 0x910000 output/pixel_skin/evolution.bin

生成 12 个片段、80 帧（实存 72 帧），1,558,262 字节。
