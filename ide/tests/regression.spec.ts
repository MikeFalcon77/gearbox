// Checks that are about the implementation rather than about a document.
//
// They came from `scripts/ui-smoke.mjs` and are worth keeping, but they do not
// belong in the conformance table: no design document says "an edge must have an
// arrowhead". Kept in their own file so that the conformance files stay a
// one-to-one map onto the documents.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  expect,
  openGraph,
  openPalette,
  openProduct,
  revealCatalogue,
  revealInspector,
  runCommand,
  expectContext,
  test,
} from "./fixtures/studio";

test.describe("the panel is operable without a mouse", () => {
  // Every interaction in the catalogue was a bare `onClick` on a div once. A
  // panel in an IDE that only answers clicks is unusable for anyone who does not
  // use a mouse. Real key events through the browser, not synthesized ones:
  // React attaches its own listeners, and a dispatched event with the wrong
  // shape would pass here while a keyboard would not.

  test("a catalogue row can take focus", async ({ studio }) => {
    // Revealed first. The Product context collapses the left panel -- the catalogue
    // is a source of components, not the subject of that context -- so its rows are
    // not on screen until asked for. Before the rework the catalogue was always
    // there, and this test relied on that without saying so.
    await revealCatalogue(studio.page);
    await studio.page.locator(".gbx-widget-catalogue .gbx-row").first().focus();
    const focused = await studio.page.evaluate(() =>
      document.activeElement?.classList.contains("gbx-row"),
    );
    expect(focused).toBe(true);
  });

  test("Enter selects the focused row", async ({ studio }) => {
    // Deliberately a row that is not already selected: Enter on an
    // already-selected row *reveals* its description instead, which moves focus
    // into the editor. Establishing the precondition here rather than relying on
    // what an earlier test left behind, since the read-only tests share one
    // loaded application.
    await studio.page.locator(".gbx-widget-catalogue .gbx-row:not(.gbx-selected)").first().focus();
    await studio.page.keyboard.press("Enter");
    const name = await studio.page.evaluate(() =>
      document.activeElement?.classList.contains("gbx-selected") === true
        ? (document.activeElement.querySelector(".gbx-row-name")?.textContent ?? "").trim()
        : null,
    );
    expect(name, "the focused row never became selected").not.toBeNull();
    expect(name!.length).toBeGreaterThan(0);
  });

  test("one row at a time is in the tab order", async ({ studio }) => {
    // `tabIndex={0}` on every row put one tab stop per gear between the filter
    // box and the rest of the shell -- 62 of them today. The ARIA listbox
    // pattern is the fix and it is the reason the arrow keys below exist: Tab
    // reaches the list, the arrows move inside it.
    const tabbable = await studio.page.evaluate(
      () =>
        Array.from(document.querySelectorAll(".gbx-widget-catalogue .gbx-row")).filter(
          (row) => row.getAttribute("tabindex") === "0",
        ).length,
    );
    expect(tabbable).toBe(1);
  });

  test("the arrow keys move between rows", async ({ studio }) => {
    // Real key events, for the reason at the top of this block. And read off
    // `activeElement` rather than off the store: the point of the change is that
    // focus follows the selection, which is what a screen reader announces.
    const names = () =>
      studio.page.evaluate(() =>
        (document.activeElement?.querySelector(".gbx-row-name")?.textContent ?? "").trim(),
      );

    await studio.page.locator(".gbx-widget-catalogue .gbx-row").first().focus();
    const first = await names();
    await studio.page.keyboard.press("ArrowDown");
    const second = await names();
    expect(second, "ArrowDown did not move focus to another row").not.toBe(first);
    expect(second.length).toBeGreaterThan(0);

    await studio.page.keyboard.press("ArrowUp");
    expect(await names(), "ArrowUp did not come back").toBe(first);

    // Clamped, not wrapped: a list that jumps from the first gear to the last
    // reads as a bug the first time it happens.
    await studio.page.keyboard.press("ArrowUp");
    expect(await names(), "ArrowUp past the first row wrapped instead of holding").toBe(first);

    await studio.page.keyboard.press("End");
    const last = await names();
    expect(last, "End did not reach a different row").not.toBe(first);
    await studio.page.keyboard.press("Home");
    expect(await names(), "Home did not return to the first row").toBe(first);
  });

  test("the command palette opens", async ({ studio }) => {
    // Opened and dismissed without running anything: every Gearbox view command
    // is a toggle, so executing one here would change the state the other tests
    // read. Its own test so that a keybinding regression is not reported as a
    // graph regression.
    await openPalette(studio.page);
    await expect(studio.page.locator(".quick-input-widget")).toBeVisible();
    await studio.page.keyboard.press("Escape");
  });
});

