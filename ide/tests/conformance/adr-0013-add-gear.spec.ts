// Product-session chrome and the Add Gear configurator (Phases 4–5).

import {
  expect,
  openProduct,
  resetCatalogueView,
  revealCatalogue,
  test,
} from "../fixtures/studio";

test.describe("product session and Add Gear", () => {
  test("Product has an Add Gear button that opens the configurator", async ({ studio }) => {
    await openProduct(studio.page, "dev");
    const add = studio.page.locator("[data-add-gear]");
    await expect(add).toBeVisible({ timeout: 60_000 });
    await add.click();
    await expect(studio.page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await studio.page.locator("[data-add-gear-cancel]").click();
  });

  test("catalogue + opens the Add Gear configurator, not an immediate write dialog", async ({
    studio,
  }) => {
    await openProduct(studio.page, "dev");
    await revealCatalogue(studio.page);
    await resetCatalogueView(studio.page);

    const toggle = studio.page.locator('[data-toggle-gear="cluster"]');
    await expect(toggle).toHaveAttribute("data-in-product", "false");
    await toggle.click();

    await expect(studio.page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await expect(
      studio.page.locator(".dialogBlock", { has: studio.page.locator(".gbx-edit-preview") }),
    ).toHaveCount(0);
    await expect(studio.page.locator("[data-add-gear-flow] .gbx-edit-preview")).toContainText(
      "cluster",
      { timeout: 30_000 },
    );
    await studio.page.locator("[data-add-gear-cancel]").click();
  });
});
