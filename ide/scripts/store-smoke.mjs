#!/usr/bin/env node
// The catalogue store's state machine, against a fake service.
//
// `rpc-smoke` never constructs a `CatalogueStore`, so the two ways the panel
// used to lie were invisible to it: a rejected `initialize()` left `loading`
// set forever with no error anywhere, and a second `load()` started while the
// first was still in flight let the first one's pending set land on top of the
// second's projections.
//
// A fake service rather than a real engine, and deliberately: both failures are
// about ordering, and an ordering test driven by a real process is a test of
// how fast the machine is.
//
// Usage: node ide/scripts/store-smoke.mjs

import { CatalogueStore } from "../gearbox-studio/lib/browser/catalogue-store.js";
import { ProductStore } from "../gearbox-studio/lib/browser/product-store.js";

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures += 1;
}

/** A store wired to `service`, bypassing inversify's property injection. */
function storeWith(service) {
  const store = new CatalogueStore();
  store.service = service;
  return store;
}

function pending(gdlPath) {
  return {
    source: "fixture",
    gdl_path: gdlPath,
    stage: "declared",
    display_name: gdlPath,
    description: null,
    category: "core-functionality",
  };
}

function projected(gdlPath, id) {
  return {
    id,
    source: "fixture",
    gdl_path: gdlPath,
    display_name: id,
    category: "core-functionality",
  };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// ------------------------------------------------- a failed load is a state

{
  const store = storeWith({
    initialize: () => Promise.reject(new Error("spawn gearbox ENOENT")),
    loadCatalogue: () => Promise.reject(new Error("unreachable")),
  });

  await store.load();
  const state = store.current;
  check(state.status === "error", `a rejected initialize ends in "error" (got "${state.status}")`);
  check(
    (state.error ?? "").includes("ENOENT"),
    `the cause is kept for the panel to show (got ${JSON.stringify(state.error)})`,
  );
  check(state.rows.length === 0, "no rows are left behind from a failed load");
}

// ------------------------------------------- a failed catalogue load, likewise

{
  const store = storeWith({
    initialize: () => Promise.resolve({ capabilities: {}, roots: [], failed_roots: [] }),
    loadCatalogue: () => Promise.reject(new Error("the engine did not answer in 120000ms")),
  });

  await store.load();
  check(store.current.status === "error", "a rejected catalogue/load ends in \"error\"");
  check((store.current.error ?? "").includes("120000ms"), "the timeout is what the panel reports");
}

// ------------------------------------ failed roots reach the state, not a log

{
  const store = storeWith({
    initialize: () =>
      Promise.resolve({
        capabilities: {},
        roots: [],
        failed_roots: [{ path: "/nope", error: "no such directory" }],
      }),
    loadCatalogue: () => Promise.resolve({ total: 0, pending: [], diagnostics: [] }),
  });

  await store.load();
  check(store.current.failedRoots.length === 1, "a root that would not open is reported");
}

// ------------------------------------------------------- overlapping loads

{
  // Load A is suspended at the S1/S2 boundary. Load B runs to completion and
  // projects a gear. A then resumes: its pending set must not land on top.
  const first = deferred();
  let loads = 0;
  const store = storeWith({
    initialize: () => Promise.resolve({ capabilities: {}, roots: [], failed_roots: [] }),
    loadCatalogue: () => {
      loads += 1;
      return loads === 1
        ? first.promise
        : Promise.resolve({ total: 1, pending: [pending("b/gear.gdl")], diagnostics: [] });
    },
  });

  const a = store.load();
  // Let A get past `initialize` and into `loadCatalogue`.
  await new Promise((r) => setImmediate(r));

  await store.load();
  store.onCatalogueChanged({ gear: projected("b/gear.gdl", "b"), replaces: "b/gear.gdl" });
  store.onProgress({ token: "catalogue", completed: 1, total: 1, done: true });

  first.resolve({ total: 1, pending: [pending("a/gear.gdl")], diagnostics: [] });
  await a;

  const rows = store.current.rows;
  check(rows.length === 1 && rows[0].gear.gdl_path === "b/gear.gdl", "only the newest load's rows survive");
  check(rows[0]?.kind === "projected", "a superseded load cannot revert a projected row to pending");
  check(store.current.status === "ready", "the newest load's terminal progress still stands");
}

// --------------------------------------- pending after `done` is not "parsing"

{
  const store = storeWith({
    initialize: () => Promise.resolve({ capabilities: {}, roots: [], failed_roots: [] }),
    loadCatalogue: () =>
      Promise.resolve({ total: 2, pending: [pending("ok/gear.gdl"), pending("bad/gear.gdl")], diagnostics: [] }),
  });

  await store.load();
  store.onCatalogueChanged({ gear: projected("ok/gear.gdl", "ok"), replaces: "ok/gear.gdl" });
  store.onCatalogueDiagnostics({
    diagnostics: [{ code: "GBX0211", severity: "error", message: "bad/gear.gdl did not project" }],
  });
  store.onProgress({ token: "catalogue", completed: 1, total: 2, done: true });

  check(store.current.status === "ready", "the load is over even though a gear never projected");
  check(
    store.current.rows.filter((r) => r.kind === "pending").length === 1,
    "the unprojected gear is still a row rather than vanishing",
  );
  check(
    store.current.diagnostics.length === 1,
    "the second pass's diagnostics reach the state the panel renders",
  );
}

// ------------------------------------------------------------- row identity

{
  const store = storeWith({
    initialize: () =>
      Promise.resolve({
        capabilities: {},
        roots: [
          { id: "one", path: "/roots/one" },
          { id: "two", path: "/roots/two" },
        ],
        failed_roots: [],
      }),
    loadCatalogue: () =>
      Promise.resolve({
        total: 2,
        pending: [
          { ...pending("widget/gear.gdl"), source: "one" },
          { ...pending("widget/gear.gdl"), source: "two" },
        ],
        diagnostics: [],
      }),
  });

  await store.load();
  check(
    store.current.rows.length === 2,
    `the same gdl_path under two roots is two rows (got ${store.current.rows.length})`,
  );
  check(
    store.absolutePath("two", "widget/gear.gdl") === "/roots/two/widget/gear.gdl",
    "each row resolves against its own root",
  );
  check(
    store.absolutePath("one", "../../etc/passwd") === undefined,
    "a path the catalogue could not have produced is refused rather than joined",
  );
}

// ------------------------------------ an abandoned load cannot come back

{
  // A load that failed -- a timeout, a dead engine -- and an engine that keeps
  // projecting into it anyway. The notifications carry no epoch, because the
  // engine does not know one exists, so the store has to decide for itself
  // whether it is still listening. Without that decision the final
  // `$/progress done` set `ready` over the top of the error and the panel showed
  // a tree for a load it had just said had failed.
  const store = storeWith({
    initialize: () => Promise.resolve({ capabilities: {}, roots: [], failed_roots: [] }),
    loadCatalogue: () => Promise.reject(new Error("the engine did not answer in 120000ms")),
  });

  await store.load();
  check(store.current.status === "error", "a load that times out is an error");

  store.onCatalogueChanged({ gear: projected("late/gear.gdl", "late"), replaces: "late/gear.gdl" });
  store.onCatalogueDiagnostics({
    diagnostics: [{ code: "GBX0211", severity: "error", message: "late" }],
  });
  store.onProgress({ token: "catalogue", completed: 9, total: 9, done: true });

  check(store.current.status === "error", "a late `done` cannot walk the error back to ready");
  check(store.current.rows.length === 0, "and a late projection cannot add a row to it");
  check(store.current.diagnostics.length === 0, "nor a late diagnostic");
}

// ------------------------------------ the engine dying mid-projection

{
  // `loadCatalogue` answers at the S1/S2 boundary, so by the time the engine
  // dies there is no request left to reject: every promise has already
  // resolved. The progress `done` that would have ended the load died with the
  // process, and the panel read `14 gear(s) projecting 1/14` for the rest of the
  // session with nothing anywhere saying why.
  const store = storeWith({
    initialize: () => Promise.resolve({ capabilities: {}, roots: [], failed_roots: [] }),
    loadCatalogue: () =>
      Promise.resolve({
        total: 2,
        pending: [pending("a/gear.gdl"), pending("b/gear.gdl")],
        diagnostics: [],
      }),
  });

  await store.load();
  store.onCatalogueChanged({ gear: projected("a/gear.gdl", "a"), replaces: "a/gear.gdl" });
  check(store.current.status === "loading", "the load is streaming");

  store.onEngineExit("exited code=null signal=SIGKILL");
  check(store.current.status === "error", "an engine that dies mid-projection ends the load");
  check(
    (store.current.error ?? "").includes("SIGKILL"),
    "and says what happened rather than only that something did",
  );
  check(
    store.current.rows.length === 2,
    "the rows that did project are kept -- they are still true",
  );

  // And an exit *between* loads is ordinary: disposed on reconnect, killed on
  // the way out. Reporting it would put a red panel over a good tree.
  store.onProgress({ token: "catalogue", completed: 2, total: 2, done: true });
  const settled = store.current.status;
  store.onEngineExit("disposed");
  check(settled === store.current.status, "an exit with no load in flight changes nothing");
}

// ------------------------------------------- logs do not drive the panel

{
  const store = storeWith({
    initialize: () => Promise.resolve({ capabilities: {}, roots: [], failed_roots: [] }),
    loadCatalogue: () => Promise.resolve({ total: 0, pending: [], diagnostics: [] }),
  });
  await store.load();

  let renders = 0;
  store.onChanged(() => {
    renders += 1;
  });
  for (let i = 0; i < 2_000; i += 1) {
    store.onLog(`line ${i}`);
  }
  check(renders === 0, `a log line does not re-render six panels (got ${renders})`);
  check(store.logs.length === 500, `the log buffer is capped (got ${store.logs.length})`);
  check(store.logs[499] === "line 1999", "and keeps the newest lines rather than the oldest");
}

// ================================================================ product

/** A product store wired to `service`, bypassing inversify. */
function productWith(service) {
  const store = new ProductStore();
  store.service = service;
  return store;
}

const REF = { path: "/repo/products/demo/product.gdl", label: "products/demo/product.gdl" };
const INTENT = { default_profile: "embedded", profiles: ["embedded"] };

function productService(overrides) {
  return {
    listProducts: () => Promise.resolve([REF]),
    loadProduct: () => Promise.resolve({ intent: INTENT, diagnostics: [] }),
    resolve: () => Promise.resolve({ product: { product: { lock_hash: "blake3:aa" } }, diagnostics: [] }),
    lock: () => Promise.resolve({ profile: "embedded", lock_hash: "blake3:aa", text: "" }),
    ...overrides,
  };
}

// -------------------------------- a failed lock does not blank the resolve

{
  // `ensureLock` runs from the Lock widget's *render*, long after `resolve`
  // returned. Routing its failure through the shared `error` field replaced a
  // resolution that had succeeded -- graph, diagnostics, profile and all -- with
  // a red box about a TOML serialization.
  const store = productWith(
    productService({ lock: () => Promise.reject(new Error("cannot serialize the lock")) }),
  );
  await store.discover();
  check(store.current.status === "ready", "the product resolved");

  await store.ensureLock();
  check(store.current.status === "ready", "a failed lock leaves the resolution standing");
  check(store.current.resolution !== undefined, "and does not throw the answer away");
  check(
    (store.current.lockError ?? "").includes("cannot serialize"),
    "the failure is reported against the lock",
  );

  // And once, not once per frame: the widget asks on every render, and `lock`
  // stays undefined after a failure, so nothing but this stops the retry loop.
  let calls = 0;
  store.service.lock = () => {
    calls += 1;
    return Promise.reject(new Error("still no"));
  };
  await store.ensureLock();
  await store.ensureLock();
  check(calls === 0, `a lock that failed is not re-requested every render (got ${calls})`);
}

// ------------------------------ reopening the panel does not lose the product

{
  // The Product widget is closable, so its `postConstruct` runs again on every
  // reopen. `discover()` there bumped the epoch -- abandoning any resolve in
  // flight -- and then re-listed. With more than one product it does not reopen
  // anything, so the resolve was thrown away and nothing replaced it: a panel
  // that had a resolved product came back with `resolution` gone and `status`
  // back to `idle`, still naming the product it could no longer show.
  const second = { path: "/repo/products/other/product.gdl", label: "products/other/product.gdl" };
  const store = productWith(
    productService({ listProducts: () => Promise.resolve([REF, second]) }),
  );

  await store.discover();
  check(store.current.open === undefined, "two products are offered rather than opened");
  await store.open(REF);
  check(store.current.status === "ready", `the chosen product resolved (got ${store.current.status})`);

  // The remount.
  await store.ensureDiscovered();
  check(store.current.status === "ready", `reopening keeps the resolution (got ${store.current.status})`);
  check(store.current.open?.path === REF.path, "and keeps the product that was open");
  check(store.current.resolution !== undefined, "and the resolution itself");
}

// ---------------------------- and does not re-run the RPCs it already ran

{
  let listed = 0;
  const store = productWith(
    productService({
      listProducts: () => {
        listed += 1;
        return Promise.resolve([REF]);
      },
    }),
  );
  await store.ensureDiscovered();
  await store.ensureDiscovered();
  await store.ensureDiscovered();
  check(listed === 1, `discovery happens once however often the panel opens (got ${listed})`);
}

console.log(
  failures === 0 ? "\nstore smoke: all checks passed" : `\nstore smoke: ${failures} failed`,
);
process.exit(failures === 0 ? 0 : 1);
