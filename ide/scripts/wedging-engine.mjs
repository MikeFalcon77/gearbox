#!/usr/bin/env node
// An engine that works, until it is told to withhold one answer.
//
// Why a pass-through and not a stub. `engine-supervision-smoke.mjs` already
// wedges an engine with `#!/bin/sh\ncat > /dev/null`, and that stub can only ever
// prove that the *first* call fails: nothing it answers is a real engine's
// answer, so no product ever opens behind it. What the timeout path has to be
// shown against is a **working session** -- a product on screen, resolved, with
// a panel full of the engine's own output -- because that is the only state in
// which "every later call refuses" and "`initialize` is what brings it back"
// mean anything. Forwarding to the real binary is also what makes the answers
// after recovery complete enough to re-read the product; a hand-written success
// reply would not be.
//
// So this stands between the Theia backend and `gearbox rpc`, speaks nothing
// itself, and does exactly one thing: while the sentinel file exists, the
// response to one chosen method never comes back. The engine still does the
// work -- the request is forwarded -- which is the point. A timed-out call is
// not a call that did not happen, and pretending otherwise is how a recovery
// path gets written that assumes the write never landed.
//
// Installed by pointing `GEARBOX_ENGINE` at this file. Configuration is entirely
// by environment, because the backend owns the argv:
//
//   GEARBOX_WEDGE_ENGINE    the real binary to spawn         (required)
//   GEARBOX_WEDGE_METHOD    the method withheld by default   (required)
//   GEARBOX_WEDGE_SENTINEL  withhold while this file exists  (required)
//   GEARBOX_WEDGE_LOG       JSONL record of what happened    (required)
//
// **The sentinel may also say what to withhold**, as
// `{"method": "...", "bodyIncludes": "..."}`, because one method is not always a
// precise enough target. A write goes out twice -- once as a dry run for the
// confirmation, once as the commit -- and withholding "applyEdits" would hold the
// preview, which is a different scenario with a different screen. `bodyIncludes`
// matches the raw request body, so `"dry_run":false` names the commit alone.
// An empty sentinel means the default method with any parameters.
//
// The log is the evidence, and it is per-process rather than per-run: every
// line carries this proxy's pid and its child's, so "the old process ended",
// "the operation reached the engine once" and "nothing replayed it after the
// restart" are all questions about lines rather than about timing.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value) {
    // To stderr rather than stdout: stdout is the JSON-RPC stream, and a
    // diagnostic written into it is a protocol error two layers away from its
    // cause. The backend pipes stderr into its own log.
    process.stderr.write(`wedging-engine: ${name} is not set\n`);
    process.exit(64);
  }
  return value;
}

const enginePath = required("GEARBOX_WEDGE_ENGINE");
const heldMethod = required("GEARBOX_WEDGE_METHOD");
const sentinel = required("GEARBOX_WEDGE_SENTINEL");
const logPath = required("GEARBOX_WEDGE_LOG");

mkdirSync(dirname(logPath), { recursive: true });

const child = spawn(enginePath, process.argv.slice(2), {
  // stderr inherited: the engine's own diagnostics keep going where they went
  // before, into the backend log, unmangled by this process.
  stdio: ["pipe", "pipe", "inherit"],
});

/**
 * Append one line, synchronously.
 *
 * Synchronous because the interesting end of this process is a SIGKILL: the
 * supervisor escalates `exit` -> SIGTERM -> SIGKILL three seconds apart, and a
 * queued write is a write that never happened.
 */
