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
    await studio.page.locator(".gbx-row").first().focus();
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
    await studio.page.locator(".gbx-row:not(.gbx-selected)").first().focus();
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

test.describe("nothing failed quietly", () => {
  test("no console errors", async ({ studio }) => {
    // The app has no favicon: @theia/cli 1.75 offers no hook for one and its
    // generated index.html has no <link rel="icon">. Tolerated by name rather
    // than by filtering every 404, so a real missing resource still fails.
    const real = studio.consoleErrors.filter((e) => !/favicon\.ico/.test(e));
    expect(real).toEqual([]);
  });
});
