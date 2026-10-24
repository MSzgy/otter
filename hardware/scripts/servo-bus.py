"""Talk to SC-series bus servos through Waveshare Bus Servo Adapter (A) over USB.

Setup: adapter jumper on B (USB), servos powered from the adapter's DC input.
The register map is the SCS series (16-bit values high byte first). Writes are
limited to torque enable and goal position/time/speed; set-id also writes Lock and ID.
"""

import argparse
import sys
import time

import serial
from serial.tools import list_ports

ADAPTER_VID = 0x1A86  # WCH CH343 USB-to-serial chip on the adapter
BAUD = 1_000_000  # factory default for SC09
OTHER_BAUDS = (500_000, 250_000, 128_000, 115_200, 76_800, 57_600, 38_400)
PING, READ, WRITE = 0x01, 0x02, 0x03
ADDR_ID, ADDR_LIMITS, ADDR_TORQUE, ADDR_GOAL, ADDR_LOCK = 5, 9, 40, 42, 48
ADDR_STATUS, ADDR_MOVING = 56, 66
CENTER = 511
MAX_STEP = 30  # largest single move, about 9 degrees (300 degrees / 1024 steps)
DEFAULT_SPEED, MAX_SPEED = 40, 100  # steps per second
SAFE_VOLTS, MAX_TEMP = (4.5, 6.2), 50  # SC09 is rated 4-6 V


class BusError(RuntimeError):
    pass


def checksum(body):
    return (~sum(body)) & 0xFF


def packet(servo_id, instruction, params=b""):
    body = bytes([servo_id, len(params) + 2, instruction]) + bytes(params)
    return b"\xff\xff" + body + bytes([checksum(body)])


def parse(data, request, servo_id):
    if data.startswith(request):  # half-duplex adapters may echo our own bytes
        data = data[len(request) :]
    start = data.find(b"\xff\xff")
    if start < 0 or len(data) < start + 4:
        return None
    end = start + 4 + data[start + 3]
    reply = data[start:end]
    if len(reply) != end - start or reply[2] != servo_id or checksum(reply[2:-1]) != reply[-1]:
        return None
    return reply[4], reply[5:-1]  # error byte, payload


def be16(value):
    return bytes([(value >> 8) & 0xFF, value & 0xFF])


class Bus:
    def __init__(self, port):
        self.port = port

    def transact(self, servo_id, instruction, params=b"", window=0.06):
        # The CH343 on macOS can deliver a reply well after 20 ms, so wait up to
        # `window` but return as soon as a complete, valid reply has arrived.
        request = packet(servo_id, instruction, params)
        self.port.reset_input_buffer()
        self.port.write(request)
        self.port.flush()
        deadline = time.monotonic() + window
        data = b""
        while time.monotonic() < deadline:
            data += self.port.read(256)
            result = parse(data, request, servo_id)
            if result:
                return result
        return None

    def call(self, servo_id, instruction, params=b""):
        # Replies are occasionally lost, in bursts of up to three while a motor runs.
        for _ in range(6):
            result = self.transact(servo_id, instruction, params)
            if result is not None:
                return result
            time.sleep(0.02)
        raise BusError(f"{servo_id} 号舵机没有回应")

    def ping(self, servo_id, tries=2):
        return any(self.transact(servo_id, PING) for _ in range(tries))

    def read(self, servo_id, addr, count):
        return self.call(servo_id, READ, bytes([addr, count]))[1]

    def write(self, servo_id, addr, data):
        return self.call(servo_id, WRITE, bytes([addr]) + bytes(data))[0]

    def status(self, servo_id):
        d = self.read(servo_id, ADDR_STATUS, 8)
        return {
            "pos": d[0] << 8 | d[1],
            "load": (d[4] << 8 | d[5]) & 0x3FF,
            "volts": d[6] / 10,
            "temp": d[7],
        }

    def release(self, servo_id):
        return any(
            self.transact(servo_id, WRITE, bytes([ADDR_TORQUE, 0])) is not None for _ in range(5)
        )


def describe(status):
    return (
        f"位置 {status['pos']:4d}  负载 {status['load']:3d}  "
        f"{status['volts']:.1f}V  {status['temp']}°C"
    )


def check_safe(bus, servo_id, status):
    volts_ok = SAFE_VOLTS[0] <= status["volts"] <= SAFE_VOLTS[1]
    if not volts_ok or status["temp"] > MAX_TEMP:
        bus.release(servo_id)
        raise BusError(f"读数异常（{status['volts']}V，{status['temp']}°C），已放松扭力")


def angle_limits(bus, servo_id):
    d = bus.read(servo_id, ADDR_LIMITS, 4)
    return d[0] << 8 | d[1], d[2] << 8 | d[3]


