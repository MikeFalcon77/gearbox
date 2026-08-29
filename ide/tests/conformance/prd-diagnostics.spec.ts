// `cpt-gearbox-fr-editor-diagnostics`, in two halves that are in different
// states:
//
//   Description-file diagnostics MUST be reported with source ranges over a
//   language-server interface, and resolution diagnostics MUST be surfaced as
//   editor problem markers replaced atomically on each resolution.
//
// `@theia/markers` is a declared dependency of browser-app and gives the Problems
// view below -- so the destination exists and nothing writes to it.

import { expect, test } from "../fixtures/studio";

test.describe("diagnostics reach a person", () => {
  test("the Problems view is present to receive markers [PRD cpt-gearbox-fr-editor-diagnostics]", async ({
    studio,
  }) => {
    const tabs = await studio.page.evaluate(() =>
      Array.from(
        document.querySelectorAll("#theia-bottom-content-panel .lm-TabBar-tabLabel"),
      ).map((e) => (e.textContent ?? "").trim()),
    );
    expect(tabs).toContain("Problems");
  });

  test("the catalogue panel renders the diagnostics a load produced [PRD cpt-gearbox-fr-editor-diagnostics]", async ({
    studio,
  }) => {
    // Scoped to the catalogue widget, and that scoping is the point. Unscoped,
    // this test flipped to green the day the Product view landed -- because the
    // Product panel renders GBX0307 for the dev profile, on the same page. It was
    // reporting a resolver diagnostic as evidence that the catalogue renders
    // catalogue diagnostics, which is precisely the kind of pass-for-the-wrong-
    // reason this suite exists to prevent.
    const rendered = studio.page.locator(".gearbox-catalogue .gbx-diagnostic");
    const count = await rendered.count();
    test.skip(
      count === 0,
      "the gear tree loads clean, so the catalogue rendered no diagnostic to inspect",
    );
    expect(await rendered.first().textContent()).toMatch(/GBX\d{4}/);
  });

  test.fixme(
    "resolution diagnostics appear as problem markers [PRD cpt-gearbox-fr-editor-diagnostics]",
    async ({ studio }) => {
      // The engine has answered `resolve` with a `diagnostics` array since M4,
      // and a refused `product/load` carries them in `data.diagnostics`. Nothing
      // in the frontend turns either into a marker.
      await studio.page.click("#theia-bottom-content-panel .lm-TabBar-tabLabel:text('Problems')");
      await expect(studio.page.locator(".theia-marker-container .theia-TreeNode")).toHaveCount(0);
    },
  );

  test.fixme(
    "markers are replaced atomically on each resolution [PRD cpt-gearbox-fr-editor-diagnostics]",
    async ({ studio }) => {
      // "Stale markers are worse than none." The claim is about the replacement,
      // so the test has to resolve twice and observe that nothing from the first
      // run survives -- which needs the product widget to exist first.
      await expect(studio.page.locator(".theia-marker-container")).toBeVisible();
    },
  );

  test.fixme(
    "description diagnostics arrive over a language-server interface with source ranges [PRD cpt-gearbox-fr-editor-diagnostics]",
    async ({ studio }) => {
      // Distinct from the marker half: this one is about squiggles in the `.gdl`
      // editor at a range the engine reported, not about a list in a panel. No
      // language server is registered for `.gdl` -- the grammar is a TextMate
      // contribution only.
      await expect(studio.page.locator(".squiggly-error")).toBeVisible();
    },
  );
});
