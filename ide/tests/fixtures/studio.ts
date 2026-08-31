// The two ways this suite opens the application, and why there are two.
//
// Most conformance tests only read what the projection produced, so they can
// share one loaded application: `studio` is worker-scoped and boots once.
// The staged-loading tests cannot -- they have to watch a load happen -- so
// `freshStudio` is test-scoped and gets its own context.
//
// The split is not only about speed. Theia persists its layout, and
// `initializeLayout` runs *only* when there is no saved layout
// (`view-contributions.ts` explains why that is the right behaviour). Playwright
// gives every context an empty localStorage, so the panels open as designed --
// which means this suite depends on never setting `storageState` or otherwise
// reusing a profile. Reusing one would collapse the panels and fail half the
// claims here for a reason that has nothing to do with the claims.

import { join } from "node:path";

import { expect, test as base, type Browser, type Locator, type Page } from "@playwright/test";

/** One sample of the catalogue's DOM, taken while a load is in flight. */
export interface Sample {
  t: number;
  rows: number;
  /**
   * Visible, not merely attached. A collapsed Theia side panel keeps its widget
   * in the DOM, so counting nodes says nothing about what a person sees -- this
   * distinction is what let an earlier version of this check pass against a
   * blank screen.
   */
  visibleRows: number;
  pending: number;
  badges: number;
  /** Ids inside rows only: `.gbx-id` is also the class on a diagnostic code. */
  rowIds: number;
  groups: string[];
  names: string[];
  /** Rows showing "parsing…" or "did not project". */
  waiting: number;
}

export interface Studio {
  page: Page;
  /** Console errors, with the failing URL appended -- see below. */
  consoleErrors: string[];
  /**
   * Console warnings, collected because of exactly one of them: a TextMate
   * grammar that fails to load is a `logger.warn` inside MonacoTextmateService,
   * never an error. Without this the editor falls back to plaintext silently and
   * every other check still passes.
   */
  consoleWarnings: string[];
  /** Every sample taken since before the document had scripts. */
  timeline(): Promise<Sample[]>;
  /** Select a row whose name contains `name`; resolve with the detail text. */
  detailOf(name: string): Promise<string | null>;
  /**
   * The detail panel read as labelled rows rather than as one string.
   *
   * Needed because `textContent` concatenates sibling `div`s with nothing
   * between them: the host gear's panel reads
   * `...selects vendor constructorfabricGTS types...`, and a regex over that
   * picks up the next row's first word. The `<code>` runs are kept separately
   * because that is where a projected identifier lives.
   */
  factsOf(name: string): Promise<Record<string, Fact> | null>;
}

/** One labelled row of the Gear detail panel. */
export interface Fact {
  text: string;
  codes: string[];
}

const SAMPLE_MS = 25;

/**
 * Installed with `addInitScript`, so it starts sampling before Theia's own
 * scripts run.
 *
 * In-page rather than driven from the test: the claim under test is that a row
 * is useful *before* it is complete, and a driver-side poll adds a round trip to
 * every sample. A snapshot taken after the load would pass even if the whole
 * tree had appeared at once, which is the failure this exists to rule out.
 */
function installSampler(): void {
  const samples: unknown[] = [];
  (window as unknown as { __gbxSamples: unknown[] }).__gbxSamples = samples;
  // Scoped to the catalogue widget. `.gbx-row` is shared with the Product view's
  // process and binding rows on purpose -- they are the same kind of thing and
  // should look alike -- which means an unscoped count silently mixes the two.
  // That is not hypothetical: a diagnostics test started passing because the
  // Product panel had rendered a diagnostic the catalogue never produced.
  const q = (sel: string): Element[] =>
    Array.from(document.querySelectorAll(`.gearbox-catalogue ${sel}`));
  const text = (e: Element): string => (e.textContent ?? "").trim();
  setInterval(() => {
    const rows = q(".gbx-row");
    samples.push({
      t: Date.now(),
      rows: rows.length,
      visibleRows: rows.filter((r) => (r as HTMLElement).getClientRects().length > 0).length,
      pending: q(".gbx-row.gbx-pending").length,
      badges: q(".gbx-badge").length,
      rowIds: q(".gbx-row .gbx-id").length,
      groups: q(".gbx-group-label").map(text),
      names: q(".gbx-row-name").map(text),
      waiting: q(".gbx-row .gbx-waiting").length,
    });
  }, 25);
}

