// Navigation as an atomic act: opening a product ends in the Product workspace,
// and a reload ends on Home.
//
// Both claims come from the UX pass of 2026-09-07, and both were unobservable
// before it. The mechanism they guard is in `StudioContextService.recompute`:
// `PerspectiveService.switchPerspective` returns early when its target is
// already the active perspective, and `ShellLayoutRestorer` sets that id from
// persisted state before any Gearbox code runs. So a session that had a product
// open came back with `gearbox.product` active and no product open -- and the
// *next* open asked for the perspective the shell already believed was active,
// got no `onActivate`, and left the Start screen in the centre with the header
// saying `payments-demo`.
//
// The suite could not see it for a second reason worth keeping: `openProduct`
// in the fixture calls `revealView`, which performs the missing step itself.
// These two tests therefore drive the shell the way a person does and assert
// visibility with no reveal anywhere.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The repository root, for the one claim that edits a description on disk. */
const REPO = join(__dirname, "../../..");

import {
  expect,
  expectContext,
  openGraph,
  openProduct,
  productSection,
  resetCatalogueView,
  revealCatalogue,
  runCommand,
  settled,
  test,
} from "../fixtures/studio";

const IDE = join(__dirname, "../..");

test.describe("Home is the start screen and nothing else", () => {
  test("nothing opens itself into the bottom panel on Home [plan §9.1: an empty domain panel is worse than an absent one]", async ({
    freshStudio,
  }) => {
    // Four panels used to open themselves on a first run: Problems, Outline, the
    // Inspector and -- before `HiddenTerminal` -- a `zsh`. None of them has a
    // subject on Home. Problems has no resolution to report on, an outline of a
    // `product.gdl` is a shorter Product tree, and the Inspector's whole content
    // with nothing selected is an invitation to select something. §9.1 already
    // calls an empty domain panel worse than an absent one; this is that rule
    // applied to the panels this application did not choose.
    //
    // The catalogue is deliberately **not** part of this claim. It stays on Home
    // as the secondary "Browse" half that ADR-0011's amendment describes, and
    // ADR-0009's claims are about watching it load.
    const { page } = freshStudio;
    await settled(page);
    await expect(page.locator(".gbx-toolbar")).toHaveAttribute("data-context", "home");

    const bottom = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll("#theia-bottom-content-panel .lm-TabBar-tabLabel"),
      ).map((e) => (e.textContent ?? "").trim()),
    );
    expect(bottom).toEqual([]);
  });
});

test.describe("a screen belongs to a subject", () => {
  test("closing a product takes its screens with it [ADR-0011 §Amendment: a screen belongs to a subject]", async ({
    studio,
  }) => {
    // The finding this is built from, verbatim: "after Close the product closes,
    // but the active tab stays an empty `Gearbox Product`". The cause is not a
    // stray widget -- it is that nothing ever decided a screen may *stop* being
    // allowed. A menu is re-read each time it opens; a widget already on screen
    // is never asked again.
    //
    // Add Gear is opened first because it is the harder half: the Product view
    // at least renders a picker with no product, whereas the configurator holds a
    // proposal composed against one, and `ProductEditService` resolves its target
    // when it commits rather than when it was staged.
    const { page } = studio;
    await openProduct(page, "dev");
    await revealCatalogue(page);
    await resetCatalogueView(page);
    await page.locator('[data-toggle-gear="tenant-resolver"]').click();
    await expect(page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });

    await page.locator('[data-command="gearbox.product.close"]').click();
    await expectContext(page, "home");

    const main = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#theia-main-content-panel .lm-TabBar-tabLabel")).map(
        (e) => (e.textContent ?? "").trim(),
      ),
    );
    expect(main, "a product's screens outlived the product").not.toContain("Gearbox Product");
    expect(main, "a product's screens outlived the product").not.toContain("Add Gear");
    // And the context's own screen is in front, rather than whichever sibling
    // Lumino picked when the active tab closed -- the rule that took ten Add Gear
    // claims down the last time anything here was closed.
    await expect(page.locator(".gbx-start")).toBeVisible();
  });
});

