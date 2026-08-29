// Checks that are about the implementation rather than about a document.
//
// They came from `scripts/ui-smoke.mjs` and are worth keeping, but they do not
// belong in the conformance table: no design document says "an edge must have an
// arrowhead". Kept in their own file so that the conformance files stay a
// one-to-one map onto the documents.

import { expect, openGraph, openPalette, test } from "./fixtures/studio";

test.describe("the panel is operable without a mouse", () => {
  // Every interaction in the catalogue was a bare `onClick` on a div once. A
  // panel in an IDE that only answers clicks is unusable for anyone who does not
  // use a mouse. Real key events through the browser, not synthesized ones:
  // React attaches its own listeners, and a dispatched event with the wrong
  // shape would pass here while a keyboard would not.

  test("a catalogue row can take focus", async ({ studio }) => {
    await studio.page.locator(".gearbox-catalogue .gbx-row").first().focus();
    const focused = await studio.page.evaluate(() =>
      document.activeElement?.classList.contains("gbx-row"),
    );
    expect(focused).toBe(true);
  });

  test("Enter selects the focused row", async ({ studio }) => {
    // Deliberately a row that is not already selected: Enter on an
    // already-selected row *reveals* its description instead, which moves focus
    // into the editor. Establishing the precondition here rather than relying on
    // what an earlier test left behind, since the read-only tests share one
    // loaded application.
    await studio.page.locator(".gearbox-catalogue .gbx-row:not(.gbx-selected)").first().focus();
    await studio.page.keyboard.press("Enter");
    const name = await studio.page.evaluate(() =>
      document.activeElement?.classList.contains("gbx-selected") === true
        ? (document.activeElement.querySelector(".gbx-row-name")?.textContent ?? "").trim()
        : null,
    );
    expect(name, "the focused row never became selected").not.toBeNull();
    expect(name!.length).toBeGreaterThan(0);
  });

  test("the command palette opens", async ({ studio }) => {
    // Opened and dismissed without running anything: every Gearbox view command
    // is a toggle, so executing one here would change the state the other tests
    // read. Its own test so that a keybinding regression is not reported as a
    // graph regression.
    await openPalette(studio.page);
    await expect(studio.page.locator(".quick-input-widget")).toBeVisible();
    await studio.page.keyboard.press("Escape");
  });
});