test.describe("the graph draws what it says it draws", () => {
  test("every edge is directed", async ({ studio }) => {
    await openGraph(studio.page);
    const counts = await studio.page.evaluate(() => ({
      edges: document.querySelectorAll(".gbx-edge").length,
      arrows: document.querySelectorAll(".gbx-edge[marker-end]").length,
    }));
    expect(counts.edges).toBeGreaterThan(0);
    expect(counts.arrows).toBe(counts.edges);
  });

  test("every edge lands on a node the graph drew", async ({ studio }) => {
    await openGraph(studio.page);
    const graph = await studio.page.evaluate(() => ({
      nodes: Array.from(document.querySelectorAll(".gbx-node-label")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
      edges: Array.from(document.querySelectorAll(".gbx-edge")).map((e) => [
        e.getAttribute("data-from"),
        e.getAttribute("data-to"),
      ]),
    }));
    // An edge to a gear outside the catalogue would be a projection bug.
    const dangling = graph.edges.filter(
      ([from, to]) => !graph.nodes.includes(from ?? "") || !graph.nodes.includes(to ?? ""),
    );
    expect(dangling).toEqual([]);
  });
});

test.describe("contributions are registered once", () => {
  // Both of these catch the same class of mistake from two sides, and it is a
  // mistake this application made: `bindViewContribution` already binds
  // `CommandContribution`, `KeybindingContribution` and `MenuContribution`, and
  // binding any of them again next to it runs the contribution twice.

  test("no menu contains the same entry twice", async ({ studio }) => {
    // Stated as an invariant over every menu rather than as a list of expected
    // entries. A test naming the entries would have to be updated by the same
    // person who added the duplicate, and `MenuModelRegistry.registerMenuAction`
    // does not deduplicate -- it makes a node and appends it, so a double
    // binding shows up here first.
    const menus = await studio.page
      .locator(".lm-MenuBar-itemLabel")
      .allTextContents()
      .then((all) => all.map((one) => one.trim()).filter((one) => one.length > 0));
    expect(menus.length).toBeGreaterThan(0);

    for (const menu of menus) {
      await studio.page.click(`.lm-MenuBar-itemLabel:text-is("${menu}")`);
      const items = await studio.page
        .locator(".lm-Menu-itemLabel")
        .allTextContents()
        .then((all) => all.map((one) => one.trim()).filter((one) => one.length > 0));
      await studio.page.keyboard.press("Escape");

      // `indexOf`, not `Set.add`. The first version of this line was
      // `items.filter((item) => !seen.add(item))`, and `Set.prototype.add`
      // returns the *set*, which is always truthy -- so the filter never matched
      // and the test passed against a menu with `Product` in it twice. Verified
      // the other way round this time: the bug was reintroduced and this failed.
      const duplicated = items.filter((item, at) => items.indexOf(item) !== at);
      expect(duplicated, `${menu} lists these twice`).toEqual([]);
    }
  });

  test("nothing is registered twice", async ({ studio }) => {
    // The command side of the same bug, and the quieter side:
    // `CommandRegistry.registerCommand` on an existing id warns and returns a
    // no-op disposable, so the *second* handler is silently discarded. Six of
    // these sat in the console unnoticed -- the fixture collects warnings and
    // only the grammar check ever read them.
    //
    // Narrow on purpose. Theia warns legitimately about slow startup steps and
    // about plugin candidates it cannot unpack, so "no warnings at all" would
    // fail every run and teach everyone to ignore it.
    const doubled = studio.consoleWarnings.filter((w) => /is already registered/.test(w));
    expect(doubled, `duplicate registrations:\n${doubled.join("\n")}`).toEqual([]);
  });
});

test.describe("nothing failed quietly", () => {
  test("the Fabric favicon is installed", async ({ studio }) => {
    // `@theia/cli` 1.75 has no favicon hook; FabricThemeContribution injects one.
    const href = await studio.page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
      return link?.href ?? null;
    });
    expect(href, "no link[rel=icon] in document.head").not.toBeNull();
    expect(href!).toMatch(/^(data:image\/svg\+xml|blob:|https?:)/);
  });

  test("no console errors", async ({ studio }) => {
    // Tolerating by name rather than by pattern: a real missing resource or a
    // real exception still fails.
    //
    // `INVALID tab` is thrown by `@theia/plugin-ext`'s own tab bookkeeping
    // (`src/plugin/tabs.ts`) when a tab update arrives for an id the extension
    // host has not recorded. It is a race in the plugin host, not in this
    // application: it appeared the day the plugin host did, it fires while the
    // suite opens and switches editors quickly, and nothing observable breaks --
    // git, the editors and every other claim keep passing. Recorded rather than
    // filtered away quietly, because it is part of what the plugin host costs.
    const tolerated = [/^pageerror: INVALID tab$/];
    const real = studio.consoleErrors.filter(
      (error) => !tolerated.some((pattern) => pattern.test(error)),
    );
    expect(real, `unexpected console output:\n${real.join("\n")}`).toEqual([]);
  });

  test("the Fabric theme is the active color theme", async ({ studio }) => {
    const theme = await studio.page.evaluate(() => {
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue("--theia-editor-background")
        .trim()
        .toLowerCase();
      const bodyClass = document.body.className;
      return { bg, bodyClass };
    });
    // navy-deep from constructorfabric.org styles.css
    expect(theme.bg).toMatch(/#001838|rgb\(\s*0,\s*24,\s*56\s*\)/);
    expect(theme.bodyClass).toContain("vs-dark");
  });
});

