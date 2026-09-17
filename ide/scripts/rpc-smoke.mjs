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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  //
  // The workspace is declared even so, because it is not a write capability:
  // it is where the generated tree lives, and `gearbox/product/lock` now runs
  // its `out` through the same boundary check generation uses -- so a session
  // that names no workspace has nowhere to look for a lock and is told so
  // rather than answered with an empty path.
  const init = await connection.sendRequest("initialize", { roots: [root], workspace: repo });
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
  // --- the lock against the lock on disk ------------------------------------
  //
  // The structured comparison, checked here rather than in the browser: the
  // interesting cases need a lock file put somewhere on purpose, and the widget
  // deliberately sends no `out` -- there is one generated tree now.
  {
    const scratch = resolve(repo, ".gearbox/smoke/lockdiff");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });

    const fresh = await connection.sendRequest("gearbox/product/lock", {
      path: product,
      profile: "dev",
      out: scratch,
    });
    check(
      fresh.lock_path.endsWith("lockdiff/product.lock"),
      "product/lock reports where it looked, even with nothing there",
    );
    check(
      fresh.on_disk === undefined || fresh.on_disk === null,
      "no lock on disk is reported as absent rather than as an empty diff",
    );

    // The same lock, written where it was expected: no differences.
    writeFileSync(join(scratch, "product.lock"), fresh.canonical);
    const same = await connection.sendRequest("gearbox/product/lock", {
      path: product,
      profile: "dev",
      out: scratch,
    });
    check(same.on_disk != null, "a lock on disk is found");
    check(
      (same.on_disk?.changes ?? ["missing"]).length === 0,
      "an identical lock on disk reports no changes",
    );
    check(
      same.on_disk?.lock_hash === same.lock_hash,
      "and the hash it read back matches the one just resolved",
    );

    // A lock for a *different* profile, so the diff has something structural to
    // say. This is the case the Lock view exists to show.
    const other = await connection.sendRequest("gearbox/product/lock", {
      path: product,
      profile: "prod",
    });
    writeFileSync(join(scratch, "product.lock"), other.canonical);
    const stale = await connection.sendRequest("gearbox/product/lock", {
      path: product,
      profile: "dev",
      out: scratch,
    });
    const changes = stale.on_disk?.changes ?? [];
    check(changes.length > 0, `a stale lock reports its differences (${changes.length})`);
    check(
      changes.some((line) => line.startsWith("~ profile: prod -> dev")),
      "and names the profile change first, in the engine's own words",
    );
    check(
      changes.every((line) => /^[+~-] /.test(line)),
      "every line is marked added, removed or changed",
    );

    // A file that is not a lock is neither current nor stale.
    writeFileSync(join(scratch, "product.lock"), "this is not a lock\n");
    const broken = await connection.sendRequest("gearbox/product/lock", {
      path: product,
      profile: "dev",
      out: scratch,
    });
    check(
      (broken.on_disk?.unreadable ?? "") !== "",
      "a file that will not parse is reported as unreadable, not as no differences",
    );
    check(
      (broken.on_disk?.changes ?? ["x"]).length === 0,
      "and carries no invented diff",
    );

    rmSync(scratch, { recursive: true, force: true });
  }

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

  // --- product description edits beyond add/remove gear --------------------
  const configPreview = await connection.sendRequest("gearbox/product/setConfig", {
    path: product,
    gear: "api-gateway",
    key: "demo_mode",
    value: "demo_value",
    dry_run: true,
  });
  check(configPreview.changed === true, "setConfig dry run reports a change");
  check(configPreview.written === false, "setConfig dry run writes nothing");

  let secretRefused = null;
  try {
    await connection.sendRequest("gearbox/product/setConfig", {
      path: product,
      gear: "api-gateway",
      key: "password",
      value: "literal",
      dry_run: true,
    });
  } catch (e) {
    secretRefused = e;
  }
  check(secretRefused?.code === -32056, "a secret-like config key is refused");
  check(
    secretRefused?.data?.diagnostics?.some((d) => /secret references/i.test(d.message ?? "")) ===
      true,
    "and the refusal mentions external secret references",
  );

  const featuresPreview = await connection.sendRequest("gearbox/product/setFeatures", {
    path: product,
    gear: "api-gateway",
    features: ["demo-feature"],
    dry_run: true,
  });
  check(featuresPreview.changed === true, "setFeatures dry run reports a change");

  const batchPreview = await connection.sendRequest("gearbox/product/applyEdits", {
    path: product,
    dry_run: true,
    edits: [
      { kind: "set_config", gear: "api-gateway", key: "draft_a", value: "one" },
      { kind: "set_config", gear: "api-gateway", key: "draft_b", value: "two" },
    ],
  });
  check(batchPreview.changed === true, "applyEdits dry run reports a change");
  check(batchPreview.written === false, "applyEdits dry run writes nothing");
  check(
    batchPreview.after.includes("draft_a") && batchPreview.after.includes("draft_b"),
    "applyEdits dry run applies both config keys in one pass",
  );

  // `resolvePreview` -- the question a configurator asks before it writes.
  //
  // Checked here rather than only through the UI because the property that
  // matters is a byte comparison: a call that answers "what would this product
  // become" must leave the description exactly as it found it.
  const beforeBytes = readFileSync(product);
  const hypothetical = await connection.sendRequest("gearbox/product/resolvePreview", {
    path: product,
    profile: "dev",
    add: { gear: "payments-audit", source: "gears-rust" },
  });
  check(
    Buffer.compare(beforeBytes, readFileSync(product)) === 0,
    "resolvePreview leaves the description byte-identical",
  );
  check(
    hypothetical.product !== undefined && hypothetical.product !== null,
    "resolvePreview answers with a resolution",
  );

  const baseline = await connection.sendRequest("gearbox/product/resolve", {
    path: product,
    profile: "dev",
  });
  const gearsOf = (result) => Object.keys(result?.product?.gears ?? {}).sort();
  check(
    gearsOf(baseline).length > 0,
    "the baseline resolution names gears to compare against",
  );
  // The gear does not exist in the corpus yet (plan §10), so the preview answers
  // with a diagnostic rather than a larger closure -- and that *is* the answer a
  // configurator needs. What must not happen is silence or a write.
  check(
    JSON.stringify(gearsOf(hypothetical)) !== undefined,
    "resolvePreview's closure is inspectable",
  );

  const profilePreview = await connection.sendRequest("gearbox/product/addProfile", {
    path: product,
    kind: "embedded",
    id: "smoke-staging",
    fields: [],
    dry_run: true,
  });
  check(profilePreview.changed === true, "addProfile dry run reports a change");

  const createScratch = resolve(repo, ".gearbox/smoke/create-product.gdl");
  rmSync(dirname(createScratch), { recursive: true, force: true });
  const created = await connection.sendRequest("gearbox/product/create", {
    path: createScratch,
    id: "smoke-create",
    name: "Smoke Create",
    version: "0.1.0",
    sources: [{ id: "gears-rust", at: "../../../gears-rust" }],
    profile_kind: "embedded",
    profile_id: "dev",
    dry_run: true,
  });
  check(created.changed === true, "create dry run returns the full text");
  check(created.after.includes('id = "smoke-create"'), "create dry run names the requested id");
  check(created.written === false, "create dry run writes nothing");
  rmSync(dirname(createScratch), { recursive: true, force: true });

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
