# 硬件到货后的第一轮验收

目标板：微雪 ESP32-S3-Touch-LCD-2.8，SKU 27690，V2。先核对实际到货型号和版本；若不是此型号，不照抄引脚。

## 阶段 1：只连接带屏板

1. 拍下板子正反面和版本标签，核对订单。
2. 使用支持数据传输的 USB 线连接 Mac。
3. 按厂商当前 V2 Arduino 教程安装支持包和示例依赖。先采用教程验证过的版本组合。
4. 运行官方屏幕与触摸示例，确认显示正常、触摸位置正确。
5. 烧录 `firmware/serial_probe/serial_probe.ino`，检查 `PING → PONG`。该固件只验证串口，不会显示表情。

当前没有安装 Arduino 工具链，也没有实物，所以不能把提供 `.ino` 文件当成编译或烧录通过。

## 阶段 2：加入头顶触摸

- 屏幕触摸与头顶触摸是两个不同输入。
- 选 3.3V 供电的 TTP223 模块连接方案，核对模块引脚顺序和输出方式。
- 当前板卡文档引出了 GPIO15 / GPIO18，但要在最终固件资源表中确认可用后再接。
- 本地短按反馈先单独通过，再加入向 Mac 上报。
- 装上感应片和外壳后重测灵敏度与误触。

## 阶段 3：单舵机测试

- 核对确实为 SC09；它的额定供电范围是 4～6V。
- 使用独立稳压 5V 电源，经 Bus Servo Adapter (A) 供给舵机。
- 该转接板没有降压：不能把 ST 系列教程的 12V 电源套用到 SC09。
- 按转接板实际 UART 接线图连接信号和公共地；它的丝印接线约定不能凭常见 TX/RX 习惯猜测。
- 不把两个供电源的正极随意并接，不从 ESP32 的 3.3V 引脚给舵机供电。
- 未装负载时只做小角度低速动作，核对中心、方向和停止行为。
- 记录噪声、抖动、温升和供电稳定性，通过后再装第二轴。

## 阶段 4：安装与联动

双舵机必须有不同 ID。先确定支架孔位、头部重量、重心和线缆余量，再画外壳。外壳可以委托打印，预留多次试装。

正式接线表与角度范围以实物和最终固件为准。本文件是验收顺序，暂不是完成的接线图。

## 一手资料

- [带屏板规格、V2 版本和开发入口](https://docs.waveshare.net/ESP32-S3-Touch-LCD-2.8/)
- [乐鑫 Arduino-ESP32 安装](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html)
- [SC09 规格](https://www.waveshare.com/SC09-Servo.htm)
- [Bus Servo Adapter (A) 接线](https://docs.waveshare.net/Bus_Servo_Adapter_A/Product-Wiring-Example/)
- [转接板电源说明](https://docs.waveshare.com/Bus_Servo_Adapter_A/FAQ)