def hold_here(bus, servo_id, speed):
    status = bus.status(servo_id)
    check_safe(bus, servo_id, status)
    # Goal = where it already is, so turning torque on cannot make it jump.
    bus.write(servo_id, ADDR_GOAL, be16(status["pos"]) + be16(0) + be16(speed))
    bus.write(servo_id, ADDR_TORQUE, [1])
    time.sleep(0.1)  # the first goal sent right after torque-on was once ignored
    return status["pos"]


def step_to(bus, servo_id, target, speed):
    bus.write(servo_id, ADDR_GOAL, be16(target) + be16(0) + be16(speed))
    started = time.monotonic()
    time.sleep(0.1)
    while bus.read(servo_id, ADDR_MOVING, 1)[0] and time.monotonic() - started < 3:
        time.sleep(0.02)
    time.sleep(0.15)
    status = bus.status(servo_id)
    check_safe(bus, servo_id, status)
    if abs(status["pos"] - target) > 15:
        bus.release(servo_id)
        raise BusError(f"没有到位：目标 {target}，实际 {status['pos']}，已放松扭力")
    diff = status["pos"] - target
    note = "  ⚠ 没完全到位" if abs(diff) > 3 else ""
    print(f"  → {target:4d}  {describe(status)}  偏差 {diff:+d}{note}", flush=True)
    return status


def travel(bus, servo_id, target, speed):
    pos = hold_here(bus, servo_id, speed)
    while pos != target:
        pos += max(-MAX_STEP, min(MAX_STEP, target - pos))
        step_to(bus, servo_id, pos, speed)


def find_port(requested):
    ports = [p.device for p in list_ports.comports() if p.vid == ADAPTER_VID]
    if requested:
        if requested not in ports:
            raise BusError("指定端口不是舵机控制板（CH343）。请检查连接。")
        return requested
    if len(ports) != 1:
        raise BusError("无法唯一确定舵机控制板，请用 --port 指定。候选：" + ", ".join(ports))
    return ports[0]


def open_bus(args, baud=BAUD):
    port = serial.Serial(find_port(args.port), baud, timeout=0.002)
    time.sleep(0.3)
    return port, Bus(port)


def scan_ids(bus):
    return [i for i in range(0, 254) if bus.ping(i)]


def cmd_scan(args):
    for baud in (BAUD, *OTHER_BAUDS) if args.all_bauds else (BAUD,):
        port, bus = open_bus(args, baud)
        with port:
            found = scan_ids(bus)
            print(f"{baud} bps：找到 {found or '无'}", flush=True)
            for servo_id in found:
                print(f"  {servo_id} 号  {describe(bus.status(servo_id))}", flush=True)
    return 0


def cmd_status(args):
    port, bus = open_bus(args)
    with port:
        status = bus.status(args.id)
        low, high = angle_limits(bus, args.id)
        torque = bus.read(args.id, ADDR_TORQUE, 1)[0]
        torque_text = "开" if torque else "关"
        print(f"{args.id} 号  {describe(status)}  扭力 {torque_text}  限位 {low}～{high}")
    return 0


def cmd_monitor(args):
    port, bus = open_bus(args)
    with port:
        print(f"监听 {args.seconds} 秒：每 0.5 秒问一次 {args.id} 号舵机（只读）。", flush=True)
        start = time.monotonic()
        state, since, samples, answered = None, None, 0, 0
        while time.monotonic() - start < args.seconds:
            reply = bus.transact(args.id, READ, bytes([ADDR_STATUS, 8]))
            elapsed = time.monotonic() - start
            samples += 1
            online = reply is not None
            answered += online
            if online != state:
                if online:
                    d = reply[1]
                    print(f"[{elapsed:6.1f}s] 在线  {d[6] / 10:.1f}V  {d[7]}°C", flush=True)
                    since = elapsed
                else:
                    lasted = f"（这次在线 {elapsed - since:.0f} 秒）" if since is not None else ""
                    print(f"[{elapsed:6.1f}s] 离线{lasted}", flush=True)
                state = online
            time.sleep(0.5)
        print(f"结束：共查询 {samples} 次，有回应 {answered} 次。")
    return 0


def cmd_move(args):
    target = CENTER if args.target == "center" else int(args.target)
    port, bus = open_bus(args)
    with port:
        low, high = angle_limits(bus, args.id)
        if not low <= target <= high:
            raise BusError(f"目标 {target} 超出舵机限位 {low}～{high}")
        print(f"{args.id} 号  {describe(bus.status(args.id))}  → 目标 {target}", flush=True)
        try:
            travel(bus, args.id, target, args.speed)
        finally:
            if not args.hold:
                bus.release(args.id)
        print("保持扭力。" if args.hold else "已放松扭力。")
    return 0


