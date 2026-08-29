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
    // The widget has a `.gbx-diagnostics` block and this corpus produces no
    // diagnostics, so there is nothing to render. Reported as not observed
    // rather than as a pass: a run that cannot reach the state proves nothing
    // about it, and calling that green is the exact failure this suite replaced.
    const count = await studio.page.locator(".gbx-diagnostic").count();
    test.skip(
      count === 0,
      "the gear tree loads clean, so no diagnostic was rendered to inspect",
    );
    const first = await studio.page.locator(".gbx-diagnostic").first().textContent();
    expect(first).toMatch(/GBX\d{4}/);
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
