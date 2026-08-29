// `cpt-gearbox-fr-studio` is one requirement with six clauses, and they are in
// very different states. Splitting it into six tests is the point: as one
// requirement it reads as "not done", which says nothing about which part.
//
//   The system MUST provide an Eclipse Theia application that browses the
//   catalogue, edits and resolves a product across profiles, renders the
//   dependency, contract, process, and cluster graphs, answers "why" for a
//   selected decision, and previews and applies generation -- containing no
//   resolution logic of its own.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, openGraph, openProduct, test } from "../fixtures/studio";

const STUDIO_SRC = join(__dirname, "../../gearbox-studio/src");

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test.describe("cpt-gearbox-fr-studio, clause by clause", () => {
  test("it browses the catalogue [PRD cpt-gearbox-fr-studio: browses the catalogue]", async ({
    studio,
  }) => {
    const rows = await studio.page.locator(".gearbox-catalogue .gbx-row").count();
    expect(rows).toBeGreaterThan(0);
    const detail = await studio.detailOf("API Gateway");
    expect(detail).toContain("api-gateway");
  });

  test("it renders the dependency graph [PRD cpt-gearbox-fr-studio: renders the dependency graph]", async ({
    studio,
  }) => {
    // `openGraph`, not the command directly: the view command is a *toggle*, and
    // this suite shares one loaded application across the read-only tests, so a
    // file that ran earlier may already have opened it.
    await openGraph(studio.page);
    await expect(studio.page.locator(".gbx-svg")).toBeVisible();
    const nodes = await studio.page.locator(".gbx-node-label").count();
    expect(nodes).toBeGreaterThan(0);
  });

  test("it resolves a product across profiles [PRD cpt-gearbox-fr-studio: edits and resolves a product]", async ({
    studio,
  }) => {
    // The *editing* half is the `.gdl` editor Theia already provides -- there is
    // deliberately no form, because a form would be a second way to express a
    // description and the two would drift. What the view adds is the half a text
    // editor cannot show: what the description resolves to, per profile.
    await openProduct(studio.page, "dev");
    await expect(studio.page.locator(".gbx-product")).toBeVisible();
    const profiles = await studio.page.locator("[data-profile]").allTextContents();
    expect(profiles.length).toBeGreaterThan(1);
    await expect(studio.page.locator("[data-resolved-profile='dev']")).toBeVisible();
  });

  test.fixme(
    "it renders the contract graph [PRD cpt-gearbox-fr-studio: renders the contract graph]",
    async ({ studio }) => {
      await expect(studio.page.locator(".gbx-svg[data-graph='contracts']")).toBeVisible();
    },
  );

  test.fixme(
    "it renders the process graph [PRD cpt-gearbox-fr-studio: renders the process graph]",
    async ({ studio }) => {
      await expect(studio.page.locator(".gbx-svg[data-graph='processes']")).toBeVisible();
    },
  );

  test.fixme(
    "it renders the cluster graph [PRD cpt-gearbox-fr-studio: renders the cluster graph]",
    async ({ studio }) => {
      await expect(studio.page.locator(".gbx-svg[data-graph='cluster']")).toBeVisible();
    },
  );

  test.fixme(
    "it answers why for a selected decision [PRD cpt-gearbox-fr-explain]",
    async ({ studio }) => {
      // `ResolveResult` already carries an `ExplanationGraph`, recorded at the
      // moment each choice is made, and the wire type is generated. Nothing
      // renders it.
      await expect(studio.page.locator(".gbx-explain")).toBeVisible();
    },
  );

  test.fixme(
    "it previews and applies generation [PRD cpt-gearbox-fr-generate-preview]",
    async ({ studio }) => {
      // The engine still reports `capabilities.generate: false`, so unlike the
      // product clause this one is honestly blocked rather than merely unbuilt.
      await expect(studio.page.locator(".gbx-generate")).toBeVisible();
    },
  );

  test("the resolver notice is gone, and gone because the engine says so [PRD cpt-gearbox-fr-rpc-api]", async ({
    studio,
  }) => {
    // The notice was driven by the engine's own `capabilities.resolve`, which is
    // why it needed no edit when M4 landed -- it disappeared on its own. That is
    // the property worth asserting: not that the text is right, but that it is
    // absent, and absent for the right reason.
    await studio.detailOf("API Gateway");
    await expect(studio.page.locator(".gbx-gap")).toHaveCount(0);
  });

  test("it contains no resolution logic of its own [PRD cpt-gearbox-fr-studio: no resolution logic]", () => {
    // The check looks for `BindingMechanism` *literals* in the frontend, and the
    // choice of signal is the whole design of this test.
    //
    // The first version forbade the type names -- `ResolvedProcess`,
    // `ResolvedBindingMode` -- and it failed the moment the Product view was
    // built, because rendering a resolution means importing the types of the
    // thing you are rendering. That was a false positive, not a finding: reading
    // `binding.mechanism` and printing it is consumption, which the clause
    // permits and in fact requires.
    //
    // A mechanism literal is different. It names the real code path the runtime
    // takes, the resolver derives it from placement, and there is no legitimate
    // reason for a client to write one down: a frontend that renders a mechanism
    // prints the value it was given, while a frontend that *decides* one has to
    // name it. So the literals are the line, and the types are not.
    //
    // It also deliberately does not flag `closureOf` in the graph widget, which
    // computes a transitive closure over projected `colocated_deps`. Co-location
    // is link-time and no resolution changes it, so that is presentation of a
    // projected fact rather than a decision.
    const mechanisms = [
      "colocated-local",
      "consumes-static",
      "consumes-directory",
      "provides-client-wiring",
    ];
    const offenders = sources(join(STUDIO_SRC, "browser"))
      .concat(sources(join(STUDIO_SRC, "node")))
      .flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return mechanisms.filter((m) => text.includes(`"${m}"`)).map((m) => `${file}: "${m}"`);
      });
    expect(offenders).toEqual([]);
  });
});
