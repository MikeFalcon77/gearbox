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
import { productTimeoutMs } from "../gearbox-studio/lib/node/gearbox-service-impl.js";

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

  {
    const engine = spawnEngine(stub, [], logger);
    const request = engine.request("initialize", {}, 30_000);
    const before = await settlesWithin(400, request);
    check(before === "timeout", `a silent engine leaves the request pending (got ${before})`);
    engine.dispose();
    const after = await settlesWithin(3_000, request);
    check(after === "rejected", `disposing rejects what was in flight (got ${after})`);
  }

  // ------------------------------------------- a timeout ends the engine

  {
    // The case the panel used to lose. A wedged engine that misses its deadline
    // is still working: it goes on projecting and eventually sends
    // `$/progress done`, which walked the store from the error it had just
    // reported back to `ready`. Abandoning the request is not enough -- the
    // work has to stop, and nothing can cancel it, so the process ends.
    const engine = spawnEngine(stub, [], logger);
    const outcome = await settlesWithin(3_000, engine.request("initialize", {}, 300));
    check(outcome === "rejected", `a timed-out request rejects (got ${outcome})`);
    check(engine.dead, "and the timeout takes the handle with it");
    check(
      (await engine.exited).includes("disposed"),
      "the engine was disposed rather than left running",
    );
    const again = await settlesWithin(3_000, engine.request("initialize", {}, 300));
    check(again === "rejected", `a request after the timeout refuses at once (got ${again})`);
  }

  // --------------------------------- a wedged engine refuses product RPCs

  {
    // `EngineHandle.request` for every method, not just the two that had it.
    // `connection.sendRequest` against this stub never settles at all, which
    // crossed the Theia proxy as a Resolve button that spun for the rest of the
    // session -- no error, no log, nothing to retry from.
    const engine = spawnEngine(stub, [], logger);
    const outcome = await settlesWithin(
      3_000,
      engine.request("gearbox/product/resolve", { path: "/p/product.gdl" }, 300),
    );
    check(outcome === "rejected", `a product RPC on a wedged engine rejects (got ${outcome})`);
    engine.dispose();
  }
}

// --------------------------------------------- the cap, read and refused

// The seam the browser-level wedge needs, checked where it is cheap to check.
// Every one of these used to be unobservable: the cap was a constant, so
// "60 seconds by default" was a line of source rather than a statement anybody
// had asked the code for.
{
  check(productTimeoutMs({}) === 60_000, "an unset cap is 60 seconds");
  check(productTimeoutMs({ GEARBOX_PRODUCT_TIMEOUT_MS: "" }) === 60_000, "and so is an empty one");
  check(
    productTimeoutMs({ GEARBOX_PRODUCT_TIMEOUT_MS: " 8000 " }) === 8_000,
    "a whole number of milliseconds is taken, surrounding space and all",
  );
  // **Refused rather than defaulted, and this is the important half.** A typo
  // silently falling back to 60s makes a wedge test pass for the wrong reason:
  // the request answers normally, long before a timeout nobody configured, and
  // the claim reports on a mechanism it never reached.
  for (const bad of ["abc", "30s", "1e4", "-1", "0", "600001"]) {
    let refused = false;
    try {
      productTimeoutMs({ GEARBOX_PRODUCT_TIMEOUT_MS: bad });
    } catch (error) {
      refused = String(error.message).includes("GEARBOX_PRODUCT_TIMEOUT_MS");
    }
    check(refused, `a cap of \`${bad}\` is refused, by name`);
  }
}

console.log(
  failures === 0
    ? "\nengine supervision smoke: all checks passed"
    : `\nengine supervision smoke: ${failures} failed`,
);
process.exit(failures === 0 ? 0 : 1);
