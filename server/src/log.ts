/**
 * log.ts — Structured JSON logging to stdout.
 *
 * Format: {"ts":"...","level":"info","event":"...","key":"value",...}
 * Level rules: normal flow = info, recoverable anomaly = warn, data loss = error.
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

export function log(level: LogLevel, event: string, fields?: Record<string, any>): void {
  const entry: Record<string, any> = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  info: (event: string, fields?: Record<string, any>) => log("info", event, fields),
  warn: (event: string, fields?: Record<string, any>) => log("warn", event, fields),
  error: (event: string, fields?: Record<string, any>) => log("error", event, fields),
  debug: (event: string, fields?: Record<string, any>) => log("debug", event, fields),
};
