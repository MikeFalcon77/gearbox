// The widget table in §9 of docs/plans/gearbox-builder-prototype.md: which views
// exist and where they live.
//
// The placements are claims, not incidental. Each of the three that exist was
// argued for in a comment beside the contribution, and two of them were wrong
// once: the catalogue was opened from `onStart` and ended up collapsed but still
// in the DOM, and the detail panel was in the side panel where its content was
// clipped -- hiding exactly the projected facts it exists to show.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, openGraph, runCommand, settled, test } from "../fixtures/studio";

const VOCABULARY = join(
  __dirname,
  "../../gearbox-studio/src/browser/gdl/generated/vocabulary.ts",
);

/** The named `readonly string[]` lists of the generated vocabulary. */
function vocabulary(): Record<string, string[]> {
  const source = readFileSync(VOCABULARY, "utf8");
  const out: Record<string, string[]> = {};
  for (const match of source.matchAll(/export const (\w+): readonly string\[\] = \[(.*?)\];/gs)) {
    out[match[1]] = [...match[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }
  return out;
}

test.describe("where the views live", () => {
  test("the Catalogue is in the left area [plan §9: Catalogue, left]", async ({ studio }) => {
    const tabs = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll("#theia-left-content-panel .lm-TabBar li")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
    );
    expect(tabs).toContain("Gearbox Catalogue");
  });

  test("the Gear detail is in the bottom area, not the side panel [plan §9: Gear detail, bottom]", async ({
    studio,
  }) => {
    // "In the side panel this content was clipped, which hid exactly the
    // projected facts it exists to show."
    const tabs = await studio.page.evaluate(() =>
      Array.from(
        document.querySelectorAll("#theia-bottom-content-panel .lm-TabBar-tabLabel"),
      ).map((e) => (e.textContent ?? "").trim()),
    );
    expect(tabs).toContain("Gearbox Gear");
    const inBottom = await studio.page.evaluate(
      () => document.querySelector("#theia-bottom-content-panel .gbx-detail") !== null,
    );
    expect(inBottom).toBe(true);
  });

  test("the co-location Graph opens in the main area [plan §9: Graph, main]", async ({
    studio,
  }) => {
    await runCommand(studio.page, "Gearbox Graph");
    const inMain = await studio.page.evaluate(
      () => document.querySelector("#theia-main-content-panel .gbx-svg") !== null,
    );
    expect(inMain).toBe(true);
  });

  test.fixme("a Product view exists [plan §9: Product]", async ({ studio }) => {
    await expect(studio.page.locator(".gbx-product")).toBeVisible();
  });

  test.fixme("an Explain view exists [plan §9: Explain]", async ({ studio }) => {
    await expect(studio.page.locator(".gbx-explain")).toBeVisible();
  });

  test.fixme("a Lock view exists [plan §9: Lock]", async ({ studio }) => {
    await expect(studio.page.locator(".gbx-lock")).toBeVisible();
  });

  test.fixme("a Generate view exists [plan §9: Generate]", async ({ studio }) => {
    await expect(studio.page.locator(".gbx-generate")).toBeVisible();
  });
});

test.describe("the graph's own claims", () => {
  test("the layout is the same after a reload [plan §9: deterministic layout]", async ({
    freshStudio,
  }) => {
    // `elkjs` was dropped for a hand-written layout, and determinism is what
    // survived of that promise. A graph that reshuffles between reloads makes
    // "these four out of fourteen" unreadable, because the reader has to find
    // the nodes again each time.
    await settled(freshStudio.page);
    const positions = async (): Promise<string> => {
      // Only open it if it is not already open. `AbstractViewContribution`
      // registers a *toggle*, so after a reload -- where Theia's layout restorer
      // has already brought the graph back -- running the command again would
      // close it.
      if ((await freshStudio.page.locator(".gbx-svg").count()) === 0) {
        await runCommand(freshStudio.page, "Gearbox Graph");
      }
      await freshStudio.page.locator(".gbx-svg").waitFor({ state: "visible" });
      return freshStudio.page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-gear]"))
          .map((e) => {
            const box = (e as SVGGraphicsElement).getBoundingClientRect();
            return `${e.getAttribute("data-gear")}@${Math.round(box.x)},${Math.round(box.y)}`;
          })
          .sort()
          .join("|"),
      );
    };

    const before = await positions();
    await freshStudio.page.reload({ waitUntil: "domcontentloaded" });
    await settled(freshStudio.page);
    const after = await positions();

    expect(before.length).toBeGreaterThan(0);
    expect(after).toBe(before);
  });
});

