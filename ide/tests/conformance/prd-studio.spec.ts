// `cpt-gearbox-fr-studio` is one requirement with six clauses, and they are in
// very different states. Splitting it into six tests is the point: as one
// requirement it reads as "not done", which says nothing about which part.
//
//   The system MUST provide an Eclipse Theia application that browses the
//   catalogue, edits and resolves a product across profiles, renders the
//   dependency, contract, application, and cluster graphs, answers "why" for a
//   selected decision, and previews and applies generation -- containing no
//   resolution logic of its own.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  closeGraph,
  expect,
  openExplain,
  openGenerate,
  openGraph,
  openGraphView,
  openProduct,
  productSection,
  resetCatalogueView,
  revealCatalogue,
  settled,
  test,
} from "../fixtures/studio";

const REPO = join(__dirname, "../../..");
/**
 * Where Studio generates: the engine's own default, asserted rather than assumed.
 *
 * This was `.gearbox/studio/` while `product.lock` still depended on how the
 * client spelled its source root -- one shared tree would have meant the CLI and
 * Studio rewriting each other's lock. The digest is content-based now, so both
 * produce byte-identical trees and one tree serves both. Asserting the path keeps
 * that a claim: if Studio ever invents its own root again, this fails.
 */
const GENERATE_OUT = join(REPO, ".gearbox/payments-demo/dev");
const GENERATE_OUT_SUFFIX = ".gearbox/payments-demo/dev";

const PRODUCT = "products/payments-demo/product.gdl";

