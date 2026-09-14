// `cpt-gearbox-fr-editor-diagnostics`, in two halves that are in different
// states:
//
//   Description-file diagnostics MUST be reported with source ranges over a
//   language-server interface, and resolution diagnostics MUST be surfaced as
//   editor problem markers replaced atomically on each resolution.
//
// `@theia/markers` is a declared dependency of browser-app and gives the Problems
// view below -- so the destination exists and nothing writes to it.

import { expect, openConflicts, openProduct, problems, test } from "../fixtures/studio";

test.describe("diagnostics reach a person", () => {
  test("the Problems view is present to receive markers [PRD cpt-gearbox-fr-editor-diagnostics]", async ({
    studio,
  }) => {
    // **Present, not pre-opened.** It used to open itself on a first run and this
    // claim read the boot tab list, which made it a claim about the default
    // layout rather than about the destination existing. Conflicts is the domain
    // screen for the resolution's diagnostics; Problems stays for the
    // file-anchored ones Monaco publishes, and is one command away
    // (`HiddenProblemsView` records why). Reached the way a person reaches it.
    await problems(studio.page);
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
    // `.gbx-conflict`, since 2026-09-08: the catalogue renders the same row as
    // every other consumer of `Diagnostic[]`. Updated even though this claim
    // currently skips on a clean corpus -- a selector that cannot match is a
    // claim that will never observe what it says, and the skip would have hidden
    // that indefinitely.
    const rendered = studio.page.locator(".gbx-widget-catalogue .gbx-conflict");
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
    // Counted on the **Conflicts screen**, which is where the resolution's
    // diagnostics are listed now. The Product view used to print them under its
    // tree and keeps only a summary: two full lists of the same array was
    // duplication, and the one squeezed under a tree was the one nobody could act
    // on. Both renderers read `ProductStore.diagnostics`, so this still compares
    // the markers against what a person is shown.
    await openProduct(studio.page, "dev");
    await openConflicts(studio.page);
    const shown = await studio.page.locator(".gbx-conflicts .gbx-conflict").count();
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
    await openConflicts(studio.page);
    const prodShown = await studio.page.locator(".gbx-conflicts .gbx-conflict").count();
    const prod = await problems(studio.page);
    expect(prod.markers.length).toBe(prodShown);

    await openProduct(studio.page, "dev");
    await openConflicts(studio.page);
    const devShown = await studio.page.locator(".gbx-conflicts .gbx-conflict").count();
    const dev = await problems(studio.page);

    expect(devShown).not.toBe(prodShown);
    // This is the anti-leak assertion, and it is the whole guard: a marker left
    // over from `prod` would make the count exceed what `dev` puts on screen.
    expect(dev.markers.length).toBe(devShown);
    // And at least one of prod's really went, so two identical sets could not
    // satisfy the line above by accident.
    expect(prod.markers.some((marker) => !dev.markers.includes(marker))).toBe(true);
    // Deliberately *not* "every prod marker is gone". A diagnostic both profiles
    // report -- GBX0410 says `prefer.fewer_applications` is not honoured, and the
    // description declares it whatever the profile -- is not stale, and demanding
    // its removal made this claim fail the day such a diagnostic first existed.
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
