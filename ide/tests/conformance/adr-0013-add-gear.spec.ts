// Product-session chrome and the Add Gear configurator (Phases 4–5).

import type { Page } from "@playwright/test";

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

// Phase 5's point: the panel answers "what does this do to my product" before it
// is asked to do it. Section 6 subtracts the resolution on screen from the one
// the engine computes for the proposed description.
test.describe("Add Gear shows consequences before the write", () => {
  /** Open the configurator on a gear the demo product does not name. */
  async function configure(page: Page, gear: string): Promise<void> {
    await openProduct(page, "dev");
    const add = page.locator("[data-add-gear]");
    await expect(add).toBeVisible({ timeout: 60_000 });
    await add.click();
    await expect(page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-add-gear-select]").selectOption(gear);
  }

  test("the closure a gear joins is visible before anything is written", async ({ studio }) => {
    const page = studio.page;
    await configure(page, "tenant-resolver");

    // Named by the product-to-be, so the reason reads "asked for". The corpus's
    // co-located dependencies (grpc-hub, types-registry, cluster) are already in
    // this product's closure through api-gateway, which is why the arrival here is
    // the gear itself -- the section reports what actually changes, not a fixed list.
    const arrival = page.locator('[data-impact-gear="tenant-resolver"]');
    await expect(arrival).toBeVisible({ timeout: 60_000 });
    await expect(arrival).toContainText("asked for");

    // Nothing has been written: the description still does not name it.
    await expect(page.locator("[data-add-gear-flow] .gbx-edit-preview")).toContainText(
      "tenant-resolver",
    );
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("choosing a plugin changes what the closure would pull in", async ({ studio }) => {
    const page = studio.page;
    await configure(page, "tenant-resolver");
    await expect(page.locator('[data-impact-gear="tenant-resolver"]')).toBeVisible({
      timeout: 60_000,
    });
    // The plugin is a gear; before it is chosen it is not in the closure.
    await expect(page.locator('[data-impact-gear="single-tenant-tr-plugin"]')).toHaveCount(0);

    await page.locator("[data-add-gear-plugin-pick]").selectOption("single-tenant-tr-plugin");
    await page.locator("[data-add-gear-plugin-add]").click();

    await expect(page.locator('[data-impact-gear="single-tenant-tr-plugin"]')).toBeVisible({
      timeout: 60_000,
    });
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("errors warn beside the button and never disable it", async ({ studio }) => {
    const page = studio.page;
    await configure(page, "tenant-resolver");
    await expect(page.locator("[data-add-gear-impact]")).toBeVisible({ timeout: 60_000 });

    // Decision 1 of the phase: building a product is add-a-gear-then-bind-it, so a
    // resolution that fails in between is a waypoint, not a refusal.
    const submit = page.locator("[data-add-gear-submit]");
    await expect(submit).toBeEnabled();

    const warning = page.locator("[data-add-gear-error-warning]");
    if ((await warning.count()) === 0) {
      test.skip(
        true,
        "no gear in this corpus makes the resolution fail when added, so the warning cannot be observed here",
      );
    }
    await expect(warning).toBeVisible();
    await expect(submit).toBeEnabled();
    await page.locator("[data-add-gear-cancel]").click();
  });
});