test.describe("co-location is a closure, not a partition", () => {
  // The claim the graph exists for. Co-location edges are link-time `deps`, so
  // the set of gears that must share a process with a given gear is its
  // transitive closure -- and processes therefore overlap. Drawing it as a
  // partition would tell a reader that a cut exists where none can.

  test("the closure reaches past the direct dependencies [plan §9: co-location closure]", async ({
    studio,
  }) => {
    await openGraph(studio.page);
    const edges = await studio.page.evaluate(() =>
      Array.from(document.querySelectorAll(".gbx-edge")).map((e) => [
        e.getAttribute("data-from"),
        e.getAttribute("data-to"),
      ]),
    );
    const has = (from: string, to: string) =>
      edges.some(([f, t]) => f === from && t === to);
    expect(has("api-gateway", "authn-resolver")).toBe(true);
    expect(has("api-gateway", "grpc-hub")).toBe(true);
    // The second hop: api-gateway does not declare types-registry, and still
    // cannot be separated from it.
    expect(has("authn-resolver", "types-registry")).toBe(true);
  });

  test("clicking a gear paints its transitive closure [plan §9: co-location closure]", async ({
    studio,
  }) => {
    await openGraph(studio.page);
    const painted = await studio.page.evaluate(async () => {
      const node = document.querySelector('[data-gear="api-gateway"]');
      if (node === null) return null;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return {
        lit: Array.from(document.querySelectorAll(".gbx-node-lit, .gbx-node-focus")).map((e) =>
          e.getAttribute("data-gear"),
        ),
        dimmed: document.querySelectorAll(".gbx-node-dim").length,
        footer: (document.querySelector(".gbx-footer")?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      };
    });
    expect(painted).not.toBeNull();
    for (const gear of ["api-gateway", "authn-resolver", "grpc-hub", "types-registry"]) {
      expect(painted!.lit).toContain(gear);
    }
    // Shown against the rest rather than alone: "these four out of fourteen" is
    // the whole point, and a closure with nothing to compare it to reads as the
    // entire product.
    expect(painted!.dimmed).toBeGreaterThan(0);
    expect(painted!.footer).toMatch(/co-locates/);
  });

  test("unconnected gears are set apart, not put in the leaf column [plan §9: isolated gears]", async ({
    studio,
  }) => {
    await openGraph(studio.page);
    const graph = await studio.page.evaluate(() => ({
      isolated: Array.from(document.querySelectorAll('[data-isolated="true"]')).map((e) =>
        e.getAttribute("data-gear"),
      ),
      touched: Array.from(document.querySelectorAll(".gbx-edge")).flatMap((e) => [
        e.getAttribute("data-from"),
        e.getAttribute("data-to"),
      ]),
    }));
    // A gear with no co-location has to be told apart from a gear everything
    // depends on: both sit at layer 0, and conflating them reads as though the
    // isolated one were depended upon.
    expect(graph.isolated.length).toBeGreaterThan(0);
    expect(graph.isolated.filter((id) => graph.touched.includes(id))).toEqual([]);
  });
});

test.describe("the .gdl grammar's generated half", () => {
  // These read the generated file rather than a rendered editor, because no
  // `gear.gdl` in the tree contains a forbidden keyword -- the interpreter
  // rejects them, so none can. Observing the colouring would mean writing an
  // illegal file into the workspace, which is a mutation this suite does not make.
  // `make grammar-check` is what proves the file matches the interpreter; these
  // tests prove the shape the widget relies on.

  test("fourteen constructs are forbidden outright [plan §9: forbidden-keyword colouring]", () => {
    const lists = vocabulary();
    expect(lists.FORBIDDEN_KEYWORDS).toHaveLength(14);
    // The set `cpt-gearbox-fr-gdl-declarative` names: control flow and anything
    // that encodes a decision.
    for (const keyword of ["if", "elif", "else", "for", "def", "lambda", "and", "or", "not"]) {
      expect(lists.FORBIDDEN_KEYWORDS).toContain(keyword);
    }
  });

  test("`while` is reserved rather than forbidden [plan §9: two keyword lists]", () => {
    // The distinction is the interpreter's, not the grammar's: Starlark has no
    // `while` at all, so it can never appear as a rejected construct -- it is a
    // reserved word. Colouring it as forbidden would tell a reader the resolver
    // refuses something it never sees.
    const lists = vocabulary();
    expect(lists.RESERVED_KEYWORDS).toContain("while");
    expect(lists.FORBIDDEN_KEYWORDS).not.toContain("while");
  });
});
