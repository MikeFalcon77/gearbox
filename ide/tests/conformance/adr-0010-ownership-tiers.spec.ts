// ADR cpt-gearbox-adr-authoring-ownership-tiers.
//
// Nothing in this ADR is implemented yet, so every test here is a `test.fixme`.
// That is the finding, not a gap in the suite: the ADR decided what the tool may
// write, and the writing surface -- scaffolding a gear, scaffolding a plugin,
// marking the lock read-only -- does not exist in Studio.
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
    "product.lock opens read-only [ADR-0010 tier 1; PRD cpt-gearbox-fr-lock-read-only]",
    async ({ studio }) => {
      // "A header comment asks; a read-only editor tells." An edit to the lock is
      // silently discarded by the next resolve, which is the failure mode worth
      // preventing rather than detecting.
      await studio.page.keyboard.press("F1");
      await studio.page.keyboard.type("product.lock");
      await studio.page.keyboard.press("Enter");
      // Monaco marks a read-only model on the editor element itself, so this is
      // the state a person would run into on their first keystroke.
      await expect(studio.page.locator(".monaco-editor.readonly")).toBeVisible();
    },
  );

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
