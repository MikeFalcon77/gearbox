// The second seam, shared between the config that installs it and the claim
// that uses it.
//
// Seam A (`tests/fixtures/rpc.ts`) holds a frame between the browser and the
// Theia backend, and that is the right tool for what the *frontend* does with a
// slow or failed answer. It says nothing whatever about `EngineHandle.request`:
// by the time a frame is held on its way back, the engine has already answered.
// Everything about the engine's own deadline -- that missing it disposes the
// handle, that the child then ends, that every later call refuses, that
// `initialize` is the only way back -- is below that seam.
//
// So this one is a real engine that answers everything except one thing. See
// `scripts/wedging-engine.mjs` for the proxy, and
// `scripts/start-studio-wedge.mjs` for why it gets a backend of its own rather
// than borrowing the suite's.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Its own port, because its own server. */
export const WEDGE_PORT = 3100;
export const WEDGE_URL = `http://127.0.0.1:${WEDGE_PORT}/`;

/** Everything this seam writes, in one place that is not the repository. */
export const WEDGE_DIR = join(tmpdir(), "gearbox-studio-wedge");

/** While this file exists, the chosen method's answer never comes back. */
export const SENTINEL = join(WEDGE_DIR, "hold");

/** What the proxy saw, one JSON object per line. */
export const LOG = join(WEDGE_DIR, "engine.jsonl");

/**
 * The operation whose answer is withheld.
 *
 * `resolve` and not a write, for the claims that are about the *mechanism*: it is
 * reachable from the screen by one click -- the profile switcher -- so the claim
 * spends no steps getting there, and it is idempotent, so the engine doing work
 * it is never allowed to report changes nothing on disk.
 *
 * A withheld **write** is the harder state and has its own target, `HELD_WRITE`
 * below: there the engine finishes the job and the answer is thrown away, so the
 * description on disk and the panel disagree and a draft describes a change that
 * is already saved. `engine-recovery.spec.ts` is about that one.
 */
export const HELD_METHOD = "gearbox/product/resolve";

/**
 * The cap this server runs with.
 *
 * Long enough that no ordinary answer is cut off -- the measured resolve of this
 * corpus is well under a second -- and short enough to sit inside a Playwright
 * test. The production default stays 60s; see `productTimeoutMs`, which refuses
 * a malformed value rather than falling back to it, precisely so that a claim
 * cannot pass here by never reaching the timeout at all.
 */
export const WEDGE_TIMEOUT_MS = 8_000;

/** One record the proxy wrote. */
export interface WedgeRecord {
  readonly at: string;
  /** The proxy's pid -- one per engine the backend spawned. */
  readonly pid: number;
  readonly enginePid: number;
  readonly kind: string;
  readonly method?: string;
  readonly id?: number | string;
  readonly code?: number | null;
  readonly signal?: string | null;
}

export function wedgeEnv(engineBinary: string): Record<string, string> {
  return {
    GEARBOX_ENGINE: join(__dirname, "../../scripts/wedging-engine.mjs"),
    GEARBOX_WEDGE_ENGINE: engineBinary,
    GEARBOX_WEDGE_METHOD: HELD_METHOD,
    GEARBOX_WEDGE_SENTINEL: SENTINEL,
    GEARBOX_WEDGE_LOG: LOG,
    GEARBOX_PRODUCT_TIMEOUT_MS: String(WEDGE_TIMEOUT_MS),
  };
}

export function readLog(): WedgeRecord[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as WedgeRecord);
}

/**
 * Where the log has got to, as a baseline for `since`.
 *
 * **One server, one log, four claims.** Anything counted absolutely -- "one
 * withheld write", "nothing withheld on the way in" -- is counting the run and
 * not the claim, and it passes until a second claim is added. Which is how both
 * of these first failed.
 */
export function logMark(): number {
  return readLog().length;
}

/** The records written since `mark`. */
export function since(mark: number): WedgeRecord[] {
  return readLog().slice(mark);
}

/** Every engine the backend has spawned on this server, oldest first. */
export function engines(): WedgeRecord[] {
  return readLog().filter((record) => record.kind === "start");
}

/** How many times `method` reached the engine with this pid. */
export function requestsTo(pid: number, method: string): number {
  return readLog().filter(
    (record) => record.kind === "request" && record.pid === pid && record.method === method,
  ).length;
}

/**
 * Start from nothing held and nothing recorded.
 *
 * Called from the wedge project's global setup rather than from the claim: a
 * sentinel left behind by a run that died would withhold the answer to the
 * *first* resolve, and the claim would then fail at "a product opens" -- which
 * is the one step it is not about.
 */
export function resetSeam(): void {
  mkdirSync(WEDGE_DIR, { recursive: true });
  rmSync(LOG, { force: true });
  release();
}

/** What to withhold: a method, and optionally a substring of its request body. */
export interface HoldTarget {
  readonly method: string;
  /**
   * Matched against the raw request body.
   *
   * Needed because a method is not always a precise enough target: a write goes
   * out twice, once as the dry run the confirmation is built from and once as
   * the commit, so `"dry_run":false` is what names the second alone. Holding the
   * first is a different scenario with a different screen.
   */
  readonly bodyIncludes?: string;
}

/** Withhold an answer from now on. The default target is `HELD_METHOD`. */
export function hold(what?: HoldTarget): void {
  mkdirSync(WEDGE_DIR, { recursive: true });
  writeFileSync(SENTINEL, what === undefined ? "" : JSON.stringify(what));
}

/** The commit half of a draft apply -- the write whose outcome is unknowable. */
export const HELD_WRITE: HoldTarget = {
  method: "gearbox/product/applyEdits",
  bodyIncludes: '"dry_run":false',
};

/** Answer normally again. Affects the next request, not one already withheld. */
export function release(): void {
  rmSync(SENTINEL, { force: true });
}

/**
 * Is this process still running?
 *
 * Signal 0 asks the kernel without delivering anything, and `ESRCH` is the
 * answer the claim is after. **Asked as well as read from the log**, because a
 * log line saying a child exited is this proxy's account of itself, and "the old
 * process ended" is a statement about the machine.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
