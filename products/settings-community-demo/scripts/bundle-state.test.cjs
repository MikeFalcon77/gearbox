"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  cp = require("node:child_process");
const {
  sourceState,
  artifacts,
  verifyArtifacts,
  checkInputs,
  within,
} = require("./bundle-state.cjs");
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gearbox-demo-test-"));
  t.after(() => {
    const resolved = path.resolve(root);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("gearbox-demo-test-")
    )
      throw Error("Unsafe test cleanup target");
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}
function git(root, args) {
  const result = cp.spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}
test("a modified or newly added path-dependency source makes the bundle stale", (t) => {
  const root = temp(t);
  git(root, ["init", "--quiet"]);
  fs.mkdirSync(path.join(root, "libs"));
  fs.writeFileSync(path.join(root, "libs/reader.rs"), "original");
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=DemoTest",
    "-c",
    "user.email=demo@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  const before = sourceState(root, ["libs"]);
  fs.writeFileSync(path.join(root, "libs/reader.rs"), "changed");
  assert.notEqual(sourceState(root, ["libs"]).digest, before.digest);
  fs.writeFileSync(path.join(root, "libs/reader.rs"), "original");
  fs.writeFileSync(path.join(root, "libs/new.rs"), "new source");
  assert.notEqual(sourceState(root, ["libs"]).digest, before.digest);
});
test("artifact tampering is rejected while node_modules and target are excluded", (t) => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules/ignored"), "cache");
  fs.writeFileSync(path.join(root, "runtime-config.json"), "prepared");
  const list = artifacts(root);
  assert.equal(list.length, 1);
  verifyArtifacts(root, list);
  fs.writeFileSync(path.join(root, "runtime-config.json"), "changed");
  assert.throws(() => verifyArtifacts(root, list), /Prepared artifact changed/);
});
test("artifact paths cannot escape the bundle", (t) => {
  const root = temp(t);
  for (const item of [
    "../secret",
    "a/../../secret",
    path.resolve(root, "..", "secret"),
  ])
    assert.throws(() => within(root, item));
  assert.equal(
    within(root, "ui/ui.lock.json"),
    path.join(root, "ui/ui.lock.json"),
  );
});
test("generator and private-input drift have actionable reasons", () => {
  const expected = {
    gearbox: { digest: "same" },
    gears: { digest: "same" },
    engine: "original",
    privateHash: "original",
  };
  assert.throws(
    () => checkInputs(expected, { ...expected, engine: "new" }),
    /Generator binary changed/,
  );
  assert.throws(
    () => checkInputs(expected, { ...expected, privateHash: "new" }),
    /Private configuration or portraits changed/,
  );
});

test("the prepared input fingerprint includes shared UI packages", (t) => {
  const root = temp(t),
    work = path.join(root, "work");
  git(root, ["init", "--quiet"]);
  fs.mkdirSync(path.join(root, "ui/ui-sdk/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "ui/ui-sdk/src/events.ts"), "original");
  git(root, ["add", "ui"]);
  git(root, [
    "-c",
    "user.name=DemoTest",
    "-c",
    "user.email=demo@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  for (const file of [
    "private/runtime-secrets.json",
    "private/values.private.json",
    "private/kubernetes-secret.json",
    "private/postgres.env",
    "private-assets/portraits/manifest.json",
    "private-assets/portraits/dasha.webp",
    "private-assets/portraits/ilya.webp",
  ]) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), "fixture");
  }
  const engine = path.join(root, "engine");
  fs.writeFileSync(engine, "fixture");
  const { inputs } = require("./bundle-state.cjs");
  const before = inputs(root, root, engine, work);
  fs.writeFileSync(path.join(root, "ui/ui-sdk/src/events.ts"), "changed");
  assert.notEqual(
    inputs(root, root, engine, work).gears.digest,
    before.gears.digest,
  );
});

test("an added deployment artifact cannot bypass the prepared manifest", (t) => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, "helm"));
  fs.writeFileSync(path.join(root, "helm/deployment.yaml"), "prepared");
  const manifest = artifacts(root);
  verifyArtifacts(root, manifest, true);
  fs.writeFileSync(path.join(root, "helm/unverified.yaml"), "new template");
  assert.throws(
    () => verifyArtifacts(root, manifest, true),
    /artifact set changed/,
  );
});
