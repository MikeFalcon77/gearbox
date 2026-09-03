// ADR cpt-gearbox-adr-authoring-ownership-tiers.
//
// Tier 0 scaffolding (New Gear + FilePlan preview) is what this file covers for
// the writing surface the ADR decided. Most of the Confirmation section is not
// browser-observable and belongs in Rust tests beside the writer.
//
// Tier 1's own claim -- `product.lock` presented read-only -- *is* built, and is
// tested in `adr-0011-workspace-and-scm.spec.ts` beside the workspace that makes
// a lock file openable at all.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  expect,
  expectContext,
  openGenerate,
  openPalette,
  openProduct,
  resetCatalogueView,
  revealCatalogue,
  settled,
  test,
} from "../fixtures/studio";

const REPO = join(__dirname, "../../..");
const PRODUCT = "products/payments-demo/product.gdl";

/** `git diff --stat` for the demo description, or "" when it matches HEAD. */
function diffOfProduct(): string {
  return execFileSync("git", ["diff", "--stat", "--", PRODUCT], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
}

/**
 * Accept the edit dialog, and only the edit dialog.
 *
 * `.theia-button.main` is every Theia dialog's default button, so an unscoped
 * click accepts whatever happens to be open. That matters here more than
 * elsewhere: the dialog this file accepts *writes to a description*, so
 * confirming a stranger's dialog would write something no test asked for. The
 * preview pane is what makes it ours.
 */
async function acceptEdit(page: import("@playwright/test").Page): Promise<void> {
  const dialog = page.locator(".dialogBlock", { has: page.locator(".gbx-edit-preview") });
  await expect(dialog, "the edit dialog is not open, so there is nothing to accept").toBeVisible();
  await dialog.locator(".theia-button.main").click();
}

test.describe("what the tool may write", () => {

  test(
    "Studio offers a command to scaffold a new gear [ADR-0010 tier 0]",
    async ({ studio }) => {
      // Tier 0 is the permitted case the ADR is most confident about -- "a tool
      // may freely create new files" -- and it is the entry point for two of the
      // three usage scenarios the documents have to cover: a new gear, and a
      // plugin, either in this repo or another.
      // Prefer the shared palette helper: a single F1 is often lost while Theia
      // is still installing keybindings.
      await openPalette(studio.page);
      await studio.page.keyboard.type("New Gear", { delay: 20 });
      await expect(
        studio.page
          .locator(`.quick-input-list [role="option"]`)
          .filter({ hasText: "New Gear" })
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await studio.page.keyboard.press("Escape");
    },
  );

  test(
    "a scaffold shows its file plan before writing anything [ADR-0010 §Consequences: a preview is not optional]",
    async ({ freshStudio }) => {
      // "Every surveyed tool has `--dry-run`; the plan's `FilePlan[]` with
      // create|update|unchanged|conflict already provides the shape, so
      // scaffolding reuses the generator's preview rather than inventing one."
      const { page } = freshStudio;
      await settled(page);
      await expectContext(page, "home");
      // Wait for the engine: New Gear is disabled until initialize succeeds.
      await expect(page.locator(".gbx-start")).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-start-action="new-gear"]:not([disabled])')).toBeVisible({
        timeout: 60_000,
      });
      await page.locator('[data-start-action="new-gear"]').click();
      await expect(page.locator(".gbx-file-plan")).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator(
          '.gbx-file-plan [data-plan-path$="gear.gdl"], .gbx-file-plan [data-plan-path="gear.gdl"]',
        ),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('.gbx-file-plan [data-action="create"]').first()).toBeVisible();
    },
  );

  test("a generated composition crate carries a header naming its generator [ADR-0010 tier 2]", async ({
    studio,
  }) => {
    // Tier 2 is "tool, entirely, with a header". The header is what tells a
    // reader not to edit the file, and it is the only thing standing between
    // tier 2 and tier 5. The files were already generated; what was missing
    // was a place in the UI to open one.
    await openProduct(studio.page, "dev");
    await openGenerate(studio.page);
    await studio.page
      .locator('[data-plan-path="processes/api-gateway/src/registered_gears.rs"]')
      .click();
    // The preview is a diff editor, so `.monaco-editor` matches three hosts
    // (gutter, original, modified). The header lives on the proposed side.
    await expect(
      studio.page.locator(".monaco-editor.modified-in-monaco-diff-editor"),
    ).toContainText("GENERATED", { timeout: 60_000 });
  });
});

