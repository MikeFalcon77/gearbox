// An edit queued while a write is in flight.
//
// The write path captures the draft before it starts and then does three things
// that take real time: a dry run, a confirmation somebody reads, and the commit.
// On success it cleared the draft **wholesale** -- so an edit queued in that
// window, never previewed and never sent, was thrown away with the ones that had
// been written. Silently, and with the panel reporting `Saved`.
//
// Reachable only with a controllable engine, which is why this claim lives here
// rather than in the conformance suite: the window has to be held open, and the
// held answer has to be **let go** afterwards so the write actually succeeds. A
// write that ended in a timeout instead would exercise a different path -- the
// draft is deliberately kept whole there, because nothing is known about it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { copyProduct, type ProductCopy } from "../fixtures/product-copy";
import { configureGear, expect, openProductById, settled, test } from "../fixtures/studio";
import { HELD_WRITE, hold, logMark, release, since } from "./seam";

const REPO = join(__dirname, "../../..");

test.describe("a draft while a write is in flight", () => {
  let product: ProductCopy;

  test.beforeAll(() => {
    product = copyProduct(REPO, "configurable-gears", "draft-in-flight");
  });

  test.afterAll(() => {
    product?.dispose();
    release();
  });

  test("an edit queued while the commit is in flight survives it", async ({ freshStudio }) => {
    const { page } = freshStudio;
    const mark = logMark();
    await settled(page);
    await openProductById(page, product.id, "dev");

    // The edit that will be written.
    const form = await configureGear(page, "api-gateway");
    await form.locator('[data-config-field="bind_addr"] input').fill("0.0.0.0:9393");
    await page.locator('[data-composition-gear="api-gateway"]').click();
    await expect(page.locator(".gbx-composition-draft")).toContainText("1 pending change");

    // ---- the commit, held open

    hold(HELD_WRITE);
    await page.locator("[data-draft-apply]").click();
    const dialog = page.locator(".dialogBlock");
    await dialog.waitFor({ state: "visible", timeout: 60_000 });
    await dialog.locator("button.theia-button.main").click();
    await expect
      .poll(() => since(mark).some((r) => r.kind === "withhold"), { timeout: 30_000 })
      .toBe(true);

    // ---- and a second edit, into the window

    // A different key, so `mergeDraft` treats it as another slot rather than a
    // replacement of the edit being written.
    const second = await configureGear(page, "api-gateway");
    await second.locator('[data-config-field="enable_docs"] input').click();
    await expect(page.locator(".gbx-composition-draft")).toContainText("2 pending changes");

    // ---- let the write finish

    // The answer was held, not discarded: this is the ending that makes the
    // claim about a *successful* write rather than about a timeout.
    release();
    await expect
      .poll(() => since(mark).some((r) => r.kind === "released-answer"), { timeout: 30_000 })
      .toBe(true);

    // **One edit was written, and one is still owed.** The banner used to read
    // `Saved` here, for a change that had never left the browser.
    await expect(page.locator(".gbx-composition-draft")).toContainText("1 pending change", {
      timeout: 60_000,
    });
    await expect
      .poll(() => readFileSync(product.path, "utf8").includes("0.0.0.0:9393"), { timeout: 30_000 })
      .toBe(true);
    expect(
      readFileSync(product.path, "utf8").includes("enable_docs"),
      "the edit queued during the write was not part of it and must not be on disk",
    ).toBe(false);

    // And it is still applicable: what survived is a draft, not a label.
    await page.locator("[data-draft-apply]").click();
    const again = page.locator(".dialogBlock");
    await again.waitFor({ state: "visible", timeout: 60_000 });
    await expect(again).toContainText("enable_docs");
    await again.locator("button.theia-button.main").click();
    await expect(page.locator(".gbx-composition-draft")).toContainText("Saved", {
      timeout: 60_000,
    });
    // **And it was refused twice before this was deterministic**, which is worth
    // leaving in the claim rather than only in a commit message. The first write
    // wakes `DescriptionWatchService`, whose product path re-read the product
    // 300ms later and bumped the store's revision -- so a second Apply started
    // inside that window was refused with "the product changed while the preview
    // was open", when the only change was the application re-reading its own
    // write. Two runs in three. The watcher now waits while a draft is queued,
    // which is the rule its gear path already stated.
    await expect(
      page.locator(".theia-notification-message").filter({ hasText: "the product changed" }),
      "no refusal about a change the application made itself",
    ).toHaveCount(0);
    await expect
      .poll(() => readFileSync(product.path, "utf8").includes("enable_docs"), { timeout: 30_000 })
      .toBe(true);
  });
});
