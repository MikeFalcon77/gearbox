// ADR cpt-gearbox-adr-domain-specific-ide-shell.
//
// The ADR's own Confirmation section is unusually specific about *how* to check
// its claims -- "the UI check asserts what a person sees, not what was
// registered" -- so most of this file is that section made executable. Its final
// bullet is the reason the removals are asserted absent rather than merely
// removed once: Selection comes from `@theia/monaco` and Go from `@theia/editor`,
// packages the editor needs, so a Theia upgrade that re-registers either would
// restore them silently.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, expectContext, openProduct, test } from "../fixtures/studio";

const IDE = join(__dirname, "../..");

test.describe("the narrowed shell", () => {
  test("the menu bar is the domain's, not a general editor's [ADR-0011 §Confirmation]", async ({
    studio,
  }) => {
    const menus = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll(".lm-MenuBar-itemLabel, .p-MenuBar-itemLabel")).map(
        (e) => (e.textContent ?? "").trim(),
      ),
    );
    // **Exactly the declared set, in order.** This is the assertion that turns a
    // whitelist into a fact: `ShellPolicy.ALLOWED_TOP_LEVEL` names five menus, and
    // anything a Theia upgrade or a transitive package adds shows up here as a
    // failure rather than as a menu nobody chose.
    //
    // Terminal used to be in this list, argued for as "a person wants a shell to
    // build a generated crate in". The shell is still there -- ADR-0011 keeps the
    // editor stack on purpose -- but a terminal is a tool, not one of the two
    // things this application is about, so it stops competing with `Product` for
    // the menu bar. Its commands are kept; see `KEPT_COMMAND_PREFIXES`.
    expect(menus).toEqual(["File", "Edit", "Gearbox", "View", "Help"]);
  });

  test("the View menu offers nothing from a language IDE [ADR-0011 §Confirmation: a removed entry must be asserted absent]", async ({
    studio,
  }) => {
    // The surface a menu-bar prune cannot reach on its own. `View` is where the
    // toggles for Debug, Testing, the two hierarchies, Notebook and Outline land,
    // all of them arriving with `@theia/plugin-ext` rather than by choice -- and a
    // toggle is not cosmetic: it is one entry in the palette and one saved
    // keybinding away from opening a panel this application has no use for.
    //
    // Read from the rendered menu, because that is what a person sees. The
    // source-level half -- that the families are declared forbidden rather than
    // forgotten -- is asserted in `regression.spec.ts`.
    // Scoped to the menu that is actually open. Theia keeps hidden `.lm-Menu`
    // templates in the DOM -- 241 of these labels exist before anything is
    // clicked -- so an unscoped read describes a menu nobody opened.
    await studio.page.locator(".lm-MenuBar-itemLabel", { hasText: /^View$/ }).click();
    const open = studio.page.locator(".lm-Menu").locator("visible=true").first();
    await open.waitFor({ state: "visible" });
    const items = (await open.locator(".lm-Menu-itemLabel").allTextContents()).map((t) => t.trim());
    await studio.page.keyboard.press("Escape");

    expect(items.length, "the View menu rendered nothing, so this proved nothing").toBeGreaterThan(
      0,
    );
    const offenders = items.filter((item) =>
      /Debug|Testing|Call Hierarchy|Type Hierarchy|Notebook/.test(item),
    );
    expect(offenders).toEqual([]);
  });

  test("Selection is absent [ADR-0011 §Confirmation: a removed entry must be asserted absent]", async ({
    studio,
  }) => {
    const menus = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll(".lm-MenuBar-itemLabel")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(menus).not.toContain("Selection");
  });

  test("Go is absent [ADR-0011 §Confirmation: a removed entry must be asserted absent]", async ({
    studio,
  }) => {
    const menus = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll(".lm-MenuBar-itemLabel")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(menus).not.toContain("Go");
  });

  test("Run is absent [ADR-0011 §Confirmation: a removed entry must be asserted absent]", async ({
    studio,
  }) => {
    // `@theia/debug` registers `[...MAIN_MENU_BAR, '6_debug']`, which the bar
    // labels "Run". It is not a dependency this application picked: it arrives
    // with `@theia/plugin-ext`, which needs it for the VS Code debug API. So the
    // package stays and the menu goes -- the trade ADR 0011 describes for a
    // package kept only because something else needs it.
    const menus = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll(".lm-MenuBar-itemLabel")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(menus).not.toContain("Run");
  });

  test("the Debug and Testing views do not open themselves [ADR-0011 §initializeLayout NOOP]", async ({
    studio,
  }) => {
    // Hidden, not removed. `initializeLayout(): NOOP` keeps the package, the
    // command and the keybinding, so the view is one command away and a saved
    // layout is respected. Asserting on the *tabs* rather than on the DOM,
    // because a hidden-by-closing panel would still have its widget attached --
    // which is the failure this application already made once.
    const tabs = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll(".lm-TabBar li")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(tabs).not.toContain("Debug");
    expect(tabs).not.toContain("Testing");
  });

  test("a catalogue row has a client rectangle [ADR-0011 §Confirmation]", async ({ studio }) => {
    const visible = await studio.page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".gearbox-catalogue .gbx-row"));
      return {
        total: rows.length,
        withRect: rows.filter((r) => (r as HTMLElement).getClientRects().length > 0).length,
      };
    });
    expect(visible.total).toBeGreaterThan(0);
    // A collapsed panel keeps its widget in the DOM, so "the node exists" is a
    // silent success. This is the assertion that fails on a blank screen.
    expect(visible.withRect).toBe(visible.total);
  });

  test("Explorer stays visible [ADR-0011 §Consequences: some Theia surface stays on purpose]", async ({
    studio,
  }) => {
    const tabs = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll("#theia-left-content-panel .lm-TabBar li")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(tabs).toContain("Explorer");
    expect(tabs).toContain("Gearbox Catalogue");
  });

  test("a terminal opens [ADR-0011 §Consequences: some Theia surface stays on purpose]", async ({
    studio,
  }) => {
    // "The workflow ends in generated crates a person will want to build, inspect
    // and diff." A live shell in the bottom panel is that, and `@theia/terminal`
    // needs `node-pty`'s native binary on the backend -- so this failing is as
    // likely to mean a broken install as a broken shell.
    const tabs = await studio.page.evaluate(() =>
      Array.from(
        document.querySelectorAll("#theia-bottom-content-panel .lm-TabBar-tabLabel"),
      ).map((e) => (e.textContent ?? "").trim()),
    );
    // Named for the shell it started, not "Terminal": Theia labels the tab with
    // `$SHELL`. Problems grows a `(N)` badge, and Product's map adds Explain,
    // so the third tab is whatever is left after those, not a string-equal
    // against the unbadged names.
    const chrome = (tab: string) =>
      /^(Problems|Gearbox Gear|Gearbox Explain)(\s+\(\d+\))?$/.test(tab);
    const shell = tabs.find((tab) => !chrome(tab));
    expect(shell, `only found ${tabs.join(", ")}`).toBeTruthy();

    // Activated first: the xterm canvas is created when the tab becomes current,
    // so checking for it on an inactive tab tests the wrong thing -- the tab
    // existing proves the contribution ran, not that a pty is attached.
    await studio.page.click(
      `#theia-bottom-content-panel .lm-TabBar-tabLabel:text-is("${shell ?? ""}")`,
    );
    await expect(studio.page.locator(".xterm").first()).toBeVisible();
  });

  test("the Source Control view is present [ADR-0011 §Consequences: some Theia surface stays on purpose]", async ({
    studio,
  }) => {
    const tabs = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll("#theia-left-content-panel .lm-TabBar li")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(tabs).toContain("Source Control");
  });

  test("the Gearbox menu offers the domain's commands [ADR-0011 §Scope: what the menu bar contains]", async ({
    studio,
  }) => {
    // `menus.ts` declared three submenu paths -- Inspect, Resolve, Engine -- long
    // before anything registered into them, so the bar carried a "Gearbox" label
    // over an empty dropdown. Theia 1.75 renders an empty submenu, which is how
    // that was visible rather than merely latent.
    await studio.page.click(".lm-MenuBar-itemLabel:text('Gearbox')");
    const items = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll(".lm-Menu-itemLabel")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(items).toContain("Catalogue");
    expect(items).toContain("Product");
    await studio.page.keyboard.press("Escape");
  });

  test("the header names what is being worked on [ADR-0011 §The two contexts]", async ({
    studio,
  }) => {
    // Was "the toolbar hosts the perspective switch". The switch is gone: its two
    // buttons repeated two Gearbox menu entries while meaning something else, and
    // ADR-0011's own revisit clause asked for the collapse. What a header should
    // carry is current state -- the distinction Arduino draws by putting the
    // selected board in both its toolbar and its menu -- so the claim is now about
    // the subject, not about navigation.
    await expect(studio.page.locator(".gbx-toolbar")).toBeVisible();
    await openProduct(studio.page, "dev");
    await expect(studio.page.locator(".gbx-toolbar-name")).not.toBeEmpty();
    await expect(studio.page.locator("[data-header-profile]")).toBeVisible();
  });

  test("a product context exists, and only with a product [ADR-0011 §The two contexts]", async ({
    studio,
  }) => {
    // Was "a product perspective exists beside the catalogue". Beside is wrong:
    // the catalogue is a source of components, not a peer mode. And "exists" was
    // too weak -- a perspective restored from a snapshot exists with nothing
    // behind it, which is the defect this rework removes. The claim is that the
    // context cannot disagree with what is open.
    await openProduct(studio.page, "dev");
    await expectContext(studio.page, "product");
    await expect(studio.page.locator(".gbx-product")).toBeVisible();

    // Explorer is kept on purpose and must survive the layout change, not be a
    // casualty of `detachStrayWidgets`.
    const left = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll("#theia-left-content-panel .lm-TabBar li")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(left).toContain("Explorer");
  });
});

