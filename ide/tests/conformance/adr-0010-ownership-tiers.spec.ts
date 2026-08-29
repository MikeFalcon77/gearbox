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

import { expect, test } from "../fixtures/studio";

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
