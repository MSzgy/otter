# 第二课：真实屏幕上的第一双眼睛

目标硬件：Waveshare ESP32-S3-Touch-LCD-2.8，V2，ST7789 显示芯片、CST3530 触摸芯片。

## 这段程序做什么

- 上电显示水獭眼睛，每隔约 4.2 秒眨一次眼。
- 点一下屏幕，开心约 2.8 秒，然后恢复陪伴状态。
- Mac 通过 USB 发送有限的文字指令，可以切换开心、思考、说话和休息。
- 这一步使用的是屏幕触摸，不是头顶 TTP223 触摸片。
- 程序没有控制舵机，没有启动 Wi-Fi，也没有连接模型。

编译与烧录结果、真实屏幕观察结果应以本次硬件验收记录为准。

## 软件分工

| 文件 | 负责什么 |
|---|---|
| firmware/otter_face/otter_face.ino | 接收 USB 指令、读取屏幕触摸、管理表情状态 |
| firmware/otter_face/display.cpp | 初始化屏幕，把像素通过 SPI 发给 ST7789 |
| firmware/otter_face/face.cpp | 把眼睛、嘴巴和胡须画到内存中的画布 |
| scripts/face-control.py | 从 Mac 发送指令，读取真实固件回应 |

屏幕内存画布为 240×320 像素，每像素 2 字节，约 150 KiB。先尝试放到板载 8 MB PSRAM 中，分配失败时才尝试内部内存。

## 从 Mac 试着操作

在终端进入项目：

    cd /Users/zouguoyang/Developer/otter/hardware

读取真实板卡状态：

    .tools/python/bin/python scripts/face-control.py info

让它开心：

    .tools/python/bin/python scripts/face-control.py happy

让它休息，再叫醒：

    .tools/python/bin/python scripts/face-control.py sleep
    .tools/python/bin/python scripts/face-control.py idle

验证双向通信：

    .tools/python/bin/python scripts/face-control.py ping

正常回应为 PONG。USB 端口编号变化是正常情况，工具会寻找唯一的 Espressif USB 设备；连接多个设备时必须明确指定 --port。

## 自己改一个参数

在 otter_face.ino 中找到：

    constexpr uint32_t happyDurationMs = 2800;

2800 的单位是毫秒，即 2.8 秒。改成 4000 后需要重新编译、烧录，真实屏幕的开心表情才会保持 4 秒。

这与网页预演台不同：网页修改脚本后刷新即可；微控制器运行的是写入 Flash 的固件，保存电脑上的源文件不会自动更新板子。

## 当前工具链

- Arduino CLI 1.5.1，安装在本项目 .tools/bin。
- ESP32 Arduino Core 3.3.10-cn，来自乐鑫官方国内镜像。
- 已将镜像中当前 macOS 工具与原站的 SHA-256 对比，保持一致。
- 开发板使用 ESP32S3 Dev Module，16 MB Flash、OPI PSRAM、Hardware CDC and JTAG、USB CDC On Boot 开启。
- 分区使用 app3M_fat9M_16MB；第一版暂不使用文件系统。

编译命令：

    .tools/bin/arduino-cli --config-file .tools/arduino-cli.yaml compile --fqbn 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB' --build-path .tools/build/otter-face --output-dir output/firmware/otter-face --warnings all --jobs 4 firmware/otter_face

## 原厂备份

首次改写固件前，已经将整片 16 MB Flash 读出，并通过 esptool 的 verify-flash 检查，摘要与板内内容一致。

- 文件：backups/2026-10-23/waveshare-2.8-v2-factory.bin
- 校验与硬件信息：同目录 waveshare-2.8-v2-factory.json
- SHA-256：adc928fee4a3548cba4c6386576e9ed0c3ceb33eb82ba48f9e3c795c82aca810

请保留这份备份。恢复操作会覆盖当前固件，应在明确要恢复时核对设备后执行；本课不自动恢复。

## 一手资料

- [板卡 V2 说明](https://docs.waveshare.com/ESP32-S3-Touch-LCD-2.8)
- [官方 V2 示例与原理图](https://docs.waveshare.com/ESP32-S3-Touch-LCD-2.8/Resources-And-Documents)
- [官方 Arduino 示例说明](https://docs.waveshare.com/ESP32-S3-Touch-LCD-2.8/Arduino)
- [ESP32-S3 下载模式说明](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/advanced-topics/boot-mode-selection.html)
