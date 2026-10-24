# 第六课：让 ESP32 转动舵机

第五课 ESP32 只能读舵机。这一课让它能写**目标位置**，舵机就会转。接线和第五课相同（跳线在 A）。固件版本 `otter-face-0.4.0`。

## 指令

| 发送 | 立刻回复 | 之后上报 |
|---|---|---|
| `SERVO MOVE 1 541` | `OK SERVO MOVE 1 541` | `EVENT servo 1 arrived 537 diff -4` |
| `SERVO CENTER 2` | `OK SERVO CENTER 2` | `EVENT servo 2 arrived 510 diff -1` |
| `SERVO STOP` | `OK SERVO STOP` | 所有舵机停在当前位置并保持 |
| `SERVO RELEASE 1` | `OK SERVO RELEASE 1` | 立刻放松扭力 |

出了问题会上报 `EVENT servo 2 fault <原因> pos … load … …V …C`，并且**已经放松扭力**。原因有：`stalled` 卡住、`blocked` 停下时离目标太远、`timeout` 超时、`unsafe` 电压或温度异常、`no-reply` 没有回应。

停住后 20 秒没有新指令，会自动放松，并上报 `EVENT servo 1 released idle`。

## 从 Mac 试着操作

    cd /Users/zouguoyang/Developer/otter/hardware
    .tools/python/bin/python scripts/face-control.py move 1 541
    .tools/python/bin/python scripts/face-control.py center 1
    .tools/python/bin/python scripts/face-control.py release 1
    .tools/python/bin/python scripts/face-control.py stop

`move` 和 `center` 会等到板子上报“到位”或“故障”才结束；故障时退出码是 1。

## 安全规则

| 规则 | 为什么 |
|---|---|
| 只允许 1 号、2 号 | 编号是白名单，总线上就算多出别的舵机也不会动它 |
| 软件限位 361～661（中点 ±150 步，约 ±44°），同时不能超出舵机自己的限位 | 头部结构还没装好，先只用一小段 |
| 速度固定 40 步/秒 | 和第四课一样慢，出问题时来得及反应 |
| 扭力关着时，先把目标设成当前位置再打开扭力，100 毫秒后才发真正的目标 | 打开的瞬间不会跳；第一次实验时，紧跟在“打开扭力”后面的那条指令曾被忽略 |
| 转动时每 50 毫秒、保持时每 500 毫秒检查一次 | 负载连续 3 次超过 400、电压不在 4.5～6.2V、温度高于 50°C，就放松 |
| 停住的判断：400 毫秒内位置变化不超过 1 步 | 见下面的“踩过的坑” |
| 停下时离目标超过 15 步算 `blocked`；超过预计时间 2 秒算 `timeout` | 被挡住或没动起来时，不会一直用力 |
| 保持 20 秒后自动放松 | 舵机不会一直发热、耗电 |
| 转动中拒绝 `SERVO SCAN`，保持中拒绝 `SERVO PINS` | 扫描会让检查停 1 秒；`PINS` 会暂时断开串口 |

整个转动过程**不阻塞**：`move()` 发出目标就返回，`loop()` 里的 `servo::update()` 负责查进度和安全，所以眨眼、触摸、声音都照常进行。转动中发 `PING` 也能立刻收到 `PONG`。

## 踩过的坑：误判“停下了”

第一版的判断方法是“连续 3 次轮询位置没变化，就算停下”。舵机每秒走 40 步，每 50 毫秒只走 2 步，传感器读数有一点抖动，就可能连续读到同一个值。结果 2 号舵机往 541 走到 524 时，被误判成“停在离目标 17 步的地方”，报了 `blocked`，然后放松了。

改成“400 毫秒内位置变化不超过 1 步才算停下”以后，两个舵机来回转了 12 次，全部到位，偏差在 ±4 步以内。保护机制本身是对的：一判定出问题就放松，并如实上报。只是判定条件要和速度相匹配。

## 实测（2026-10-24）

- 两个舵机在中点 ±30 步之间来回各 6 次，全部到位，偏差 −4～+4 步。
- 超出范围、不在名单里的编号、格式错误的指令都会被拒绝；转动中 `SCAN` 被拒绝，`PING` 正常回应。
- `STOP` 让 2 号停在去 461 的半路（495），并保持住；20 秒后两个都自动放松。

## 下一步

`SERVO MOVE` 是**调试用**的底层指令。按照 PROTOCOL.md，Otter 应用以后只发“有意义的动作”（点头、向左看、回正），不直接发角度。等头部装好、量出实际能转的范围、定下哪个舵机负责左右、哪个负责上下以后，再在它上面加 `nod`、`look_left` 这类预设动作。