async function open(browser: Browser): Promise<{ studio: Studio; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      // The URL of a failed request lives in `location()`, not in `text()`: the
      // text is only "Failed to load resource: ... 404". Without the URL there
      // is no way to tell a missing favicon from a missing bundle.
      const url = message.location()?.url ?? "";
      consoleErrors.push(url ? `${message.text()} [${url}]` : message.text());
    }
    if (message.type() === "warning") consoleWarnings.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.addInitScript(installSampler);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const studio: Studio = {
    page,
    consoleErrors,
    consoleWarnings,
    timeline: () =>
      page.evaluate(
        () => (window as unknown as { __gbxSamples?: Sample[] }).__gbxSamples ?? [],
      ) as Promise<Sample[]>,
    detailOf: async (name: string) => {
      await resetCatalogueView(page);
      await revealDetail(page);
      return page.evaluate(async (wanted) => {
        const row = Array.from(
          document.querySelectorAll(".gearbox-catalogue .gbx-row"),
        ).find((r) =>
          r.querySelector(".gbx-row-name")?.textContent?.includes(wanted),
        );
        if (!row) return null;
        (row as HTMLElement).click();
        // The detail widget renders on the store's change event, so poll for the
        // gear's own name to appear rather than sleeping a guessed interval.
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const text = document.querySelector(".gbx-detail")?.textContent ?? "";
          if (text.includes(wanted)) return text.replace(/\s+/g, " ").trim();
          await new Promise((r) => setTimeout(r, 50));
        }
        return (document.querySelector(".gbx-detail")?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
      }, name);
    },
    factsOf: async (name: string) => {
      const found = await studio.detailOf(name);
      if (found === null) return null;
      return page.evaluate(() => {
        const out: Record<string, { text: string; codes: string[] }> = {};
        for (const row of Array.from(document.querySelectorAll(".gbx-detail .gbx-kv"))) {
          const spans = row.children;
          const label = (spans[0]?.textContent ?? "").trim();
          const value = spans[1];
          if (label.length === 0 || value === undefined) continue;
          out[label] = {
            text: (value.textContent ?? "").replace(/\s+/g, " ").trim(),
            codes: Array.from(value.querySelectorAll("code")).map((c) =>
              (c.textContent ?? "").trim(),
            ),
          };
        }
        return out;
      });
    },
  };

  return { studio, close: () => context.close() };
}

/** Wait until rows exist, none are pending, and that has held for a beat. */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const samples = (window as unknown as { __gbxSamples?: Sample[] }).__gbxSamples ?? [];
      const last = samples[samples.length - 1];
      const previous = samples[samples.length - 2];
      return Boolean(
        last &&
          previous &&
          last.rows > 0 &&
          last.pending === 0 &&
          previous.pending === 0 &&
          previous.rows === last.rows,
      );
    },
    undefined,
    { timeout: 90_000, polling: SAMPLE_MS },
  );
  // Theia's bottom area attaches later than the side panel -- measured at about
  // 3.3s against 1.1s for the tree -- so the Inspector has to be waited for
  // rather than assumed present the moment a row is clickable.
  //
  // `.gbx-inspector` and not `.gbx-detail`: the detail is a *section*, and it only
  // renders once something is selected. Waiting on it here waited for a selection
  // nobody had made yet.
  await page.waitForSelector(".gbx-inspector", { timeout: 60_000 });
}

/**
 * Open a view through the command palette.
 *
 * F1 is pressed repeatedly because a keypress sent while Theia is still
 * installing its keybindings is simply lost -- a race in driving the UI, not a
 * defect in it, and one that waiting cannot fix because nothing opens without
 * another press. The selector is `.quick-input-widget`, without the `monaco-`
 * prefix Theia used to carry; a selector that never matches is worse than no
 * wait at all, because swallowing the timeout leaves the step passing or failing
 * on timing.
 */
