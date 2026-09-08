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

import {
  expect,
  expectContext,
  openProduct,
  paletteOffers,
  revealCatalogue,
  productSection,
  runCommand,
  test,
} from "../fixtures/studio";

const IDE = join(__dirname, "../..");

/**
 * The labels a top-level menu renders, with the menu closed again afterwards.
 *
 * Scoped to the menu that is actually open. Theia keeps hidden `.lm-Menu`
 * templates in the DOM -- hundreds of labels exist before anything is clicked --
 * so an unscoped read describes a menu nobody opened.
 */
async function menuItems(page: import("@playwright/test").Page, name: string): Promise<string[]> {
  await page.locator(".lm-MenuBar-itemLabel", { hasText: new RegExp(`^${name}$`) }).click();
  const open = page.locator(".lm-Menu").locator("visible=true").first();
  await open.waitFor({ state: "visible" });
  const items = (await open.locator(".lm-Menu-itemLabel").allTextContents()).map((t) => t.trim());
  await page.keyboard.press("Escape");
  expect(items.length, `the ${name} menu rendered nothing, so this proved nothing`).toBeGreaterThan(
    0,
  );
  return items;
}

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
    // `Product`, not `Gearbox`: the top level names the person's task rather than
    // the application, which is the point of having contexts at all. It is scoped
    // to the product context, so with nothing open the bar is four entries and
    // never offers verbs for a subject that is not there. A `Gear` menu belongs
    // beside it and is not registered until the gear context exists.
    expect(menus).toEqual(["File", "Edit", "Product", "View", "Help"]);
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
    // **Revealed first, since 2026-09-08.** Home folds all three side panels, so
    // the catalogue is not on screen until something asks for it -- the second
    // claim in this suite to pay that price, after ADR-0009's staged load. What
    // this claim is about is unchanged and is still worth asserting: a row is a
    // laid-out element rather than a node that exists and renders to nothing,
    // which is the failure it was written for.
    await revealCatalogue(studio.page);
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

  test("no terminal is offered, anywhere [ADR-0011 §Amendment: the terminal promise is withdrawn]", async ({
    studio,
  }) => {
    // **The inverse of a claim that used to pass for the wrong reason.**
    //
    // ADR-0011 kept "a live shell in the bottom panel" on purpose, and the claim
    // that checked it asserted a `zsh` tab was *already there* on a fresh shell.
    // That was true because Theia's contribution opened one from
    // `initializeLayout`; nothing ever exercised *creating* one. With the boot
    // terminal suppressed the real claim became testable and failed:
    // `Terminal: Create New Terminal` creates nothing, by command and by
    // keybinding, silently. Measured against a build without the suppression (the
    // boot terminal returns, creating still does nothing) and against `node-pty`
    // (present, and the boot terminal did attach a pty), so it is neither a
    // regression from the suppression nor a broken install.
    //
    // The ADR's amendment withdraws the promise, and this asserts the withdrawal
    // rather than deleting the claim: an absence nobody checks is an absence that
    // comes back on the next upgrade.
    const bottom = await studio.page.evaluate(() =>
      Array.from(
        document.querySelectorAll("#theia-bottom-content-panel .lm-TabBar-tabLabel"),
      ).map((e) => (e.textContent ?? "").trim()),
    );
    expect(bottom.some((label) => /zsh|bash|terminal/i.test(label))).toBe(false);
    expect(await studio.page.locator(".xterm").count()).toBe(0);

    // And not one keystroke away either. The palette reads
    // `CommandRegistry.getAllCommands()`, so a command still registered is a
    // command still offered -- which is why the policy unregisters them rather
    // than only removing their menu entries.
    const offered = await paletteOffers(studio.page, "Terminal");
    expect(offered.filter((label) => /^Terminal:/.test(label))).toEqual([]);
  });

  test("the command palette offers nothing from a forbidden family [ADR-0011 §Decision Outcome: unregister what remains]", async ({
    studio,
  }) => {
    // The half of the strategy that was claimed and not done. `ShellPolicy` removed
    // forbidden commands from every *menu*, and its own header said the palette and
    // any saved keybinding went with them -- but the palette does not read menus, it
    // reads `CommandRegistry.getAllCommands()`. So every suppressed view was one
    // `Ctrl+Shift+P` away, and the assertion that only looked at the View menu could
    // not tell.
    //
    // Queried by family rather than in one search, because the palette's fuzzy
    // matcher will happily match a word inside an unrelated label.
    for (const family of ["Type Hierarchy", "Call Hierarchy", "Debug:", "Notebook"]) {
      const offered = await paletteOffers(studio.page, family);
      expect(
        offered.filter((label) => label.toLowerCase().startsWith(family.toLowerCase())),
        `the palette still offers ${family}`,
      ).toEqual([]);
    }
  });

  test("the Explorer and git are one level down, under Advanced Tools [ADR-0011 §Consequences: some Theia surface stays on purpose]", async ({
    studio,
  }) => {
    // Kept, and demoted. They are tools rather than one of the two things this
    // application is about, so they stop competing with the domain's own views in a
    // flat `View` list -- which is the arrangement that made this read as a general
    // editor with Gearbox panels bolted on.
    await studio.page.locator(".lm-MenuBar-itemLabel", { hasText: /^View$/ }).click();
    const submenu = studio.page.locator(".lm-Menu-itemLabel", { hasText: "Advanced Tools" });
    await expect(submenu).toBeVisible();

    // The **child** menu, not every `.lm-Menu` on screen. Hovering a submenu leaves
    // the parent open beside it, so reading all of them returns View's own items --
    // which is what the first version of this did, and it reported "Explorer is
    // missing" while Explorer was sitting one menu to the right.
    await submenu.hover();
    const menus = studio.page.locator(".lm-Menu");
    await expect(menus).toHaveCount(2);
    const items = (await menus.last().locator(".lm-Menu-itemLabel").allInnerTexts()).map((text) =>
      text.trim(),
    );
    // All six, because the submenu is now where the window's own controls live as
    // well as the file tools -- and because a relocation that dropped one would look
    // exactly like a relocation that worked.
    for (const tool of [
      "Explorer",
      "Search",
      "Source Control",
      "Output",
      "Appearance",
      "Editor Layout",
    ]) {
      expect(items, `${tool} is not under Advanced Tools`).toContain(tool);
    }
    await studio.page.keyboard.press("Escape");
    await studio.page.keyboard.press("Escape");
  });

  test("File offers the product's verbs and nothing about a workspace [ADR-0011 §Amendment: File is the product's]", async ({
    studio,
  }) => {
    // `File` came with the shell's other half: New Text File, New Window, Open
    // Folder, Open Workspace, Open Recent Workspace, Save All, Auto Save, Close
    // Workspace. Most of that is noise, but the workspace entries are worse than
    // noise -- the Theia workspace is an internal set of source roots that
    // `ProductSessionService` owns, so a menu offering to change it offers to move
    // the ground the open product stands on, behind the session's back.
    //
    // What a person opens here is a product. `Save` stays because a description is
    // edited in the editor and the write gate refuses an unsaved buffer; without it
    // that refusal is a dead end.
    const items = await menuItems(studio.page, "File");
    expect(items).toContain("Open Product…");
    expect(items).toContain("Save");

    const offenders = items.filter((item) =>
      /Workspace|Folder|New (Text )?File|New Window|Save All|Auto Save|Save As/i.test(item),
    );
    expect(offenders, "File still offers a general editor's verbs").toEqual([]);
  });

  test("the first level of View is the domain's [ADR-0011 §Amendment: View is the domain's]", async ({
    studio,
  }) => {
    // Everything a person opens *about the product* at the top, everything about the
    // window one level down. The tools are asserted present under Advanced Tools by
    // the claim above; this one asserts they are not *also* at the top, which is the
    // half that makes the menu shorter rather than merely differently arranged.
    //
    // **Counting `Gearbox*` entries is not what this asserts any more.** It used to
    // require more than four of them with no product open, which was a claim about
    // the wrong thing: the domain's views are now scoped, so on Home the ones that
    // act on a product are correctly absent. What survives here is the part the
    // amendment is actually about -- the window's own views are one level down --
    // and the scoping is the claim below.
    const items = (await menuItems(studio.page, "View")).filter((item) => item.length > 0);
    expect(items).toContain("Command Palette...");
    expect(items).toContain("Advanced Tools");
    expect(items.filter((item) => item.startsWith("Gearbox")).length).toBeGreaterThan(0);

    const offenders = items.filter((item) =>
      /Appearance|Editor Layout|Explorer|Source Control|Output|Plugins|Timeline|Outline|Testing|Notebook/.test(
        item,
      ),
    );
    expect(offenders, "View's first level still holds a general editor's views").toEqual([]);
  });

  test("View offers a product's views only with a product [ADR-0011 §Amendment: a screen belongs to a subject]", async ({
    studio,
  }) => {
    // The other half of "the shell must not allow impossible states", read where a
    // UX pass found it: `View > Add Gear` was live on Home and opened an empty
    // panel. `AbstractViewContribution` registers an ungated toggle per view, so
    // the gate has to be added rather than assumed.
    //
    // Asserted in both directions, because the half that is easy to get right by
    // accident is the absence: a typo in a widget id would hide these from *both*
    // contexts and the one-sided claim would still pass.
    // Open first and close second, which is the order the Product-menu claim above
    // uses and for the same reason: `studio` is worker-scoped, so whatever ran
    // before decides what is open. Reading Home first would be reading a state
    // this test did not establish -- it passed alone and failed in the suite,
    // which is the shape of every claim that trusts an inherited session.
    const PRODUCTS = ["Add Gear", "Resolution Lock", "Gearbox Conflicts", "Gearbox Generate"];

    await openProduct(studio.page, "dev");
    await expectContext(studio.page, "product");
    const withProduct = (await menuItems(studio.page, "View")).filter((item) => item.length > 0);
    for (const name of PRODUCTS) {
      expect(
        withProduct.some((item) => item.includes(name)),
        `View does not offer ${name} with a product open`,
      ).toBe(true);
    }

    // Through the header's own button rather than the palette: it is what a
    // person clicks, and it is on screen already.
    await studio.page.locator('[data-command="gearbox.product.close"]').click();
    await expectContext(studio.page, "home");
    const onHome = (await menuItems(studio.page, "View")).filter((item) => item.length > 0);
    expect(
      onHome.filter((item) => PRODUCTS.some((name) => item.includes(name))),
      "View offers a product's views with no product open",
    ).toEqual([]);
  });

  test("the Plugins view is gone from the shell [ADR-0011 §Amendment: the plugin host is not a view]", async ({
    studio,
  }) => {
    // The plugin host stays -- git runs on it -- and its shop window goes. It never
    // opened itself, so anyone who had it in the left bar had it from a saved
    // layout, which is what `LayoutMigration` is for.
    //
    // Three surfaces, because two were not enough the last three times: the left
    // bar, the palette, and `Open View…` -- which reads neither menus nor commands
    // but `QuickViewService`, and would have kept offering it after the other two
    // were clean.
    const tabs = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll("#theia-left-content-panel .lm-TabBar li")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(tabs.filter((tab) => /Plugins/.test(tab))).toEqual([]);
    expect(await paletteOffers(studio.page, "Plugins")).toEqual([]);

    await runCommand(studio.page, "Open View...");
    const offered = (await studio.page.locator('.quick-input-list [role="option"]').allInnerTexts())
      .map((text) => text.split("\n")[0]?.trim() ?? "");
    await studio.page.keyboard.press("Escape");
    expect(offered.filter((label) => /Plugins/.test(label))).toEqual([]);
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

  test("the Product menu offers the product's verbs, and only with a product [ADR-0011 §Scope: what the menu bar contains]", async ({
    studio,
  }) => {
    // Was "the Gearbox menu offers the domain's commands". Two things changed and
    // both are the point of the rework: the menu is named after the **task** rather
    // than after the application, and it is scoped -- with nothing open there is no
    // Product menu at all, so the top level never offers verbs for a subject that
    // is not there.
    //
    // Read from the menu that is open, because Theia keeps hidden `.lm-Menu`
    // templates in the DOM and an unscoped read describes a menu nobody opened.
    await openProduct(studio.page, "dev");
    await expectContext(studio.page, "product");

    await studio.page.locator(".lm-MenuBar-itemLabel", { hasText: /^Product$/ }).click();
    const open = studio.page.locator(".lm-Menu").locator("visible=true").first();
    await open.waitFor({ state: "visible" });
    const items = (await open.locator(".lm-Menu-itemLabel").allTextContents()).map((t) => t.trim());
    await studio.page.keyboard.press("Escape");

    // The verbs, not the panels: what a person does to a product.
    expect(items).toContain("Resolve Product");
    expect(items.length, "the Product menu rendered nothing").toBeGreaterThan(1);

    // **And the second half of the title, which nothing used to assert.** A UX
    // pass found the Product menu in the bar with no product open, offering
    // Conflicts, Lock and Generate as though they had a subject -- so the claim
    // read as green while describing something untrue. Closing the product is the
    // only way to observe it, which is why it happens here rather than in a test
    // of its own: the shared session would have to open one again anyway.
    //
    // Through the header's own button rather than the palette: it is what a
    // person clicks, and it is on screen already.
    await studio.page.locator('[data-command="gearbox.product.close"]').click();
    await expectContext(studio.page, "home");

    // **Disabled, not absent, and that is Theia's answer rather than ours.**
    // Every entry under this submenu is `when`-gated on the product context, and
    // a submenu whose items are all invisible renders as an unopenable label
    // (`aria-disabled="true"`) rather than disappearing. What the claim is about
    // is that the bar never offers verbs for a subject that is not there, and a
    // label that cannot be opened does not.
    //
    // Worth knowing why this needed work at all: the menu bar is rebuilt on a
    // preference, keybinding or *menu model* change and **not** on a context-key
    // change (`browser-menu-plugin.js:45-54`), so the label's state was decided
    // once and then went stale in whichever direction the session started from.
    // `ShellPolicy` now touches the registry when the context changes.
    const item = studio.page
      .locator(".lm-MenuBar-item", {
        has: studio.page.locator(".lm-MenuBar-itemLabel", { hasText: /^Product$/ }),
      })
      .first();
    await expect(item).toHaveAttribute("aria-disabled", "true");
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
    // The Gears stage: the panel is `Overview · Gears · Topology · Validation`.
    await productSection(studio.page, "gears");
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
  test("a screen composed for one product does not survive another [ADR-0011 §Amendment: a screen belongs to a subject]", async () => {
    // **The dangerous half of the finding, and the half with no visible symptom.**
    // Scoping by context *kind* would have closed the empty-tab complaint and left
    // this: open a second product and the kind is still `product`, so nothing is
    // withdrawn -- while `ProductEditService.commitAddGear` resolves its target
    // from whatever is open at commit time. A proposal staged against the first
    // product is then written to the second.
    //
    // **Asserted against the module rather than through the shell, and that is a
    // limitation worth stating.** The corpus has one product
    // (`products/payments-demo`), so a browser claim cannot reach the transition
    // at all; the rule lives in `outOfScope`, which is a pure function precisely
    // so that it can be read here. A second product in the corpus would let this
    // become a behavioural claim, and it should when there is one.
    //
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const screens = require(join(IDE, "gearbox-studio/lib/browser/shell/screens"));
    const a = "product:file:///a/product.gdl";
    const b = "product:file:///b/product.gdl";

    const moved: string[] = screens.outOfScope(a, b);
    for (const id of ["gearbox.add-gear", "gearbox.product", "gearbox.generate", "gearbox.lock"]) {
      expect(moved, `${id} survives a change of product`).toContain(id);
    }

    // **The Graph is deliberately not in that list.** It is the one screen that
    // is valid with no product -- its co-location view reads the catalogue --
    // so withdrawing it on a change of subject destroys a screen the new context
    // can hold, and destroys it mid-interaction. Its per-product state is
    // cleared by the widget instead; the claim here is that the table says so.
    expect(moved, "the Graph is withdrawn rather than cleared").not.toContain("gearbox.graph");

    // The other direction, which is what stops the rule being "close everything
    // always": re-resolving the same product is not a change of subject, and a
    // configurator must not be swept out from under someone mid-edit.
    expect(screens.outOfScope(a, a), "a screen is withdrawn from its own subject").not.toContain(
      "gearbox.add-gear",
    );

    // And the identity is canonical, so two spellings of one path are one
    // subject -- otherwise every reconcile would withdraw a product's screens
    // from the product they belong to.
    const idOf = (path: string): string =>
      screens.identityOf({ kind: "product", product: { path, label: "x" } });
    expect(idOf("/a/./b/product.gdl")).toBe(idOf("/a/b/product.gdl"));
  });

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