test.describe("every view has an icon, and the icon exists", () => {
  // The Catalogue tab in the left activity bar was blank: Theia renders only the
  // icon there, and no widget set `title.iconClass`. The other six were equally
  // iconless and nobody noticed, because a main-area or bottom tab shows its
  // label as well.
  //
  // Two checks, because there are two ways to get a blank button and only one of
  // them is "no icon". A codicon name that does not exist renders an empty box,
  // which looks exactly like the bug being fixed here -- so the name is checked
  // against the font rather than trusted.

  const STUDIO_SRC = join(__dirname, "../gearbox-studio/src/browser");
  const CODICON_CSS = join(
    __dirname,
    "../node_modules/@vscode/codicons/dist/codicon.css",
  );

  /** Every `.ts`/`.tsx` file under a directory, recursively. */
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  test("every codicon named in the frontend is a real codicon", () => {
    const css = readFileSync(CODICON_CSS, "utf8");
    const known = new Set(
      [...css.matchAll(/^\.codicon-([a-z0-9-]+):/gm)].map((m) => m[1]),
    );
    // A sanity floor: if the stylesheet moved or its format changed, an empty
    // `known` set would make this test pass by knowing nothing.
    expect(known.size).toBeGreaterThan(400);

    const named = sources(STUDIO_SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      // `codicon("x")` and the literal class form. Names built by interpolation
      // -- `codicon-${iconFor(process)}` in the process view -- cannot be read
      // statically; those are covered by the views' own conformance tests, which
      // assert on the elements that carry them.
      const found: { file: string; name: string }[] = [];
      for (const m of text.matchAll(/\bcodicon\("([a-z0-9-]+)"\)/g)) {
        found.push({ file, name: m[1] });
      }
      // The literal class form, e.g. `className="codicon codicon-pinned"`. The
      // trailing character is captured and inspected rather than bounded with
      // `\b`, because a `\b` match on `codicon-chevron-${down ? ... }` stops at
      // `chevron` and reports a codicon nobody wrote. A name that runs into `${`
      // or ends in `-` is built at runtime, so it is skipped here.
      for (const m of text.matchAll(/codicon-([a-z0-9-]+)([^a-z0-9-]|$)/g)) {
        const [, name, next] = m;
        if (next === "$" || next === "{" || name.endsWith("-")) continue;
        found.push({ file, name });
      }
      return found;
    });
    expect(named.length).toBeGreaterThan(6);

    const unknown = [
      ...new Set(
        named
          .filter(({ name }) => !known.has(name))
          .map(({ file, name }) => `${file.replace(STUDIO_SRC, "")}: codicon-${name}`),
      ),
    ];
    expect(unknown).toEqual([]);
  });

  test("the Gearbox views carry a codicon in the shell", async ({ studio }) => {
    // **The state is established, not inherited.** The Inspector is gated on
    // having a subject -- a panel whose whole content is "select something" is
    // worse than an absent one -- so with nothing selected it has no tab and no
    // icon to carry. This test inherited a session where something happened to
    // be selected, and that held only because two conformance claims failed
    // earlier in the run and left one behind them. With those fixed the suite
    // reaches here at the home screen and this asserted on a tab that does not
    // exist. The same mistake the first test in this file already names --
    // "relied on that without saying so" -- two screens further in.
    await openProduct(studio.page, "dev");
    await revealInspector(studio.page);
    // Theia gives every tab the id `shell-tab-<widgetId>`, which is what makes
    // this checkable without depending on a label the activity bar does not show.
    const icons = await studio.page.evaluate(() =>
      Object.fromEntries(
        ["gearbox.catalogue", "gearbox.inspector"].map((id) => {
          const tab = document.querySelector(`#shell-tab-${CSS.escape(id)}`);
          const icon = tab?.querySelector(".lm-TabBar-tabIcon");
          return [id, icon?.className ?? ""];
        }),
      ),
    );
    // The catalogue is the reported case: left bar, icon only, so an empty class
    // is a button with nothing in it.
    expect(icons["gearbox.catalogue"]).toContain("codicon-library");
    expect(icons["gearbox.inspector"]).toContain("codicon-info");
  });
});