export async function openPalette(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.keyboard.press("F1");
    const opened = await page
      .locator(".quick-input-widget")
      .waitFor({ state: "visible", timeout: 1000 })
      .then(() => true, () => false);
    if (opened) return;
  }
  await page.locator(".quick-input-widget").waitFor({ state: "visible" });
}

/**
 * Refuse to drive the application while a modal dialog is up.
 *
 * A leftover dialog is not untidy, it is armed. Theia binds Enter on
 * **`document.body`** while one is open (`@theia/core/lib/browser/dialogs.js:82`)
 * and `handleEnter` accepts unless the event came from a textarea, so the next
 * keystroke any test sends -- to the palette, to an editor, to nothing in
 * particular -- answers it. When the dialog is a description-edit confirmation,
 * that keystroke writes to `product.gdl`. The `studio` page is worker-scoped, so a
 * leftover outlives the test that made it and lands on a stranger.
 *
 * Checked here rather than in an `afterEach`, and the reason is mechanical: this
 * suite's page belongs to the worker-scoped `studio` fixture, and a hook that
 * asked for a page fixture would get a *different*, freshly created one. So the
 * check sits at the two doors every test goes through, which is also where the
 * damage would be done.
 */
async function refuseIfDialogOpen(page: Page, doing: string): Promise<void> {
  const dialogs = page.locator(".dialogBlock");
  if ((await dialogs.count()) === 0) return;
  const titles = await page.locator(".dialogBlock .dialogTitle").allInnerTexts();
  await page.keyboard.press("Escape");
  throw new Error(
    `a modal dialog was open before ${doing}: ${JSON.stringify(titles)}. ` +
      `An earlier test left it, and Enter is bound on document.body while it is up, ` +
      `so the next keystroke would have answered it. It has been dismissed.`,
  );
}

/**
 * What the command palette offers for a query, as labels.
 *
 * Reads rather than runs, because "this command is not reachable" is a claim about
 * the palette itself: `QuickCommandService` filters
 * `CommandRegistry.getAllCommands()` by `isVisible && isEnabled`, so a command
 * that is still registered is still offered no matter what the menus say. Asserting
 * on menus alone missed that for the whole life of the shell policy.
 *
 * Closes the palette on the way out. A palette left open swallows the next test's
 * keystrokes, and the dialog guard above exists because that class of leftover has
 * already cost this suite a stray write.
 */