def cmd_wiggle(args):
    port, bus = open_bus(args)
    with port:
        low, high = angle_limits(bus, args.id)
        here = bus.status(args.id)["pos"]
        if not (low <= here - args.offset and here + args.offset <= high):
            raise BusError(f"当前位置 {here} 离限位 {low}～{high} 太近，无法摆动")
        try:
            origin = hold_here(bus, args.id, DEFAULT_SPEED)
            print(f"{args.id} 号从 {origin} 左右各摆 {args.offset} 步，两次：", flush=True)
            for _ in range(2):
                for target in (origin + args.offset, origin, origin - args.offset, origin):
                    step_to(bus, args.id, target, DEFAULT_SPEED)
        finally:
            bus.release(args.id)
        print("已放松扭力。")
    return 0


def cmd_set_id(args):
    if args.new == args.old:
        raise BusError("新旧编号相同，不需要修改。")
    if not args.yes:
        raise BusError("改编号会永久写入舵机。总线上只接这一个舵机，确认后加 --yes 再运行。")
    port, bus = open_bus(args)
    with port:
        found = scan_ids(bus)
        if found != [args.old]:
            raise BusError(f"总线上必须只有 {args.old} 号一个舵机，现在找到 {found or '无'}。")
        lock = bus.read(args.old, ADDR_LOCK, 1)[0]
        if lock not in (0, 1) or bus.read(args.old, ADDR_ID, 1)[0] != args.old:
            raise BusError("锁定或编号寄存器读数不对，可能不是 SC 系列舵机，没有写入。")
        bus.write(args.old, ADDR_LOCK, [0])  # unlock so the new ID is saved
        # The reply to the ID change may come back under either ID, so don't wait for it.
        bus.port.reset_input_buffer()
        bus.port.write(packet(args.old, WRITE, bytes([ADDR_ID, args.new])))
        bus.port.flush()
        time.sleep(0.05)
        bus.write(args.new, ADDR_LOCK, [1])  # lock again, now addressed by the new ID
        ok = bus.ping(args.new, 3) and not bus.ping(args.old, 3)
        saved = bus.read(args.new, ADDR_ID, 1)[0]
        mark = "✓" if ok else "✗"
        print(f"{args.new} 号回应 {mark}，编号寄存器 {saved}。断电重启后再扫一次确认。")
    return 0 if ok and saved == args.new else 1


def servo_id(text):
    value = int(text)
    if not 0 <= value <= 253:
        raise argparse.ArgumentTypeError("编号必须在 0～253 之间")
    return value


def position(text):
    if text == "center":
        return text
    value = int(text)
    if not 0 <= value <= 1023:
        raise argparse.ArgumentTypeError("位置必须在 0～1023 之间，或写 center")
    return str(value)


def bounded(low, high):
    def parse_value(text):
        value = int(text)
        if not low <= value <= high:
            raise argparse.ArgumentTypeError(f"必须在 {low}～{high} 之间")
        return value

    return parse_value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--port", help="例如 /dev/cu.usbmodem5B901475431；省略时只接受唯一的 CH343 设备"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="查找总线上的舵机（只读）")
    scan.add_argument("--all-bauds", action="store_true", help="1 Mbps 之外也试其他常见波特率")
    scan.set_defaults(run=cmd_scan)

    status = sub.add_parser("status", help="读取一个舵机的状态（只读）")
    status.add_argument("id", type=servo_id)
    status.set_defaults(run=cmd_status)

    monitor = sub.add_parser("monitor", help="持续检查一个舵机是否在线（只读）")
    monitor.add_argument("id", type=servo_id)
    monitor.add_argument("--seconds", type=bounded(1, 600), default=180)
    monitor.set_defaults(run=cmd_monitor)

    move = sub.add_parser("move", help=f"从当前位置分步慢慢转到目标（每步最多 {MAX_STEP}）")
    move.add_argument("id", type=servo_id)
    move.add_argument("target", type=position, help="0～1023，或 center（511）")
    move.add_argument("--speed", type=bounded(1, MAX_SPEED), default=DEFAULT_SPEED, help="步/秒")
    move.add_argument("--hold", action="store_true", help="到位后保持扭力（默认放松）")
    move.set_defaults(run=cmd_move)

    wiggle = sub.add_parser("wiggle", help="原地左右轻轻摆两次，用来认出是哪一个舵机")
    wiggle.add_argument("id", type=servo_id)
    # Moves of about 5 steps or less can stall on gear friction: load rises, position stays.
    wiggle.add_argument(
        "--offset", type=bounded(8, MAX_STEP), default=10, help="每边几步（8～30，太小推不动）"
    )
    wiggle.set_defaults(run=cmd_wiggle)

    set_id = sub.add_parser("set-id", help="修改编号（总线上只能接这一个舵机）")
    set_id.add_argument("old", type=servo_id)
    set_id.add_argument("new", type=servo_id)
    set_id.add_argument("--yes", action="store_true", help="确认要永久写入")
    set_id.set_defaults(run=cmd_set_id)

    args = parser.parse_args()
    return args.run(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (BusError, serial.SerialException, ValueError) as error:
        print("错误：" + str(error), file=sys.stderr)
        sys.exit(1)
