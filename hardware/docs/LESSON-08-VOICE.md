# 第八课：水獭会说话

像素水獭的 21 种表情，每种配了一句很短的语音，比如摸头时说“嘿嘿！”、提醒到点说“时间到啦！”、办好了说“办好啦！”。这一课把它们放进 ESP32，由板子的喇叭播放。固件版本 `otter-face-0.6.0`。

## 素材

`assets/pixel_game/voice/`：21 条 16 kHz、单声道、有符号 16 位（小端）PCM，每条 0.48～1.40 秒，共 18.6 秒、581 KiB。用 `gpt-4o-mini-tts`（nova 音色）生成，清单里有每条的台词、时长、SHA-256 和播放规则。

刚好和喇叭本来用的 16 kHz 一致，不需要重采样。量过响度：语音 RMS 约 -20 dBFS，原来的“啾”约 -17.8 dBFS，差不多一样响，所以原样播放、不再缩放。

## Flash 里的布局

    ffat 分区（0x610000 起，9.9 MB）
      +0x000000  像素动画包 pixel_game.bin（1.8 MB）
      +0x200000  语音包 voices.bin（0.6 MB）

`scripts/build-voice-pack.py` 逐条核对 SHA-256 和格式，打包成 `OTVO` 格式：头部 16 字节、每条 32 字节的索引（名字、位置、长度），后面是 PCM。`build-pixel-skin.py` 现在会检查动画包不超过 2 MiB，两者不会重叠。

    python3 scripts/build-voice-pack.py assets/pixel_game/voice output/pixel_skin/voices.bin
    .tools/arduino-data/packages/esp32/tools/esptool_py/5.3.0-cn/esptool --chip esp32s3 -p /dev/cu.usbmodem3101 --after watchdog-reset write-flash 0x810000 output/pixel_skin/voices.bin

## 板子怎么播放

- 播放任务还是第三课那个，跑在核心 0。队列里一次只有一个待播项：一段音效或一条语音。
- **边读边播**：每次从 Flash 读 256 个采样（512 字节），单声道复制到左右声道写给 I²S。整条语音不进内存。
- **新的替换旧的**：`SAY` 会设一个“打断”标记，正在播的那条在下一块之前停下，新的一条接着播。始终只有一个声音。
- 没有语音包或格式不对：`voices` 为 0，`SAY` 回 `ERR voice unavailable`，音效照常。

## 指令

| 发送 | 回复 |
|---|---|
| `SAY happy` | `OK SAY happy`，打断正在播放的声音 |
| `SAY STOP` | `OK SAY STOP` |
| `SAY LIST` | `{"voices":["idle","happy",...]}` |
| `INFO` | 新增 `"voices":21` |

`SOUND` 在播语音时仍回 `ERR sound busy`，不会叠音。

**点屏幕说“嘿嘿！”**：这是板子自己的反应，不等 Mac。正在播放时点击保持安静，连点不会一直重来；没有语音包时退回“啾”。

从 Mac 试：

    .tools/python/bin/python scripts/face-control.py say reminder
    .tools/python/bin/python scripts/face-control.py hush

## 什么时候说：由桌面 App 决定

板子只管“说哪句”，“什么时候说”按语音包的规则由桌面桥接（`desktop/electron/body.cjs`）决定：

- 状态**真正切换进来**时说一次；刚连上或重连时补发的那个表情不算，不说。
- 每句 5 秒冷却。
- 不自动说：`idle`、`focus`、`speaking`（只供手动），`listening`（必须在开麦之前，桥接看不到麦克风）。
- 安静模式不说；专注期间只有提醒说话。
- Mac 开始朗读时先发 `SAY STOP`，不和真实语音叠在一起。
- 提醒到点说“时间到啦！”，代替原来的“啾”。
- 点屏幕后 3 秒内，桌面那边的摸头不再让板子重复说“嘿嘿”。

这些规则写在桌面代码里，有一项测试会读取 `voice/manifest.json` 核对它们，语音包改了规则测试就会提醒。

## 实测（2026-10-25）

- 写入后 `INFO` 报 `"voices":21`；`SAY LIST` 列出 21 条；21 条 `SAY` 都回 `OK`。
- 连发两条：后一条回 `OK`；播放中 `SOUND chirp` 回 `busy`；播放中 `PING` 立即回 `PONG`；`SAY STOP`、未知台词、换表情都正常。
- 桌面桥接的语音规则有 7 项新测试；桌面单元测试共 86 项、端到端冒烟测试都通过。
- **还需要人耳确认**：语速和音高是否正常、打断是否干净、喇叭里有没有破音。
