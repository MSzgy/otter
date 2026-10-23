"""Send a small, allowlisted command to Otter's first physical face firmware."""

import argparse
import json
import sys
import time

import serial
from serial.tools import list_ports

FIRMWARE = "otter-face-0.2.0"
COMMANDS = {
    "info": "INFO",
    "ping": "PING",
    "blink": "BLINK",
    "idle": "FACE idle",
    "happy": "FACE happy",
    "sleep": "FACE sleeping",
    "thinking": "FACE thinking",
    "speaking": "FACE speaking",
    "beep": "SOUND beep",
    "chirp": "SOUND chirp",
}


def read_until(connection, predicate, timeout=6):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = connection.readline().decode("utf-8", errors="replace").strip()
        if line and predicate(line):
            return line
    raise RuntimeError("设备没有返回预期响应。请确认已烧录 otter_face，且没有其他程序占用串口。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=COMMANDS, nargs="?", default="info")
    parser.add_argument(
        "--port", help="例如 /dev/cu.usbmodem3101；省略时只接受唯一的 Espressif USB 设备"
    )
    parser.add_argument("--listen", type=int, default=0, help="命令后监听触摸事件的秒数，0～30")
    args = parser.parse_args()
    if not 0 <= args.listen <= 30:
        parser.error("--listen 必须在 0～30 秒之间")
    ports = [port.device for port in list_ports.comports() if port.vid == 0x303A]
    port = args.port
    if not port:
        if len(ports) != 1:
            raise RuntimeError("无法唯一确定设备，请用 --port 指定。候选：" + ", ".join(ports))
        port = ports[0]
    elif port not in ports:
        raise RuntimeError("指定端口不是当前识别到的 Espressif USB 设备。请检查连接。")
    with serial.Serial(port, 115200, timeout=0.2, write_timeout=2) as connection:
        time.sleep(1.2)
        connection.reset_input_buffer()
        connection.write(b"INFO\n")
        response = read_until(connection, lambda line: line.startswith('{"firmware":'))
        info = json.loads(response)
        if info.get("firmware") != FIRMWARE:
            raise RuntimeError(f"设备固件不是 {FIRMWARE}；没有发送指令。")
        if args.action == "info":
            print(json.dumps(info, ensure_ascii=False, indent=2), flush=True)
        else:
            command = COMMANDS[args.action]
            connection.write((command + "\n").encode())
            expected = "PONG" if args.action == "ping" else "OK " + command
            reply = read_until(connection, lambda line: line == expected or line.startswith("ERR "))
            if reply.startswith("ERR "):
                raise RuntimeError("设备拒绝了指令：" + reply)
            print(reply, flush=True)
        if args.listen:
            print(f"正在监听 {args.listen} 秒，可以点一下屏幕。", flush=True)
            deadline = time.monotonic() + args.listen
            while time.monotonic() < deadline:
                line = connection.readline().decode("utf-8", errors="replace").strip()
                if line:
                    print(line, flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, serial.SerialException, ValueError) as error:
        print("错误：" + str(error), file=sys.stderr)
        sys.exit(1)
