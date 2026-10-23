# 第三课：让水獭发出声音

目标硬件：Waveshare ESP32-S3-Touch-LCD-2.8，V2，板载 PCM5101 音频芯片和功放，喇叭接口配 8Ω 2W 小喇叭。板子没有麦克风，这一课只发声。

## 这段程序做什么

- 在第二课的表情固件上增加两段内置声音：`beep`（单音）和 `chirp`（两声上扬，表示开心）。
- Mac 发送 `SOUND beep` 或 `SOUND chirp`，板子回应 `OK SOUND …` 并播放。
- 声音由程序现场计算正弦波生成，不读 SD 卡、不联网、不需要音频文件。
- 一次只播一段；正在播放时再请求，回应 `ERR sound busy`。
- 固件版本升为 `otter-face-0.2.0`，`INFO` 增加 `audio_available` 字段。

## 声音是怎么出来的

    程序算出数字采样 ──I2S──▶ PCM5101（数字变模拟） ──▶ 功放 ──▶ 喇叭

- **采样**：声音是空气振动。程序每秒算出 16000 个数字（采样率 16 kHz），每个数字表示那一瞬间喇叭膜该推到哪里。
- **正弦波**：880 Hz 的单音，就是每秒振动 880 次的正弦曲线。`chirp` 的后半段让频率从 990 Hz 滑到 1320 Hz，听起来是上扬的。
- **淡入淡出**：每个音的开头和结尾各有 5 毫秒的音量渐变。直接从 0 跳到最大会听到“咔哒”声。
- **I²S**：专门传音频的三线总线。BCLK（GPIO48）是节拍，WS（GPIO38）区分左右声道，DOUT（GPIO47）送数据。引脚来自厂商 V2 示例 `Audio_PCM5101.h`。
- **音量**：程序只用了约 18% 的满幅度，其余交给板上的音量旋钮。

## 为什么要用另一个 CPU 核心

ESP32-S3 有两个核心。Arduino 的 `loop()` 跑在核心 1，每 50 毫秒要往屏幕推一帧约 150 KiB 的画面，推一次就要占用几十毫秒。

如果声音也放在 `loop()` 里写，推画面的那几十毫秒没人送音频数据，声音就会断断续续。所以 `sound.cpp` 在**核心 0** 上开了一个独立的播放任务：

- `loop()` 收到 `SOUND chirp`，只把请求放进一个容量为 1 的队列，马上回复，继续刷新屏幕。
- 播放任务从队列里取出请求，一边算一边写给 I²S。
- 没有声音要播时，I²S 自动输出静音（`auto_clear`），喇叭保持安静。

这是嵌入式里常见的分工：**实时性要求不同的工作，放进不同的任务里**。

## 软件分工

| 文件 | 负责什么 |
|---|---|
| firmware/otter_face/sound.cpp | 初始化 I²S，生成音调，在核心 0 播放 |
| firmware/otter_face/otter_face.ino | 新增 `SOUND` 白名单指令和 `audio_available` |
| scripts/face-control.py | 新增 `beep`、`chirp`；板子回 `ERR` 时立刻显示原话 |

## 编译、烧录、重启

在终端进入项目：

    cd /Users/zouguoyang/Developer/otter/hardware

编译：

    .tools/bin/arduino-cli --config-file .tools/arduino-cli.yaml compile --fqbn 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB' --build-path .tools/build/otter-face --output-dir output/firmware/otter-face --warnings all --jobs 4 firmware/otter_face

烧录：

    .tools/bin/arduino-cli --config-file .tools/arduino-cli.yaml upload -p /dev/cu.usbmodem3101 --fqbn 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB' --input-dir output/firmware/otter-face firmware/otter_face

烧录结束后，板子在这台 Mac 上会停在下载模式，屏幕不会变化。按一下板上的 RST 键，或者用看门狗复位：

    .tools/arduino-data/packages/esp32/tools/esptool_py/5.3.0-cn/esptool --chip esp32s3 -p /dev/cu.usbmodem3101 --after watchdog-reset read-mac

## 从 Mac 试着操作

先确认音频已启动，`audio_available` 应为 `true`：

    .tools/python/bin/python scripts/face-control.py info

播放两段声音：

    .tools/python/bin/python scripts/face-control.py beep
    .tools/python/bin/python scripts/face-control.py chirp

听不到声音时，依次检查：喇叭是否插好；音量旋钮是否调到了最小；`audio_available` 是否为 `true`。

## 自己动手

1. **换个音高**：在 sound.cpp 里把 `beepNotes` 的 `880` 改成 `440`，重新编译、烧录、复位，听听低了八度的声音。
2. **加一段新声音**：仿照 `chirpNotes` 写一个 `sleepyNotes`，比如频率从 600 Hz 慢慢降到 300 Hz，加进 `clips` 列表。还要在 face-control.py 的 `COMMANDS` 里加一个短名字。
3. **摸一下就叫一声**：在 otter_face.ino 检测到触摸的地方调用 `sound::play("chirp")`。想一想：为什么这里不需要等 Mac 下指令？

## 一手资料

- [板卡 V2 说明（板载 PCM5101 与喇叭接口）](https://docs.waveshare.net/ESP32-S3-Touch-LCD-2.8/)
- [官方 V2 示例与原理图](https://docs.waveshare.com/ESP32-S3-Touch-LCD-2.8/Resources-And-Documents)
- [ESP-IDF I2S 标准模式驱动](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/i2s.html)