test.describe("the graph draws what it says it draws", () => {
  test("every edge is directed", async ({ studio }) => {
    await openGraph(studio.page);
    const counts = await studio.page.evaluate(() => ({
      edges: document.querySelectorAll(".gbx-edge").length,
      arrows: document.querySelectorAll(".gbx-edge[marker-end]").length,
    }));
    expect(counts.edges).toBeGreaterThan(0);
    expect(counts.arrows).toBe(counts.edges);
  });

  test("every edge lands on a node the graph drew", async ({ studio }) => {
    await openGraph(studio.page);
    const graph = await studio.page.evaluate(() => ({
      nodes: Array.from(document.querySelectorAll(".gbx-node-label")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
      edges: Array.from(document.querySelectorAll(".gbx-edge")).map((e) => [
        e.getAttribute("data-from"),
        e.getAttribute("data-to"),
      ]),
    }));
    // An edge to a gear outside the catalogue would be a projection bug.
    const dangling = graph.edges.filter(
      ([from, to]) => !graph.nodes.includes(from ?? "") || !graph.nodes.includes(to ?? ""),
    );
    expect(dangling).toEqual([]);
  });
});

test.describe("contributions are registered once", () => {
  // Both of these catch the same class of mistake from two sides, and it is a
  // mistake this application made: `bindViewContribution` already binds
  // `CommandContribution`, `KeybindingContribution` and `MenuContribution`, and
  // binding any of them again next to it runs the contribution twice.

  test("no menu contains the same entry twice", async ({ studio }) => {
    // Stated as an invariant over every menu rather than as a list of expected
    // entries. A test naming the entries would have to be updated by the same
    // person who added the duplicate, and `MenuModelRegistry.registerMenuAction`
    // does not deduplicate -- it makes a node and appends it, so a double
    // binding shows up here first.
    const menus = await studio.page
      .locator(".lm-MenuBar-itemLabel")
      .allTextContents()
      .then((all) => all.map((one) => one.trim()).filter((one) => one.length > 0));
    expect(menus.length).toBeGreaterThan(0);

    for (const menu of menus) {
      await studio.page.click(`.lm-MenuBar-itemLabel:text-is("${menu}")`);
      const items = await studio.page
        .locator(".lm-Menu-itemLabel")
        .allTextContents()
        .then((all) => all.map((one) => one.trim()).filter((one) => one.length > 0));
      await studio.page.keyboard.press("Escape");

      // `indexOf`, not `Set.add`. The first version of this line was
      // `items.filter((item) => !seen.add(item))`, and `Set.prototype.add`
      // returns the *set*, which is always truthy -- so the filter never matched
      // and the test passed against a menu with `Product` in it twice. Verified
      // the other way round this time: the bug was reintroduced and this failed.
      const duplicated = items.filter((item, at) => items.indexOf(item) !== at);
      expect(duplicated, `${menu} lists these twice`).toEqual([]);
    }
  });

  test("nothing is registered twice", async ({ studio }) => {
    // The command side of the same bug, and the quieter side:
    // `CommandRegistry.registerCommand` on an existing id warns and returns a
    // no-op disposable, so the *second* handler is silently discarded. Six of
    // these sat in the console unnoticed -- the fixture collects warnings and
    // only the grammar check ever read them.
    //
    // Narrow on purpose. Theia warns legitimately about slow startup steps and
    // about plugin candidates it cannot unpack, so "no warnings at all" would
    // fail every run and teach everyone to ignore it.
    const doubled = studio.consoleWarnings.filter((w) => /is already registered/.test(w));
    expect(doubled, `duplicate registrations:\n${doubled.join("\n")}`).toEqual([]);
  });
});

test.describe("nothing failed quietly", () => {
  test("the Fabric favicon is installed", async ({ studio }) => {
    // `@theia/cli` 1.75 has no favicon hook; FabricThemeContribution injects one.
    const href = await studio.page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
      return link?.href ?? null;
    });
    expect(href, "no link[rel=icon] in document.head").not.toBeNull();
    expect(href!).toMatch(/^(data:image\/svg\+xml|blob:|https?:)/);
  });

  test("no console errors", async ({ studio }) => {
    // Tolerating by name rather than by pattern: a real missing resource or a
    // real exception still fails.
    //
    // `INVALID tab` is thrown by `@theia/plugin-ext`'s own tab bookkeeping
    // (`src/plugin/tabs.ts`) when a tab update arrives for an id the extension
    // host has not recorded. It is a race in the plugin host, not in this
    // application: it appeared the day the plugin host did, it fires while the
    // suite opens and switches editors quickly, and nothing observable breaks --
    // git, the editors and every other claim keep passing. Recorded rather than
    // filtered away quietly, because it is part of what the plugin host costs.
    const tolerated = [/^pageerror: INVALID tab$/];
    const real = studio.consoleErrors.filter(
      (error) => !tolerated.some((pattern) => pattern.test(error)),
    );
    expect(real, `unexpected console output:\n${real.join("\n")}`).toEqual([]);
  });

  test("the Fabric theme is the active color theme", async ({ studio }) => {
    const theme = await studio.page.evaluate(() => {
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue("--theia-editor-background")
        .trim()
        .toLowerCase();
      const bodyClass = document.body.className;
      return { bg, bodyClass };
    });
    // navy-deep from constructorfabric.org styles.css
    expect(theme.bg).toMatch(/#001838|rgb\(\s*0,\s*24,\s*56\s*\)/);
    expect(theme.bodyClass).toContain("vs-dark");
  });
});
