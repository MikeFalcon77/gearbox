// ADR cpt-gearbox-adr-authoring-ownership-tiers.
//
// The *writing* surface this ADR decided -- scaffolding a gear, scaffolding a
// plugin, previewing a file plan -- does not exist in Studio, so every test here
// is a `test.fixme`. That is the finding rather than a gap in the suite.
//
// Tier 1's own claim -- `product.lock` presented read-only -- *is* built, and is
// tested in `adr-0011-workspace-and-scm.spec.ts` beside the workspace that makes
// a lock file openable at all. It is asserted once, there, rather than twice
// here: the same claim in two files drifts into two states, which is what this
// table exists to prevent.
//
// Most of the ADR's Confirmation section is not browser-observable and does not
// belong here: "a scaffold into a directory that already exists must refuse",
// "running the same scaffold twice must produce no second `members` entry", "a
// scaffold interrupted between its first and last write must leave no trace" are
// engine claims and belong in Rust tests beside the writer. What is left is what
// a person can see in the editor, which is what this file covers.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { expect, openProduct, resetCatalogueView, revealCatalogue, test } from "../fixtures/studio";

const REPO = join(__dirname, "../../..");
const PRODUCT = "products/payments-demo/product.gdl";

/** `git diff --stat` for the demo description, or "" when it matches HEAD. */
function diffOfProduct(): string {
  return execFileSync("git", ["diff", "--stat", "--", PRODUCT], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
}

test.describe("what the tool may write", () => {

  test.fixme(
    "Studio offers a command to scaffold a new gear [ADR-0010 tier 0]",
    async ({ studio }) => {
      // Tier 0 is the permitted case the ADR is most confident about -- "a tool
      // may freely create new files" -- and it is the entry point for two of the
      // three usage scenarios the documents have to cover: a new gear, and a
      // plugin, either in this repo or another.
      await studio.page.keyboard.press("F1");
      await studio.page.keyboard.type("Gearbox: New Gear");
      await expect(
        studio.page.locator(`.quick-input-list [role="option"]`).first(),
      ).toBeVisible();
    },
  );

  test.fixme(
    "a scaffold shows its file plan before writing anything [ADR-0010 §Consequences: a preview is not optional]",
    async ({ studio }) => {
      // "Every surveyed tool has `--dry-run`; the plan's `FilePlan[]` with
      // create|update|unchanged|conflict already provides the shape, so
      // scaffolding reuses the generator's preview rather than inventing one."
      //
      // The same requirement over a description edit *is* met -- see "a
      // description edit shows the line before writing it" below. What is missing
      // is the `FilePlan[]` form of it, which belongs to scaffolding and to
      // `generate`, and neither exists yet.
      await expect(studio.page.locator(".gbx-file-plan")).toBeVisible();
    },
  );

  test.fixme(
    "a generated composition crate carries a header naming its generator [ADR-0010 tier 2]",
    async ({ studio }) => {
      // Tier 2 is "tool, entirely, with a header". The header is what tells a
      // reader not to edit the file, and it is the only thing standing between
      // tier 2 and tier 5.
      await expect(studio.page.locator(".monaco-editor")).toContainText("GENERATED");
    },
  );
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
    // is on disk until the person agrees.
    expect(diffOfProduct(), "the description must start clean for this to mean anything").toBe("");

    await openProduct(studio.page, "dev");
    await revealCatalogue(studio.page);
    await resetCatalogueView(studio.page);

    // `cluster` is in the catalogue and not named by the product, so the toggle
    // is off. The lit ones are exactly the gears the description asks for.
    const toggle = studio.page.locator('[data-toggle-gear="cluster"]');
    await expect(toggle).toHaveAttribute("data-in-product", "false");
    await toggle.click();

    // The line itself, not "a change": a preview that does not say what it will
    // write is not a preview.
    await expect(studio.page.locator(".gbx-edit-preview")).toContainText(
      'use_gear("cluster", source = "gears-rust")',
    );
    expect(diffOfProduct(), "the dry run must not have written anything").toBe("");

    await studio.page.locator(".theia-button.secondary").click();
    await expect(studio.page.locator(".gbx-edit-preview")).toHaveCount(0);
    expect(diffOfProduct(), "cancelling must leave the file alone").toBe("");
    await expect(toggle).toHaveAttribute("data-in-product", "false");
  });

  test("adding a gear inserts one line, and removing it restores the file exactly [ADR-0010 tier 3]", async ({
    studio,
  }) => {
    // Both halves in one test because the inverse being exact is what makes this
    // surgery rather than rewriting -- a re-serialising editor could add a line
    // and would never take it back byte for byte -- and because the undo is what
    // leaves the application consistent with the file.
    expect(diffOfProduct()).toBe("");

    try {
      await openProduct(studio.page, "dev");
      await revealCatalogue(studio.page);
      await resetCatalogueView(studio.page);

      const toggle = studio.page.locator('[data-toggle-gear="cluster"]');
      await toggle.click();
      await studio.page.locator(".theia-button.main").click();
      // The product is re-read and re-resolved before the toggle can change, so
      // this waits on the whole cycle and not just on the write.
      await expect(toggle).toHaveAttribute("data-in-product", "true", { timeout: 30_000 });

      // `git diff --stat` names deletions too, so its summary says both halves at
      // once: one line arrived, and no line was disturbed.
      expect(diffOfProduct()).toContain("1 file changed, 1 insertion(+)");
      expect(
        diffOfProduct(),
        "a deletion means the edit rewrote rather than inserted",
      ).not.toContain("deletion");

      await toggle.click();
      await studio.page.locator(".theia-button.main").click();
      await expect(toggle).toHaveAttribute("data-in-product", "false", { timeout: 30_000 });

      expect(diffOfProduct(), "add then remove did not return the file to what it was").toBe("");
    } finally {
      if (diffOfProduct() !== "") {
        execFileSync("git", ["checkout", "--", PRODUCT], { cwd: REPO });
        await studio.page.reload();
      }
    }
  });
});
