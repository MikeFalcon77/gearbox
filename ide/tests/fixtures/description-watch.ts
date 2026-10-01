// Who writes a shared description, and when — recorded rather than reasoned about.
//
// **This exists because I reasoned about it and was wrong.** A run left a
// deliberate typo inside `products/payments-demo/product.gdl` mid-run and a
// later claim read it as its baseline. Auto-save is on (`browser-app` is the
// browser target, where Theia defaults to `afterDelay`/1000 ms and nothing
// overrides it), the window between a claim's `finally` and a page closing is
// real, and every guard is blind to it. All of that makes a **possible**
// carrier. None of it shows that a buffer was ever modified, and neither claim
// that opens the file in Monaco types into it — one double-clicks it open, the
// other opens the suggest widget and never accepts a suggestion.
//
// So: a log of every mutation of the watched descriptions, with the claim that
// was running when it happened. Either the four-step sequence appears — *buffer
// modified → dirty → file restored → a later save* — or the write has a
// different cause and this says so.
//
// Off by default. `GEARBOX_WATCH_DESCRIPTIONS=1` turns it on, because a watcher
// on every run costs something and proves nothing once the question is settled.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

const LOG = join(__dirname, "../.description-watch.log");

/** Whether this run was asked to record. */
export function watching(): boolean {
  return process.env.GEARBOX_WATCH_DESCRIPTIONS === "1";
}

let watchers: FSWatcher[] = [];
/** Last digest per path, so an event that changed nothing is not reported. */
const seen = new Map<string, string>();

function note(kind: string, detail: Record<string, unknown>): void {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, ...detail })}\n`);
}

/**
 * A line a reader can act on: the digest, and whether the typo is in it.
 *
 * The content is not logged. It is a description a person wrote and the log is
 * an artefact; the digest answers "did it change" and the probe answers "is it
 * the damage", which is the whole question.
 */
function sample(path: string): { sha: string; hasTypo: boolean } | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return {
      sha: createHash("sha256").update(text).digest("hex").slice(0, 12),
      hasTypo: text.includes("embeddedd"),
    };
  } catch {
    return undefined;
  }
}

export function startWatching(repo: string): void {
  if (!watching()) return;
  rmSync(LOG, { force: true });
  const products = join(repo, "products");
  note("start", { products });
  // Recursive: a product is a directory, and a copy made by a claim is a new one.
  const watcher = watch(products, { recursive: true }, (_event, name) => {
    if (name === null || !name.endsWith(".gdl")) return;
    const path = join(products, name);
    const now = sample(path);
    if (now === undefined) {
      note("gone", { path });
      seen.delete(path);
      return;
    }
    if (seen.get(path) === now.sha) return;
    seen.set(path, now.sha);
    note("write", { path, ...now });
  });
  watchers.push(watcher);
}

/** Bracket the claim that is running, so a write can be attributed to one. */
export function noteTest(phase: "begin" | "end", title: string): void {
  if (!watching()) return;
  note(phase, { title });
}

export function stopWatching(): void {
  if (!watching()) return;
  for (const watcher of watchers) watcher.close();
  watchers = [];
  note("stop", {});
  // Printed rather than left to be found: a run asked to record has a reader
  // waiting for the answer.
  // eslint-disable-next-line no-console
  console.log(`\ndescription watch: ${LOG}`);
}
