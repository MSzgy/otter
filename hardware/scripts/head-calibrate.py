"""Calibrate Otter's two-axis head from the Mac (lesson 9).

Servo 1 turns the head left and right, servo 2 tilts it up and down. Jog each
servo with the arrow keys, watch the head, and mark where it faces forward and
how far it can comfortably go each way. The board stores the result and builds
its preset motions (nod, look_left, ...) from it.

While calibrating, the firmware lets each servo use its own full range, but
moves it slowly, at most 30 steps at a time, and still releases it if it jams.
"""

import argparse
import json
import sys
import time
from functools import partial

import serial
from serial.tools import list_ports

FIRMWARE = "otter-face-0.7.0"
PAN, TILT = 1, 2
LOWEST, HIGHEST, MIN_SIDE = 20, 1003, 20
DEGREES_PER_STEP = 300 / 1024
STEPS = (5, 20)
MARKS = {  # key: (label, servo; None marks both)
    "c": ("正前方", None),
    "l": ("最左", PAN),
    "r": ("最右", PAN),
    "u": ("最上", TILT),
    "d": ("最下", TILT),
}
ARROWS = {"[A": "up", "[B": "down", "[C": "right", "[D": "left"}
HELP = """\
方向键 ←/→：1 号舵机（左右）位置 −/+    ↑/↓：2 号舵机（上下）位置 +/−
空格：步长 5 ↔ 20 步（约 1.5° ↔ 6°）
标记：c 正前方（两个舵机一起）  l 最左  r 最右  u 最上（抬头）  d 最下（低头）
x：放松两个舵机    s 或回车：保存到板子    q：不保存退出    h：再看说明
"""


class Board:
    def __init__(self, connection):
        self.connection = connection

    def read_until(self, predicate, timeout=6):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.connection.readline().decode("utf-8", errors="replace").strip()
            if line and predicate(line):
                return line
        raise RuntimeError("设备没有返回预期响应。请确认没有其他程序（比如桌面 App）占用串口。")

    def command(self, command):
        self.connection.write((command + "\n").encode())
        return self.read_until(lambda line: line == "OK " + command or line.startswith("ERR "))

    def position(self, servo):
        self.connection.write(f"SERVO STATUS {servo}\n".encode())
        reply = self.read_until(lambda line: line.startswith(('{"servo":', "ERR ")))
        if reply.startswith("ERR "):
            raise RuntimeError(f"{servo} 号舵机没有回应：{reply}。检查舵机电源和连线。")
        return json.loads(reply)["pos"]


def keys(stream):
    while ch := stream.read(1):
        yield ARROWS.get(stream.read(2), "") if ch == "\x1b" else ch


def problem(marks):
    missing = [label for key, (label, _) in MARKS.items() if key not in marks]
    if missing:
        return "还没标记：" + "、".join(missing)
    pan_center, tilt_center = marks["c"]
    for axis, center, a, b in (
        ("左右", pan_center, marks["l"], marks["r"]),
        ("上下", tilt_center, marks["u"], marks["d"]),
    ):
        if (a - center) * (b - center) >= 0:
            return f"{axis}的两头必须分在正前方的两边"
        if min(abs(a - center), abs(b - center)) < MIN_SIDE:
            return f"{axis}每边至少要能转 {MIN_SIDE} 步（约 6°）"
    return None


def degrees(steps):
    return f"{abs(steps) * DEGREES_PER_STEP:.0f}°"


