# 第五课：让 ESP32 读舵机（只读）

上一课是 Mac 直接控制舵机。这一课把舵机控制板改接到 ESP32 上：板子自己就能找到舵机、读出状态。这一版**只读不写**，舵机不会动。

## 接线

    ESP32 4 针 UART 座            舵机控制板 UART（跳线插 A）
      TXD（GPIO43）  ──橙──▶  TX
      RXD（GPIO44）  ──黄──▶  RX
      GND            ──黑──▶  GND
      3V3            ──红──   不接，线头要包好

- **同名相接**：TX 接 TX，RX 接 RX。这是 Waveshare 的接法，和常见的“交叉接”相反，实测这样接是通的。
- **跳线帽要插在 A**（UART → 舵机）。跳线排针有三排，中间一排是公共端。帽子盖住**上面两排**、露出最下面一排才是 A；露出最上面一排就是 B（USB）。这一课排查了很久，最后发现就是跳线还在 B。
- 用 ESP32 上的 **4 针 UART 座**比 12 针排针更不容易插错。这根 4 芯线里有一根红线是 3V3 电源，线头一定要包好：碰到地或金属就会把 ESP32 的电源短路。
- 舵机仍然由控制板的 DC 5V 供电。ESP32 和控制板之间只接三根线，两边各用各的电，只有地线连在一起。

## 板子上的程序

| 文件 | 负责什么 |
|---|---|
| firmware/otter_face/servo.cpp | 用 UART1（GPIO43/44，1 Mbps）收发总线舵机协议，只发 PING 和 READ |
| firmware/otter_face/otter_face.ino | 新增 `SERVO …` 白名单指令，版本升为 `otter-face-0.3.0` |
| scripts/face-control.py | 新增 `servos`：先扫描，再逐个读状态 |

USB 串口（和 Mac 通信）和 UART1（和舵机通信）是两条独立的通道，互不影响。ESP32 的协议代码和第四课 Mac 上那份 Python 代码思路一样：组包、发送、等回复、跳过可能出现的回声、核对编号和校验。区别在于 ESP32 直接接串口，回复几百微秒就到，所以等待窗口只要几毫秒；Mac 那边要隔一层 USB 芯片，得等几十毫秒。

## 指令

| 发送 | 回复 |
|---|---|
| `SERVO SCAN` | `{"servos":[1,2]}`。会扫描编号 0～253，大约需要 1 秒，期间表情停一下 |
| `SERVO STATUS 1` | `{"servo":1,"pos":514,"load":0,"volts":5.1,"temp":20,"torque":false}` |
| `SERVO RAW 1` | 诊断用：发一次 PING，原样报回 10 毫秒内收到的所有字节 |
| `SERVO PINS` | 诊断用：GPIO43/44 只作输入，分别开下拉、上拉，读空闲电平 |

## 从 Mac 试着操作

    cd /Users/zouguoyang/Developer/otter/hardware
    .tools/python/bin/python scripts/face-control.py servos

正常的输出：

    找到舵机： [1, 2]
    {"servo":1,"pos":514,"load":0,"volts":5.1,"temp":20,"torque":false}
    {"servo":2,"pos":518,"load":0,"volts":5.0,"temp":20,"torque":false}

## 排查时怎么看诊断结果

| 现象 | 说明 |
|---|---|
| `SERVO RAW` 收到 0 字节，`SERVO PINS` 两个脚都是 `down=0 up=1` | 两根线都没连到控制板的有源输出：跳线不在 A、线没插对，或者地线没接 |
| `SERVO PINS` 两个脚都是 `down=1 up=1` | 控制板在驱动这两根线，接线和跳线都对了 |
| `SERVO RAW 1` 收到 `ff ff 01 02 00 fc` | 1 号舵机正常应答，`00` 表示没有错误 |

## 一手资料

- [Bus Servo Adapter (A) 说明](https://www.waveshare.com/wiki/Bus_Servo_Adapter_(A))
- [板卡 V2 说明（UART 接口引脚）](https://docs.waveshare.net/ESP32-S3-Touch-LCD-2.8/)