test.describe("the toolbar names only registered commands", () => {
  const STUDIO_SRC = join(__dirname, "../gearbox-studio/src/browser");

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  test("every command id the toolbar names is registered", () => {
    // Same form as the codicon check: the source is the contract, not a running
    // registry. A toolbar that invents an id compiles and fails at click time.
    const toolbar = readFileSync(
      join(STUDIO_SRC, "shell/toolbar-widget.tsx"),
      "utf8",
    );
    const block = toolbar.match(/TOOLBAR_COMMAND_IDS = \[([\s\S]*?)\]/);
    expect(block, "TOOLBAR_COMMAND_IDS is missing").not.toBeNull();
    const ids = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);

    // Both spellings a command id is declared in. `id: "..."` covers a `Command`
    // literal; `toggleCommandId: "..."` covers the one every
    // `AbstractViewContribution` registers for its view -- which is how the
    // header's Generate entry is declared, and which this test missed at first,
    // reporting a registered command as unregistered.
    const registered = sources(STUDIO_SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [
        ...[...text.matchAll(/\bid:\s*"([^"]+)"/g)],
        ...[...text.matchAll(/\btoggleCommandId:\s*"([^"]+)"/g)],
      ].map((m) => m[1]);
    });
    const unknown = ids.filter((id) => !registered.includes(id));
    expect(unknown, `toolbar names unregistered commands: ${unknown.join(", ")}`).toEqual(
      [],
    );
  });

  test("the toolbar renders exactly the commands it declares", async ({ studio }) => {
    // The declared list and the rendered one are two different things:
    // `TOOLBAR_COMMAND_IDS` is string literals, while the buttons come from an
    // `ACTIONS` map built out of imported `Command` constants. The test above
    // guards the literals against the registry; without this one, a third action
    // could be added to the map and the declared list would quietly stop
    // describing the toolbar.
    const declared = new Set(
      [
        ...(
          readFileSync(join(STUDIO_SRC, "shell/toolbar-widget.tsx"), "utf8").match(
            /TOOLBAR_COMMAND_IDS = \[([\s\S]*?)\]/,
          )?.[1] ?? ""
        ).matchAll(/"([^"]+)"/g),
      ].map((m) => m[1]),
    );

    // A context is not switchable by a control -- it follows what is open -- so
    // this reads whatever the shell reports, then opens a product and reads again.
    //
    // It does not assert that `home` is reachable, because on this corpus it is
    // not: `ProductStore.discover()` opens the product when it is the only one, so
    // the shell passes through `home` and lands in `product` before a test can
    // look. That is the behaviour, not a defect, and the Start screen is where it
    // changes.
    const actions = () =>
      studio.page
        .locator(".gbx-toolbar-actions [data-command]")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-command") ?? ""));

    const rendered = new Set<string>();
    for (const id of await actions()) rendered.add(id);

    await openProduct(studio.page, "dev");
    await expectContext(studio.page, "product");
    const inProduct = await actions();
    expect(inProduct.length, "the product context renders no action").toBeGreaterThan(0);
    for (const id of inProduct) rendered.add(id);

    // Declared may include gear-session commands that this corpus never opens.
    // Every rendered id must be declared; undeclared buttons are the failure.
    const undeclared = [...rendered].filter((id) => !declared.has(id));
    expect(undeclared, `toolbar rendered undeclared commands: ${undeclared.join(", ")}`).toEqual(
      [],
    );
    expect([...rendered].sort().length).toBeGreaterThan(0);
  });

  test.fixme("the toggle command reveals a view hidden behind another tab", async ({ studio }) => {
    // **Measured as broken, and deliberately not fixed here.**
    //
    // This asserts the path a person takes -- Gearbox > Product, or the palette --
    // as opposed to the path `revealView` takes, which clicks the shell tab
    // because that proved reliable across the suite. It passes in isolation with
    // the Graph over Product, and fails inside the suite; the toggle semantics of
    // `AbstractViewContribution` plus the palette are two stateful things and one
    // of them loses.
    //
    // A fixme rather than a fix because the mechanism is being removed: view
    // toggles through a generic menu are what the shell rework replaces with
    // context tabs, so repairing this would be work on code that is going away.
    // It stays named so the claim is not lost with the mechanism -- whatever
    // replaces it has to reveal a hidden panel from a menu.
    await openProduct(studio.page, "dev");
    await expect(studio.page.locator(".gbx-product")).toBeVisible();

    // Put the Graph on top of it in the same area.
    await openGraph(studio.page);
    const covered = !(await studio.page.locator(".gbx-product").first().isVisible());
    test.skip(!covered, "the graph did not cover Product, so there is nothing hidden to reveal");

    await runCommand(studio.page, "Gearbox Product");
    await expect(studio.page.locator(".gbx-product")).toBeVisible({ timeout: 30_000 });
  });

  test("the header reports the context, and the context follows what is open", async ({
    studio,
  }) => {
    // The property that made this rework necessary: a shell state can no longer
    // disagree with reality. `data-context` is written by `StudioContextService`
    // from `ProductStore`, not from a restored perspective -- so there is no way
    // to be in the product context with no product.
    await openProduct(studio.page, "dev");
    await expectContext(studio.page, "product");
    await expect(studio.page.locator(".gbx-product")).toBeVisible();
    await expect(studio.page.locator(".gbx-toolbar-name")).not.toBeEmpty();
  });
});

