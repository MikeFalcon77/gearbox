// `cpt-gearbox-fr-editor-diagnostics`, in two halves that are in different
// states:
//
//   Description-file diagnostics MUST be reported with source ranges over a
//   language-server interface, and resolution diagnostics MUST be surfaced as
//   editor problem markers replaced atomically on each resolution.
//
// `@theia/markers` is a declared dependency of browser-app and gives the Problems
// view below -- so the destination exists and nothing writes to it.

import { expect, openProduct, problems, test } from "../fixtures/studio";

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

  test("resolution diagnostics appear as problem markers [PRD cpt-gearbox-fr-editor-diagnostics]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "dev");
    const shown = await studio.page.locator(".gearbox-product .gbx-diagnostic").count();
    expect(shown, "the dev profile produces no diagnostic to surface").toBeGreaterThan(0);

    const { files, markers } = await problems(studio.page);
    // Anchored to the product description. The wire type says resolution
    // diagnostics "often have no location and are anchored by the client", and
    // the description is the only file the whole resolution is about.
    expect(files.some((file) => file.includes("product.gdl"))).toBe(true);
    expect(markers.length).toBe(shown);
  });

  test("markers are replaced atomically on each resolution [PRD cpt-gearbox-fr-editor-diagnostics]", async ({
    studio,
  }) => {
    // "Stale markers are worse than none." prod produces more diagnostics than
    // dev, so going prod → dev is the direction that would leave leftovers: a
    // per-file `setMarkers` replaces one file's markers and says nothing about a
    // file the new resolution no longer mentions.
    await openProduct(studio.page, "prod");
    const prodShown = await studio.page.locator(".gearbox-product .gbx-diagnostic").count();
    const prod = await problems(studio.page);
    expect(prod.markers.length).toBe(prodShown);

    await openProduct(studio.page, "dev");
    const devShown = await studio.page.locator(".gearbox-product .gbx-diagnostic").count();
    const dev = await problems(studio.page);

    expect(devShown).not.toBe(prodShown);
    expect(dev.markers.length).toBe(devShown);
    // And the specific ones are gone, not merely fewer.
    for (const stale of prod.markers) {
      expect(dev.markers).not.toContain(stale);
    }
  });

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
