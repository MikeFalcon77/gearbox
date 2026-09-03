// ADR-0011 amendment 2026-09-02 — session trust: Product opens, Discard restores,
// no window.prompt, Generate short label, Start buttons as the path.

import { execFileSync } from "node:child_process";

import {
  expect,
  expectContext,
  openProduct,
  paletteOffers,
  revealInspector,
  runCommand,
  settled,
  test,
} from "../fixtures/studio";

/**
 * Kill every running engine, the way a crash would.
 *
 * `pkill`, not a graceful shutdown: the claim below is about what the shell does
 * when the engine goes away *without* being asked, which is the state the UX
 * report found -- New Product still offered, the wizard opening as a blank tab.
 *
 * It kills **every** engine because there is one per frontend connection
 * (measured: one page, one `gearbox rpc`; two pages, two), and no way to tell
 * from outside which belongs to which page. So the test repairs both sessions
 * afterwards rather than leaving the shared one broken for everything that runs
 * after it.
 */
function killEngines(): void {
  try {
    execFileSync("pkill", ["-f", "gearbox rpc"]);
  } catch {
    // `pkill` exits 1 when nothing matched, which is not a failure here.
  }
}

test.describe("session trust [ADR-0011 amendment 2026-09-02]", () => {
  test("Open Product from Start shows the Product view without View menu [ADR-0011 §Amendment: Product openView]", async ({
    freshStudio,
  }) => {
    const { page } = freshStudio;
    await settled(page);
    await expectContext(page, "home");
    // Prefer a Start list row: Open Product… opens a quick-pick that is flaky
    // when discover already named the only product. A list button always opens.
    await expect(page.locator(".gbx-start")).toBeVisible({ timeout: 60_000 });
    const listed = page.locator("[data-start-product]").first();
    await expect(listed).toBeVisible({ timeout: 60_000 });
    await listed.click();
    await expect(page.locator(".gbx-product [data-resolved-profile]")).toBeVisible({
      timeout: 60_000,
    });
    await expectContext(page, "product");
  });

  test("a dead engine disables the actions that need it, and Retry brings them back [ADR-0011 §Amendment: disconnected state]", async ({
    freshStudio,
    studio,
  }) => {
    // The first critical problem in the 2026-09-02 UX report: the engine was down
    // and the shell went on offering New Product, Resolve and Generate, so the
    // wizard opened as an empty tab with no error. The fix is
    // `EngineConnectionService`; this is what holds it.
    //
    // Both fixtures on purpose. `freshStudio` is the page under test; `studio` is
    // the shared one every later claim uses, and killing the engines takes its
    // engine too -- so this claim owns putting it back.
    const { page } = freshStudio;
    await settled(page);
    await expect(page.locator(".gbx-start")).toBeVisible({ timeout: 60_000 });

    try {
      killEngines();

      // Said, not merely implied by things not working.
      await expect(page.locator('[data-engine-status="disconnected"]')).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.locator('[data-start-action="create"]')).toBeDisabled();

      // And not reachable by any other door. `QuickCommandService` filters by
      // `isEnabled`, so a command gated on the engine leaves the palette -- which
      // is what stops the empty wizard rather than merely greying a button.
      //
      // The match is on the words rather than on one id, and that is what caught
      // the hole: `NEW_PRODUCT` was gated while `View: Toggle New Product` --
      // registered automatically for the wizard's own view -- was not, and opened
      // the same blank tab. Two commands, one door.
      const offered = await paletteOffers(page, "New Product");
      expect(offered.filter((label) => /New Product/.test(label))).toEqual([]);
    } finally {
      // Retry is the user's way back, so the repair is also the assertion.
      await page.locator("[data-engine-retry]").click();
      await expect(page.locator('[data-engine-status="disconnected"]')).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(page.locator('[data-start-action="create"]')).toBeEnabled();

      // The shared session has its own engine and its own frontend; nothing tells
      // it to reconnect, so this does.
      await runCommand(studio.page, "Gearbox: Reload Catalogue");
      await expect(studio.page.locator(".gearbox-catalogue .gbx-row").first()).toBeVisible({
        timeout: 90_000,
      });
    }
  });

  test("toolbar Generate is labelled Generate, not Toggle [ADR-0011 §Amendment: Generate shortTitle]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "dev");
    const generate = studio.page.locator('[data-command="gearbox.generate.toggle"]');
    await expect(generate).toBeVisible();
    await expect(generate).toHaveText(/^\s*Generate\s*$/);
  });

  test("Discard on a profile field restores the saved value [ADR-0013 §Amendment: Discard restores]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "local");
    const host = studio.page.locator('[data-profile-field="host"]').first();
    await expect(host).toBeVisible({ timeout: 30_000 });
    const saved = await host.inputValue();
    await host.fill("ux-test-host-should-not-stick");
    await expect(studio.page.locator("[data-draft-discard]").first()).toBeVisible();
    await studio.page.locator("[data-draft-discard]").first().click();
    await expect(studio.page.locator('[data-profile-field="host"]').first()).toHaveValue(saved, {
      timeout: 10_000,
    });
  });

  test("Add profile uses an in-panel form, not window.prompt [ADR-0013 §Amendment: no window.prompt]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "dev");
    // Profile edit sits under the selected profile in the Product tree.
    await studio.page.locator('[data-profile="dev"]').click();
    await studio.page.locator("[data-add-profile]").click();
    await expect(studio.page.locator("[data-profile-new-id]")).toBeVisible({ timeout: 15_000 });
    await expect(studio.page.locator("[data-profile-new-kind]")).toBeVisible();
    await studio.page.locator("[data-profile-add-cancel]").click();
    await expect(studio.page.locator("[data-profile-new-id]")).toHaveCount(0);
  });

  test("Home has no Product menu while Start is showing [ADR-0011 §Amendment: no Product menu on Home]", async ({
    freshStudio,
  }) => {
    const { page } = freshStudio;
    await settled(page);
    await expectContext(page, "home");
    const menus = await page.locator("#theia-top-panel .p-MenuBar-itemLabel").allTextContents();
    expect(menus.map((m) => m.trim())).not.toContain("Product");
  });

  test("Inspector opens when a process is selected [ADR-0011 §Amendment: Inspector from selection]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "prod");
    await studio.page.locator("[data-process]").first().click();
    await expect(studio.page.locator(".gbx-inspector, .gbx-explain, .gbx-detail").first()).toBeVisible({
      timeout: 30_000,
    });
    // And it did not require hunting View → Inspector first.
    await revealInspector(studio.page);
    await expect(studio.page.locator("[data-explaining], .gbx-detail-title").first()).toBeVisible();
  });
});
