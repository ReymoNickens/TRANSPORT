/**
 * Structured logs with a correlation id on every line (spec 20.7, 22.3).
 * Never pass codes, QR tokens, secrets or full phone numbers (spec 19.4).
 */
type Level = "info" | "warn" | "error";

export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
