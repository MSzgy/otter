/*
 * Otter 第一块板子：串口自检
 *
 * 这是独立的入门固件，不实现屏幕、触摸或舵机驱动，也不实现预演台 JSON 协议。
 * 在 Arduino IDE 中按对应板卡教程开启 USB CDC On Boot，并选择正确端口。
 * 烧录后打开 115200 波特率串口监视器，行结束符选“新行”。
 * 输入 PING 应收到 PONG；输入 HELP 查看说明。
 * 不接舵机，仅通过 USB 供电测试。
 */
#include <Arduino.h>

static char lineBuffer[96];
static size_t lineLength = 0;
static bool discardingLine = false;

static void handleLine(const char *line) {
  if (strcmp(line, "PING") == 0) {
    Serial.println("PONG");
  } else if (strcmp(line, "HELP") == 0) {
    Serial.println("OTTER SERIAL PROBE v0.1 | commands: PING, HELP");
  } else if (line[0] != '\0') {
    Serial.println("ERR unknown command; try PING or HELP");
  }
}

void setup() {
  Serial.begin(115200);
  const uint32_t startedAt = millis();
  // 不让未打开串口监视器的设备无限等待。
  while (!Serial && (uint32_t)(millis() - startedAt) < 2000) delay(10);
  Serial.println("OTTER READY | send PING with a newline");
}

void loop() {
  while (Serial.available() > 0) {
    const char ch = (char)Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (!discardingLine) {
        lineBuffer[lineLength] = '\0';
        handleLine(lineBuffer);
      }
      lineLength = 0;
      discardingLine = false;
    } else if (!discardingLine) {
      if (lineLength < sizeof(lineBuffer) - 1) {
        lineBuffer[lineLength++] = ch;
      } else {
        // 超长输入整行丢弃，不把后半段误当成新命令。
        discardingLine = true;
        Serial.println("ERR line too long");
      }
    }
  }
  delay(2);
}
