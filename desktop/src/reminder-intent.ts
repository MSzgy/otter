export function parseReminder(text: string, now = Date.now()) {
  const match = text
    .trim()
    .match(
      /^(?:请)?(?:在)?(\d+)\s*(秒|分钟|小时)后(?:提醒我|叫我)(.{1,200})$/u,
    );
  if (!match) return null;
  const units: Record<string, number> = {
    秒: 1000,
    分钟: 60000,
    小时: 3600000,
  };
  const delay = Number(match[1]) * units[match[2]];
  if (!Number.isFinite(delay) || delay <= 0 || delay > 366 * 86400000)
    return null;
  return {
    title: match[3].trim(),
    dueAt: now + delay,
    kind: "reminder",
    requestId: crypto.randomUUID(),
  };
}
