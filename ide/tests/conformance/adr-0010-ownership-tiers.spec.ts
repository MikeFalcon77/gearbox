// ADR cpt-gearbox-adr-authoring-ownership-tiers.
//
// Tier 0 scaffolding (New Gear + FilePlan preview) is what this file covers for
// the writing surface the ADR decided. Most of the Confirmation section is not
// browser-observable and belongs in Rust tests beside the writer.
//
// Tier 1's own claim -- `product.lock` presented read-only -- *is* built, and is
// tested in `adr-0011-workspace-and-scm.spec.ts` beside the workspace that makes
// a lock file openable at all.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  expect,
  expectContext,
  openGenerate,
  openPalette,
  openProduct,
  resetCatalogueView,
  revealCatalogue,
  revealInspector,
  settled,
  test,
} from "../fixtures/studio";

const REPO = join(__dirname, "../../..");
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
 * click accepts whatever happens to be open. That matters here more than
 * elsewhere: the dialog this file accepts *writes to a description*, so
 * confirming a stranger's dialog would write something no test asked for. The
 * preview pane is what makes it ours.
 */
async function acceptEdit(page: import("@playwright/test").Page): Promise<void> {
  const dialog = page.locator(".dialogBlock", { has: page.locator(".gbx-edit-preview") });
  await expect(dialog, "the edit dialog is not open, so there is nothing to accept").toBeVisible();
  await dialog.locator(".theia-button.main").click();
}