export async function paletteOffers(page: Page, query: string): Promise<string[]> {
  await openPalette(page);
  await page.keyboard.type(query, { delay: 10 });
  const options = page.locator(`.quick-input-list [role="option"]`);
  // Either something matched or the list is empty; both are answers, and waiting
  // for the first option would turn "nothing is offered" into a timeout.
  await page
    .locator(".quick-input-widget")
    .waitFor({ state: "visible" })
    .catch(() => undefined);
  const labels = (await options.allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
  await page.keyboard.press("Escape");
  await page.locator(".quick-input-widget").waitFor({ state: "hidden" });
  return labels;
}

export async function runCommand(page: Page, label: string): Promise<void> {
  await refuseIfDialogOpen(page, `running "${label}"`);
  await openPalette(page);
  await page.keyboard.type(label, { delay: 20 });
  // Wait for the filtered list to settle on a match before committing, rather
  // than sleeping a guessed interval.
  const options = page.locator(`.quick-input-list [role="option"]`);
  await options.first().waitFor({ state: "visible" });

  // Click an entry that actually *contains* what was typed, rather than pressing
  // Enter on whatever the fuzzy matcher ranked first.
  //
  // Measured: typing `Gearbox Product` offers `Gearbox: Open Product…` **first**
  // and `View: Toggle Gearbox Product` second, because a view toggle's palette
  // label is prefixed. So Enter ran the wrong command -- it opened a second
  // quick-pick -- and the caller waited sixty seconds for a panel nobody had
  // asked for. First-match-wins was a fragility all along: every command added to
  // this application could shift the ranking under every test that reveals a view.
  //
  // Containment, not equality: the label a caller knows is `Gearbox Product`, and
  // the palette renders it inside `View: Toggle …`.
  const matching = options.filter({ hasText: label });
  if ((await matching.count()) > 0) {
    await matching.first().click();
    return;
  }

  // **Not `Enter`.** Pressing it here used to be the fallback, on the theory that
  // the fuzzy matcher had probably ranked the right thing first. Two problems, and
  // the second is why this throws instead.
  //
  // It hides a broken test: a command whose label changed, or one that was never
  // registered, ran *something else* and the failure surfaced sixty seconds later
  // as a panel that never appeared.
  //
  // And it can write to a file. `DialogOverlayService` binds Enter on
  // `document.body` (`@theia/core/lib/browser/dialogs.js:82`), so while any dialog
  // is open an Enter anywhere accepts it -- including a description-edit
  // confirmation left over from an earlier test in this worker-scoped page. That
  // is a candidate mechanism for the stray `use_gear(...)` writes this suite has
  // guarded against three times, and it costs nothing to take away.
  const offered = await options.allInnerTexts();
  throw new Error(
    `no command in the palette contains "${label}". Offered: ${JSON.stringify(offered)}`,
  );
}

/**
 * Bring a view to the front, idempotently.
 *
 * Three Theia behaviours have to be respected at once, and each of them broke a
 * test before this helper existed:
 *
 *   - the view command is a *toggle*, so calling it on the active view closes it;
 *   - `visible` is not `attached` -- a tab that exists but is not current keeps
 *     its widget in the DOM, and with two Gearbox views in the main area that is
 *     the normal case;
 *   - Theia's layout restorer reopens tabs after a reload, so a view may already
 *     be there before anything asks for it.
 *
 * So: check visibility, not presence, and let the toggle activate rather than
 * open. `toggleView` activates a view that is open but not focused, which is
 * exactly what is wanted here.
 */
async function revealView(page: Page, command: string, selector: string): Promise<void> {
  await refuseIfDialogOpen(page, `revealing ${command}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.locator(selector).first().isVisible()) return;
    // Attached-but-hidden: the widget is in the DOM behind another tab. Click its
    // shell tab; fall back to the command only when the widget does not exist yet.
    //
    // This was briefly reverted to always use the command, on the argument that a
    // tab click moves the tests off the path a person takes. Measured both ways:
    // the command reveals Product when the Graph is on top of it, but across the
    // whole suite it produced widespread `toBeVisible` failures and took 19.6
    // minutes against 3.3. Whatever the mechanism -- a toggle is a toggle, and
    // `runCommand` drives the palette, which is a second stateful thing to get
    // wrong -- the tab click is what Theia reliably listens to.
    //
    // The user's path is not left uncovered by this: `regression.spec.ts` asserts
    // that the toggle *command* reveals an open-but-hidden view, which is the
    // claim a tab click would otherwise hide.
    const tabId = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      let n: HTMLElement | null = el instanceof HTMLElement ? el : null;
      while (n) {
        if (n.id && document.getElementById(`shell-tab-${n.id}`)) return n.id;
        n = n.parentElement;
      }
      return "";
    }, selector);
    if (tabId !== "") {
      await page.locator(`[id="shell-tab-${tabId}"]`).click();
    } else {
      await runCommand(page, command);
    }
    const shown = await page
      .locator(selector)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true, () => false);
    if (shown) return;
  }
  await page.locator(selector).first().waitFor({ state: "visible" });
}

/**
 * No test may leave a product description changed.
 *
 * `global-setup` checks this once, before the run; this checks it after every
 * test, and the difference is attribution. A description that goes dirty
 * mid-run poisons every later claim that depends on the resolution -- observed
 * twice, as a stray `use_gear("grpc-hub")` and a stray `use_gear("types-registry")`
 * -- and the failures land in files that have nothing to do with the write.
 *
 * The cause has not been found: it did not reproduce across three full runs with
 * a stack trace armed on the only code path that writes. So this does the next
 * best thing rather than pretending otherwise -- it **fails the test that did
 * it**, prints the diff naming the gear, and restores the tree so the rest of the
 * run is still worth reading. Silently restoring would have hidden it again.
 */
base.afterEach(async ({}, testInfo) => {
  const { execFileSync } = await import("node:child_process");
  const repo = join(__dirname, "../..");
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "products"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  if (dirty === "") return;

  const diff = execFileSync("git", ["diff", "--", "products"], {
    cwd: repo,
    encoding: "utf8",
  });
  execFileSync("git", ["checkout", "--", "products"], { cwd: repo });
  throw new Error(
    `"${testInfo.title}" left a product description changed:\n${dirty}\n\n${diff}\n` +
      `The tree has been restored. Two claims edit a description on purpose and put ` +
      `it back; anything else writing there is the defect this guard exists to name.`,
  );
});

export async function openGraph(page: Page): Promise<void> {
  await revealView(page, "Gearbox Graph", ".gbx-svg");
}

/**
 * Open the Graph panel and switch it to one of its four views.
 *
 * The switch is a button rather than a Theia tab, so this clicks it and then
 * waits for that view's own root -- waiting on `.gbx-svg` alone would pass
 * against the view that was already showing.
 */
export async function openGraphView(
  page: Page,
  view: "deps" | "contracts" | "processes" | "cluster",
): Promise<void> {
  await openGraph(page);
  await page.locator(`.gearbox-graph .gbx-view-tab[data-view="${view}"]`).click();
  await page
    .locator(`.gearbox-graph [data-graph="${view}"], .gearbox-graph .gbx-empty`)
    .first()
    .waitFor({ state: "visible" });
}

/**
 * Bring the Inspector to the front, and wait for its "why" section.
 *
 * `Gearbox Explain` was a panel of its own until the two bottom panels became one
 * Inspector. The section kept its class, so everything asserted about the
 * explanation still asserts the same markup -- only the tab it lives behind
 * changed.
 */
export async function openExplain(page: Page): Promise<void> {
  await revealInspector(page);
}

/**
 * Open the Problems view and read the Gearbox markers in it.
 *
 * Two Theia behaviours to respect. Clicking the *already current* tab of a
 * bottom-panel view collapses the panel, so the tab is only clicked when
 * Problems is not already showing. And the marker tree is rebuilt
 * asynchronously after `setMarkers`, so the node list is read until it stops
 * changing -- reading once returned a half-updated tree, which looked exactly
 * like markers that had not been replaced.
 */
export async function problems(
  page: Page,
): Promise<{ files: string[]; markers: string[] }> {
  const tab = page.locator("#theia-bottom-content-panel .lm-TabBar-tab", {
    hasText: "Problems",
  });
  const current = await tab.evaluate((e) => e.classList.contains("lm-mod-current"));
  if (!current) {
    await tab.click();
  }
  await page.locator(".theia-marker-container").waitFor({ state: "visible" });

  const read = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".theia-marker-container .theia-TreeNode")).map((e) =>
        (e.textContent ?? "").replace(/\s+/g, " ").trim(),
      ),
    );
  let previous = await read();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(250);
    const nodes = await read();
    if (nodes.length === previous.length && nodes.every((n, i) => n === previous[i])) {
      // A file node names a path; a marker node is the message. Split on that
      // rather than on tree depth, which Theia renders with padding rather than
      // with a class.
      return {
        files: nodes.filter((text) => /\.gdl|\.lock|\.rs\b/.test(text)),
        markers: nodes.filter((text) => !/\.gdl|\.lock|\.rs\b/.test(text)),
      };
    }
    previous = nodes;
  }
  throw new Error("the Problems tree never settled");
}

/**
 * Bring the Gear detail panel to the front.
 *
 * It shares the bottom panel with Problems and with any terminal, so opening
 * either hides it -- ordinary IDE behaviour, and the reason a test that clicks a
 * link *inside* the detail panel has to say which tab it wants first. Playwright
 * waits for visibility before clicking, so without this the click hangs until the
 * test times out, which looks nothing like "the wrong tab is showing".
 */
/**
 * Bring a left-panel view to the front, by tab label.
 *
 * Needed because the left panel now holds four tabs -- Explorer, Catalogue,
 * Search, Source Control -- and only one is current. Anything asserting that a
 * catalogue row is *visible* has to say so first, and clicking the already
 * current tab would collapse the panel instead.
 */
export async function revealLeft(page: Page, label: string | RegExp): Promise<void> {
  const tab = page.locator("#theia-left-content-panel .lm-TabBar li", { hasText: label });
  if (!(await tab.first().evaluate((e) => e.classList.contains("lm-mod-current")))) {
    await tab.first().click();
  }
}

export const revealCatalogue = (page: Page): Promise<void> =>
  revealLeft(page, "Gearbox Catalogue");

/**
 * Put the catalogue back where a row lookup can find anything.
 *
 * The catalogue now folds by category and filters by text, and both remove rows
 * from the DOM -- correctly, that is what they are for. So any test that looks a
 * gear up by name has to restore the precondition rather than inherit whatever an
 * earlier test left. Found the hard way: one test folded a category and the next
 * one's `detailOf("Payments (example provider)")` returned null.
 */
export async function resetCatalogueView(page: Page): Promise<void> {
  const filter = page.locator(".gearbox-catalogue .gbx-filter");
  if ((await filter.count()) > 0 && (await filter.inputValue()) !== "") {
    await filter.fill("");
  }
  const folded = page.locator('.gearbox-catalogue .gbx-group-label[data-collapsed="true"]');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await folded.count()) === 0) return;
    await folded.first().click();
  }
}

/**
 * Expand the Explorer until `file` is visible, and return its node.
 *
 * Not a list of path segments, and that is the point. Theia collapses chains of
 * single-child directories into one node, so `.gearbox/payments-demo/dev` is
 * *one* row -- but only while the intermediate directories are unexpanded. Once
 * something has expanded `.gearbox`, the same path renders as several rows. So
 * the node text depends on the tree's remembered state, and matching it exactly
 * is a test that passes or fails on what an earlier test happened to click.
 *
 * Instead: expand whatever is collapsed and looks like it leads there, until the
 * file appears. Also expands only collapsed nodes -- a click on an expanded one
 * *collapses* it, which is the same toggle hazard as the view commands in a third
 * disguise.
 */
export async function revealInExplorer(
  page: Page,
  root: string,
  pathContains: string | readonly string[],
  file: string,
): Promise<Locator> {
  await revealLeft(page, "Explorer");
  const target = page.locator(".theia-TreeNode", { hasText: new RegExp(`^${escapeForRegExp(file)}$`) });
  const hints = typeof pathContains === "string" ? [pathContains] : [...pathContains];

  for (let round = 0; round < 10; round += 1) {
    if ((await target.count()) > 0 && (await target.first().isVisible())) {
      return target.first();
    }
    // The *index* is chosen in the page and the click is done by Playwright. A
    // `HTMLElement.click()` on the node div does nothing: Theia's tree listens on
    // an inner caption element, and Playwright clicks the centre of the row, which
    // lands on it.
    const index = await page.evaluate(
      ({ rootName, hints: pathHints, fileName }) => {
        const nodes = Array.from(document.querySelectorAll(".theia-TreeNode"));
        // Expansion state lives on the chevron, not on the row: an expanded node
        // is one whose `.theia-ExpansionToggle` has lost `theia-mod-collapsed`.
        // Reading it off the row instead made every node look collapsed, so the
        // loop clicked the root open and then closed again, forever.
        const collapsed = (node: Element) =>
          node.className.includes("theia-ExpandableTreeNode") &&
          node.querySelector(".theia-ExpansionToggle.theia-mod-collapsed") !== null;
        const text = (node: Element) => (node.textContent ?? "").trim();
        const pick = nodes.findIndex((node) => collapsed(node) && text(node) === rootName);
        if (pick >= 0) return pick;
        return nodes.findIndex(
          (node) =>
            collapsed(node) &&
            pathHints.some((hint) => text(node).includes(hint)) &&
            text(node) !== fileName,
        );
      },
      { rootName: root, hints, fileName: file },
    );
    if (index < 0) break;
    await page.locator(".theia-TreeNode").nth(index).click();
    await page.waitForTimeout(500);
  }

  const visible = await page
    .locator(".theia-TreeNode")
    .allTextContents()
    .then((all) => all.map((one) => one.trim()));
  throw new Error(`never reached ${file}; the tree shows: ${visible.join(", ")}`);
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bring the Inspector to the front, by tab.
 *
 * Waits for the **panel**, not for either of its sections. That distinction cost a
 * whole suite run: `.gbx-detail` and `.gbx-explain` render only once something is
 * selected, so waiting for one here waited thirty seconds for a selection the
 * caller had not made yet -- and `detailOf` reveals the panel *before* clicking a
 * row, which is every gear-facts claim in the suite.
 *
 * By tab rather than by command for the reason `revealView` records: the tab is
 * what Theia reliably listens to, and the toggle command on an already-current
 * view closes it. Returns silently when the tab does not exist, because a caller
 * that then waits on a section gets a better failure than this could produce.
 */
export async function revealInspector(page: Page): Promise<void> {
  await refuseIfDialogOpen(page, "revealing the Inspector");
  const tab = page.locator("#theia-bottom-content-panel .lm-TabBar-tab", {
    hasText: "Gearbox Inspector",
  });
  if ((await tab.count()) === 0) return;
  if (!(await tab.evaluate((e) => e.classList.contains("lm-mod-current")))) {
    await tab.click();
  }
  await page.locator(".gbx-inspector").waitFor({ state: "visible" });
}

/**
 * The Inspector, by its old name.
 *
 * Kept as an alias because the callers ask for "the panel with the gear facts in
 * it", which is what this is -- one panel now, two sections.
 */
export async function revealDetail(page: Page): Promise<void> {
  await revealInspector(page);
}

/**
 * Open the Conflicts screen.
 *
 * By command, because unlike the Inspector this panel is not opened at startup --
 * a panel that appears to say "no conflicts" says nothing -- so there is no tab to
 * click until something has asked for one.
 */
export async function openConflicts(page: Page): Promise<void> {
  await revealView(page, "Gearbox Conflicts", ".gbx-conflicts");
}

export async function revealLock(page: Page): Promise<void> {
  await revealView(page, "Gearbox Lock", ".gbx-lock");
  // The text is fetched lazily on first render, so the view being visible is not
  // the same as the lock being there.
  await page.locator("[data-lock-canonical]").waitFor({ state: "visible", timeout: 60_000 });
}

/**
 * Open the Product view and resolve one profile.
 *
 * Waits on `data-resolved-profile`, which the widget reads off the resolved
 * header rather than off the profile switch. Waiting on the switch instead would
 * pass the moment the button lights up, which happens before the resolution
 * lands -- so the test would read the previous profile's answer.
 */
export async function openGenerate(page: Page): Promise<void> {
  await revealView(page, "Gearbox Generate", ".gbx-generate");
}

/**
 * Wait for the shell to report the context it is in.
 *
 * There is no control that sets a context: it is derived from what is open, which
 * is the whole point of `StudioContextService`. So a test does not *switch* a
 * context -- it opens something and waits for the shell to agree. This replaced a
 * `switchPerspective` helper that clicked buttons which no longer exist, and it
 * asserts the same property more honestly: the header's `data-context` is set from
 * the service, not from whatever layout happened to be restored.
 */
export async function expectContext(
  page: Page,
  kind: "home" | "product" | "gear",
): Promise<void> {
  await expect(page.locator(".gbx-toolbar")).toHaveAttribute("data-context", kind, {
    timeout: 30_000,
  });
}

export async function openProduct(page: Page, profile: string): Promise<void> {
  await revealView(page, "Gearbox Product", ".gbx-product");
  await page.locator("[data-resolved-profile]").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator(`[data-profile="${profile}"]`).click();
  await page
    .locator(`[data-resolved-profile="${profile}"]`)
    .waitFor({ state: "visible", timeout: 60_000 });
}

export const test = base.extend<{ freshStudio: Studio }, { studio: Studio }>({
  studio: [
    async ({ browser }, use) => {
      const { studio, close } = await open(browser);
      await settled(studio.page);
      await use(studio);
      await close();
    },
    { scope: "worker" },
  ],

  freshStudio: async ({ browser }, use) => {
    const { studio, close } = await open(browser);
    await use(studio);
    await close();
  },
});

export { expect } from "@playwright/test";
