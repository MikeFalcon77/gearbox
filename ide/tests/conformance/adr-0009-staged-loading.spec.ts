// ADR cpt-gearbox-adr-staged-catalogue-loading, checked against the widget that
// consumes it.
//
// The ADR was written before any consumer existed, and its whole claim is that a
// row is useful before it is complete. That is not observable in a final state,
// so these tests read a *timeline* sampled from before the document had scripts
// (see fixtures/studio.ts). A snapshot after the load would pass even if the
// tree had appeared all at once.

import { expect, settled, test, type Sample } from "../fixtures/studio";

/** Samples where rows are on screen and at least one is still pending. */
function stagedWindow(timeline: Sample[]): Sample[] {
  return timeline.filter((s) => s.rows > 0 && s.pending > 0);
}

test.describe("staged catalogue loading", () => {
  test("the load settles into a non-empty tree [ADR-0009 §Decision Outcome]", async ({
    freshStudio,
  }) => {
    await settled(freshStudio.page);
    const timeline = await freshStudio.timeline();
    const last = timeline[timeline.length - 1];
    expect(last.rows).toBeGreaterThan(0);
    // Visible, not merely attached: a collapsed side panel keeps its widget in
    // the DOM, and an earlier version of this check passed against a blank
    // screen for exactly that reason.
    expect(last.visibleRows).toBe(last.rows);
  });

  test("rows are on screen while still pending [ADR-0009 §Decision Drivers: time to first row]", async ({
    freshStudio,
  }) => {
    await settled(freshStudio.page);
    const timeline = await freshStudio.timeline();
    const staged = stagedWindow(timeline);
    const observable = timeline.filter((s) => s.rows > 0).length;

    // Skipped rather than failed when the load was too short to observe: on a
    // fast machine with a small corpus the whole projection can land between two
    // samples, and failing then would be the harness reporting its own sampling
    // rate as a product defect. The escape hatch is narrow on purpose -- it
    // applies only when there was at most one sample to see -- and a skip is
    // reported as "not observed", never as a pass.
    test.skip(
      staged.length === 0 && observable <= 1,
      `the load finished within ${observable} sample(s); too fast to observe staging`,
    );

    expect(
      staged.length,
      "no sample caught a partial tree -- staging is invisible to a user",
    ).toBeGreaterThan(0);
    expect(staged[0].rows).toBeGreaterThan(0);
    expect(staged[0].pending).toBeGreaterThan(0);
  });

  test("a pending row already carries the name and category S1 yields [ADR-0009 §The five stages]", async ({
    freshStudio,
  }) => {
    await settled(freshStudio.page);
    const staged = stagedWindow(await freshStudio.timeline());
    test.skip(staged.length === 0, "no staged sample to read");

    const first = staged[0];
    expect(first.names.length).toBeGreaterThanOrEqual(first.rows);
    expect(first.names.every((n) => n.length > 0)).toBe(true);
    // `category` is declared at S1, so the shape of the tree settles first.
    expect(first.groups.length).toBeGreaterThan(0);
  });

  test("badges trail the names, because runtime_caps is projected at S2 [ADR-0009 §Consequences]", async ({
    freshStudio,
  }) => {
    await settled(freshStudio.page);
    const timeline = await freshStudio.timeline();
    const staged = stagedWindow(timeline);
    test.skip(staged.length === 0, "no staged sample to read");

    const last = timeline[timeline.length - 1];
    expect(
      staged[0].badges,
      "the ADR's desirable order: grouping early, badges filling in after",
    ).toBeLessThan(last.badges);
  });

  test("a pending row says it is still parsing [ADR-0009 §Consequences]", async ({
    freshStudio,
  }) => {
    await settled(freshStudio.page);
    const staged = stagedWindow(await freshStudio.timeline());
    test.skip(staged.length === 0, "no staged sample to read");
    expect(staged[0].waiting).toBeGreaterThan(0);
  });

  test("pending is empty once the load completes [ADR-0009 §Consequences]", async ({
    freshStudio,
  }) => {
    await settled(freshStudio.page);
    const timeline = await freshStudio.timeline();
    // "Otherwise the list becomes a place where gears quietly go missing."
    expect(timeline[timeline.length - 1].pending).toBe(0);
  });

  test("a projected row carries an id and a pending row does not [ADR-0009 §GearId is projected]", async ({
    freshStudio,
  }) => {
    await settled(freshStudio.page);
    const timeline = await freshStudio.timeline();
    const last = timeline[timeline.length - 1];
    expect(last.rowIds).toBe(last.rows);

    // A pending gear has no `GearId` at all -- it is projected at S2 -- so the
    // number of ids on screen can never exceed the number of projected rows.
    // Stated as an invariant over every sample rather than as "find a sample
    // where every row is pending": the first version asked for that and was
    // skipped, because on this corpus some rows project before others appear.
    const violations = timeline.filter((s) => s.rowIds > s.rows - s.pending);
    expect(
      violations,
      "an id on a pending row would mean the widget invented one",
    ).toHaveLength(0);

    const staged = stagedWindow(timeline);
    test.skip(staged.length === 0, "no staged sample, so only the final state was checked");
    expect(staged.some((s) => s.pending > 0 && s.rowIds < s.rows)).toBe(true);
  });

  test("selection survives the pending to projected replacement [ADR-0009 §GearId is projected]", async ({
    freshStudio,
  }) => {
    // The reason rows are keyed by `(source, gdl_path)` and not by id: the
    // pending row is *replaced* by a projected one, and a key that did not exist
    // yet at S1 cannot survive that. Nothing tested this before.
    const selected = await freshStudio.page.evaluate(async () => {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const row = document.querySelector(".gearbox-catalogue .gbx-row.gbx-pending");
        if (row) {
          (row as HTMLElement).click();
          return row.querySelector(".gbx-row-name")?.textContent?.trim() ?? "";
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return null;
    });
    test.skip(selected === null, "no pending row was ever on screen to select");

    await settled(freshStudio.page);

    const after = await freshStudio.page.evaluate(() => {
      const row = document.querySelector(".gearbox-catalogue .gbx-row.gbx-selected");
      return row === null
        ? null
        : {
            name: row.querySelector(".gbx-row-name")?.textContent?.trim() ?? "",
            stillPending: row.classList.contains("gbx-pending"),
            hasId: row.querySelector(".gbx-id") !== null,
          };
    });

    expect(after, "the selection was lost when the row was replaced").not.toBeNull();
    expect(after!.name).toBe(selected);
    expect(after!.stillPending).toBe(false);
    expect(after!.hasId, "the same row is now projected").toBe(true);
  });
});
