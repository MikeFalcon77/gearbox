#!/usr/bin/env node
// The failure paths of engine supervision, which the happy-path smoke cannot see.
//
// Three ways an engine stops being usable, and all three used to end the same
// way: a `sendRequest` that never settles, behind a panel that never stops
// saying "projecting". `vscode-jsonrpc` rejects in-flight requests when the
// *connection* is disposed and not when the stream closes, so nothing but an
// explicit supervisor turns a dead child into a rejected promise.
//
// A missing binary is the fourth, and the worst: `spawn` reports it by emitting
// `'error'`, which with no listener is an uncaught exception that takes the
// Theia backend down with it. This script staying alive to print its summary is
// that assertion.
//
// Usage: node ide/scripts/engine-supervision-smoke.mjs

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnEngine } from "../gearbox-studio/lib/node/gearbox-engine-process.js";

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures += 1;
}

const logger = {
  info: async () => undefined,
  warn: async () => undefined,
  error: async () => undefined,
};

/** Resolve with `"timeout"` rather than hang, so a hang is a failed check. */
async function settlesWithin(ms, promise) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise.then(() => "resolved", () => "rejected"), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- ENOENT

{
  const engine = spawnEngine("/nonexistent/definitely-not-gearbox", ["/tmp"], logger);
  const outcome = await settlesWithin(3_000, engine.request("initialize", {}, 30_000));
  check(outcome === "rejected", `a missing binary rejects the request (got ${outcome})`);
  check(engine.dead, "the handle reports the engine as dead");
  check((await engine.exited).includes("could not be started"), "the reason names the failure");
  engine.dispose();
}

// ------------------------------------------------------- child exits at once

{
  // `node rpc --stdio --root /tmp` -- node tries to run a file called `rpc`,
  // fails, and exits. A stand-in for an engine that panics during startup.
  const engine = spawnEngine(process.execPath, ["/tmp"], logger);
  const outcome = await settlesWithin(5_000, engine.request("initialize", {}, 30_000));
  check(outcome === "rejected", `an engine that exits rejects the request (got ${outcome})`);
  check(engine.dead, "the handle reports the engine as dead after an exit");
  engine.dispose();
}

// ------------------------------------------------------------ silent engine

if (process.platform === "win32") {
  console.log("  skip  silent-engine case needs a POSIX shell");
} else {
  // A child that reads its stdin and answers nothing: the shape of a wedged
  // projection, and the case a timeout is the only escape from. Disposing must
  // reject what is in flight.
  //
  // A script rather than `/bin/cat`, which echoes the request back -- the client
  // then answers its own message and the request settles, which is the opposite
  // of the thing being tested.
  const stub = join(mkdtempSync(join(tmpdir(), "gearbox-stub-")), "silent-engine");
  // `cat` alone, not `exec cat`: the redirection then applies to `cat` rather
  // than to the shell, so the child keeps its stdout pipe open. Closing it is a
  // *dead* engine, which the case above already covers.
  writeFileSync(stub, "#!/bin/sh\ncat > /dev/null\n");
  chmodSync(stub, 0o755);

  const engine = spawnEngine(stub, [], logger);
  const request = engine.request("initialize", {}, 30_000);
  const before = await settlesWithin(400, request);
  check(before === "timeout", `a silent engine leaves the request pending (got ${before})`);
  engine.dispose();
  const after = await settlesWithin(3_000, request);
  check(after === "rejected", `disposing rejects what was in flight (got ${after})`);
}

console.log(
  failures === 0
    ? "\nengine supervision smoke: all checks passed"
    : `\nengine supervision smoke: ${failures} failed`,
);
process.exit(failures === 0 ? 0 : 1);