test.describe("the editor Studio came for", () => {
  test("a clicked link opens the file [ADR-0011 §Confirmation: a clicked link must open a tab]", async ({
    studio,
  }) => {
    // Asserting that an `<a>` exists proves nothing, and this is the check whose
    // absence is why the links shipped dead: the original rendered perfectly and
    // resolved to a URI with no scheme, and the rejection went into an empty
    // catch. So the assertion has to be that a *tab opens*.
    await studio.detailOf("API Gateway");
    const before = await studio.page.locator(".lm-TabBar-tabLabel").count();
    await studio.page.locator(".gbx-links a", { hasText: "gear.gdl" }).first().click();

    const opened = await studio.page.evaluate(async (previous) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const labels = Array.from(document.querySelectorAll(".lm-TabBar-tabLabel")).map((t) =>
          (t.textContent ?? "").trim(),
        );
        if (labels.some((l) => l.includes("gear.gdl"))) return { ok: true, labels };
        // A failure now surfaces as a notification instead of silence.
        const toast = document.querySelector(".theia-notification-message span");
        if (toast) return { ok: false, error: (toast.textContent ?? "").trim() };
        if (labels.length > previous) return { ok: true, labels };
      }
      return { ok: false, error: "nothing happened within 6s" };
    }, before);

    expect(opened.ok, opened.error ?? "no tab and no error -- a silent failure").toBe(true);
  });

  test("a gear in the Product view opens its description [ADR-0011 §Confirmation: a clicked link must open a tab]", async ({
    studio,
  }) => {
    // The Product view had no links at all: the gear ids were `<code>` elements
    // that only moved the Explain focus, while the stylesheet gave them a pointer
    // cursor and a hover underline. So they promised navigation and delivered
    // nothing visible unless Explain happened to be open.
    //
    // Asserted by a tab opening, not by an `<a>` existing -- the same reason the
    // catalogue's link test is written that way, and the reason those links once
    // shipped dead.
    await openProduct(studio.page, "dev");
    const link = studio.page.locator('[data-asked-for="api-gateway"] a').first();
    await expect(link).toBeVisible();
    await link.click();

    await expect(
      studio.page.locator("#theia-main-content-panel .lm-TabBar-tabLabel", {
        hasText: "gear.gdl",
      }).first(),
    ).toBeVisible();
  });

  test("the Product view opens its own description [ADR-0011 §Confirmation: a clicked link must open a tab]", async ({
    studio,
  }) => {
    // The panel is about one product and had no way to open it. The path arrives
    // absolute from `listProducts`, which is why `RevealService` grew a
    // separate opener rather than reusing the catalogue-relative one.
    await openProduct(studio.page, "dev");
    const link = studio.page.locator(".gbx-product .gbx-links a").first();
    await expect(link).toBeVisible();
    await link.click();

    await expect(
      studio.page.locator("#theia-main-content-panel .lm-TabBar-tabLabel", {
        hasText: "product.gdl",
      }).first(),
    ).toBeVisible();
  });

  test("the .gdl editor is tokenized, not plaintext [ADR-0011 §Confirmation]", async ({
    studio,
  }) => {
    const tokens = await studio.page.evaluate(async () => {
      let last = { editor: false, spans: 0, classes: 0, comment: "", string: "" };
      // A plaintext Monaco model still wraps every line in `<span class="mtk1">`,
      // so "spans exist" would have passed with no grammar registered at all --
      // which is precisely the state this feature fixed. The exit condition
      // therefore cannot be "more than one class exists": a plaintext model
      // already renders several, which is how the first version of this check
      // passed against an untokenized editor. It has to be the assertion itself.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // Visible, not merely attached: Theia keeps a background editor in the
        // DOM, and only rendered lines are tokenized.
        const editor = Array.from(document.querySelectorAll(".monaco-editor")).find(
          (e) => (e as HTMLElement).getClientRects().length > 0,
        );
        const spans = editor
          ? Array.from(editor.querySelectorAll('.view-lines .view-line span[class^="mtk"]'))
          : [];
        const startsWith = (c: string) =>
          spans.find((sp) => (sp.textContent ?? "").trimStart().startsWith(c))?.className ?? "";
        last = {
          editor: Boolean(editor),
          spans: spans.length,
          classes: new Set(spans.map((sp) => sp.className)).size,
          comment: startsWith("#"),
          string: startsWith('"'),
        };
        if (last.classes >= 4 && last.comment && last.string && last.comment !== last.string) {
          return last;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return last;
    });

    expect(tokens.editor).toBe(true);
    expect(tokens.classes, `${tokens.classes} token classes over ${tokens.spans} spans`)
      .toBeGreaterThanOrEqual(4);
    // Content-agnostic on purpose: gear.gdl lives in a sibling repo and its first
    // screen is not ours to pin.
    expect(tokens.comment).toBeTruthy();
    expect(tokens.string).toBeTruthy();
    expect(tokens.comment).not.toBe(tokens.string);
  });

  test("no grammar failed to load [ADR-0011 §the .gdl grammar is native]", async ({ studio }) => {
    // A grammar that fails to load is a `logger.warn` inside
    // MonacoTextmateService, never an error, and the editor then falls back to
    // plaintext silently -- so without this the tokenization test above could
    // pass on a stale render while the grammar was in fact broken.
    const grammar = studio.consoleWarnings.filter((w) => /grammar/i.test(w));
    expect(grammar).toEqual([]);
  });
});

