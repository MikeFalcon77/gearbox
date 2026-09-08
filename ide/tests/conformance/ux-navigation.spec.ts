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

import {
  expect,
  expectContext,
  openGraph,
  openProduct,
  productSection,
  resetCatalogueView,
  revealCatalogue,
  settled,
  test,
} from "../fixtures/studio";

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
    await page.locator('[data-toggle-gear="cluster"]').click();
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

    await page.locator('[data-toggle-gear="cluster"]').click();
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
});