test.describe("a screen that wants the room", () => {
  test("the panels come back when the last such screen closes, not the first [ADR-0011 §Amendment: the room is arranged before the screen appears]", async ({
    freshStudio,
  }) => {
    // Found by using the thing: `Add Gear -> Graph -> close Add Gear` gave the
    // panels back while the Graph -- which had asked for the room in the same
    // episode -- was still the screen in front of them. The service tracked one
    // screen per episode, so the first close looked like the last.
    //
    // **Read by comparing the panel to its own tab bar**, which is what makes
    // this independent of how wide a person has dragged it: a collapsed side
    // panel is its tab bar and nothing else. `lm-mod-current` was tried first and
    // is not the signal -- `collapse()` nulls the tab bar's `currentTitle`, but
    // the DOM class stays, so it read as open at 49 pixels wide.
    // **A fresh app, and that is not caution -- the shared session cannot show
    // this.** An episode spans consecutive focus screens by design, so a Graph
    // that an earlier test left open keeps its episode running, and a later
    // `enterFocus` correctly does nothing. Correct behaviour, unobservable claim.
    const { page } = freshStudio;
    await settled(page);
    const leftOpen = (): Promise<boolean> =>
      page.evaluate(() => {
        const panel = document.querySelector("#theia-left-content-panel") as HTMLElement | null;
        if (panel === null) return false;
        const bar = panel.querySelector(".lm-TabBar") as HTMLElement | null;
        return panel.offsetWidth > (bar?.offsetWidth ?? 0) + 8;
      });

    await openProduct(page, "dev");
    await revealCatalogue(page);
    await resetCatalogueView(page);
    expect(await leftOpen(), "the catalogue must start open for this to mean anything").toBe(true);

    await page.locator('[data-toggle-gear="tenant-resolver"]').click();
    await expect(page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    expect(await leftOpen(), "opening the configurator did not fold the catalogue").toBe(false);

    await openGraph(page);
    // Still one episode: opening a second such screen must not re-snapshot, or
    // the episode records "already folded" as the state it owes.
    expect(await leftOpen()).toBe(false);

    await page.locator('[id="shell-tab-gearbox.add-gear"] .lm-TabBar-tabCloseIcon').click();
    await expect(page.locator("[data-add-gear-flow]")).toHaveCount(0);
    expect(
      await leftOpen(),
      "the panels came back while a screen that wanted the room was still open",
    ).toBe(false);

    await page.locator('[id="shell-tab-gearbox.graph"] .lm-TabBar-tabCloseIcon').click();
    await expect(page.locator(".gearbox-graph")).toHaveCount(0);
    expect(await leftOpen(), "the last close did not give the catalogue back").toBe(true);
  });
});

test.describe("the product has stages", () => {
  test("the Product view is four stages and a way out to Generate [plan §9.1: Product navigation]", async ({
    studio,
  }) => {
    // The panel had grown to the whole product on one strip -- header, actions,
    // profile switch, profile fields, four foldable branches and a diagnostics
    // line -- and a UX pass reported it as a very long screen with no sense of
    // where one is. The four names are the stages of composing a product: what
    // it *is*, what it is *made of*, how that *deploys*, and what is *wrong*.
    //
    // Generate is the fifth stage and is a view of its own, so the strip links
    // out to it rather than reproducing a file plan and an Apply button in two
    // places. That is the difference this claim fixes in place: a tab would
    // become a second answer to the same question.
    await openProduct(studio.page, "dev");
    const strip = studio.page.locator(".gbx-product-nav");
    await expect(strip).toBeVisible();
    const tabs = await strip
      .locator("[data-product-section]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-product-section")));
    expect(tabs).toEqual(["overview", "gears", "topology", "validation"]);

    // The profile switch and the diagnostics summary are above the strip, so they
    // survive a change of stage: the switch has to work while a resolution is in
    // flight, and one line saying the resolution complained belongs on every
    // stage rather than only on the one about complaints.
    await productSection(studio.page, "topology");
    await expect(studio.page.locator('[data-profile="dev"]')).toBeVisible();
    await expect(studio.page.locator(".gbx-diagnostics")).toBeVisible();
    await expect(studio.page.locator("[data-resolved-profile]")).toHaveCount(0);

    await expect(strip.locator("[data-product-section-generate]")).toBeVisible();
    await strip.locator("[data-product-section-generate]").click();
    await expect(studio.page.locator(".gbx-generate")).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("validation is a stage, not a doorway", () => {
  test("Validation shows the diagnostics rather than a way to reach them [plan §9.1: Validation is a screen]", async ({
    studio,
  }) => {
    // The finding: a centre panel holding two counts and two nearly identical
    // buttons, while the rows carrying the code, the remedy and the location
    // lived only in the bottom panel. Asserted as the three things that changed:
    // the summary is there, the rows are there, and the duplicate button is not.
    const { page } = studio;
    await openProduct(page, "dev");
    await productSection(page, "validation");

    const stage = page.locator("[data-product-validation]");
    await expect(stage).toBeVisible();

    // The counts stay -- they are the orientation the list is read against.
    await expect(stage.locator("[data-validation-errors]")).toBeVisible();
    await expect(stage.locator("[data-validation-warnings]")).toBeVisible();

    // The rows themselves, in the stage rather than only in the bottom panel,
    // and each naming its code: a diagnostic without one cannot be looked up.
    const rows = stage.locator(".gbx-conflict");
    const count = await rows.count();
    expect(count, "this profile resolves with at least one diagnostic to show").toBeGreaterThan(0);
    const codes = await rows.evaluateAll((all) =>
      all.map((r) => r.getAttribute("data-conflict-code")),
    );
    expect(codes.every((code) => code !== null && code.length > 0)).toBe(true);

    // And the remedy, which is the half three of the four old renderers dropped.
    expect(await stage.locator(".gbx-conflict-help").count()).toBeGreaterThan(0);

    // The one-line summary is suppressed *here* and nowhere else: on this stage
    // it would be a second copy of the summary above, beside a button
    // duplicating the link below it.
    await expect(page.locator("[data-show-conflicts]")).toHaveCount(0);
    await productSection(page, "topology");
    await expect(page.locator("[data-show-conflicts]")).toHaveCount(1);
    await productSection(page, "validation");

    // **The demoted link still does what it says.** It survives because the
    // bottom panel is where the list is read *beside* the tree, so the assertion
    // is not that a panel appears but that it appears **there** -- a Conflicts
    // screen in the main area would have replaced the thing it is about.
    await stage.locator("[data-validation-open-conflicts]").click();
    await expect(page.locator("#theia-bottom-content-panel .gbx-conflicts")).toBeVisible({
      timeout: 30_000,
    });

    // And a row's location opens the description. Left until last because it puts
    // an editor in the main area, which is the one action here that navigates.
    //
    // The expected file is read from the link rather than written in: what the
    // claim is about is that the location resolves to the file it names. On this
    // corpus both dev diagnostics point at `product.gdl:1`.
    const where = stage.locator(".gbx-conflict-where").first();
    const label = ((await where.textContent()) ?? "").trim();
    const file = /([^/\s:]+\.gdl):\d+$/.exec(label)?.[1];
    expect(file, `a location link should name a .gdl file, got "${label}"`).toBeDefined();
    await where.click();
    await expect(
      page.locator("#theia-main-content-panel .lm-TabBar-tabLabel", { hasText: String(file) }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("what a proposal would introduce is the same row, at a smaller weight [plan §9.1: Validation is a screen]", async ({
    studio,
  }) => {
    // **Reported unobserved, and the reason is a fix rather than a gap.** This
    // used to drive `rg-tr-plugin`, the one gear whose addition introduced a
    // diagnostic -- and it introduced one *because the preview was describing the
    // wrong operation*: it asked the engine what a top-level `use_gear` of a
    // plugin would do, which is the form this build refuses to write. With the
    // preview computed from the batch that will actually be written, no proposal
    // on this corpus introduces a diagnostic, so there is no compact list to look
    // at. Tried all nine addable gears, plugins with a host chosen included.
    //
    // What still holds is asserted at the source, the way the `ensurePlan` rule
    // is: the panel renders the shared row at compact density rather than a
    // key-value line of its own. The DOM half returns as soon as the corpus has a
    // proposal that introduces a diagnostic.
    const widget = readFileSync(
      join(IDE, "gearbox-studio/src/browser/add-gear/add-gear-widget.tsx"),
      "utf8",
    );
    expect(widget, "Add Gear should render diagnostics with the shared row").toMatch(
      /<DiagnosticsList[\s\S]{0,200}density="compact"/,
    );
    test.skip(
      true,
      "no proposal on this corpus introduces a diagnostic: the one that did was previewing a plugin as a top-level gear, which this build refuses",
    );
    await expect(studio.page.locator("[data-add-gear-impact-diagnostics]")).toHaveCount(0);
  });
});

test.describe("an open says which part of it is slow", () => {
  test("the wait is four named steps that advance [plan §9.1: opening is staged]", async ({
    freshStudio,
  }) => {
    // Three seconds of `Loading payments-demo…` cannot tell a slow catalogue from
    // a description that will never evaluate, and an open is two engine spawns
    // plus a catalogue load. So the panel names the four steps and says which one
    // it is on.
    //
    // A fresh app and the picker, not the Continue card: there are no recents on
    // a first run, and clicking `Open Product…` is the path that exists.
    const { page } = freshStudio;
    await settled(page);
    await runCommand(page, "Open Product…");
    const options = page.locator(`.quick-input-list [role="option"]`);
    await options.first().waitFor({ state: "visible", timeout: 30_000 });
    await options.filter({ hasText: "payments-demo" }).first().click();

    // Sampled, because the claim is about *advancing* -- a single reading cannot
    // tell a checklist from a picture of one.
    const samples: { stage: string | null; done: number; steps: number; label: string }[] = [];
    for (let round = 0; round < 120; round += 1) {
      const snap = await page.evaluate(() => {
        const el = document.querySelector("[data-opening-stage]");
        return {
          stage: el?.getAttribute("data-opening-stage") ?? null,
          label: el?.getAttribute("data-product-opening") ?? "",
          steps: document.querySelectorAll("[data-step]").length,
          done: document.querySelectorAll("[data-step].gbx-opening-done").length,
        };
      });
      if (snap.stage !== null) samples.push(snap);
      if ((await page.locator("[data-resolved-profile]").count()) > 0) break;
      await page.waitForTimeout(80);
    }

    expect(samples.length, "the open finished without the panel ever saying so").toBeGreaterThan(0);
    // All four steps, always: a list that grew as it went would hide how much is
    // left, which is the question a wait raises.
    expect(new Set(samples.map((s) => s.steps))).toEqual(new Set([4]));
    // The product's name, because "Loading…" with no subject is what an
    // application that has lost track of itself says.
    expect(samples[0]?.label).toContain("payments-demo");
    // It starts on the first step with nothing ticked -- a checklist that
    // pre-ticks its steps is a progress bar in a costume -- and it advances.
    expect(samples[0]?.stage).toBe("workspace");
    expect(samples[0]?.done).toBe(0);
    expect(Math.max(...samples.map((s) => s.done)), "no step was ever completed").toBeGreaterThan(
      0,
    );
    expect(new Set(samples.map((s) => s.stage)).size, "the step never changed").toBeGreaterThan(1);

    // **And the branch that renders this comes before the one that renders a
    // product's error**, which is an ordering that broke once and cannot be
    // observed here: with a *failed* product in the store, `status === "error"`
    // answered first, so opening another product kept the old one's error on
    // screen for the whole open and then in place of the new one's refusal.
    //
    // Asserted on the source because reaching it needs two products and a
    // failure, and this corpus has one product and no way to make it fail (see
    // the note below). An ordering bug of this shape returns silently.
    const widget = readFileSync(
      join(IDE, "gearbox-studio/src/browser/product/product-widget.tsx"),
      "utf8",
    );
    const openingBranch = widget.indexOf('opening.status !== "idle"');
    const errorBranch = widget.indexOf('state.status === "error"');
    expect(openingBranch, "the opening branch is gone").toBeGreaterThan(0);
    expect(errorBranch, "the error branch is gone").toBeGreaterThan(0);
    expect(
      openingBranch < errorBranch,
      "a product's error is rendered before another product's open, so it outlives its subject",
    ).toBe(true);
  });

  // **There is no browser claim for a refused open, and that is a finding rather
  // than an omission.** Every product in this corpus opens; writing one that does
  // not evaluate means putting it under `products/`, which `global-setup` refuses.
  // Killing the engine looks like the way in and is not: `initialize` spawns a new
  // engine on every call, so an open that begins with `catalogue.load` gets a
  // fresh one and succeeds -- verified by trying it, and the panel duly never
  // reported a failure.
  //
  // So the failure paths are checked deterministically in
  // `scripts/store-smoke.mjs` against `shell/opening-outcome.js`, which is where
  // the decisions live and which imports nothing but types: a `git(...)` source
  // belongs to `describe`, a catalogue that reports `status: "error"` stops its
  // own step, and a product the store did not resolve is not an open at all. That
  // script runs in `npm run verify`. A `⚪ not observed` row here would suggest a
  // later run might see it, and none can.
});

test.describe("Overview says what the product is", () => {
  test("Overview reports the shape, the tree and the sources without asking for any of it [plan §9.1: Overview is the product at a glance]", async ({
    studio,
  }) => {
    // The stage was two rows -- a profile and a link -- which made the emptiest
    // screen in the application the one every open lands on.
    const { page } = studio;
    await openProduct(page, "dev");
    await productSection(page, "overview");

    const gears = page.locator("[data-overview-gears]");
    const processes = page.locator("[data-overview-applications]");
    await expect(gears).toBeVisible();
    await expect(processes).toBeVisible();
    expect(Number(await gears.getAttribute("data-overview-gears"))).toBeGreaterThan(0);
    expect(Number(await processes.getAttribute("data-overview-applications"))).toBeGreaterThan(0);
    // The count that surprises people: a closure nobody asked for.
    await expect(gears).toHaveText(/\d+/);
    await expect(page.locator("[data-figure='gears']")).toContainText("pulled in");

    // The sources are the description's, so a root that failed to load is named.
    const sources = page.locator("[data-overview-sources]");
    await expect(sources).toBeVisible();
    expect(Number(await sources.getAttribute("data-overview-sources"))).toBeGreaterThan(0);

    // **Arriving on the stage must not start work.** `ensurePlan` is a round trip
    // to the engine, and a render that asked for one would do it on every repaint
    // of a panel that repaints on every store change.
    //
    // Asserted at the source, because the observable version is not sound: a plan
    // that completed between two readings leaves the status looking untouched, so
    // "the status did not change" is a check that passes when the rule is broken.
    // What the rule actually says is that this widget never calls `ensurePlan`,
    // and that is a statement about the source -- the same shape as the codicon
    // and accessibility claims, which read these files for the same reason.
    const widget = readFileSync(
      join(IDE, "gearbox-studio/src/browser/product/product-widget.tsx"),
      "utf8",
    );
    expect(
      /ensurePlan\s*\(/.test(widget),
      "the Product view asks the engine for a plan while rendering",
    ).toBe(false);
    // And the visible half: the stage reports a status rather than a spinner,
    // which is what "not planned yet is an answer" means.
    const status = page.locator("[data-overview-generate]");
    await expect(status).toBeVisible();
    expect(await status.getAttribute("data-overview-generate")).not.toBe("planning");

    // A count with no way through is trivia: the figures move between stages.
    await page.locator("[data-figure='applications']").click();
    await expect(page.locator('[data-product-section="topology"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

test.describe("opening a product is one act", () => {
  test("a reload with a product open comes back to Home [plan §9.1: Home is a screen, not an empty area]", async ({
    freshStudio,
  }) => {
    const { page } = freshStudio;
    await settled(page);

    // Boot no longer opens a product on the strength of finding one, so getting
    // there is an act: the picker, since a fresh profile has nothing to continue.
    await page.locator('[data-start-action="open"]').click();
    const options = page.locator(`.quick-input-list [role="option"]`);
    await options.first().waitFor({ state: "visible", timeout: 30_000 });
    await options.filter({ hasText: "payments-demo" }).first().click();
    await expect(page.locator(".gbx-toolbar")).toHaveAttribute("data-context", "product", {
      timeout: 90_000,
    });
    // Resolved, not merely opening. `data-context` flips as soon as the store has
    // a reference, which is seconds before the open finishes -- and Recent is
    // written at the *end*, deliberately, because it is a list of products that
    // opened rather than of ones once attempted. Reloading before then aborts the
    // open and there is nothing to continue.
    await expect(page.locator("[data-resolved-profile]")).toBeVisible({ timeout: 90_000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await settled(page);

    await expect(page.locator(".gbx-toolbar")).toHaveAttribute("data-context", "home", {
      timeout: 30_000,
    });
    await expect(page.locator(".gbx-start")).toBeVisible();
    // And the way back is one click, named after the thing it returns to.
    await expect(page.locator('[data-start-action="continue"]')).toContainText("payments-demo");
  });

  test("opening a product leaves the Product workspace on screen [plan §9.1: Open Product is atomic]", async ({
    freshStudio,
  }) => {
    const { page } = freshStudio;
    await settled(page);

    // Round trip through a product and a reload first, because that is what puts
    // `gearbox.product` into the restored perspective id. Opening a product in a
    // shell that has never had one open takes a path where the early return
    // cannot fire, so a test that skipped this would pass against the defect.
    await page.locator('[data-start-action="open"]').click();
    const options = page.locator(`.quick-input-list [role="option"]`);
    await options.first().waitFor({ state: "visible", timeout: 30_000 });
    await options.filter({ hasText: "payments-demo" }).first().click();
    await expect(page.locator(".gbx-toolbar")).toHaveAttribute("data-context", "product", {
      timeout: 90_000,
    });
    await expect(page.locator("[data-resolved-profile]")).toBeVisible({ timeout: 90_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await settled(page);

    await page.locator('[data-start-action="continue"]').click();

    // The whole claim: no `revealView`, no `View > Gearbox Product`, no tab click.
    // While the engine restarts twice the panel says which product it is waiting
    // for, and it is the Product panel saying it rather than Home still sitting
    // there.
    await expect(page.locator(".gbx-product")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("[data-resolved-profile]")).toBeVisible({ timeout: 90_000 });
    // Home is not in front of it: the header would say `payments-demo` while the
    // centre offered to open one. Not *absent* -- the Start screen stays a tab
    // in the main area, and `StartViewContribution` records why closing it is
    // the wrong instrument. The complaint was about what is on screen.
    await expect(page.locator(".gbx-start")).toBeHidden();
  });

  test("saving the description on disk re-resolves it without a click [plan §9.1: the panel shows what the file says]", async ({
    freshStudio,
  }) => {
    // Nothing subscribed to the filesystem before `DescriptionWatchService`, so
    // every Gearbox surface went on rendering the resolution from before the
    // save -- twelve of them, all reading the same two stores. The complaint
    // arrives as "the Inspector does not update"; the Inspector is not special.
    //
    // A fresh app because the claim is about a *product this session opened*
    // and the watch is scoped to it, and on the real description rather than a
    // fixture because Theia's watcher is what delivers the event and it only
    // watches the workspace.
    const { page } = freshStudio;
    await settled(page);
    await openProduct(page, "dev");

    const gdl = join(REPO, "products/payments-demo/product.gdl");
    const original = readFileSync(gdl, "utf8");
    const hash = page.locator("[data-resolved-profile]");
    const before = await hash.getAttribute("data-lock-hash");

    try {
      // A real edit, and one every resolution reads, so the lock hash has to
      // move if the file was read again at all.
      writeFileSync(gdl, original.replace('version = "0.1.0"', 'version = "0.1.1"'));
      // No click, no command, no reveal between here and the assertion.
      await expect(hash).not.toHaveAttribute("data-lock-hash", before ?? "", {
        timeout: 30_000,
      });
    } finally {
      writeFileSync(gdl, original);
    }
  });

  test("saving a gear description re-reads the catalogue without a reload [plan §9.1: the panel shows what the file says]", async ({
    freshStudio,
  }) => {
    // The other half of the same complaint. `product.gdl` was picked up above;
    // a `gear.gdl` was not, and the reason recorded in `DescriptionWatchService`
    // -- that catching it would mean respawning the engine -- turned out to be a
    // client-side habit rather than a protocol requirement. `catalogue/load`
    // re-reads on the process already running.
    //
    // The gear's `description` is the probe, and the choice is load-bearing.
    // Not its `name`: `detailOf` finds a row *by* display name and four other
    // claims call `detailOf("API Gateway")`, so a run interrupted between the
    // write and the restore would break them with a failure naming nothing.
    // Not a structural fact like `deps` either -- that moves resolutions this
    // suite asserts on elsewhere. A description is declared, presentational,
    // and pinned by nobody.
    const { page } = freshStudio;
    await settled(page);

    // Selected *before* the edit, and not touched after it. The claim is that
    // an open panel changes on its own; re-clicking the row afterwards would
    // prove only that the store can be re-read, which was never in doubt.
    const shown = await freshStudio.detailOf("API Gateway");
    expect(shown, "the api-gateway row is in the catalogue").not.toBeNull();

    const gdl = join(REPO, "../gears-rust/gears/system/api-gateway/gear.gdl");
    const original = readFileSync(gdl, "utf8");
    const probe = `watched at ${Date.now()}`;

    try {
      writeFileSync(gdl, original.replace(/description = "[^"]*"/, `description = "${probe}"`));
      // No click, no command, no reveal between here and the assertion. The
      // budget covers a 700ms settle plus a full staged rescan of the corpus.
      await expect(page.locator(".gbx-detail")).toContainText(probe, { timeout: 60_000 });
    } finally {
      // Load-bearing: `global-setup` guards `products/` only, so nothing else
      // in this suite would notice a `gear.gdl` left rewritten.
      writeFileSync(gdl, original);
    }
  });
});
