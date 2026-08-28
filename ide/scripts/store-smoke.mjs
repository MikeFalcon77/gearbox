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

console.log(
  failures === 0 ? "\nstore smoke: all checks passed" : `\nstore smoke: ${failures} failed`,
);
process.exit(failures === 0 ? 0 : 1);
