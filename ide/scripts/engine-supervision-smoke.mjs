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

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnEngine } from "../gearbox-studio/lib/node/gearbox-engine-process.js";
import {
  GearboxServiceImpl,
  productTimeoutMs,
} from "../gearbox-studio/lib/node/gearbox-service-impl.js";

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

// ------------------- a working session, one missed deadline, and back

// What `cat > /dev/null` above cannot say anything about.
//
// That stub answers nothing, so every call against it is the *first* call, and
// the three consequences of a timeout that matter -- the child ending, every
// later call refusing, `initialize` being the only way back -- are consequences
// for a session that was working. This is that session: the real engine, a real
// catalogue, a product that resolves, and then one answer withheld until the cap
// runs out. `scripts/wedging-engine.mjs` is the seam; see its header for why it
// forwards the request it withholds the answer to.
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const engineBinary = join(repo, "target/debug/gearbox");

if (process.platform === "win32") {
  console.log("  skip  the wedge proxy is a shebang script");
} else if (!existsSync(engineBinary)) {
  console.log(`  skip  no engine at ${engineBinary} -- run \`npm run engine\``);
} else {
  const dir = mkdtempSync(join(tmpdir(), "gearbox-wedge-"));
  const sentinel = join(dir, "hold");
  const log = join(dir, "engine.jsonl");
  const product = join(repo, "products/configurable-gears/product.gdl");

  const before = { ...process.env };
  Object.assign(process.env, {
    GEARBOX_ENGINE: join(here, "wedging-engine.mjs"),
    GEARBOX_WEDGE_ENGINE: engineBinary,
    GEARBOX_WEDGE_METHOD: "gearbox/product/resolve",
    GEARBOX_WEDGE_SENTINEL: sentinel,
    GEARBOX_WEDGE_LOG: log,
    // Short, because this script sits inside somebody's `npm run verify`. The
    // point is that the mechanism is the real one, not that the number is.
    GEARBOX_PRODUCT_TIMEOUT_MS: "3000",
  });

  /** The proxy's log, as records. */
  const records = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
      : [];

  /** Poll rather than sleep, so a fast machine is not waited on. */
  async function until(predicate, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const alive = (pid) => {
    try {
      // Signal 0 tests for existence and permission without delivering
      // anything; ESRCH is the answer being looked for.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // Constructed rather than injected: this is the class the Theia backend binds,
  // and the seam under test is between it and the engine, not in the container.
  const service = new GearboxServiceImpl();
  service.logger = logger;

  try {
    await service.initialize();
    await service.loadCatalogue();
    await service.loadProduct(product);
    const first = await settlesWithin(30_000, service.resolve(product, "dev"));
    check(first === "resolved", `a product resolves through the proxy (got ${first})`);
    const started = records().filter((r) => r.kind === "start");
    check(started.length === 1, `one engine was spawned (got ${started.length})`);

    // ---- one operation held past the cap

    writeFileSync(sentinel, "");
    let refusal = "";
    const timedOut = await settlesWithin(
      20_000,
      service.resolve(product, "prod").catch((error) => {
        refusal = String(error.message);
        throw error;
      }),
    );
    check(timedOut === "rejected", `an answer held past the cap rejects (got ${timedOut})`);
    check(
      refusal.includes("did not answer") && refusal.includes("3000ms"),
      `the refusal names the deadline it missed (got ${JSON.stringify(refusal)})`,
    );

    // ---- the old process ended

    const gone = await until(() => records().some((r) => r.kind === "engine-exit"), 10_000);
    check(gone, "the engine process ended rather than being left running");
    const [spawned] = started;
    check(
      await until(() => !alive(spawned.pid) && !alive(spawned.enginePid), 10_000),
      `neither the engine nor its proxy is still alive ` +
        `(proxy ${spawned.pid}, engine ${spawned.enginePid})`,
    );

    // ---- and every later call refuses

    let later = "";
    const again = await settlesWithin(
      10_000,
      service.resolve(product, "dev").catch((error) => {
        later = String(error.message);
        throw error;
      }),
    );
    check(again === "rejected", `a later call refuses at once (got ${again})`);
    check(
      later.includes("the engine is not initialized"),
      `and says the engine is not initialized (got ${JSON.stringify(later)})`,
    );
    const otherCall = await settlesWithin(10_000, service.validate(product));
    check(otherCall === "rejected", `so does an unrelated product call (got ${otherCall})`);

    // ---- `initialize` is what makes them work again

    rmSync(sentinel);
    const heldBefore = records().filter(
      (r) => r.kind === "request" && r.method === "gearbox/product/resolve",
    ).length;
    await service.initialize();
    await service.loadCatalogue();
    const respawned = records().filter((r) => r.kind === "start");
    check(respawned.length === 2, `a second engine was spawned (got ${respawned.length})`);
    const fresh = respawned[1].pid;

    // **Nothing replayed it.** A timed-out operation's outcome is unknown, so
    // re-sending it is not the supervisor's call to make -- and this is the
    // measurement rather than the argument: the new process was asked for no
    // resolve at all until one was asked for here.
    const replayed = records().filter(
      (r) => r.kind === "request" && r.method === "gearbox/product/resolve" && r.pid === fresh,
    );
    check(
      replayed.length === 0,
      `the abandoned operation was not replayed against the new engine (got ${replayed.length})`,
    );
    check(
      records().filter((r) => r.kind === "request" && r.method === "gearbox/product/resolve")
        .length === heldBefore,
      "and nothing else re-sent it either",
    );

    await service.loadProduct(product);
    const recovered = await settlesWithin(30_000, service.resolve(product, "dev"));
    check(recovered === "resolved", `the session resolves again after \`initialize\` (got ${recovered})`);
    check(
      records().some(
        (r) => r.kind === "request" && r.method === "gearbox/product/resolve" && r.pid === fresh,
      ),
      "and that resolve is the one asked for here",
    );
  } finally {
    service.disposeEngine();
    for (const key of [
      "GEARBOX_ENGINE",
      "GEARBOX_WEDGE_ENGINE",
      "GEARBOX_WEDGE_METHOD",
      "GEARBOX_WEDGE_SENTINEL",
      "GEARBOX_WEDGE_LOG",
      "GEARBOX_PRODUCT_TIMEOUT_MS",
    ]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  failures === 0
    ? "\nengine supervision smoke: all checks passed"
    : `\nengine supervision smoke: ${failures} failed`,
);
process.exit(failures === 0 ? 0 : 1);
