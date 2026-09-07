// Every control a person can operate has a name, and a source check that keeps
// it that way.
//
// A UX pass found the catalogue's add/remove control announcing nothing: it was
// an icon inside a button with a `title`, so a screen reader read the glyph's
// empty text and a keyboard user never saw the tooltip. That one is fixed at the
// source. What this file adds is the rule -- because the next icon-only button
// will be written by somebody who has not read that fix, and a claim that reads
// the rendered DOM can only cover the controls a test happens to visit.
//
// The shape is the one `prd-lock.spec.ts` already uses for "the client never
// serializes a lock of its own": grep this application's own sources for the
// pattern, and name the offenders.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, openProduct, revealCatalogue, resetCatalogueView, test } from "../fixtures/studio";

const STUDIO_SRC = join(__dirname, "../../gearbox-studio/src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx$/.test(entry.name) ? [path] : [];
  });
}

/** Every `<button …>` opening tag, with its attributes, as written. */
function buttonTags(text: string): string[] {
  return Array.from(text.matchAll(/<button\b[\s\S]*?>/g)).map((match) => match[0]);
}

test.describe("controls that can be operated can be named", () => {
  test("no button in the Studio is written without a type [ADR-0011 §Confirmation]", () => {
    // `type` defaults to `submit`, and this application does put buttons inside
    // `<label>` and `<form>`-shaped markup. A submit inside a Theia dialog
    // reloads the frame, which is a spectacular way to lose a draft.
    const offenders = sources(STUDIO_SRC).flatMap((file) =>
      buttonTags(readFileSync(file, "utf8"))
        .filter((tag) => !/\btype=/.test(tag))
        .map((tag) => `${file}: ${tag.replace(/\s+/g, " ").slice(0, 80)}`),
    );
    expect(offenders).toEqual([]);
  });

  test("an icon-only button carries an accessible name [ADR-0011 §Confirmation]", () => {
    // **"Icon-only" is decided structurally, not by guessing at rendered text.**
    // A button whose entire body is one `codicon` span has nothing for a screen
    // reader to read, so it needs `aria-label`; a button with any other child
    // may well render a word and is not this claim's business. Deciding it by
    // looking for letters in the body would be undecidable in JSX -- `{title}`
    // is text at runtime and punctuation in the source -- and a check that
    // guesses is a check that gets edited until it passes.
    const offenders: string[] = [];
    for (const file of sources(STUDIO_SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<button\b([\s\S]*?)>([\s\S]*?)<\/button>/g)) {
        const [, attributes, body] = match;
        // Remove exactly one self-closing codicon span; if nothing is left, the
        // glyph was the whole content.
        const withoutIcon = body
          .replace(/<span[^>]*codicon[^>]*\/>/g, "")
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
          .trim();
        const iconOnly = withoutIcon === "" && /codicon/.test(body);
        if (!iconOnly) continue;
        if (/aria-label/.test(attributes)) continue;
        offenders.push(`${file}: ${attributes.replace(/\s+/g, " ").trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the catalogue's add control says which gear and which product [ADR-0011 §Confirmation]", async ({
    studio,
  }) => {
    // The control the pass actually found. Its name is the whole sentence, and it
    // has to be: the button repeats down a list of fourteen rows, so "Add" alone
    // is fourteen buttons a screen reader cannot tell apart.
    await openProduct(studio.page, "dev");
    await revealCatalogue(studio.page);
    await resetCatalogueView(studio.page);
    const toggle = studio.page.locator('[data-toggle-gear="cluster"]');
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    const label = await toggle.getAttribute("aria-label");
    expect(label).toMatch(/^(Add|Remove) .+ (to|from) .+$/);
    expect(label).toContain("Cluster");
    expect(await toggle.getAttribute("type")).toBe("button");
  });
});
