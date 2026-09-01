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

export async function flushWriteTraces(): Promise<void> {
  const batch = pending;
  pending = [];
  await Promise.all(batch);
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
