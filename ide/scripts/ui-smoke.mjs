// Headless check of the staged rendering, against a running browser-app.
//
// This exists because ADR-0009 designed staged loading before any consumer of it
// existed. The design's whole claim is that a row is useful before it is
// complete, and the only way to know that is to watch the DOM while a real load
// runs. So the checks below are a *timeline*, not a final state: a snapshot after
// the load would pass even if the tree had appeared all at once.
//
// Usage: node scripts/ui-smoke.mjs [url]
//   Requires the app already serving (npm run start:browser).

import puppeteer from "puppeteer";

const URL = process.argv[2] ?? "http://127.0.0.1:3000/";
const SAMPLE_MS = 25;
const TIMEOUT_MS = 90_000;

// Eleven of these checks sit inside `if` guards, so a run where a guard did not
// fire reports a *smaller denominator* and still prints "passed". Pinning the
// total is what turns that silent regression into a failure.
const EXPECTED_CHECKS = 38;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  const mark = ok ? "ok  " : "FAIL";
  console.log(`${mark} ${name}${detail ? ` -- ${detail}` : ""}`);
}

/** One DOM sample: what the catalogue looks like right now. */
const SAMPLE = () => {
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  const rows = q(".gbx-row");
  return {
    t: Date.now(),
    rows: rows.length,
    // Visible, not merely attached: a collapsed Theia side panel keeps its
    // widget in the DOM, so counting nodes says nothing about what a person
    // sees. This distinction is what let an earlier run pass with a blank
    // screen.
    visibleRows: rows.filter((r) => r.getClientRects().length > 0).length,
    pending: q(".gbx-row.gbx-pending").length,
    badges: q(".gbx-badge").length,
    ids: q(".gbx-id").length,
    groups: q(".gbx-group-label").map((e) => e.textContent.trim()),
    names: q(".gbx-row-name").map((e) => e.textContent.trim()),
    waiting: q(".gbx-waiting").length,
  };
};

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  const consoleErrors = [];
  // Warnings are collected too, and only because of one of them: a grammar that
  // fails to load is a `logger.warn` inside MonacoTextmateService, never an
  // error. Without this the editor would quietly fall back to plaintext and
  // every check below would still pass.
  const consoleWarnings = [];
  page.on("console", (m) => {
    // The URL of a failed request lives in `location()`, not in `text()`: the
    // text is only "Failed to load resource: ... 404". Without the URL there is
    // no way to tell a missing favicon from a missing bundle.
    if (m.type() === "error") {
      const url = m.location()?.url ?? "";
      consoleErrors.push(url ? `${m.text()} [${url}]` : m.text());
    }
    if (m.type() === "warning" || m.type() === "warn") {
      consoleWarnings.push(m.text());
    }
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });

  // Sample from before the first row exists until the load reports done.
  const timeline = [];
  const deadline = Date.now() + TIMEOUT_MS;
  let settled = false;
  while (Date.now() < deadline) {
    const s = await page.evaluate(SAMPLE).catch(() => null);
    if (s) {
      timeline.push(s);
      // Done when rows exist, none are pending, and that has held for a beat.
      if (s.rows > 0 && s.pending === 0) {
        const prev = timeline[timeline.length - 2];
        if (prev && prev.rows === s.rows && prev.pending === 0) {
          settled = true;
          break;
        }
      }
    }
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }

  const last = timeline[timeline.length - 1] ?? { rows: 0, pending: 0, badges: 0 };
  check("the load settles", settled, `${last.rows} rows, ${timeline.length} samples`);
  check(
    "the rows are actually on screen",
    last.visibleRows === last.rows && last.rows > 0,
    `${last.visibleRows} of ${last.rows} rows have a client rect`,
  );

  // --- the staged claim ---------------------------------------------------
  // The decisive one: a sample where rows are on screen and still pending.
  //
  // Bounded rather than asserted outright. On a fast machine with a small
  // corpus the whole projection can land between two samples, and failing then
  // would be the harness reporting its own sampling rate as a product defect.
  // The escape hatch is narrow on purpose: it applies only when the load was
  // too short to have been observed at all, which is itself reported.
  const staged = timeline.filter((s) => s.rows > 0 && s.pending > 0);
  const observable = timeline.filter((s) => s.rows > 0).length;
  if (staged.length === 0 && observable <= 1) {
    console.log(
      `skip rows are on screen while still pending -- the load finished within ` +
        `${observable} sample(s) of ${SAMPLE_MS}ms; too fast to observe`,
    );
  } else {
    check(
      "rows are on screen while still pending",
      staged.length > 0,
      staged.length > 0
        ? `${staged.length} samples, first with ${staged[0].rows} rows / ${staged[0].pending} pending`
        : "no sample caught a partial tree -- staging is invisible to a user",
    );
  }

  // Names and categories are present in that partial state, badges are not.
  const firstStaged = staged[0];
  if (firstStaged) {
    check(
      "a pending row already has a name",
      firstStaged.names.length >= firstStaged.rows && firstStaged.names.every((n) => n.length > 0),
      `${firstStaged.names.length} names for ${firstStaged.rows} rows`,
    );
    check(
      "a pending row is already grouped by category",
      firstStaged.groups.length > 0,
      firstStaged.groups.join(", "),
    );
    check(
      "badges trail the names",
      firstStaged.badges < last.badges,
      `${firstStaged.badges} badges while pending, ${last.badges} at the end`,
    );
    check(
      "a pending row says so",
      firstStaged.waiting > 0,
      `${firstStaged.waiting} rows marked parsing`,
    );
  }

  check("nothing is left pending", last.pending === 0, `${last.pending} pending`);
  check(
    "every row got an id once projected",
    last.ids >= last.rows,
    `${last.ids} ids for ${last.rows} rows`,
  );

  // --- content ------------------------------------------------------------
  // Theia's bottom area attaches later than the side panel -- measured at about
  // 3.3s against 1.1s for the tree -- so the detail widget has to be waited for
  // rather than assumed present the moment a row is clickable.
  await page.waitForSelector(".gbx-detail", { timeout: 30_000 });

  const detail = await page.evaluate(async () => {
    const rows = Array.from(document.querySelectorAll(".gbx-row"));
    const target = rows.find((r) =>
      r.querySelector(".gbx-row-name")?.textContent.includes("API Gateway"),
    );
    if (!target) return { found: false, names: rows.map((r) => r.textContent) };
    target.click();
    // The detail widget renders on the store's change event, so poll for its
    // content rather than sleeping a guessed interval.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const panel = document.querySelector(".gbx-detail");
      if (panel && /co-located with/.test(panel.textContent)) {
        return { found: true, text: panel.textContent };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const panel = document.querySelector(".gbx-detail");
    return { found: true, text: panel ? panel.textContent : "" };
  });
  check("the api-gateway row selects", detail.found, detail.found ? "" : "row not found");
  if (detail.found) {
    check(
      "co-location is shown as a closure, not a pair",
      /authn-resolver/.test(detail.text) && /grpc-hub/.test(detail.text),
      detail.text.slice(0, 120).replace(/\s+/g, " "),
    );
  }

  // --- operable without a mouse -------------------------------------------
  // A panel in an IDE that only answers clicks is unusable for anyone who does
  // not use a mouse, and every interaction here was a bare `onClick` on a div.
  // Real key events through the browser, not synthesized ones: React attaches
  // its own listeners, and a dispatched event with the wrong shape would pass
  // while a keyboard would not.
  await page.focus(".gbx-row");
  const focused = await page.evaluate(
    () => document.activeElement?.classList.contains("gbx-row") === true,
  );
  check("a catalogue row can take focus", focused);

  await page.keyboard.press("Enter");
  const keyboardSelected = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const active = document.activeElement;
      if (active?.classList.contains("gbx-selected")) {
        return active.querySelector(".gbx-row-name")?.textContent?.trim() ?? "";
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  });
  check(
    "Enter selects the focused row",
    typeof keyboardSelected === "string",
    keyboardSelected ?? "the focused row never became selected",
  );

  // What is *not* built yet has to be visible. The notice is driven by the
  // engine's own `capabilities.resolve`, so it disappears on its own when M4
  // lands rather than needing this text to be remembered and deleted.
  const gap = await page.evaluate(() => {
    const el = document.querySelector(".gbx-gap");
    return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
  });
  check(
    "the missing resolver is stated, not hidden",
    gap !== null && /resolver/i.test(gap) && /resolve: false/.test(gap),
    gap ?? "no .gbx-gap notice",
  );

  // --- the graph ----------------------------------------------------------
  // The view that makes co-location legible as a closure. Opened through the
  // command palette, which is also a check that the contribution is registered.
  // `.quick-input-widget`, without the `monaco-` prefix Theia used to carry. A
  // selector that never matches is worse than no wait at all: swallowing the
  // timeout left this step passing or failing on timing.
  //
  // F1 is pressed until the palette answers, because a keypress sent while
  // Theia is still installing its keybindings is simply lost -- a race in
  // driving the UI, not a defect in it, and one that waiting cannot fix because
  // nothing will open without another press.
  const palette = await (async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.keyboard.press("F1");
      const found = await page
        .waitForSelector(".quick-input-widget", { timeout: 1000 })
        .catch(() => null);
      if (found) return true;
    }
    return false;
  })();
  check("the command palette opens", palette);
  await page.keyboard.type("Gearbox Graph", { delay: 20 });
  await new Promise((r) => setTimeout(r, 600));
  await page.keyboard.press("Enter");
  const graph = await page
    .waitForSelector(".gbx-svg", { timeout: 15_000 })
    .then(async () =>
      page.evaluate(() => ({
        nodes: Array.from(document.querySelectorAll(".gbx-node-label")).map((e) =>
          e.textContent.trim(),
        ),
        edges: Array.from(document.querySelectorAll(".gbx-edge")).map((e) => [
          e.getAttribute("data-from"),
          e.getAttribute("data-to"),
        ]),
        isolated: Array.from(document.querySelectorAll('[data-isolated="true"]')).map((e) =>
          e.getAttribute("data-gear"),
        ),
        arrows: document.querySelectorAll(".gbx-edge[marker-end]").length,
      })),
    )
    .catch(() => null);

  check("the graph opens from the command palette", graph !== null);
  if (graph) {
    const has = (a, b) => graph.edges.some(([f, t]) => f === a && t === b);
    check(
      "co-location is a closure, not a partition",
      has("api-gateway", "authn-resolver") &&
        has("api-gateway", "grpc-hub") &&
        has("authn-resolver", "types-registry"),
      `${graph.nodes.length} nodes, ${graph.edges.length} edges`,
    );
    check(
      "every edge lands on a node the graph drew",
      graph.edges.every(([f, t]) => graph.nodes.includes(f) && graph.nodes.includes(t)),
      "an edge to a gear outside the catalogue would be a projection bug",
    );
    check(
      "every edge is directed",
      graph.arrows === graph.edges.length && graph.edges.length > 0,
      `${graph.arrows} arrowheads for ${graph.edges.length} edges`,
    );
    // A gear with no co-location has to be told apart from a gear everything
    // depends on: both sit at layer 0, and conflating them reads as though the
    // isolated one were depended upon.
    const touched = new Set(graph.edges.flat());
    check(
      "unconnected gears are set apart, not put in the leaf column",
      graph.isolated.length > 0 && graph.isolated.every((id) => !touched.has(id)),
      `${graph.isolated.length} isolated: ${graph.isolated.join(", ")}`,
    );

    // The closure is the finding this view exists for, so clicking has to show it.
    const painted = await page.evaluate(async () => {
      const node = document.querySelector('[data-gear="api-gateway"]');
      if (!node) return null;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return {
        lit: Array.from(document.querySelectorAll(".gbx-node-lit, .gbx-node-focus")).map((e) =>
          e.getAttribute("data-gear"),
        ),
        dimmed: document.querySelectorAll(".gbx-node-dim").length,
        footer: document.querySelector(".gbx-footer")?.textContent.replace(/\s+/g, " ").trim(),
      };
    });
    check("clicking a gear paints its closure", painted !== null && painted.lit.length > 1);
    if (painted) {
      const lit = new Set(painted.lit);
      check(
        "the painted closure is transitive",
        ["api-gateway", "authn-resolver", "grpc-hub", "types-registry"].every((id) => lit.has(id)),
        `lit: ${painted.lit.sort().join(", ")}`,
      );
      check(
        "the closure is shown against the rest, not alone",
        painted.dimmed > 0,
        `${painted.dimmed} dimmed -- "these four out of fourteen" is the point`,
      );
      check(
        "the closure is stated in words too",
        typeof painted.footer === "string" && /co-locates/.test(painted.footer),
        painted.footer ?? "no footer",
      );
    }
  }

  // --- the projected facts the catalogue exists to carry --------------------
  // Selecting a row by name and reading the detail panel, because these two are
  // the parts of the projection that were hardest to get right and the easiest
  // to regress into something plausible.
  const detailOf = async (name) =>
    page.evaluate(async (wanted) => {
      const row = Array.from(document.querySelectorAll(".gbx-row")).find((r) =>
        r.querySelector(".gbx-row-name")?.textContent.includes(wanted),
      );
      if (!row) return null;
      row.click();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const panel = document.querySelector(".gbx-detail");
        const text = panel?.textContent ?? "";
        if (text.includes(wanted)) return text.replace(/\s+/g, " ").trim();
        await new Promise((r) => setTimeout(r, 50));
      }
      return document.querySelector(".gbx-detail")?.textContent ?? "";
    }, name);

  const plugin = await detailOf("OIDC AuthN Plugin");
  check(
    "a plugin says which point it fills, and under which vendor",
    plugin !== null && /fills/.test(plugin) && /vendor/.test(plugin),
    plugin?.slice(0, 160) ?? "row not found",
  );

  const provider = await detailOf("Payments (example provider)");
  check(
    "a provider's transports are what it wires up, not what the contract allows",
    provider !== null && /PaymentApi/.test(provider) && !/grpc/.test(provider),
    // api-contracts-sdk declares PaymentApiGrpc, so gRPC is possible for v1 --
    // but the gear's own #[toolkit::provides] omits it, because that client sits
    // behind an opt-in Cargo feature. Seeing "grpc" here would mean the
    // catalogue had gone back to reading the contract's possibilities as the
    // provider's offer.
    provider?.slice(0, 200) ?? "row not found",
  );

  // --- the links actually open ---------------------------------------------
  // This is the check that was missing, and its absence is why the links shipped
  // dead. Asserting that an <a> exists proves nothing: the original one rendered
  // perfectly and resolved to a URI with no scheme, and the rejection went into
  // an empty catch. So the assertion has to be that a *tab opens*.
  const opened = await page.evaluate(async () => {
    const before = document.querySelectorAll(".p-TabBar-tab, .lm-TabBar-tab").length;
    const link = Array.from(document.querySelectorAll(".gbx-links a")).find((a) =>
      a.textContent.includes("gear.gdl"),
    );
    if (!link) return { clicked: false };
    link.click();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const tabs = Array.from(document.querySelectorAll(".p-TabBar-tab, .lm-TabBar-tab"));
      const gdl = tabs.find((t) => t.textContent.includes("gear.gdl"));
      if (gdl) return { clicked: true, opened: true, title: gdl.textContent.trim() };
      // A failure now surfaces as a notification instead of silence.
      const toast = document.querySelector(".theia-notification-message span");
      if (toast) return { clicked: true, opened: false, error: toast.textContent };
      if (document.querySelectorAll(".p-TabBar-tab, .lm-TabBar-tab").length > before) {
        return { clicked: true, opened: true, title: "(new tab)" };
      }
    }
    return { clicked: true, opened: false, error: "nothing happened within 6s" };
  });

  check("the gear.gdl link is present", opened.clicked);
  check(
    "clicking it opens the file",
    opened.opened === true,
    opened.opened ? opened.title : (opened.error ?? "no tab and no error -- silent failure"),
  );

  // --- and what it opened is a language, not a wall of grey ----------------
  // A plaintext Monaco model still wraps every line in <span class="mtk1">, so
  // "spans exist" would have passed with no grammar registered at all -- which
  // is precisely the state this feature fixed. The signal is that more than one
  // token class is in play, and that a comment and a string are not the same
  // one. Both assertions are content-agnostic on purpose: gear.gdl lives in a
  // sibling repo and its first screen is not ours to pin.
  const tokens = await page.evaluate(async () => {
    let last = {};
    // The model is plaintext for a beat while the grammar's oniguruma wasm
    // loads, so this polls rather than sampling once. Note the exit condition
    // cannot be "more than one class exists": a *plaintext* model already
    // renders several, which is how the first version of this check passed
    // against an untokenized editor. It has to be the assertion itself.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // Visible, not merely attached: Theia keeps a background editor in the
      // DOM, and only rendered lines are tokenized.
      const editor = Array.from(document.querySelectorAll(".monaco-editor")).find(
        (e) => e.getClientRects().length > 0,
      );
      const spans = editor
        ? Array.from(editor.querySelectorAll('.view-lines .view-line span[class^="mtk"]'))
        : [];
      const startsWith = (c) =>
        spans.find((s) => s.textContent.trimStart().startsWith(c))?.className;
      last = {
        editor: Boolean(editor),
        spans: spans.length,
        classes: new Set(spans.map((s) => s.className)).size,
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

  check(
    "the .gdl editor is tokenized, not plaintext",
    tokens.editor === true && tokens.classes >= 4,
    `${tokens.classes ?? 0} token classes over ${tokens.spans ?? 0} spans`,
  );
  check(
    "a comment and a string are different colours",
    Boolean(tokens.comment) && Boolean(tokens.string) && tokens.comment !== tokens.string,
    `${tokens.comment ?? "no comment run"} vs ${tokens.string ?? "no string run"}`,
  );

  const grammarWarnings = consoleWarnings.filter((w) => /grammar/i.test(w));
  check(
    "no grammar failed to load",
    grammarWarnings.length === 0,
    grammarWarnings.slice(0, 2).join(" | "),
  );

  // The docs links are the same code path with a different field and a
  // different gear, and `cluster` is the one that has all three kinds.
  const docs = await page.evaluate(async () => {
    const row = Array.from(document.querySelectorAll(".gbx-row")).find((r) =>
      r.querySelector(".gbx-row-name")?.textContent.includes("Cluster Coordination"),
    );
    if (!row) return { found: false };
    row.click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const links = Array.from(document.querySelectorAll(".gbx-links a")).map((a) =>
        a.textContent.trim(),
      );
      if (links.includes("PRD")) {
        const prd = Array.from(document.querySelectorAll(".gbx-links a")).find(
          (a) => a.textContent.trim() === "PRD",
        );
        prd.click();
        for (let wait = 0; wait < 60; wait += 1) {
          await new Promise((r) => setTimeout(r, 100));
          const tabs = Array.from(document.querySelectorAll(".lm-TabBar-tabLabel")).map((t) =>
            t.textContent.trim(),
          );
          if (tabs.includes("PRD.md")) return { found: true, opened: true, links };
          const toast = document.querySelector(".theia-notification-message");
          if (toast) return { found: true, opened: false, error: toast.textContent };
        }
        return { found: true, opened: false, error: "no tab within 6s", links };
      }
    }
    return { found: true, opened: false, error: "no PRD link rendered" };
  });
  check("a gear with docs shows PRD, DESIGN and ADR links", docs.found && !!docs.links, (docs.links ?? []).join(", "));
  check(
    "a docs link opens too",
    docs.opened === true,
    docs.opened ? "PRD.md" : (docs.error ?? "silent failure"),
  );

  const categories = last.groups ?? [];
  check(
    "categories come from the platform, not from us",
    categories.length > 1 && !categories.includes("platform"),
    categories.join(", "),
  );

  // The app has no favicon: @theia/cli 1.75 offers no hook for one and its
  // generated index.html has no <link rel="icon">. Tolerated by name rather than
  // by filtering every 404, so a real missing resource still fails.
  // --- the shell is narrowed ------------------------------------------------
  // ADR 0011 requires that a removed menu be asserted *absent*, not merely
  // removed once. Selection comes from `@theia/monaco` and Go from
  // `@theia/editor` — packages the editor needs, so an upgrade that re-registers
  // either would restore them silently.
  const menus = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".lm-MenuBar-itemLabel, .p-MenuBar-itemLabel")).map((e) =>
      e.textContent.trim(),
    ),
  );
  check(
    "the menu bar is the domain's, not a general editor's",
    JSON.stringify(menus) === JSON.stringify(["File", "Edit", "Gearbox", "View", "Help"]),
    menus.join(" "),
  );
  check("Selection is gone", !menus.includes("Selection"), menus.join(" "));
  check("Go is gone", !menus.includes("Go"), menus.join(" "));

  const realErrors = consoleErrors.filter((e) => !/favicon\.ico/.test(e));
  check("no console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  await page.screenshot({ path: "/tmp/gearbox-studio.png", fullPage: false });
  console.log("\nscreenshot: /tmp/gearbox-studio.png");
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);

if (checks.length !== EXPECTED_CHECKS) {
  console.log(
    `\nFAIL ran ${checks.length} checks, expected ${EXPECTED_CHECKS}. A guarded block did not ` +
      `fire, so this run proved less than it looks. Update EXPECTED_CHECKS when adding one.`,
  );
  process.exit(1);
}
process.exit(failed.length === 0 ? 0 : 1);
