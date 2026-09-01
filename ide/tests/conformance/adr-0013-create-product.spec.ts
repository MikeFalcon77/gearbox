// ADR cpt-gearbox-adr-create-product — create, clone and in-description edits.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  expect,
  openProduct,
  revealCatalogue,
  revealInspector,
  resetCatalogueView,
  runCommand,
  settled,
  test,
} from "../fixtures/studio";

const REPO = join(__dirname, "../../..");
const DEMO = join(REPO, "products/payments-demo/product.gdl");
const DEMO_REL = "products/payments-demo/product.gdl";

function diffOf(path: string): string {
  return execFileSync("git", ["diff", "--stat", "--", path], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
}

function commentLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().startsWith("#")).length;
}

async function acceptPreview(page: import("@playwright/test").Page): Promise<void> {
  const dialog = page.locator(".dialogBlock", {
    has: page.locator(".gbx-edit-preview, .gbx-create-preview"),
  });
  await expect(dialog).toBeVisible();
  await dialog.locator(".theia-button.main").click();
}

function removeProductDir(id: string): void {
  rmSync(join(REPO, "products", id), { recursive: true, force: true });
}

async function openCreateWizard(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector(".theia-ApplicationShell", { timeout: 60_000 });
  await runCommand(page, "New Product");
  await expect(page.locator(".gbx-create-preview")).toBeVisible({ timeout: 30_000 });
}

test.describe("create and clone a product", () => {
  const id = "conformance-create";
  const rel = `products/${id}/product.gdl`;

  test.afterEach(() => {
    removeProductDir(id);
  });

  test("Create shows preview text, Cancel writes nothing, Create opens the product [ADR-0013 §Confirmation]", async ({
    freshStudio,
  }) => {
    const { page } = freshStudio;
    await settled(page);
    expect(diffOf(rel)).toBe("");

    await openCreateWizard(page);
    await expect(page.locator(".gbx-create-preview")).toContainText("product(");
    await page.locator("[data-create-id]").fill(id);
    await page.locator("[data-create-name]").fill("Conformance Create");
    await expect(page.locator(".gbx-create-preview")).toContainText(`id = "${id}"`, {
      timeout: 10_000,
    });

    await page.locator("[data-create-cancel]").click();
    await expect(page.locator(".gbx-create")).toHaveCount(0);
    expect(diffOf(rel)).toBe("");

    await openCreateWizard(page);
    await page.locator("[data-create-id]").fill(id);
    await page.locator("[data-create-name]").fill("Conformance Create");
    await expect(page.locator(".gbx-create-preview")).toContainText(`id = "${id}"`, {
      timeout: 10_000,
    });
    await page.locator("[data-create-submit]").click();
    await acceptPreview(page);

    await expect(page.locator("[data-resolved-profile]")).toBeVisible({ timeout: 60_000 });
    expect(existsSync(join(REPO, "products", id, "product.gdl"))).toBe(true);
  });

  test("Clone keeps the source comment line count [ADR-0013 §Confirmation]", async ({ freshStudio }) => {
    const { page } = freshStudio;
    await settled(page);
    const comments = commentLines(readFileSync(DEMO, "utf8"));

    await openCreateWizard(page);
    await page.locator("[data-clone-path]").fill(DEMO);
    await expect
      .poll(async () => commentLines(await page.locator(".gbx-create-preview").innerText()), {
        timeout: 15_000,
      })
      .toBe(comments);
    await page.locator("[data-create-cancel]").click();
  });
});

test.describe("edit config and profiles in the open product", () => {
  test("a config edit changes one line [ADR-0013 §Confirmation]", async ({ studio }) => {
    expect(diffOf(DEMO_REL)).toBe("");

    try {
      await openProduct(studio.page, "dev");
      await revealCatalogue(studio.page);
      await resetCatalogueView(studio.page);
      await studio.page
        .locator(".gearbox-catalogue .gbx-row", { hasText: "api-gateway" })
        .click();
      await revealInspector(studio.page);
      await studio.page.locator('[data-gear-config="api-gateway"]').waitFor({ state: "visible" });

      await studio.page.locator("[data-config-new-key]").fill("demo_mode");
      await studio.page.locator("[data-config-new-value]").fill("demo_value");
      await studio.page.locator('[data-add-config="api-gateway"]').click();
      await acceptPreview(studio.page);
      await expect(studio.page.locator('[data-config-key="demo_mode"]')).toBeVisible({
        timeout: 30_000,
      });
      expect(diffOf(DEMO_REL)).toContain("1 insertion(+)");

      // Undo through the interface, not with `git checkout` + reload: restoring
      // the file behind the app leaves the store holding the edited description
      // (§9.1), and a reload of the shared worker page races the next test against
      // an empty catalogue `rootPaths()`.
      await studio.page.locator('[data-config-remove="demo_mode"]').click();
      await acceptPreview(studio.page);
      await expect(studio.page.locator('[data-config-key="demo_mode"]')).toHaveCount(0, {
        timeout: 30_000,
      });
      expect(diffOf(DEMO_REL)).toBe("");
    } finally {
      if (diffOf(DEMO_REL) !== "") {
        execFileSync("git", ["checkout", "--", DEMO_REL], { cwd: REPO });
      }
    }
  });

  test("a config key named password is refused with an explanation [ADR-0013 §Confirmation]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "dev");
    await revealCatalogue(studio.page);
    await resetCatalogueView(studio.page);
    await studio.page.locator(".gearbox-catalogue .gbx-row", { hasText: "api-gateway" }).click();
    await revealInspector(studio.page);
    await studio.page.locator('[data-gear-config="api-gateway"]').waitFor({ state: "visible" });

    await studio.page.locator("[data-config-new-key]").fill("password");
    await studio.page.locator("[data-config-new-value]").fill("literal");
    await studio.page.locator('[data-add-config="api-gateway"]').click();
    await expect(studio.page.locator(".theia-notification-message").first()).toContainText(
      /refusing|password|secret|could not be edited/i,
      { timeout: 10_000 },
    );
    expect(diffOf(DEMO_REL)).toBe("");
  });

  test("an added profile appears in the switcher and resolves [ADR-0013 §Confirmation]", async ({
    studio,
  }) => {
    const profileId = "conformance-staging";
    expect(diffOf(DEMO_REL)).toBe("");

    try {
      await openProduct(studio.page, "dev");
      studio.page.on("dialog", (dialog) => void dialog.accept(profileId));
      await studio.page.locator("[data-add-profile]").click();
      await acceptPreview(studio.page);
      await expect(studio.page.locator(`[data-profile="${profileId}"]`)).toBeVisible({
        timeout: 30_000,
      });
      await studio.page.locator(`[data-profile="${profileId}"]`).click();
      await expect(studio.page.locator(`[data-resolved-profile="${profileId}"]`)).toBeVisible({
        timeout: 60_000,
      });

      await studio.page.locator(`[data-remove-profile="${profileId}"]`).click();
      await acceptPreview(studio.page);
      await expect(studio.page.locator(`[data-profile="${profileId}"]`)).toHaveCount(0, {
        timeout: 30_000,
      });
      expect(diffOf(DEMO_REL)).toBe("");
    } finally {
      if (diffOf(DEMO_REL) !== "") {
        execFileSync("git", ["checkout", "--", DEMO_REL], { cwd: REPO });
      }
    }
  });
});
