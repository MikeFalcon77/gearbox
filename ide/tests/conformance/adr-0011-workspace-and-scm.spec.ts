// The workspace, and the Git that depends on it.
//
// ADR 0011 says Explorer, Terminal and Git remain visible. Two things had to be
// true before Git could be anything but an empty panel, and neither was:
//
//   - a workspace has to be open, because the VS Code git extension finds
//     repositories by walking workspace folders;
//   - it has to be **multi-root**, because the two repositories that matter are
//     siblings -- `gearbox-builder` and `gears-rust` -- so no single folder
//     contains both.
//
// The second is the reason this is not just "open a folder". A single-folder
// workspace would have covered half the tree a person edits and looked like it
// worked.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, revealInExplorer, revealLeft, test } from "../fixtures/studio";

const IDE = join(__dirname, "../..");

/** `git status` counted the way an SCM view counts it: untracked files, not directories. */
function changeCount(repo: string): number {
  const out = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
  });
  return out.split("\n").filter((line) => line.trim().length > 0).length;
}

test.describe("the workspace Studio opens for itself", () => {
  test("both repositories are workspace roots [ADR-0011 §Consequences: Explorer remains]", async ({
    studio,
  }) => {
    await revealLeft(studio.page, "Explorer");
    const roots = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll(".theia-TreeNode"))
        .filter((node) => node.className.includes("theia-DirNode"))
        .map((node) => (node.textContent ?? "").trim()),
    );
    // The multi-root claim, stated as the two names: `gears-rust` is a sibling of
    // the builder repository, so its presence is the whole reason the workspace
    // is multi-root rather than one folder.
    expect(roots).toContain("gearbox-builder");
    expect(roots).toContain("gears-rust");
  });

  test("the watcher does not walk the Rust target directories [ADR-0011 §Scope: which packages are present]", () => {
    // Not a UI claim, and it is here because the failure is invisible until it is
    // not: opening two Rust checkouts as workspace roots points Theia's file
    // watcher at two multi-gigabyte `target/` trees. `.gearbox/` is generated
    // wholesale, so watching it reports churn nobody acts on.
    const app = JSON.parse(readFileSync(join(IDE, "browser-app/package.json"), "utf8")) as {
      theia: { frontend: { config: { preferences: Record<string, unknown> } } };
    };
    const exclude = app.theia.frontend.config.preferences["files.watcherExclude"] as
      | Record<string, boolean>
      | undefined;
    expect(exclude?.["**/target/**"]).toBe(true);
    expect(exclude?.["**/.gearbox/**"]).toBe(true);
  });
});

test.describe("Git, from the VS Code extension", () => {
  test("Source Control lists both repositories [ADR-0011 §Consequences: Git remains]", async ({
    studio,
  }) => {
    // Theia 1.75 ships no `@theia/git` -- its last release was `1.61.0-next.8`.
    // This provider is `vscode.git` running in the plugin host, which is what the
    // earlier decision to install `@theia/plugin-ext` bought.
    await revealLeft(studio.page, /^Source Control/);
    const repos = await studio.page
      .locator(".theia-scm-repository-name")
      .allTextContents()
      .then((names) => names.map((name) => name.trim()));
    expect(repos).toContain("gearbox-builder");
    expect(repos).toContain("gears-rust");
  });

  test("the change count is the repository's, not a placeholder [ADR-0011 §Consequences: Git remains]", async ({
    studio,
  }) => {
    // A provider that registered but read nothing would still render a name and a
    // zero. Comparing against `git status` in the real checkout is what tells
    // "wired up" from "present".
    await revealLeft(studio.page, /^Source Control/);
    const badge = await studio.page
      .locator("#shell-tab-scm-view-container .theia-badge-decorator-sidebar")
      .textContent();
    const shown = Number.parseInt((badge ?? "").trim(), 10);
    expect(Number.isNaN(shown)).toBe(false);
    // The selected repository is the first one, the builder checkout.
    expect(shown).toBe(changeCount(join(IDE, "..")));
  });

  test("git decorates the Explorer [ADR-0011 §Consequences: Git remains]", async ({ studio }) => {
    // Independent of the Source Control view: the letters the extension puts on
    // changed files in the file tree. If the provider were registered but inert,
    // the tree would be undecorated.
    await revealLeft(studio.page, "Explorer");
    const decorated = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll(".theia-TreeNode"))
        .map((node) => (node.textContent ?? "").trim())
        .filter((text) => /[MUAD]$/.test(text)),
    );
    expect(decorated.length).toBeGreaterThan(0);
  });
});

test.describe("what the workspace makes checkable", () => {
  test("a product.lock opened as a file is read-only [PRD cpt-gearbox-fr-lock-read-only]", async ({
    studio,
  }) => {
    // Implemented long before it could be reached: with no workspace there was no
    // way to open a `product.lock` at all, so `ReadOnlyLockEditorProvider` sat
    // unverified.
    // Both names: Studio generate writes `.gearbox/studio/` beside the
    // CLI default `.gearbox/payments-demo/`, so Theia no longer collapses the
    // chain into one `.gearbox/payments-demo/dev` row. Expanding `.gearbox`
    // then `payments-demo` reaches the lock in either layout.
    const lock = await revealInExplorer(
      studio.page,
      "gearbox-builder",
      [".gearbox", "payments-demo"],
      "product.lock",
    );
    await lock.dblclick();

    // Not `.monaco-editor`.first(): Generate's preview is a diff editor that
    // stays in the DOM after ADR-0010 opens a planned file, and its gutter
    // matches first while remaining hidden.
    const editor = studio.page
      .locator(".monaco-editor:not(.gutter)")
      .locator("visible=true")
      .first();
    await editor.waitFor({ state: "visible" });
    await expect(editor.locator(".view-lines .view-line").first()).toContainText("GENERATED");

    // Asserted as behaviour, not as a CSS class: the requirement is that a person
    // cannot edit the file, and a class name is Monaco's business and free to
    // change. "An edit to the lock is silently discarded by the next resolve,
    // which is the failure mode worth preventing rather than detecting."
    // Clicked into the text and typed with the keyboard, not `press` on
    // `.inputarea`: Monaco's input is a textarea parked off-screen, so
    // Playwright's actionability check waits on it forever.
    //
    // And asserted on the refusal rather than on the text. Comparing the rendered
    // lines does not work -- Monaco virtualises them, so a click that scrolls
    // changes what is on screen without anything being edited, which is exactly
    // what the first version of this test mistook for a failure.
    await editor.locator(".view-lines").first().click();
    await studio.page.keyboard.type("xx");

    // Monaco's own overlay, carrying the message `ReadOnlyLockEditorProvider`
    // supplies. Asserting the text means asserting that *our* rebind is what
    // refused, not merely that something did.
    await expect(studio.page.locator(".monaco-editor-overlaymessage")).toContainText(
      "product.lock is generated",
    );
    // And nothing reached the document: an edited editor is marked dirty at once.
    const tab = studio.page.locator(".lm-TabBar-tab", { hasText: "product.lock" }).first();
    expect(await tab.getAttribute("class")).not.toContain("dirty");
  });
});