// Two claims about the shape of the code rather than about what it renders. They
// are here, in the ADR's own file, because that is where the claim lives.
test.describe("structural claims", () => {
  test("exactly one @theia/core is installed [ADR-0011 §Confirmation]", () => {
    // A transitive `^` pulls a second copy, which breaks inversify identity --
    // the most common Theia build failure, and one that produces a runtime
    // mystery rather than a build error. Read from the lockfile rather than
    // shelling out to `npm ls`, so the check is deterministic and offline.
    const lock = JSON.parse(readFileSync(join(IDE, "package-lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    const copies = Object.keys(lock.packages).filter((p) => p.endsWith("node_modules/@theia/core"));
    expect(copies).toEqual(["node_modules/@theia/core"]);
  });

  test("a contribution base class binds five contribution interfaces at once [ADR-0011 §Consequences]", () => {
    // "A contribution base class comes first [...] Without it, each feature costs
    // six lines of boilerplate in a shared module, which is how that module
    // becomes unreviewable."
    const source = readFileSync(
      join(IDE, "gearbox-studio/src/browser/contribution.ts"),
      "utf8",
    );
    const bound = [
      "CommandContribution",
      "MenuContribution",
      "KeybindingContribution",
      "TabBarToolbarContribution",
      "FrontendApplicationContribution",
    ].filter((id) => source.includes(`bind(${id}).toService(identifier)`));
    expect(bound).toHaveLength(5);
    // `Contribution.configure` is a function in a namespace beside the class,
    // not a static member -- the ADR says "binds them in one line", not where
    // the one line lives.
    expect(source).toContain("export function configure(");
  });
});
