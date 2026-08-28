#!/usr/bin/env node
// Drives the engine over real LSP framing, with the same library Theia uses.
//
// The point is not that the server answers -- a Rust test could check that. It
// is that `vscode-jsonrpc` can read what `lsp-server` writes, byte for byte. A
// hand-rolled framing bug would pass every Rust test and fail only here.
//
// Usage: node ide/scripts/rpc-smoke.mjs [--root <dir>]

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");

const rootFlag = process.argv.indexOf("--root");
const root = rootFlag === -1 ? resolve(repo, "..", "gears-rust") : process.argv[rootFlag + 1];

const bin = resolve(repo, "target", "debug", "gearbox");

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures += 1;
}

const child = spawn(bin, ["rpc", "--stdio", "--root", root], {
  stdio: ["pipe", "pipe", "pipe"],
});

// Anything on stdout that is not JSON-RPC corrupts the stream, so stderr is
// where the engine must put its logs. Surfacing it here is how a crash becomes
// legible instead of a hang.
let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

const connection = createMessageConnection(
  new StreamMessageReader(child.stdout),
  new StreamMessageWriter(child.stdin),
);

const changed = [];
const progress = [];
const logs = [];
connection.onNotification("gearbox/catalogueChanged", (p) => changed.push(p));
connection.onNotification("$/progress", (p) => progress.push(p));
connection.onNotification("gearbox/log", (p) => logs.push(p));

connection.listen();

try {
  // A request before `initialize` must be refused, not served.
  let refused = null;
  try {
    await connection.sendRequest("gearbox/catalogue/load", {});
  } catch (e) {
    refused = e;
  }
  check(refused !== null, "catalogue/load before initialize is refused");
  check(refused?.code === -32050, `refusal carries the application code (got ${refused?.code})`);

  const init = await connection.sendRequest("initialize", { roots: [root] });
  check(init.server_info?.name === "gearbox", "initialize returns serverInfo");
  check(init.capabilities?.staged_catalogue === true, "staged loading is advertised");
  check(
    init.capabilities?.resolve === false,
    "resolve is advertised as absent rather than pretended",
  );
  connection.sendNotification("initialized", {});

  const loaded = await connection.sendRequest("gearbox/catalogue/load", {});

  // The response is the boundary between the two passes: the whole tree by name,
  // none of it projected yet.
  check(loaded.total > 0, `discovery reported a total (${loaded.total})`);
  check(
    loaded.pending.length === loaded.total,
    `every discovered gear is pending at the boundary (${loaded.pending.length}/${loaded.total})`,
  );
  check(
    loaded.pending.every((p) => p.stage === "declared"),
    "each pending gear reached the declared stage",
  );
  check(
    loaded.pending.every((p) => p.display_name && p.category),
    "each pending gear has the name and category a tree needs",
  );
  check(
    loaded.pending.every((p) => p.id === undefined),
    "no pending gear carries an id -- it is projected, so it does not exist yet",
  );

  // Projections arrive as notifications. Wait for the terminal progress.
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("timed out waiting for progress done")), 60_000);
    const poll = setInterval(() => {
      if (progress.some((p) => p.done)) {
        clearInterval(poll);
        clearTimeout(timer);
        done();
      }
    }, 25);
  });

  check(changed.length > 0, `gears streamed in (${changed.length})`);
  check(
    changed.length === loaded.total,
    `every pending gear was replaced (${changed.length}/${loaded.total})`,
  );
  check(
    changed.every((c) => typeof c.replaces === "string" && c.gear?.id),
    "each notification names what it replaces and carries a projected gear",
  );
  // Compared as sets, not as counts: two roots of the same shape hold the same
  // `gdl_path` twice, so equal cardinality proves nothing about which row each
  // notification retires. The key is `(source, gdl_path)`.
  const key = (source, gdlPath) => `${source}:${gdlPath}`;
  const pendingKeys = new Set(loaded.pending.map((p) => key(p.source, p.gdl_path)));
  const replacedKeys = new Set(changed.map((c) => key(c.gear.source, c.replaces)));
  check(
    pendingKeys.size === replacedKeys.size &&
      [...replacedKeys].every((k) => pendingKeys.has(k)),
    "every replaced key is a pending key",
  );
  check(logs.length > 0, "the engine logged its scan cost over gearbox/log");

  await connection.sendRequest("shutdown");
  connection.sendNotification("exit");
} catch (e) {
  console.error(`\nsmoke failed: ${e.message}`);
  failures += 1;
} finally {
  connection.dispose();
  child.kill();
}

if (stderr.trim()) console.error(`\n--- engine stderr ---\n${stderr.trim()}`);
console.log(failures === 0 ? "\nrpc smoke: all checks passed" : `\nrpc smoke: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
