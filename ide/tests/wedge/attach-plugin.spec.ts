// A staged proposal that outlives the engine it was being previewed against.
//
// The scope a person picks for each staged plugin is the thing most easily lost
// here, because the dialog recomputes its preview on every change and the engine
// is what answers it. Losing the engine mid-preview is the case that cannot be
// reached without a controllable one, which is why this claim lives beside the
// other wedge claims rather than in the conformance suite.
//
// It is also the case that made the dialog need a way back of its own: it is
// modal, so the panel's Reconnect button is underneath it, and `Refresh preview`
// -- the only offer it had -- re-asks an engine that is not there.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { copyProduct, type ProductCopy } from "../fixtures/product-copy";
import { expect, openProductById, settled, test } from "../fixtures/studio";
import { engines, hold, logMark, release, since } from "./seam";

const REPO = join(__dirname, "../../..");

test.describe("a staged proposal across a lost engine", () => {
  let product: ProductCopy;

  test.beforeAll(() => {
    product = copyProduct(REPO, "payments-demo", "attach-reconnect");
  });

  test.afterAll(() => {
    product?.dispose();
    release();
  });

  test("the staged plugins and their scopes survive the engine stopping and coming back", async ({
    freshStudio,
  }) => {
    const { page } = freshStudio;
    const mark = logMark();
    const before = readFileSync(product.path, "utf8");
    await settled(page);
    await openProductById(page, product.id, "dev");

    // A host this product does not have, so the proposal is two edits, and one
    // plugin narrowed to a profile that is not the one being viewed -- a default
    // would be indistinguishable from a choice that survived.
    await page.locator("[data-add-gear]").click();
    await expect(page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-add-gear-select="tenant-resolver"]').click();
    await expect(page.locator("[data-add-gear-plugin-pick]")).toBeVisible({ timeout: 60_000 });
    await page.locator("[data-add-gear-plugin-pick]").selectOption("single-tenant-tr-plugin");
    await page.locator("[data-add-gear-plugin-add]").click();
    const staged = page.locator('[data-add-gear-staged="single-tenant-tr-plugin"]');
    await expect(staged).toBeVisible({ timeout: 60_000 });
    await staged.locator("[data-profile-scope-selected]").click();
    await staged.locator('input[data-profile="local"]').check();
    await staged.locator('input[data-profile="dev"]').uncheck();
    await expect(staged.locator('input[data-profile="local"]')).toBeChecked();

    // ---- the engine stops while the preview is being recomputed

    // `resolvePreview` is the half of the refresh that says what the product
    // would resolve to; the other half is a dry run of the write, which answers
    // normally. So this is a preview that half-arrives, which is the shape of the
    // real failure.
    hold({ method: "gearbox/product/resolvePreview" });
    const engine = engines().at(-1)!;
    await page.locator("[data-add-gear-plugin-pick]").selectOption("rg-tr-plugin");
    await page.locator("[data-add-gear-plugin-add]").click();

    const failure = page.locator("[data-add-gear-impact-error]");
    await expect(failure).toBeVisible({ timeout: 40_000 });
    await expect(failure).toContainText("did not answer");
    await expect
      .poll(() => since(mark).some((r) => r.kind === "withhold"), { timeout: 30_000 })
      .toBe(true);

    // **The offer is recovery, not another attempt.** `Refresh preview` re-asks
    // the engine, and there is no engine; the panel's own Reconnect button is
    // behind this dialog.
    await expect(page.locator("[data-add-gear-reconnect]")).toBeVisible();
    await expect(page.locator("[data-add-gear-refresh]")).toHaveCount(0);

    // ---- and back, with the proposal untouched

    release();
    await page.locator("[data-add-gear-reconnect]").click();
    await expect(page.locator("[data-add-gear-impact-error]")).toHaveCount(0, { timeout: 90_000 });
    await expect.poll(() => engines().length, { timeout: 90_000 }).toBeGreaterThan(
      engines().findIndex((e) => e.pid === engine.pid) + 1,
    );

    // Both staged plugins, and each one's own answer: the one that was narrowed
    // is still narrow, and the one that was not is still every profile.
    await expect(staged.locator("[data-profile-scope]")).toHaveAttribute(
      "data-profile-scope",
      "selected",
    );
    await expect(staged.locator('input[data-profile="local"]')).toBeChecked();
    await expect(staged.locator('input[data-profile="dev"]')).not.toBeChecked();
    const second = page.locator('[data-add-gear-staged="rg-tr-plugin"]');
    await expect(second.locator("[data-profile-scope]")).toHaveAttribute(
      "data-profile-scope",
      "all",
    );

    // And the preview is a real one again, computed against the new session.
    await expect(page.locator("[data-add-gear-after]")).toContainText("single-tenant-tr-plugin", {
      timeout: 60_000,
    });

    // Nothing was written by any of it: a recovery is a read.
    await page.locator("[data-add-gear-cancel]").click();
    await expect(page.locator("[data-add-gear-flow]")).toHaveCount(0, { timeout: 30_000 });
    expect(readFileSync(product.path, "utf8")).toBe(before);
  });
});