class Calibration:
    def __init__(self, board):
        self.board = board
        self.position = {PAN: board.position(PAN), TILT: board.position(TILT)}
        self.marks = {}
        self.step = STEPS[0]

    def show(self):
        marked = "  ".join(
            f"{label} {self.marks[key]}" if key in self.marks else f"{label} —"
            for key, (label, _) in MARKS.items()
        )
        pan, tilt = self.position[PAN], self.position[TILT]
        print(f"1号 {pan:4}  2号 {tilt:4}  步长 {self.step:2} │ {marked}", flush=True)

    def jog(self, servo, delta):
        target = min(HIGHEST, max(LOWEST, self.position[servo] + delta))
        reply = self.board.command(f"SERVO MOVE {servo} {target}")
        if reply.startswith("ERR "):
            print("板子拒绝了：" + reply, flush=True)
            return
        prefixes = (f"EVENT servo {servo} arrived", f"EVENT servo {servo} fault")
        event = self.board.read_until(lambda line: line.startswith(prefixes), timeout=5)
        if " fault " in event:
            print("被挡住或出了问题，舵机已经放松：" + event, flush=True)
            print("这里就是极限附近。往回退一点，再标记。", flush=True)
        self.position[servo] = self.board.position(servo)

    def mark(self, key):
        label, servo = MARKS[key]
        if servo is None:
            self.marks[key] = (self.board.position(PAN), self.board.position(TILT))
        else:
            self.marks[key] = self.board.position(servo)
        print(f"已标记 {label}", flush=True)

    def save(self):
        if why := problem(self.marks):
            print("还不能保存：" + why, flush=True)
            return False
        pan_center, tilt_center = self.marks["c"]
        values = [self.marks["l"], pan_center, self.marks["r"]]
        values += [self.marks["u"], tilt_center, self.marks["d"]]
        reply = self.board.command("HEAD SAVE " + " ".join(map(str, values)))
        if reply.startswith("ERR "):
            print("板子拒绝了：" + reply, flush=True)
            return False
        print(
            f"已保存。左 {degrees(self.marks['l'] - pan_center)}、"
            f"右 {degrees(self.marks['r'] - pan_center)}；"
            f"上 {degrees(self.marks['u'] - tilt_center)}、"
            f"下 {degrees(self.marks['d'] - tilt_center)}。",
            flush=True,
        )
        return True

    def run(self, stream, flush_input):
        print(HELP, flush=True)
        self.show()
        for key in keys(stream):
            if key in ("left", "right"):
                self.jog(PAN, self.step if key == "right" else -self.step)
            elif key in ("up", "down"):
                self.jog(TILT, self.step if key == "up" else -self.step)
            elif key == " ":
                self.step = STEPS[1] if self.step == STEPS[0] else STEPS[0]
            elif key in MARKS:
                self.mark(key)
            elif key == "x":
                for servo in (PAN, TILT):
                    self.board.command(f"SERVO RELEASE {servo}")
                print("两个舵机都放松了。", flush=True)
            elif key in ("s", "\n", "\r"):
                if self.save():
                    return True
            elif key == "q":
                return False
            elif key == "h":
                print(HELP, flush=True)
                continue
            else:
                continue
            self.show()
            flush_input()  # keys typed during a move would otherwise run on after release
        return False


def open_port(port):
    ports = [p.device for p in list_ports.comports() if p.vid == 0x303A]
    if not port:
        if len(ports) != 1:
            raise RuntimeError("无法唯一确定设备，请用 --port 指定。候选：" + ", ".join(ports))
        port = ports[0]
    elif port not in ports:
        raise RuntimeError("指定端口不是当前识别到的 Espressif USB 设备。请检查连接。")
    return serial.Serial(port, 115200, timeout=0.2, write_timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", help="例如 /dev/cu.usbmodem3101")
    args = parser.parse_args()
    with open_port(args.port) as connection:
        time.sleep(1.2)
        connection.reset_input_buffer()
        board = Board(connection)
        connection.write(b"INFO\n")
        info = json.loads(board.read_until(lambda line: line.startswith('{"firmware":')))
        if info.get("firmware") != FIRMWARE:
            raise RuntimeError(f"设备固件不是 {FIRMWARE}，请先烧录。")
        saved = False
        if board.command("HEAD CALIBRATE").startswith("ERR "):
            raise RuntimeError("板子没有进入标定模式。")
        try:
            calibration = Calibration(board)
            if sys.stdin.isatty():
                import termios
                import tty

                fd = sys.stdin.fileno()
                previous = termios.tcgetattr(fd)
                tty.setcbreak(fd)
                try:
                    flush = partial(termios.tcflush, fd, termios.TCIFLUSH)
                    saved = calibration.run(sys.stdin, flush)
                finally:
                    termios.tcsetattr(fd, termios.TCSADRAIN, previous)
            else:
                saved = calibration.run(sys.stdin, lambda: None)
        finally:
            if not saved:
                board.command("SERVO STOP")
                board.command("HEAD CANCEL")
                print("没有保存，板子上原来的标定不变。", flush=True)
        if not saved:
            return
        board.command("MOTION center")
        print(board.read_until(lambda line: line.startswith("EVENT motion center ")), flush=True)
        print("试试：.tools/python/bin/python scripts/face-control.py motion nod", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except (RuntimeError, serial.SerialException, ValueError) as error:
        print("错误：" + str(error), file=sys.stderr)
        sys.exit(1)
