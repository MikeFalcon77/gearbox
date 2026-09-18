// `cpt-gearbox-adr-gdl-completion-and-hover`, the browser half.
//
// The engine's half is covered in Rust: the caret scan in
// `crates/gearbox-gdl/src/assist_tests.rs`, and the request wiring in
// `crates/gearbox-rpc/src/document_tests.rs`. What only a browser can say is
// that a native Monaco provider is registered against the `gdl` language and
// that its answers reach the suggest widget -- the step where a second Monaco
// copy, or a provider registered too late, fails silently.

import { readFileSync, writeFileSync } from "node:fs";

import { restoreProducts } from "../fixtures/products-tree";
import { join } from "node:path";

import { expect, revealInExplorer, test } from "../fixtures/studio";

const REPO = join(__dirname, "../../..");
const PRODUCT_GDL = join(REPO, "products/payments-demo/product.gdl");

test.describe("the description language helps while it is being written", () => {
  test("completion offers a construct's parameters inside an unfinished call [ADR-0022 §Decision Outcome]", async ({
    freshStudio,
  }) => {
    // **An unfinished call, deliberately.** The decision this claim belongs to
    // turns on the fact that a buffer mid-edit does not parse, so a fixture with
    // a *closed* call would pass against an implementation that only works on
    // valid syntax -- which is the implementation the ADR rejects.
    const { page } = freshStudio;
    const original = readFileSync(PRODUCT_GDL, "utf8");

    try {
      // A line whose text is unique in the file, so the caret can be placed by
      // clicking it rather than by cursor keys -- `Cmd+End` does not reach the
      // end of a Monaco buffer on macOS, which cost one run of this claim and
      // showed up as `kubernetes(...)` parameters being offered instead.
      //
      // Prepended, not appended: Monaco virtualises its lines, so a probe at the
      // end of a hundred-line file is not in the DOM to click. The first line
      // always is.
      writeFileSync(PRODUCT_GDL, `use_gear("probe-marker",\n${original}`);

      const node = await revealInExplorer(
        page,
        "gearbox",
        ["products", "payments-demo"],
        "product.gdl",
      );
      await node.dblclick();

      const editor = page.locator('.monaco-editor[data-uri*="product.gdl"]');
      await expect(editor).toBeVisible({ timeout: 30_000 });

      // Clicking the probe line puts the caret inside the unclosed call: the
      // click lands on the line's centre, which is between `use_gear(` and the
      // line's end. Typing into Monaco is blocked for this suite --
      // `.monaco-editor .inputarea` is off-screen, which `regression.spec.ts`
      // records -- but a click and a chord are not.
      const probe = editor.locator(".view-line", { hasText: "probe-marker" });
      await expect(probe, "the probe line must be on screen to click").toHaveCount(1);
      await probe.click();
      await page.keyboard.press("Control+Space");

      const suggestions = page.locator(".suggest-widget .monaco-list-row");
      await expect(
        suggestions.first(),
        "the suggest widget must open: a provider registered against a second Monaco, \
or registered after `onLanguage` fired, shows nothing and reports nothing",
      ).toBeVisible({ timeout: 30_000 });

      const offered = (await suggestions.allTextContents()).join(" ");
      // `source` is a named parameter of `use_gear` that the probe does not
      // write. Asserting a *specific* parameter rather than "something appeared"
      // is what ties this to the vocabulary: any list would satisfy the former.
      expect(
        offered,
        `the engine's vocabulary must reach the widget; it offered: ${offered}`,
      ).toContain("source");
    } finally {
      // **From `git`, not from the snapshot above.** Writing `original` back
      // assumes it was the committed text, and when it is not -- because an
      // earlier run or an earlier claim left its own edit behind -- the restore
      // re-writes the damage instead of undoing it. One leftover then survives
      // every later cleanup, which is how a single failure became three in
      // `prd-diagnostics`.
      restoreProducts(REPO);
    }
  });
});
