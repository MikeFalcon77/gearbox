#!/usr/bin/env node
// Drives the engine over real LSP framing, with the same library Theia uses.
//
// The point is not that the server answers -- a Rust test could check that. It
// is that `vscode-jsonrpc` can read what `lsp-server` writes, byte for byte. A
// hand-rolled framing bug would pass every Rust test and fail only here.
//
// Usage: node ide/scripts/rpc-smoke.mjs [--root <dir>]

import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
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

  // Deliberately *without* write capability first: read-only is the default the
  // requirement asks for, and the refusal below is what proves it.
  const init = await connection.sendRequest("initialize", { roots: [root] });
  check(init.server_info?.name === "gearbox", "initialize returns serverInfo");
  check(init.capabilities.writes === false, "writes are absent until a client asks");
  check(init.capabilities?.staged_catalogue === true, "staged loading is advertised");
  check(
    init.capabilities?.resolve === true,
    "resolve is advertised now that M4 landed",
  );
  check(
    init.capabilities?.generate === true,
    "generate is advertised now that M5 landed",
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

  // --- what M4 computes, over the wire ---------------------------------------
  // The CLI already proves the engine resolves. What this proves is that the
  // envelopes carry it: a client reading these types gets three distinct
  // topologies from one description without knowing anything about profiles.
  const product = resolve(repo, "products/payments-demo/product.gdl");

  const loadedProduct = await connection.sendRequest("gearbox/product/load", { path: product });
  check(loadedProduct.intent.id === "payments-demo", "product/load returns the intent");

  const hashes = new Set();
  for (const profile of [null, "local", "prod"]) {
    const resolved = await connection.sendRequest("gearbox/product/resolve", {
      path: product,
      profile,
    });
    hashes.add(resolved.product.product.lock_hash);
    check(
      resolved.explanation.edges.length > 0,
      `resolve ${profile ?? "(default)"} carries its explanation`,
    );
  }
  check(hashes.size === 3, "one description, three profiles, three distinct locks");

  // The lock text, and the reason it is a method rather than a field: the client
  // must never render its own TOML. `write_canonical` is the one function that
  // decides these bytes, and byte identity across runs is what the lock is for.
  const locks = new Map();
  for (const profile of ["dev", "prod"]) {
    const lock = await connection.sendRequest("gearbox/product/lock", { path: product, profile });
    locks.set(profile, lock);
    check(lock.profile === profile, `product/lock answers for the profile asked (${profile})`);
    check(
      lock.canonical.startsWith("# GENERATED by gearbox"),
      `the ${profile} lock text leads with its generated header`,
    );
    check(
      lock.canonical.includes(lock.lock_hash),
      `the ${profile} lock text carries the hash the envelope reports`,
    );
  }
  check(
    locks.get("dev").canonical !== locks.get("prod").canonical,
    "two profiles produce two different lock texts",
  );
  // Twice for the same profile, byte for byte. This is the determinism the hash
  // is a shorthand for, checked on the text rather than on the digest.
  const again = await connection.sendRequest("gearbox/product/lock", { path: product, profile: "dev" });
  check(
    again.canonical === locks.get("dev").canonical,
    "the same profile resolved twice writes byte-identical text",
  );

  // --- editing a description, and the two gates in front of it ---------------
  //
  // `cpt-gearbox-fr-rpc-writes-opt-in`: "The system MUST refuse every
  // filesystem-mutating RPC method unless the client declared write capability
  // during initialization, and MUST reject any path outside the declared
  // workspace or source roots."
  let refusedWithoutCapability = null;
  try {
    await connection.sendRequest("gearbox/product/addGear", {
      path: product,
      gear: "cluster",
      source: "gears-rust",
      dry_run: true,
    });
  } catch (e) {
    refusedWithoutCapability = e.code;
  }
  check(
    refusedWithoutCapability === -32055,
    `a mutating method is refused without write capability (got ${refusedWithoutCapability})`,
  );

  let generateWithoutWrites = null;
  try {
    await connection.sendRequest("gearbox/generate/apply", {
      path: product,
      profile: "dev",
      out: resolve(repo, ".gearbox/smoke/denied"),
    });
  } catch (e) {
    generateWithoutWrites = e.code;
  }
  check(
    generateWithoutWrites === -32055,
    `generate/apply is refused without write capability (got ${generateWithoutWrites})`,
  );

  // Now declare it. Re-initializing is the honest way to test both postures in
  // one session: the capability is state the client set, so setting it again is
  // the same code path a second client would take.
  const writable = await connection.sendRequest("initialize", {
    roots: [root],
    // snake_case, like every other field on the wire (`server_info`,
    // `staged_catalogue`). ts-rs does not rename, so the Rust field name *is*
    // the wire name.
    allow_writes: true,
    workspace: repo,
  });
  check(writable.capabilities.writes === true, "declared write capability is echoed back");

  const outside = await (async () => {
    try {
      await connection.sendRequest("gearbox/product/addGear", {
        path: "/etc/hosts",
        gear: "cluster",
        source: "gears-rust",
        dry_run: true,
      });
      return null;
    } catch (e) {
      return e;
    }
  })();
  check(outside?.code === -32056, "a path outside the workspace is rejected");
  check(
    /not a `.gdl` description/.test(outside?.message ?? ""),
    "and the refusal says why rather than just saying no",
  );

  const preview = await connection.sendRequest("gearbox/product/addGear", {
    path: product,
    gear: "cluster",
    source: "gears-rust",
    dry_run: true,
  });
  check(preview.changed === true, "a dry run reports that the description would change");
  check(preview.written === false, "a dry run writes nothing");
  check(
    preview.after.split("\n").length === preview.before.split("\n").length + 1,
    "the change is one line",
  );
  const commentsBefore = preview.before.split("\n").filter((l) => l.trim().startsWith("#")).length;
  const commentsAfter = preview.after.split("\n").filter((l) => l.trim().startsWith("#")).length;
  check(commentsAfter === commentsBefore, `every comment survives (${commentsBefore})`);

  const already = await connection.sendRequest("gearbox/product/addGear", {
    path: product,
    gear: "api-gateway",
    source: "gears-rust",
    dry_run: true,
  });
  check(already.changed === false, "adding a gear the product already names changes nothing");

  const validated = await connection.sendRequest("gearbox/validate", { product });
  check(validated.errors === 0, "the real product validates clean over the wire");

  // A refusal has to say *why*. The engine had these diagnostics and was
  // dropping them with the failed result, which left a client with "could not be
  // evaluated" and nothing to act on.
  let refusedWithReason = false;
  try {
    await connection.sendRequest("gearbox/product/load", { path: "/definitely/absent.gdl" });
  } catch (e) {
    refusedWithReason = e.code === -32053 && (e.data?.diagnostics ?? []).length > 0;
  }
  check(refusedWithReason, "a refused product load carries its diagnostics in `data`");

  // --- generate: preview writes nothing; the four remaining gates ------------
  //
  // `writable_out_root` is the other half of the write gate: a description
  // edit requires the path to exist and to be `.gdl`; generation creates new
  // files that are not `.gdl`, must stay inside the workspace, and must not
  // land inside a source root (ADR-0010 tier 5).
  const out = resolve(repo, ".gearbox/smoke/plan");
  const porcelain = () =>
    execSync("git status --porcelain", { cwd: repo, encoding: "utf8" });
  const beforePlan = porcelain();
  const planned = await connection.sendRequest("gearbox/generate/plan", {
    path: product,
    profile: "dev",
    out,
  });
  check(planned.plans.length > 0, `generate/plan returns a file plan (${planned.plans.length})`);
  check(
    planned.plans.every((p) => typeof p.path === "string" && p.action),
    "each plan line is a path and an action, not a payload",
  );
  check(porcelain() === beforePlan, "generate/plan writes nothing");

  let outOutside = null;
  try {
    await connection.sendRequest("gearbox/generate/plan", {
      path: product,
      profile: "dev",
      out: "/tmp/gearbox-generate-outside",
    });
  } catch (e) {
    outOutside = e;
  }
  check(outOutside?.code === -32057, "an out root outside the workspace is refused");
  check(
    /outside the declared workspace/.test(outOutside?.message ?? ""),
    "and the refusal says the root is outside the workspace",
  );

  let outInSource = null;
  try {
    await connection.sendRequest("gearbox/generate/plan", {
      path: product,
      profile: "dev",
      out: root,
    });
  } catch (e) {
    outInSource = e;
  }
  check(outInSource?.code === -32057, "an out root inside a source root is refused");
  check(
    /inside a source root/.test(outInSource?.message ?? ""),
    "and the refusal names the source-root rule",
  );

  const brokenDir = join(tmpdir(), `gearbox-broken-gen-${process.pid}`);
  mkdirSync(brokenDir, { recursive: true });
  const broken = join(brokenDir, "product.gdl");
  writeFileSync(
    broken,
    `product(
    id = "broken-gen",
    name = "Broken",
    version = "0.1.0",
    sources = [source(id = "gears-rust", at = path(${JSON.stringify(root)}))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [use_gear("no-such-gear-anywhere", source = "gears-rust")],
)
`,
  );
  let refusedOnErrors = null;
  try {
    await connection.sendRequest("gearbox/generate/plan", {
      path: broken,
      profile: "dev",
      out,
    });
  } catch (e) {
    refusedOnErrors = e;
  }
  check(
    refusedOnErrors?.code === -32057,
    `generation is refused when resolution has errors (got ${refusedOnErrors?.code})`,
  );
  check(
    /resolution reported errors/.test(refusedOnErrors?.message ?? ""),
    "and the refusal says resolution reported errors",
  );

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