/** `git diff --stat` for the demo description, or "" when it matches HEAD. */
function diffOfProduct(): string {
  return execFileSync("git", ["diff", "--stat", "--", PRODUCT], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
}

/**
 * Accept the edit dialog, and only the edit dialog.
 *
 * `.theia-button.main` is every Theia dialog's default button, so an unscoped
 * click accepts whatever happens to be open -- and the dialog this accepts
 * *writes to a description*.
 */
async function acceptEdit(page: import("@playwright/test").Page): Promise<void> {
  const dialog = page.locator(".dialogBlock", { has: page.locator(".gbx-edit-preview") });
  await expect(dialog, "the edit dialog is not open, so there is nothing to accept").toBeVisible();
  await dialog.locator(".theia-button.main").click();
}


/**
 * One generated file this test may delete and have regenerated.
 *
 * A config file rather than a `.rs`: it is `Ownership::Generated`, so removing it
 * makes the plan say `create`, and restoring it cannot invalidate an incremental
 * Rust build the way touching a source file would.
 *
 * Deleting one file rather than clearing the tree, which is what this test used
 * to do. The tree is now the one §12 step 2 builds and runs, and it carries
 * gigabytes of `target/`; a suite that wipes it costs a rebuild every run. One
 * file is also the stronger assertion -- it proves the plan is accurate per file
 * rather than merely non-empty.
 */
const REGENERABLE = "config/api-gateway.yaml";

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
    const rows = await studio.page.locator(".gbx-widget-catalogue .gbx-row").count();
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

  // The three resolution graphs are checked on the **`prod`** profile, not the
  // default `dev`, and that is not incidental. On `dev` the demo product resolves
  // to two local bindings and one application, so each of these
  // views would render truthfully and show nothing that could have made it wrong.
  // On `prod` the same description resolves to a severed contract edge beside a
  // local one, and to two applications instead of one.
  //
  // What `prod` still cannot show is a gear in two binaries: its extra anchors
  // declare no `deps`, so their closures are singletons. `prd-product.spec.ts`
  // reports that claim as "not observed" and this file does not pretend otherwise.

  test("it renders the contract graph [PRD cpt-gearbox-fr-studio: renders the contract graph]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "prod");
    await openGraphView(studio.page, "contracts");

    const graph = studio.page.locator("[data-graph='contracts']");
    await expect(graph).toBeVisible();

    // `PaymentApi@v1` is bound remote for `local` and `prod` while `@v2` stays
    // local, between the same pair of gears. So this profile must show a severed
    // edge -- the picture that distinguishes a contract edge from a co-location
    // edge, which can never be severed.
    const severed = graph.locator(".gbx-edge[data-remote='true']");
    await expect(severed).toHaveCount(1);
    await expect(severed).toHaveAttribute("data-from", "api-contracts-consumer");
    await expect(severed).toHaveAttribute("data-to", "api-contracts");
    await expect(severed).toHaveClass(/gbx-edge-remote/);
    // Both contracts between this pair travel it. `mode` is derived from
    // placement, never configured, so two bindings between the same pair of gears
    // always agree about it -- which is why one arrow per pair loses nothing.
    await expect(severed).toHaveAttribute(
      "data-contract",
      "api-contracts/PaymentApi@v1 api-contracts/PaymentApi@v2",
    );

    // The same edge, the same description, the other profile: local. That contrast
    // is the claim -- a contract edge is a resolver decision, not a declared fact,
    // and the co-location graph has no equivalent because a `deps` edge cannot
    // change with the profile.
    await openProduct(studio.page, "dev");
    await openGraphView(studio.page, "contracts");
    const local = studio.page.locator("[data-graph='contracts'] .gbx-edge");
    await expect(local).toHaveCount(1);
    await expect(local).toHaveAttribute("data-remote", "false");
    await expect(local).toHaveClass(/gbx-edge-local/);
  });

  test("it renders the application graph [PRD cpt-gearbox-fr-studio: renders the application graph]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "prod");
    await openGraphView(studio.page, "applications");

    // Boxes with gear chips, as plan §9 specifies, rather than the `.gbx-svg` this
    // test guessed at before the view existed: a node-link drawing cannot show one
    // gear inside two boxes, which is the whole content of the view.
    const graph = studio.page.locator("[data-graph='applications']");
    await expect(graph).toBeVisible();
    // Three, not two: `audit` is declared in the description, and `api-contracts`
    // becomes an application of its own because the remote binding needs it
    // reachable across a boundary. An application the resolver *derived* is
    // exactly the kind of thing this view exists to make visible.
    await expect(graph.locator(".gbx-binary")).toHaveCount(3);
    for (const name of ["api-gateway", "audit", "api-contracts"]) {
      await expect(graph.locator(`[data-binary='${name}']`)).toBeVisible();
    }
    // 6 + 1 + 1 = 8, the same eight gears `dev` puts in one binary. On this corpus
    // the split happens to be a partition, and the view says so in words rather
    // than letting the absence of a repeated chip imply that partitions are what
    // the model produces.
    // Seven, not six: the product selects `cluster` explicitly now, because the
    // provider registry every cluster requirement resolves against is projected
    // from that gear and nothing else pulls it in.
    await expect(graph.locator("[data-binary='api-gateway'] [data-gear]")).toHaveCount(7);
    await expect(graph.locator("[data-shared='true']")).toHaveCount(0);
  });

  test("it renders the cluster graph [PRD cpt-gearbox-fr-studio: renders the cluster graph]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "prod");
    await openGraphView(studio.page, "cluster");

    // Observed rather than skipped since `api-contracts-consumer` requires the
    // `event-broker` scope: its crate carries the `impl ClusterProfile` marker
    // that makes the profile name a join key, so a `ResolvedClusterBinding`
    // reaches this view in every profile. The requester was to be
    // `payments-audit` (plan §10), a gear nobody wrote; the requirement moved to
    // a gear that exists rather than waiting for one that does not.
    const drawn = studio.page.locator("[data-graph='cluster']");
    await expect(drawn).toBeVisible();
    await expect(drawn.locator("[data-cluster-requirement]").first()).toBeVisible();
    await expect(drawn.locator("[data-cluster-provider]").first()).toBeVisible();
  });

  /**
   * The empty state still explains itself.
   *
   * It used to be the only thing this file asserted about the cluster view, in
   * the branch that skipped when nothing required a primitive. Requiring one
   * made the graph observable and took that assertion with it -- so the view's
   * own comment claimed the empty state "still says what is missing" with
   * nothing left checking it. A view that renders a blank frame here is
   * indistinguishable from a broken one, which is exactly what the skipped
   * branch existed to guard against.
   *
   * Reaching it now costs an edit: `api-contracts-consumer` is the only
   * requester in the corpus, so the state appears only with it removed. The
   * write goes through the same previewed path everything else uses, and the
   * `finally` restores the description whether or not the assertions held.
   */
  test("the cluster view explains an empty resolution [PRD cpt-gearbox-fr-studio: renders the cluster graph]", async ({
    studio,
  }) => {
    const page = studio.page;
    expect(diffOfProduct(), "the description must start clean").toBe("");

    try {
      await openProduct(page, "dev");
      await revealCatalogue(page);
      await resetCatalogueView(page);

      const toggle = page.locator('[data-toggle-gear="api-contracts-consumer"]');
      await expect(toggle).toHaveAttribute("data-in-product", "true", { timeout: 60_000 });
      await toggle.click();
      await acceptEdit(page);
      await expect(toggle).toHaveAttribute("data-in-product", "false", { timeout: 60_000 });

      await openGraphView(page, "cluster");
      await expect(page.locator("[data-graph='cluster']")).toHaveCount(0);
      const empty = page.locator(".gbx-widget-graph .gbx-cluster-empty");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("no gear in the catalogue currently requires it");
    } finally {
      // The Graph goes away *before* the reload, and `settled` runs after it.
      // Restoring the description is what this reload is for; leaving a screen
      // that takes the room in front of it made the restorer re-activate the
      // Graph seconds into the next test, which then waited a full minute for a
      // Product header that was behind it. `closeGraph` says why in full.
      await closeGraph(page);
      execFileSync("git", ["checkout", "--", PRODUCT], { cwd: REPO });
      await page.reload();
      await settled(page);
    }
  });

  test("it answers why for a selected decision [PRD cpt-gearbox-fr-studio: answers why]", async ({
    studio,
  }) => {
    // §9 expected a `gearbox/product/explain` call. There is none and none is
    // needed: `ResolveResult` carries the whole `ExplanationGraph` with the
    // resolution, so "why" costs no second round trip and cannot answer about a
    // different resolution than the one on screen. The substance is checked in
    // `prd-explain.spec.ts`; this clause is only that the view exists and answers.
    await openProduct(studio.page, "prod");
    await openExplain(studio.page);
    // Bindings are on the Topology stage; the panel has four since 2026-09-07.
    await productSection(studio.page, "topology");
    await studio.page.click("[data-binding]");
    await expect(studio.page.locator("[data-explaining]")).toBeVisible();
    await expect(studio.page.locator(".gbx-step").first()).toBeVisible();
  });

  test("it previews and applies generation [PRD cpt-gearbox-fr-generate-preview]", async ({
    studio,
  }) => {
    // Remove one generated file so the plan has something to create. Without
    // this the tree is already current and every line reads `unchanged`, which
    // proves nothing about applying.
    rmSync(join(GENERATE_OUT, REGENERABLE), { force: true });

    await openProduct(studio.page, "dev");
    await openGenerate(studio.page);
    await expect(studio.page.locator("[data-plan-path]").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(studio.page.locator(".gbx-generate")).toBeVisible();

    // The output root is part of the claim, not an implementation detail the test
    // may quietly follow.
    await expect(studio.page.locator(".gbx-generate")).toHaveAttribute(
      "data-out-root",
      new RegExp(`${GENERATE_OUT_SUFFIX.replace(/\./g, "\\.")}$`),
    );

    const line = studio.page.locator(`[data-plan-path="${REGENERABLE}"]`);
    await expect(line).toHaveAttribute("data-action", "create");

    const porcelain = (): string =>
      execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
    const before = porcelain();
    expect(
      existsSync(join(GENERATE_OUT, REGENERABLE)),
      "the preview must not have written the file it plans to create",
    ).toBe(false);
    expect(porcelain(), "a preview must not change the git tree").toBe(before);

    await studio.page.locator("[data-apply]").click();
    await expect(studio.page.locator("[data-written-count]")).toBeVisible({ timeout: 60_000 });
    const written = Number(
      await studio.page.locator("[data-written-count]").getAttribute("data-written-count"),
    );
    expect(written).toBeGreaterThan(0);
    expect(existsSync(join(GENERATE_OUT, REGENERABLE))).toBe(true);
    await expect(line).toHaveAttribute("data-action", "create");

    // Applying again writes nothing and every line reads `unchanged`. Not a
    // nicety: ADR-0010 requires generation to be idempotent by content, and this
    // is the only place that is observable from the interface.
    await studio.page.locator("[data-apply]").click();
    await expect(studio.page.locator("[data-written-count]")).toHaveAttribute(
      "data-written-count",
      "0",
      { timeout: 60_000 },
    );
    const actions = await studio.page
      .locator("[data-plan-path]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-action")));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action === "unchanged")).toBe(true);
  });

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
