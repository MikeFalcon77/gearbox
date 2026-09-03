// Traces from `ProductEditService` when a description write is about to happen.
//
// `console.info` carries the stack, but Playwright's default fixture only kept
// errors and warnings. These lines are collected separately and printed whenever
// a run dirties `products/` or leaves traces behind — including in
// `global-teardown`, which runs after the last test's hook.
//
// Appends are asynchronous (the stack arrives via Playwright's `jsonValue()`),
// so callers that reset or judge the file must `await flushWriteTraces()` first.
// Otherwise a late append lands after a clean reset and teardown reports a
// "changed description" against a clean tree.

import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TRACE_FILE = join(__dirname, "../.write-traces.log");

let pending: Promise<void>[] = [];

export function resetWriteTraces(): void {
  try {
    unlinkSync(TRACE_FILE);
  } catch {
    writeFileSync(TRACE_FILE, "", "utf8");
  }
}

export function appendWriteTrace(line: string): void {
  appendFileSync(TRACE_FILE, `${line}\n`, "utf8");
}

/** Record an in-flight append so guards can wait before reading or resetting. */
export function trackWriteTrace(work: Promise<void>): void {
  pending.push(work);
}

/** How long a guard will wait for an in-flight trace before giving up on it. */
const FLUSH_TIMEOUT_MS = 5_000;

/**
 * Wait for the appends still in flight -- but never forever.
 *
 * Each append is waiting on `jsonValue()` for the stack, which is a round trip
 * into the page over CDP. When the page it came from is already closing, that
 * round trip can simply never settle, and an unbounded `Promise.all` in
 * `afterEach` then wedges the whole run: no test is running, so no test timeout
 * ever fires, and the reporter goes silent mid-file with nothing to blame.
 *
 * A guard that can hang the suite is worse than a guard that admits it lost a
 * trace, so this races the batch against a timer. The trace file is still the
 * record; what is bounded here is only the waiting.
 */
export async function flushWriteTraces(): Promise<void> {
  const batch = pending;
  pending = [];
  if (batch.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.all(batch).then(() => undefined), bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function readWriteTraces(): string[] {
  try {
    const text = readFileSync(TRACE_FILE, "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

export function formatWriteTraces(traces: readonly string[]): string {
  if (traces.length === 0) return "";
  return `Gearbox write traces (${traces.length}):\n${traces.join("\n")}\n`;
}
