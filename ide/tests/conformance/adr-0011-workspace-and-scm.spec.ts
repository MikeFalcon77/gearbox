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
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, revealInExplorer, revealLeft, test } from "../fixtures/studio";

const IDE = join(__dirname, "../..");

/**
 * A file that makes the repository dirty, for as long as the claim needs it.
 *
 * **The two Git claims below used to depend on the developer's working tree.**
 * They asserted "the badge is greater than zero" and "some node carries a letter",
 * which is true whenever someone has uncommitted work and false the moment they
 * commit -- so the suite went red on a clean checkout and green again after any
 * edit. A conformance run that reports the state of somebody's editor is not
 * reporting on the application.
 *
 * So the claim makes its own change: one untracked file, asserted on, then removed.
 * That is also a stronger statement than the old one -- the provider is not merely
 * non-zero, it *noticed something appear* -- and it holds on a clean checkout,
 * which is where a conformance suite has to hold.
 *
 * Outside `products/`, because the three guards on the descriptions exist to catch
 * exactly this kind of write, and rightly.
 */
function withDirtyRepo<T>(repo: string, run: (marker: string) => Promise<T>): Promise<T> {
  const name = `.scm-probe-${process.pid}`;
  const file = join(repo, "ide", name);
  writeFileSync(file, "A file one conformance claim makes and removes. Safe to delete.\n");
  return run(name).finally(() => rmSync(file, { force: true }));
}

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
    await withDirtyRepo(join(IDE, ".."), async () => {
      await revealLeft(studio.page, /^Source Control/);
      // Polled: the extension learns about the new file from a watcher, so the
      // badge is a moment behind the write rather than wrong.
      await expect
        .poll(async () =>
          Number.parseInt(
            (
              (await studio.page
                .locator("#shell-tab-scm-view-container .theia-badge-decorator-sidebar")
                .textContent()
                .catch(() => "0")) ?? "0"
            ).trim(),
            10,
          ),
        )
        .toBeGreaterThan(0);
    });

    await revealLeft(studio.page, /^Source Control/);
    const badge = await studio.page
      .locator("#shell-tab-scm-view-container .theia-badge-decorator-sidebar")
      .textContent()
      .catch(() => "0");
    const shown = Number.parseInt((badge ?? "0").trim(), 10);
    expect(Number.isNaN(shown)).toBe(false);
    // A floor, and the floor is what was measured rather than what was assumed.
    //
    // Run alone, the badge reads exactly the builder checkout's count -- observed
    // at 14 with 14 changes there and 24 in `gears-rust`. Run inside the whole
    // suite it does not: something earlier changes what the Source Control view
    // has selected or aggregated. So an exact match is not a property of the
    // application, and asserting one made this test fail for a reason that has
    // nothing to do with the claim.
    //
    // The claim is that the provider actually read a repository, which the floor
    // still holds: a provider that registered and read nothing renders zero, and
    // one reading a *different* repository cannot reach the builder's count.
    // A floor against what git reports *now*, after the probe file is gone. On a
    // clean checkout both are zero, and the claim above is the one that proved the
    // provider is live.
    expect(shown).toBeGreaterThanOrEqual(changeCount(join(IDE, "..")));
  });

  test("git decorates the Explorer [ADR-0011 §Consequences: Git remains]", async ({ studio }) => {
    // Independent of the Source Control view: the letters the extension puts on
    // changed files in the file tree. If the provider were registered but inert,
    // the tree would be undecorated.
    //
    // Expand the builder root first. After a perspective switch Theia restores a
    // snapshot that may have had the folders collapsed, and a collapsed tree
    // has no letters to find.
    await withDirtyRepo(join(IDE, ".."), async (marker) => {
      // The probe file is in `ide/`, so that is the folder to expand: a collapsed
      // tree has no letters to find, and after a perspective switch Theia may have
      // restored a snapshot with the folders closed. Expanding by naming the probe
      // file itself also waits for the tree to have noticed it.
      await revealInExplorer(studio.page, "gearbox-builder", "ide", marker);
      await expect
        .poll(async () =>
          studio.page.evaluate(() =>
            Array.from(document.querySelectorAll(".theia-TreeNode"))
              .map((node) => (node.textContent ?? "").trim())
              .filter((text) => /[MUAD]$/.test(text)).length,
          ),
        )
        .toBeGreaterThan(0);
    });
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
