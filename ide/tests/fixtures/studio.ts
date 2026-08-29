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

import { test as base, type Browser, type Page } from "@playwright/test";

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
    detailOf: (name: string) =>
      page.evaluate(async (wanted) => {
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
        return (document.querySelector(".gbx-detail")?.textContent ?? "").replace(/\s+/g, " ").trim();
      }, name),
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
  // 3.3s against 1.1s for the tree -- so the detail widget has to be waited for
  // rather than assumed present the moment a row is clickable.
  await page.waitForSelector(".gbx-detail", { timeout: 60_000 });
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

export async function runCommand(page: Page, label: string): Promise<void> {
  await openPalette(page);
  await page.keyboard.type(label, { delay: 20 });
  // Wait for the filtered list to settle on a match before committing, rather
  // than sleeping a guessed interval.
  await page.locator(`.quick-input-list [role="option"]`).first().waitFor({ state: "visible" });
  await page.keyboard.press("Enter");
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.locator(selector).first().isVisible()) return;
    await runCommand(page, command);
    const shown = await page
      .locator(selector)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true, () => false);
    if (shown) return;
  }
  await page.locator(selector).first().waitFor({ state: "visible" });
}

export async function openGraph(page: Page): Promise<void> {
  await revealView(page, "Gearbox Graph", ".gbx-svg");
}

/**
 * Open the Product view and resolve one profile.
 *
 * Waits on `data-resolved-profile`, which the widget reads off the resolved
 * header rather than off the profile switch. Waiting on the switch instead would
 * pass the moment the button lights up, which happens before the resolution
 * lands -- so the test would read the previous profile's answer.
 */
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