function note(kind, extra = {}) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, enginePid: child.pid, kind, ...extra })}\n`,
  );
}

note("start", { engine: enginePath, method: heldMethod, args: process.argv.slice(2) });

/**
 * Split an LSP-framed stream into whole messages, and hand on the exact bytes.
 *
 * The original bytes rather than a re-encoding: a header this does not model --
 * `Content-Type`, an unexpected order -- would otherwise be silently rewritten,
 * and a proxy that edits the protocol it is only supposed to observe is a source
 * of failures nobody will look for here.
 */
function frames(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = buffer.subarray(0, separator).toString("ascii");
      const length = /content-length:\s*(\d+)/i.exec(header);
      if (!length) {
        note("framing-error", { header });
        process.exit(65);
      }
      const start = separator + 4;
      const end = start + Number(length[1]);
      if (buffer.length < end) return;
      onFrame(buffer.subarray(0, end), buffer.subarray(start, end));
      buffer = buffer.subarray(end);
    }
  };
}

/** Parse, or answer `undefined` -- a frame this cannot read is still forwarded. */
function parse(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Request ids whose answer is not to come back yet. */
const withheld = new Set();

/**
 * Answers that arrived while they were withheld, waiting for the sentinel to go.
 *
 * **Held rather than dropped, so a claim can ask for the other ending.** The
 * timeout scenarios never release, and for them a buffer that dies with the
 * process is indistinguishable from a bin. What needs the buffer is the state
 * where a write *succeeds* while the person goes on editing: the commit is in
 * flight, another change is queued behind it, and then the answer lands. There is
 * no way to reach that by dropping the answer -- the request would end in a
 * timeout, which is a different claim.
 */
const holding = [];

/**
 * What is being withheld right now, or `undefined` for nothing.
 *
 * Read per request rather than cached: the sentinel is how a claim changes its
 * mind between two steps, and a cached answer would make the second step depend
 * on when this process happened to look.
 */
function target() {
  let content;
  try {
    content = readFileSync(sentinel, "utf8").trim();
  } catch {
    return undefined;
  }
  if (content === "") return { method: heldMethod };
  try {
    const parsed = JSON.parse(content);
    return { method: parsed.method ?? heldMethod, bodyIncludes: parsed.bodyIncludes };
  } catch {
    note("sentinel-unreadable", { content });
    return { method: heldMethod };
  }
}

/** Which method each withheld id belongs to, so a release can be selective. */
const methodOf = new Map();

/**
 * Let go of anything the sentinel no longer withholds.
 *
 * On a timer because a release has no traffic of its own: the sentinel is
 * removed by the claim, out of band, and the engine has already said everything
 * it is going to say.
 */
function releaseHeld() {
  if (holding.length === 0) return;
  const wanted = target();
  const stillHeld = [];
  for (const answer of holding) {
    if (wanted !== undefined && wanted.method === answer.method) {
      stillHeld.push(answer);
      continue;
    }
    note("released-answer", { id: answer.id, method: answer.method });
    withheld.delete(answer.id);
    process.stdout.write(answer.frame);
  }
  holding.length = 0;
  holding.push(...stillHeld);
}

setInterval(releaseHeld, 100);

function withholds(message, body) {
  const wanted = target();
  if (wanted === undefined || message.method !== wanted.method) return false;
  if (wanted.bodyIncludes === undefined) return true;
  return body.toString("utf8").includes(wanted.bodyIncludes);
}

process.stdin.on(
  "data",
  frames((frame, body) => {
    const message = parse(body);
    if (message?.method !== undefined && message.id !== undefined) {
      // Every request, not only the held one: the count of these is how a claim
      // asks whether an abandoned operation was replayed behind somebody's back.
      note("request", { method: message.method, id: message.id });
      if (withholds(message, body)) {
        withheld.add(message.id);
        methodOf.set(message.id, message.method);
        note("withhold", { method: message.method, id: message.id });
      }
    }
    // **Forwarded either way.** See the header: withholding the request would
    // make the engine idle rather than busy, and the state being reproduced is
    // an engine that is working and late.
    child.stdin.write(frame);
  }),
);

child.stdout.on(
  "data",
  frames((frame, body) => {
    const message = parse(body);
    if (message?.id !== undefined && withheld.has(message.id)) {
      note("held-answer", { id: message.id });
      holding.push({ id: message.id, method: methodOf.get(message.id), frame });
      return;
    }
    process.stdout.write(frame);
  }),
);

// The supervisor does not close stdin on purpose (see `EngineHandle.dispose`),
// so this is the ordinary shutdown of a backend going away, not the timeout
// path. Passed on, or the engine keeps a root open with nobody attached.
process.stdin.on("end", () => child.stdin.end());

for (const stream of [process.stdin, process.stdout, child.stdin, child.stdout]) {
  // An unlistened stream `'error'` is an uncaught exception, and this process
  // dying silently would look exactly like the wedge under test.
  stream.on("error", (error) => note("stream-error", { message: error.message }));
}

child.on("error", (error) => {
  note("engine-spawn-failed", { message: error.message });
  process.exit(66);
});

child.on("exit", (code, signal) => {
  note("engine-exit", { code, signal });
  // The same code, so the backend's `exited` reason describes the engine rather
  // than describing this.
  process.exit(code ?? 1);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    // **Forwarded, and this is not a nicety.** The supervisor signals the
    // process it spawned, which is this one; an unforwarded SIGTERM leaves a
    // `gearbox rpc` holding its source roots with nothing attached to it, once
    // per timeout, for as long as the machine is up.
    note("proxy-signal", { signal });
    child.kill(signal);
  });
}

// Last resort for the paths above that call `process.exit` themselves.
process.on("exit", () => child.kill("SIGKILL"));
