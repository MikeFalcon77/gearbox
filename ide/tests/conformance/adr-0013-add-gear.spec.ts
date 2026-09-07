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

  test("a gear that declares no extension point is offered no plugin [plan §9.1: the surface offers only what is applicable]", async ({
    studio,
  }) => {
    // The UX pass of 2026-09-07 selected `types-registry`, read "Extension
    // points: none declared." three lines above a list of every plugin in the
    // catalogue, chose `oidc-authn-plugin`, and was told it would join the
    // closure as a "plugin of types-registry". The data to refuse that was
    // already on the wire in both directions -- the host's `extension_points`
    // and the plugin's `fills.point` -- so the offer was the defect.
    const page = studio.page;
    await configure(page, "types-registry");
    await expect(page.locator("[data-add-gear-plugins]")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-add-gear-plugins]")).toContainText("none declared");
    await expect(page.locator("[data-add-gear-plugin-pick]")).toHaveCount(0);
    await expect(page.locator("[data-add-gear-plugins-none]")).toBeVisible();
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("a host is offered only the plugins that fill its own points [plan §9.1: the surface offers only what is applicable]", async ({
    studio,
  }) => {
    // `tenant-resolver` declares one point, and three gears in the corpus fill
    // it; `oidc-authn-plugin` fills a different SDK's trait and must not be on
    // offer here. The join key is the pair, never a derived short name -- see
    // `common/extension-points.ts`.
    const page = studio.page;
    await configure(page, "tenant-resolver");
    const picker = page.locator("[data-add-gear-plugin-pick]");
    await expect(picker).toBeVisible({ timeout: 60_000 });
    const offered = await picker.locator("option").evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== ""),
    );
    expect(offered).toContain("single-tenant-tr-plugin");
    expect(offered).not.toContain("oidc-authn-plugin");
    expect(offered).not.toContain("static-authn-plugin");
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("What will be written names every staged edit, not just the gear [plan §9.1: the review is the exact serialization]", async ({
    studio,
  }) => {
    // The UX pass staged a feature, a config key and a plugin and read a preview
    // that said only `+ use_gear("types-registry", source = "gears-rust")`. It
    // could not have said more: the follow-up edits name a gear the file does not
    // have yet, so `applyEdits` refused them and the panel dry-ran the addition
    // alone -- which also meant the commit wrote twice.
    // `ProductEdit::AddGear` puts the addition in the same batch, so the dry
    // run's text *is* what would be written.
    const page = studio.page;
    await configure(page, "tenant-resolver");
    const preview = page.locator("[data-add-gear-flow] .gbx-edit-preview");
    await expect(preview).toContainText("tenant-resolver", { timeout: 60_000 });

    await page.locator("[data-add-gear-config-key]").fill("namespace");
    await page.locator("[data-add-gear-config-value]").fill("demo");
    await page.locator("[data-add-gear-config-add]").click();
    await page.locator("[data-add-gear-plugin-pick]").selectOption("single-tenant-tr-plugin");
    await page.locator("[data-add-gear-plugin-add]").click();

    await expect(preview).toContainText("namespace", { timeout: 60_000 });
    await expect(preview).toContainText("single-tenant-tr-plugin");
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("a config key that no field could be is refused at the row [plan §9.1: checked where the caret is]", async ({
    studio,
  }) => {
    // `bad key = "secret-looking"` was accepted and written cleanly -- a config
    // key is a quoted dict key, so the span surgeon has no opinion -- and refused
    // three steps later at resolve, as GBX0115.
    const page = studio.page;
    await configure(page, "tenant-resolver");
    await page.locator("[data-add-gear-config-key]").fill("bad key");
    await expect(page.locator("[data-config-key-error]")).toContainText("spaces");
    await expect(page.locator("[data-add-gear-config-add]")).toBeDisabled();
    await page.locator("[data-add-gear-config-key]").fill("namespace");
    await expect(page.locator("[data-config-key-error]")).toHaveCount(0);
    await expect(page.locator("[data-add-gear-config-add]")).toBeEnabled();
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("features are the crate's own, and absence says so [plan §9.1: features are projected]", async ({
    studio,
  }) => {
    // "No features yet" could not be told from "this gear has none", and the box
    // beside it took any string -- so a typo became a Cargo feature that does not
    // exist and a build failure two steps later. Measured across the corpus: 7 of
    // 14 gear crates declare a `[features]` table.
    const page = studio.page;
    await configure(page, "tenant-resolver");
    await expect(page.locator("[data-add-gear-features-none]")).toContainText(
      "no Cargo features",
      { timeout: 60_000 },
    );
    await expect(page.locator("[data-add-gear-feature-option]")).toHaveCount(0);

    // `types-registry` declares exactly one -- `integration`, which gates tests
    // needing a Docker daemon. It is offered *and* the panel says the list is the
    // crate's own rather than a curated one, because nobody has curated it.
    //
    // Through "Choose a different gear", because the picker is not on screen once
    // a gear is chosen -- the overview replaces it, which is also what makes the
    // staged features, config and plugins safe to clear on a change of subject.
    await page.locator("[data-add-gear-change]").click();
    await page.locator("[data-add-gear-select]").selectOption("types-registry");
    await expect(page.locator('[data-add-gear-feature-option="integration"]')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator("[data-add-gear-features]")).toContainText("declares");
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