test.describe("tier 3: a description edited surgically", () => {
  // ADR-0010's tier 3 is "structured manifests | tool edits surgically |
  // **Permitted**", and its survey calls that "the single most universal
  // behaviour in the set -- `cargo add`, `dotnet package add`, Gazelle". A GDL
  // description qualifies because GDL cannot be logic: the dialect refuses every
  // branching construct (`cpt-gearbox-fr-gdl-declarative`), so a `use_gear(...)`
  // entry is a data entry in a list, and the tier-5 prohibition on rewriting
  // human logic does not reach it.
  //
  // The round trip runs against `products/payments-demo/product.gdl` itself,
  // deliberately: 29 of its 105 lines are comments carrying the reasoning for the
  // description, and an edit that survives them is the entire claim. A copy with
  // no comments in it would prove nothing.
  //
  // Undoing happens *through the interface*, not with `git checkout`. Restoring
  // the file behind the running application leaves its product store holding the
  // edited description, and the next click then asks the engine for a change the
  // file no longer needs -- which the engine correctly declines, with no dialog
  // to confirm. So git only appears in `finally`, as a net under a failed
  // assertion, and the page is reloaded with it so no stale state outlives the
  // test.

  test("a description edit shows the line before writing it [ADR-0010 §Consequences: a preview is not optional]", async ({
    studio,
  }) => {
    // "A preview is not optional. Every surveyed tool has `--dry-run`." This test
    // takes the preview and cancels, so it asserts the harder half: that nothing
    // is on disk until the person agrees. Catalogue `+` opens the Add Gear
    // configurator; the dry-run lives in that panel (not a modal).
    expect(diffOfProduct(), "the description must start clean for this to mean anything").toBe("");

    await openProduct(studio.page, "dev");
    await revealCatalogue(studio.page);
    await resetCatalogueView(studio.page);

    const toggle = studio.page.locator('[data-toggle-gear="cluster"]');
    await expect(toggle).toHaveAttribute("data-in-product", "false");
    await toggle.click();

    await expect(studio.page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await expect(studio.page.locator("[data-add-gear-flow] .gbx-edit-preview")).toContainText(
      'use_gear("cluster"',
      { timeout: 30_000 },
    );
    expect(diffOfProduct(), "the dry run must not have written anything").toBe("");

    await studio.page.locator("[data-add-gear-cancel]").click();
    await expect(studio.page.locator("[data-add-gear-flow]")).toHaveCount(0);
    expect(diffOfProduct(), "cancelling must leave the file alone").toBe("");
    await expect(toggle).toHaveAttribute("data-in-product", "false");
  });

  test("adding a gear inserts one line, and removing it restores the file exactly [ADR-0010 tier 3]", async ({
    studio,
  }) => {
    expect(diffOfProduct()).toBe("");

    try {
      await openProduct(studio.page, "dev");
      await revealCatalogue(studio.page);
      await resetCatalogueView(studio.page);

      const toggle = studio.page.locator('[data-toggle-gear="cluster"]');
      await toggle.click();
      await expect(studio.page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
      await expect(studio.page.locator("[data-add-gear-submit]")).toBeEnabled({ timeout: 30_000 });
      await studio.page.locator("[data-add-gear-submit]").click();
      await expect(studio.page.locator("[data-add-gear-flow]")).toHaveCount(0, { timeout: 30_000 });
      // The product is re-read and re-resolved before the toggle can change, so
      await expect(toggle).toHaveAttribute("data-in-product", "true", { timeout: 60_000 });
      expect(diffOfProduct()).not.toBe("");

      await toggle.click();
      await acceptEdit(studio.page);
      await expect(toggle).toHaveAttribute("data-in-product", "false", { timeout: 60_000 });
      expect(diffOfProduct()).toBe("");
    } finally {
      if (diffOfProduct() !== "") {
        execFileSync("git", ["checkout", "--", PRODUCT], { cwd: REPO });
        await studio.page.reload();
      }
    }
  });
});

test.describe("typed config from schema (Phase 7)", () => {
  test.fixme(
    "Inspector projects JSON Schema properties as typed config fields [Phase 7]",
    async ({ studio }) => {
      // Skipped until merge.rs projects config_schema JSON into GearDescriptor
      // config_fields. Until then Add Gear / Inspector show a schema path link
      // and keep string config inputs.
      await openProduct(studio.page, "dev");
      await expect(studio.page.locator("[data-config-field]")).toBeVisible();
    },
  );
});
