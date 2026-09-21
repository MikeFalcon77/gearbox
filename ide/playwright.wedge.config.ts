// The claims that have to break an engine, and therefore cannot share one.
//
// A separate configuration rather than a second project in
// `playwright.config.ts`, for one reason that is not about tidiness:
// `webServer` is global in Playwright, so a second entry there would boot a
// second Theia -- with a second engine and a second plugin host -- on every
// conformance run, including the hundred and ninety-five claims that have no use
// for it. This way the cost is paid by the run that asks for it.
//
// What the run needs, and why each part is here rather than inherited:
//
// * **Its own server, never a reused one.** The claim ends its engine and
//   re-initializes. Against somebody's open Studio that is a session taken down
//   mid-review; against a *reused* one it inherits whatever state that session
//   was already in, which is the opposite of a controlled timeout. So
//   `reuseExistingServer: false` and a port of its own -- and if that port is
//   busy, the run fails rather than quietly testing something else.
// * **Its own engine.** `GEARBOX_ENGINE` points at the pass-through proxy, read
//   at every spawn, so the recovery half runs against the real binary too.
// * **Its own cap.** `GEARBOX_PRODUCT_TIMEOUT_MS`, validated by
//   `productTimeoutMs` and 60s when it is unset, which is every other run.
// * **Its own data.** The claim copies a product under an id of its own; see
//   `tests/fixtures/product-copy.ts` for why the id and not the directory is the
//   part that isolates.
//
// Run it with `npm run wedge`. `npm run verify` does.

import { defineConfig } from "@playwright/test";
import { join } from "node:path";

import { WEDGE_PORT, WEDGE_URL, wedgeEnv } from "./tests/wedge/seam";

const ENGINE = join(__dirname, "../target/debug/gearbox");

export default defineConfig({
  testDir: "tests/wedge",

  // One at a time and no retries, for the reasons the conformance config gives
  // at length. Here there is a second: the engine is a single process per
  // server, so two claims wedging it in parallel would be one claim watching the
  // other's timeout.
  workers: 1,
  fullyParallel: false,
  retries: 0,

  // A real deadline has to elapse inside this. The cap is 8s and the claim waits
  // out one of them on top of an application boot and a product open.
  timeout: 180_000,
  expect: { timeout: 15_000 },

  // No conformance reporter: these are not claims in a design document, they are
  // the seam the claims about recovery will be driven through. `EXPECTED_TESTS`
  // counts what lives under `tests/conformance/`, and adding to that count from
  // a different configuration would make the table's total depend on which
  // command somebody ran.
  reporter: [["list"]],

  globalSetup: "./tests/wedge/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",

  use: {
    baseURL: WEDGE_URL,
    viewport: { width: 1600, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },

  webServer: {
    command: "node scripts/start-studio-wedge.mjs",
    url: WEDGE_URL,
    // **The whole point.** See the header: a reused server is a server whose
    // engine somebody else has already had their way with.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      GEARBOX_STUDIO_PORT: String(WEDGE_PORT),
      ...wedgeEnv(ENGINE),
    },
  },
});