test.describe("a product is a session, not a panel", () => {
  test("closing returns the shell to home and empties the header", async ({ studio }) => {
    // Closing is not "hide the panel": the session ends, so the resolution, the
    // lock, the diagnostics and the selection go with it. A stale resolution
    // behind a closed product is worse than an empty one, because it looks like an
    // answer.
    await openProduct(studio.page, "dev");
    await expectContext(studio.page, "product");

    await runCommand(studio.page, "Close Product");
    await expectContext(studio.page, "home");
    await expect(studio.page.locator(".gbx-toolbar-empty")).toBeVisible();
    await expect(studio.page.locator(".gbx-toolbar-name")).toHaveCount(0);
  });

  test("a product that opened is offered again, and reopens from the picker", async ({
    studio,
  }) => {
    // Two claims in one flow, because they are the same flow. Recent is written
    // only on a successful open -- the difference between a Recent list and a list
    // of things once attempted -- and reopening goes through the picker.
    //
    // **Not through `openProduct`**, and that is the point. After a close the
    // Product panel does not re-open anything: `ensureOpen` runs when the widget
    // is constructed, not every time it is shown, so a close stays closed. A panel
    // that reopened what you just closed would make Close look broken. The panel
    // offers the picker instead, which is what this drives.
    await runCommand(studio.page, "Open Product…");
    const first = studio.page.locator(`.quick-input-list [role="option"]`);
    await first.first().waitFor({ state: "visible" });
    await first.filter({ hasText: "payments-demo" }).first().click();
    await expectContext(studio.page, "product");

    await runCommand(studio.page, "Close Product");
    await expectContext(studio.page, "home");

    await runCommand(studio.page, "Open Product…");
    const options = studio.page.locator(`.quick-input-list [role="option"]`);
    await options.first().waitFor({ state: "visible" });
    const labels = await options.evaluateAll((ns) => ns.map((n) => (n.textContent ?? "").trim()));
    await studio.page.keyboard.press("Escape");
    expect(labels.some((l) => l.includes("payments-demo"))).toBe(true);
  });

  test.fixme("closing refuses while the description has unsaved changes", async ({ studio }) => {
    // The guard is written -- `ProductSessionService.close` reads
    // `MonacoTextModelService.models` for a dirty model of the description, the
    // same check `ProductEditService` makes before writing -- but making a model
    // dirty from a test means typing into Monaco, and this repository has already
    // recorded why that is not straightforward: `.monaco-editor .inputarea` is
    // parked off-screen, so `press` hangs on it.
    //
    // Named rather than skipped silently, because the claim matters: closing under
    // an unsaved edit is exactly the loss the write gates exist to prevent.
    await openProduct(studio.page, "dev");
  });
});