test.describe("what the tool may write", () => {

  test(
    "Studio offers a command to scaffold a new gear [ADR-0010 tier 0]",
    async ({ studio }) => {
      // Tier 0 is the permitted case the ADR is most confident about -- "a tool
      // may freely create new files" -- and it is the entry point for two of the
      // three usage scenarios the documents have to cover: a new gear, and a
      // plugin, either in this repo or another.
      // Prefer the shared palette helper: a single F1 is often lost while Theia
      // is still installing keybindings.
      await openPalette(studio.page);
      await studio.page.keyboard.type("New Gear", { delay: 20 });
      await expect(
        studio.page
          .locator(`.quick-input-list [role="option"]`)
          .filter({ hasText: "New Gear" })
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await studio.page.keyboard.press("Escape");
    },
  );

  test(
    "a scaffold shows its file plan before writing anything [ADR-0010 §Consequences: a preview is not optional]",
    async ({ freshStudio }) => {
      // "Every surveyed tool has `--dry-run`; the plan's `FilePlan[]` with
      // create|update|unchanged|conflict already provides the shape, so
      // scaffolding reuses the generator's preview rather than inventing one."
      const { page } = freshStudio;
      await settled(page);
      await expectContext(page, "home");
      // Wait for the engine: New Gear is disabled until initialize succeeds.
      await expect(page.locator(".gbx-start")).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-start-action="new-gear"]:not([disabled])')).toBeVisible({
        timeout: 60_000,
      });
      await page.locator('[data-start-action="new-gear"]').click();
      await expect(page.locator(".gbx-file-plan")).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator(
          '.gbx-file-plan [data-plan-path$="gear.gdl"], .gbx-file-plan [data-plan-path="gear.gdl"]',
        ),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('.gbx-file-plan [data-action="create"]').first()).toBeVisible();
    },
  );

  test(
    "a scaffold has three shapes, and each offers what its kind needs [ADR-0010 tier 0]",
    async ({ freshStudio }) => {
      // Of the fourteen described gears in the corpus, seven are plugins -- they
      // fill an extension point an SDK crate declares -- and none is a bare
      // crate with a name. One shape for all of them left a plugin author to
      // find out what else a plugin needs.
      //
      // What differs is which declarations the file *offers*, not generated
      // code: a scaffold has no compiler and does not know where the toolkit or
      // an SDK lives. And for a plugin the two fields that matter are offered
      // **commented**, because `plugin_interface` naming no `pub trait` is
      // refused (GBX0516) and an `sdk` locator pointing nowhere makes the gear
      // fail to load -- so a placeholder would hand its author a description to
      // repair rather than one to fill in.
      const { page } = freshStudio;
      await settled(page);
      await expect(page.locator('[data-start-action="new-gear"]:not([disabled])')).toBeVisible({
        timeout: 60_000,
      });
      await page.locator('[data-start-action="new-gear"]').click();

      const kind = page.locator("[data-create-gear-kind]");
      await expect(kind).toBeVisible({ timeout: 30_000 });
      const shapes = await kind
        .locator("option")
        .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
      expect(shapes).toEqual(["service", "plugin", "minimal"]);

      // Every shape writes the same three files: the shape is what the
      // description says, not how many files there are. `data-plan-blake3` is
      // how the test sees that `kind` reached the scaffold -- FilePlan carries
      // no content, and the preview lists paths only.
      const blake3Of = async (rel: string): Promise<string> => {
        const row = page.locator(`.gbx-create-preview [data-plan-path="${rel}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        return (await row.getAttribute("data-plan-blake3")) ?? "";
      };
      const paths = async (): Promise<string[]> =>
        page
          .locator(".gbx-create-preview [data-plan-path]")
          .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-plan-path") ?? ""));
      await expect(page.locator(".gbx-create-preview [data-plan-path]").first()).toBeVisible({
        timeout: 30_000,
      });
      expect((await paths()).sort()).toEqual(["Cargo.toml", "gear.gdl", "src/lib.rs"]);
      const serviceGdl = await blake3Of("gear.gdl");
      expect(serviceGdl).not.toEqual("");

      await kind.selectOption("plugin");
      await expect
        .poll(async () => blake3Of("gear.gdl"), { timeout: 30_000 })
        .not.toEqual(serviceGdl);
      expect((await paths()).sort()).toEqual(["Cargo.toml", "gear.gdl", "src/lib.rs"]);
      const pluginGdl = await blake3Of("gear.gdl");
      expect(pluginGdl).not.toEqual("");

      await kind.selectOption("minimal");
      await expect
        .poll(async () => blake3Of("gear.gdl"), { timeout: 30_000 })
        .not.toEqual(pluginGdl);
      const minimalGdl = await blake3Of("gear.gdl");
      expect(minimalGdl).not.toEqual("");
      expect(minimalGdl).not.toEqual(serviceGdl);
      await page.locator("[data-create-gear-cancel]").click();
    },
  );

  test(
    "choosing a host writes the plugin's locator instead of commenting it [ADR-0010 tier 0]",
    async ({ freshStudio }) => {
      // **The claim the `Kind` control needed to earn.** `Plugin` chose a
      // different `gear.gdl` all along, but every declaration in it was a
      // comment -- an `sdk` pointing at a directory that does not exist makes the
      // gear fail to load -- so a UX pass reported the choice as doing nothing,
      // and it was right about what a person could see.
      //
      // A host picked out of the loaded catalogue is a locator the engine itself
      // projected, so there is nothing left to protect against and it is written
      // live. The preview shows the description's own text now, because the three
      // file *paths* are identical for all three shapes.
      const { page } = freshStudio;
      await settled(page);
      await expect(page.locator('[data-start-action="new-gear"]:not([disabled])')).toBeVisible({
        timeout: 60_000,
      });
      await page.locator('[data-start-action="new-gear"]').click();
      await expect(page.locator("[data-create-gear-kind]")).toBeVisible({ timeout: 30_000 });

      await page.locator("[data-create-gear-kind]").selectOption("plugin");
      const gdl = page.locator("[data-create-gear-gdl]");
      await expect(gdl).toBeVisible({ timeout: 30_000 });

      // With no host the locator is a comment -- and the panel says why rather
      // than disabling Create over it, because "I know it is a plugin but not yet
      // whose" is a real state to be in.
      await expect
        .poll(async () => (await gdl.textContent()) ?? "", { timeout: 30_000 })
        .toContain("# sdk = cargo(");
      // **Asserted, not only asserted about.** The sentence above was the whole
      // claim for this state, and it checked the `gear.gdl` alone -- so the
      // difference between "the commented locator is the right answer" and "the
      // locator was silently dropped and Create is live anyway" was invisible.
      // `[data-create-gear-locator]` is the element the other three states
      // render; `none` is the one arm that renders nothing.
      await expect(page.locator("[data-create-gear-locator]")).toHaveCount(0);
      await expect(page.locator("[data-create-gear-submit]")).toBeEnabled({ timeout: 30_000 });

      // The picker is grouped by host and labelled by the trait, because the
      // trait is the identity: the key is `sdk_lib::TraitIdent` and never a
      // derived short name, which is the mistake GBX0206 exists to catch.
      const picker = page.locator("[data-create-gear-point]");
      const hosts = await picker
        .locator("optgroup")
        .evaluateAll((groups) => groups.map((g) => g.getAttribute("label") ?? ""));
      expect(hosts.length, "no host in the catalogue declares an extension point").toBeGreaterThan(
        0,
      );
      const first = await picker.locator("optgroup option").first().getAttribute("value");
      expect(first).toContain("::");

      await picker.selectOption(String(first));
      // Live: the same line, no longer commented. Polled because the preview is
      // debounced -- and the debounce is why it carries an epoch guard, without
      // which the answer for `service` could arrive last and win.
      await expect
        .poll(async () => (await gdl.textContent()) ?? "", { timeout: 30_000 })
        .toMatch(/^\s{4}sdk = cargo\(/m);
      expect((await gdl.textContent()) ?? "", "a link line needs the library identifier").toMatch(
        /lib = "[a-z0-9_]+"/,
      );
      await expect(page.locator("[data-create-gear-locator]")).toHaveCount(0);

      // **And the refusal is named beside the picker that promised the
      // locator.** Be exact about what is new: Create was already disabled for a
      // relative destination, because the engine refuses one -- so the preview
      // pane went blank and nothing said which control was at fault. The reason
      // here is computed from the panel's own state, which is why it does not
      // wait on a dry run, and it is the only observable one of the four: the
      // other three need a second volume, an SDK outside its source root, or a
      // catalogue reload that drops a host.
      await page.locator("[data-create-gear-destination]").fill("gears");
      const refusal = page.locator('[data-create-gear-locator="blocked"]');
      await expect(refusal).toBeVisible({ timeout: 30_000 });
      await expect(refusal).toContainText("absolute path");
      await expect(page.locator("[data-create-gear-submit]")).toBeDisabled();
    },
  );

  test("a generated composition crate carries a header naming its generator [ADR-0010 tier 2]", async ({
    studio,
  }) => {
    // Tier 2 is "tool, entirely, with a header". The header is what tells a
    // reader not to edit the file, and it is the only thing standing between
    // tier 2 and tier 5. The files were already generated; what was missing
    // was a place in the UI to open one.
    await openProduct(studio.page, "dev");
    await openGenerate(studio.page);
    await studio.page
      .locator('[data-plan-path="processes/api-gateway/src/registered_gears.rs"]')
      .click();
    // The preview is a diff editor, so `.monaco-editor` matches three hosts
    // (gutter, original, modified). The header lives on the proposed side.
    await expect(
      studio.page.locator(".monaco-editor.modified-in-monaco-diff-editor"),
    ).toContainText("GENERATED", { timeout: 60_000 });
  });
});

test.describe("tier 3: a description edited surgically", () => {
  // ADR-0010's tier 3 is "structured manifests | tool edits surgically |
  // **Permitted**", and its survey calls that "the single most universal
  // behaviour in the set -- `cargo add`, `dotnet package add`, Gazelle". A GDL
  // description qualifies because GDL cannot be logic: the dialect refuses every
  // branching construct (`cpt-gearbox-fr-gdl-declarative`), so a `use_gear(...)`
  // entry is a data entry in a list, and the tier-5 prohibition on rewriting
  // human logic does not reach it.
  //
  // The round trip runs against `products/payments-demo/product.gdl` itself,
  // deliberately: 29 of its 105 lines are comments carrying the reasoning for the
  // description, and an edit that survives them is the entire claim. A copy with
  // no comments in it would prove nothing.
  //
  // Undoing happens *through the interface*, not with `git checkout`. Restoring
  // the file behind the running application leaves its product store holding the
  // edited description, and the next click then asks the engine for a change the
  // file no longer needs -- which the engine correctly declines, with no dialog
  // to confirm. So git only appears in `finally`, as a net under a failed
  // assertion, and the page is reloaded with it so no stale state outlives the
  // test.

  test("a description edit shows the line before writing it [ADR-0010 §Consequences: a preview is not optional]", async ({
    studio,
  }) => {
    // "A preview is not optional. Every surveyed tool has `--dry-run`." This test
    // takes the preview and cancels, so it asserts the harder half: that nothing
    // is on disk until the person agrees. Catalogue `+` opens the Add Gear
    // configurator; the dry-run lives in that panel (not a modal).
    expect(diffOfProduct(), "the description must start clean for this to mean anything").toBe("");

    await openProduct(studio.page, "dev");
    await revealCatalogue(studio.page);
    await resetCatalogueView(studio.page);

    const toggle = studio.page.locator('[data-toggle-gear="cluster"]');
    await expect(toggle).toHaveAttribute("data-in-product", "false");
    await toggle.click();

    await expect(studio.page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await expect(studio.page.locator("[data-add-gear-flow] .gbx-edit-preview")).toContainText(
      'use_gear("cluster"',
      { timeout: 30_000 },
    );
    expect(diffOfProduct(), "the dry run must not have written anything").toBe("");

    await studio.page.locator("[data-add-gear-cancel]").click();
    await expect(studio.page.locator("[data-add-gear-flow]")).toHaveCount(0);
    expect(diffOfProduct(), "cancelling must leave the file alone").toBe("");
    await expect(toggle).toHaveAttribute("data-in-product", "false");
  });

  test("adding a gear inserts one line, and removing it restores the file exactly [ADR-0010 tier 3]", async ({
    studio,
  }) => {
    expect(diffOfProduct()).toBe("");

    try {
      await openProduct(studio.page, "dev");
      await revealCatalogue(studio.page);
      await resetCatalogueView(studio.page);

      const toggle = studio.page.locator('[data-toggle-gear="cluster"]');
      await toggle.click();
      await expect(studio.page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
      await expect(studio.page.locator("[data-add-gear-submit]")).toBeEnabled({ timeout: 30_000 });
      await studio.page.locator("[data-add-gear-submit]").click();
      await expect(studio.page.locator("[data-add-gear-flow]")).toHaveCount(0, { timeout: 30_000 });
      // The product is re-read and re-resolved before the toggle can change, so
      await expect(toggle).toHaveAttribute("data-in-product", "true", { timeout: 60_000 });
      expect(diffOfProduct()).not.toBe("");

      await toggle.click();
      await acceptEdit(studio.page);
      await expect(toggle).toHaveAttribute("data-in-product", "false", { timeout: 60_000 });
      expect(diffOfProduct()).toBe("");
    } finally {
      if (diffOfProduct() !== "") {
        execFileSync("git", ["checkout", "--", PRODUCT], { cwd: REPO });
        await studio.page.reload();
      }
    }
  });
});

test.describe("typed config from schema (Phase 7)", () => {
  /**
   * The claim this file carried as a `test.fixme` for two milestones. What
   * closed it was not the projection alone but the corpus: `config_schema`
   * declared by nobody meant there was nothing to project, so the feature would
   * have been a guess. `tenant-resolver` declares one exposed field now.
   */
  test("Inspector projects config struct fields as typed controls [Phase 7]", async ({
    studio,
  }) => {
    const page = studio.page;
    await openProduct(page, "dev");
    await revealCatalogue(page);
    await resetCatalogueView(page);
    await page.locator(".gearbox-catalogue .gbx-row", { hasText: "api-gateway" }).click();
    await revealInspector(page);

    await expect(page.locator('[data-gear-config="api-gateway"]')).toBeVisible({
      timeout: 60_000,
    });

    // The five settings its description exposes, out of the fourteen the struct
    // declares -- curation is the half a description contributes.
    const bind = page.locator('[data-config-field="bind_addr"]');
    await expect(bind).toBeVisible();
    await expect(bind).toHaveAttribute("data-config-field-kind", "str");

    // A bool is a checkbox because Rust says it is a bool, not because anything
    // here knows what `enable_docs` means.
    const docs = page.locator('[data-config-field="enable_docs"]');
    await expect(docs).toHaveAttribute("data-config-field-kind", "bool");
    await expect(docs.locator('input[type="checkbox"]')).toBeVisible();

    // Nested fields carry no control and are not offered as one.
    await expect(page.locator('[data-config-field="openapi"]')).toHaveCount(0);
  });

  /**
   * The field's *type* decides the control, and the type is read from Rust. A
   * string field gets a text input rather than the untyped key/value row that
   * stood here before.
   */
  test("a field says where its value came from, and an explicit one can be reset [Phase 7]", async ({
    studio,
  }) => {
    // Three states a person acts on differently, and a form that renders them
    // identically invites someone to override the resolver by accident: what the
    // *description* sets can be reset, what the *resolver* derived should
    // usually be left alone (GBX0114 is the engine saying so), and what nothing
    // sets is the gear's own default -- already the control's placeholder.
    //
    // All three are read from what is on screen: the intent, the resolution, and
    // the difference between them. No new wire field.
    await openProduct(studio.page, "dev");
    await revealCatalogue(studio.page);
    await resetCatalogueView(studio.page);
    await studio.page.locator(".gearbox-catalogue .gbx-row", { hasText: "api-gateway" }).click();
    await revealInspector(studio.page);
    const config = studio.page.locator('[data-gear-config="api-gateway"]');
    await config.waitFor({ state: "visible", timeout: 60_000 });

    // `bind_addr` is the derived case in this corpus: the resolver assigns the
    // port from the process topology, and the demo description sets nothing.
    const bindAddr = config.locator('[data-config-field="bind_addr"]');
    await expect(bindAddr).toBeVisible();
    const provenance = await bindAddr.getAttribute("data-config-provenance");
    expect(["derived", "default", "explicit"]).toContain(provenance);
    // Whatever it is, it is *said*: the label is the claim, not the attribute.
    await expect(bindAddr.locator("[data-config-provenance-label]")).toBeVisible();

    // Reset is offered for an explicit value and only for one, so the flow is:
    // type, watch it become explicit, reset, watch the offer go.
    const field = config.locator('[data-config-field="prefix_path"]');
    await expect(field).toBeVisible();
    await field.locator("input").fill("/demo");
    await expect(field).toHaveAttribute("data-config-provenance", "explicit");
    await expect(field.locator("[data-config-reset]")).toBeVisible();
    await field.locator("[data-config-reset]").click();
    await expect(field.locator("[data-config-reset]")).toHaveCount(0);
    // Reset means "the gear's default", not "derived": the last resolution still
    // holds the old key, and without a `removed` branch provenance fell through
    // to derived and lied about who set it.
    await expect(field).toHaveAttribute("data-config-provenance", "default");
    await studio.page.locator(".gbx-toolbar [data-draft-discard]").click();
  });

  test("a projected string field renders as a typed control [Phase 7]", async ({ studio }) => {
    const page = studio.page;
    await openProduct(page, "dev");
    const add = page.locator("[data-add-gear]");
    await expect(add).toBeVisible({ timeout: 60_000 });
    await add.click();
    await expect(page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-add-gear-select]").selectOption("tenant-resolver");

    const field = page.locator('[data-config-field="vendor"]');
    await expect(field).toBeVisible({ timeout: 60_000 });
    await expect(field).toHaveAttribute("data-config-field-kind", "str");
    // The default is projected from `impl Default`, not typed into the gdl.
    await expect(field.locator("input")).toHaveAttribute("placeholder", "constructorfabric");
    await page.locator("[data-add-gear-cancel]").click();
  });
});
