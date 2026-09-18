// Product-session chrome and the Add Gear configurator (Phases 4–5).

import type { Page } from "@playwright/test";

import {
  configureGear,
  expect,
  openAdvancedKeys,
  openProduct,
  openProductById,
  resetCatalogueView,
  revealCatalogue,
  test,
} from "../fixtures/studio";

test.describe("product session and Add Gear", () => {
  test("Product has an Add Gear button that opens the configurator", async ({ studio }) => {
    await openProduct(studio.page, "dev");
    const add = studio.page.locator("[data-add-gear]");
    await expect(add).toBeVisible({ timeout: 60_000 });
    await add.click();
    await expect(studio.page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await studio.page.locator("[data-add-gear-cancel]").click();
  });

  test("catalogue + opens the Add Gear configurator, not an immediate write dialog", async ({
    studio,
  }) => {
    await openProduct(studio.page, "dev");
    await revealCatalogue(studio.page);
    await resetCatalogueView(studio.page);

    const toggle = studio.page.locator('[data-toggle-gear="tenant-resolver"]');
    await expect(toggle).toHaveAttribute("data-in-product", "false");
    await toggle.click();

    await expect(studio.page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    // **The confirmation by name, not by shape.** This read "a `.dialogBlock`
    // containing a preview", which distinguished the configurator from the write
    // confirmation only while the configurator was a panel. Both are dialogs
    // showing what would be written now, so the claim -- a catalogue `+` opens
    // the configurator and writes nothing -- is asserted against the
    // confirmation's own class.
    await expect(studio.page.locator(".gbx-edit-confirm")).toHaveCount(0);
    await expect(studio.page.locator("[data-add-gear-flow] .gbx-edit-preview")).toContainText(
      "tenant-resolver",
      { timeout: 30_000 },
    );
    await studio.page.locator("[data-add-gear-cancel]").click();
  });
});

// Phase 5's point: the panel answers "what does this do to my product" before it
// is asked to do it. Section 6 subtracts the resolution on screen from the one
// the engine computes for the proposed description.
test.describe("Add Gear shows consequences before the write", () => {
  /** Open the configurator on a gear the demo product does not name. */
  async function configure(page: Page, gear: string): Promise<void> {
    await openProduct(page, "dev");
    const add = page.locator("[data-add-gear]");
    await expect(add).toBeVisible({ timeout: 60_000 });
    await add.click();
    await expect(page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await page.locator(`[data-add-gear-select="${gear}"]`).click();
  }

  test("the closure a gear joins is visible before anything is written", async ({ studio }) => {
    const page = studio.page;
    await configure(page, "tenant-resolver");

    // Named by the product-to-be, so the reason reads "asked for". The corpus's
    // co-located dependencies (grpc-hub, types-registry, cluster) are already in
    // this product's closure through api-gateway, which is why the arrival here is
    // the gear itself -- the section reports what actually changes, not a fixed list.
    const arrival = page.locator('[data-impact-gear="tenant-resolver"]');
    await expect(arrival).toBeVisible({ timeout: 60_000 });
    await expect(arrival).toContainText("asked for");

    // Nothing has been written: the description still does not name it.
    await expect(page.locator("[data-add-gear-flow] .gbx-edit-preview")).toContainText(
      "tenant-resolver",
    );
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("choosing a plugin changes what the closure would pull in", async ({ studio }) => {
    const page = studio.page;
    await configure(page, "tenant-resolver");
    await expect(page.locator('[data-impact-gear="tenant-resolver"]')).toBeVisible({
      timeout: 60_000,
    });
    // The plugin is a gear; before it is chosen it is not in the closure.
    await expect(page.locator('[data-impact-gear="single-tenant-tr-plugin"]')).toHaveCount(0);

    await page.locator("[data-add-gear-plugin-pick]").selectOption("single-tenant-tr-plugin");
    await page.locator("[data-add-gear-plugin-add]").click();

    await expect(page.locator('[data-impact-gear="single-tenant-tr-plugin"]')).toBeVisible({
      timeout: 60_000,
    });
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("a gear that declares no extension point is offered no plugin [plan §9.1: the surface offers only what is applicable]", async ({
    studio,
  }) => {
    // The UX pass of 2026-09-07 selected `types-registry`, read "Extension
    // points: none declared." three lines above a list of every plugin in the
    // catalogue, chose `oidc-authn-plugin`, and was told it would join the
    // closure as a "plugin of types-registry". The data to refuse that was
    // already on the wire in both directions -- the host's `extension_points`
    // and the plugin's `fills.point` -- so the offer was the defect.
    const page = studio.page;
    await configure(page, "types-registry");
    await expect(page.locator("[data-add-gear-plugins]")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-add-gear-plugins]")).toContainText("none declared");
    await expect(page.locator("[data-add-gear-plugin-pick]")).toHaveCount(0);
    await expect(page.locator("[data-add-gear-plugins-none]")).toBeVisible();
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("a host is offered only the plugins that fill its own points [plan §9.1: the surface offers only what is applicable]", async ({
    studio,
  }) => {
    // `tenant-resolver` declares one point, and three gears in the corpus fill
    // it; `oidc-authn-plugin` fills a different SDK's trait and must not be on
    // offer here. The join key is the pair, never a derived short name -- see
    // `common/extension-points.ts`.
    const page = studio.page;
    await configure(page, "tenant-resolver");
    const picker = page.locator("[data-add-gear-plugin-pick]");
    await expect(picker).toBeVisible({ timeout: 60_000 });
    const offered = await picker.locator("option").evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== ""),
    );
    expect(offered).toContain("single-tenant-tr-plugin");
    expect(offered).not.toContain("oidc-authn-plugin");
    expect(offered).not.toContain("static-authn-plugin");
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("What will be written names every staged edit, not just the gear [plan §9.1: the review is the exact serialization]", async ({
    studio,
  }) => {
    // The UX pass staged a feature, a config key and a plugin and read a preview
    // that said only `+ use_gear("types-registry", source = "gears-rust")`. It
    // could not have said more: the follow-up edits name a gear the file does not
    // have yet, so `applyEdits` refused them and the panel dry-ran the addition
    // alone -- which also meant the commit wrote twice.
    // `ProductEdit::AddGear` puts the addition in the same batch, so the dry
    // run's text *is* what would be written.
    const page = studio.page;
    await configure(page, "tenant-resolver");
    const preview = page.locator("[data-add-gear-flow] .gbx-edit-preview");
    await expect(preview).toContainText("tenant-resolver", { timeout: 60_000 });

    // **A plugin is what this batch can still stage, and config is not.**
    // Attaching a plugin is a consequence of *this* addition -- a plugin is a
    // gear, so it joins the closure -- which is why it belongs to the preview.
    // Config and features change nothing about which gears arrive, so they wait
    // for the product; `[plan §9.1: checked where the caret is]` reads them
    // there now. What this claim is about is unchanged: the review is the exact
    // serialization of the whole batch, not of the gear alone.
    await page.locator("[data-add-gear-plugin-pick]").selectOption("single-tenant-tr-plugin");
    await page.locator("[data-add-gear-plugin-add]").click();

    await expect(preview).toContainText("single-tenant-tr-plugin", { timeout: 60_000 });
    await expect(preview, "the gear is still named beside what was staged onto it").toContainText(
      "tenant-resolver",
    );
    await page.locator("[data-add-gear-cancel]").click();
  });

  test(
    "free keys are behind Advanced, and a bad value is refused at the field [plan §9.1: checked where the caret is]",
    async ({ studio }) => {
      // Two halves of the same complaint. A gear with no schema still offered a
      // bare `Add key`, so the obvious thing to do with it was type a key the
      // gear does not read -- and the only answer was a refusal about the whole
      // proposal, from the other side of the screen. A control that is available
      // invites use.
      //
      // And the checks that *are* possible now happen at the field. Narrow on
      // purpose: `ConfigFieldDecl` carries no pattern and no bounds, so only what
      // the declaration states is checkable -- a rule this repository does not
      // have, enforced against a gear that accepts the value, is the
      // `prefix_path` mistake.
      // **`event-broker`, because `tenant-resolver` has no enum and this claim
      // needs one.** The second half of it reported `⚪ not observed` for as long
      // as it existed -- "this gear exposes no enum field, so there is no closed
      // set to leave" -- which was true of the gear the test happened to pick,
      // not of the corpus: `event-broker.mode` is a `DeploymentMode`, and
      // `ux-navigation.spec.ts` already adds that gear. A claim skipped by its
      // own choice of subject is a claim nobody was watching.
      // In the product, on the description that names `event-broker`: the
      // advanced disclosure and the typed controls are `GearSettings`, and the
      // add dialog stopped rendering them when configuration moved to the gear.
      const { page } = studio;
      await openProductById(page, "configurable-gears", "dev");
      const form = await configureGear(page, "event-broker");
      const config = '.gbx-composition-settings [data-gear-config="event-broker"]';

      // Folded, and the free-key input is not reachable until it is opened.
      //
      // **Two disclosures, not one.** `GearSettings` has a second
      // `details.gbx-advanced` for a feature name outside the projected table,
      // so the count is 2 here where the panel had 1. `openAdvancedKeys` takes
      // the first, which is the config one -- the order is the claim's, and
      // asserting the count keeps a third from appearing unnoticed.
      const advanced = form.locator("details.gbx-advanced");
      await expect(advanced).toHaveCount(2);
      expect(
        await advanced.first().evaluate((e) => (e as HTMLDetailsElement).open),
        "free-form keys should start folded",
      ).toBe(false);
      await expect(form.locator("[data-config-new-key]")).toBeHidden();

      await openAdvancedKeys(page, config);
      await expect(form.locator("[data-config-new-key]")).toBeVisible();

      // An enum whose value is not one of its variants is refused where it was
      // typed, and the variants come from the engine's own list rather than from
      // a rule written here.
      const enums = form.locator('[data-config-field-kind="enum"]');
      const count = await enums.count();
      test.skip(count === 0, "this gear exposes no enum field, so there is no closed set to leave");
      const field = enums.first();
      const name = await field.getAttribute("data-config-field");
      const options = await field
        .locator("option")
        .evaluateAll((all) => all.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
      expect(options.length, "an enum with no variants is not a closed set").toBeGreaterThan(0);
      // Selecting a real variant must *not* complain -- the check has to be about
      // the value, not about the field having been touched.
      await field.locator("select").selectOption(String(options[0]));
      await expect(form.locator(`[data-config-field-error="${String(name)}"]`)).toHaveCount(0);

      // Selecting a variant queues a draft, so it has to be dropped: the suite
      // refuses to start when `products/` differs from HEAD, and teardown
      // restores it -- a test that applied here would fail the next run.
      await page.locator(".gbx-toolbar [data-draft-discard]").click();
      await expect(page.locator(".gbx-toolbar [data-draft-apply]")).toHaveCount(0);
    },
  );

  test(
    "a plugin is attached to a host, and the impact is of that [ADR-0013 §Amendment: a plugin is not a selected gear]",
    async ({ studio }) => {
      // **The write was right and the preview described something else.** The
      // batch became `add_plugin`, but "What changes" still asked the engine what
      // a top-level `use_gear` would do -- so for a plugin with no eligible host
      // the panel said "Nothing in this product declares
      // TenantResolverPluginClient" *and* "1 gear joins the closure", and offered
      // "you can still add it" beside a disabled button. One proposal, two
      // descriptions, and only one of them was the one that would be written.
      const { page } = studio;
      await openProduct(page, "dev");
      await revealCatalogue(page);
      await resetCatalogueView(page);

      // `oidc-authn-plugin` fills the point `authn-resolver` declares, and the
      // product has that host -- so this is the case that works.
      await page.locator('[data-toggle-gear="oidc-authn-plugin"]').click();
      await expect(page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });

      // The plugin path replaces features/config/plugins: `set_config` and
      // `set_features` are span surgery on a `use_gear` entry, and a plugin has
      // none, so offering them would offer a choice that cannot be right.
      await expect(page.locator("[data-add-gear-host]")).toBeVisible();
      await expect(page.locator('[data-add-gear-section="features"]')).toHaveCount(0);

      const host = page.locator("[data-add-gear-host-pick]");
      await expect(host).toBeVisible();
      const offered = await host
        .locator("option")
        .evaluateAll((all) => all.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
      expect(offered, "the host that declares the point should be offered").toContain(
        "authn-resolver",
      );

      // Nothing is asked of the engine until a host is chosen, and the panes say
      // why rather than describing an addition nobody proposed.
      const changes = page.locator('[data-add-gear-section="changes"]');
      await expect(changes).toContainText("Choose the gear", { timeout: 30_000 });
      await expect(changes).not.toContainText("joins the closure");

      // **What this claim cannot reach, said rather than left implied.** A
      // *successful* new attach is not observable on this corpus: every plugin
      // whose host the product has is already attached to it -- both authn
      // plugins are in `payments-demo`'s description -- and every other host is
      // absent, so there is no `add_plugin` that changes anything. The
      // composition is checked in `scripts/store-smoke.mjs` against
      // `add-gear/staged-edits.js`: attach for a named host, promote-then-attach
      // for a closure-only one, nothing at all with no host, and the follow-ups
      // dropped because a plugin has no `use_gear` for them to edit.
      //
      // What *is* observable is that the already-attached case agrees with
      // itself, which is the disagreement this replaced: the serialization says
      // nothing changes rather than proposing a top-level addition.
      await host.selectOption("authn-resolver");
      const written = page.locator('[data-add-gear-section="closure"]');
      await expect(written).toContainText("already attached to authn-resolver", {
        timeout: 30_000,
      });
      await expect(written).not.toContainText("use_gear");

      // **And the host does not survive a change of plugin.** It used to: the
      // next plugin was reported as "already attached to authn-resolver" while
      // the section above correctly said that host declares no point it fills.
      //
      // Straight to the next candidate, with no "choose a different gear" step.
      // The panel needed one because the picker and the overview shared a slot,
      // so choosing put the list off screen; the dialog's list never leaves.
      // That makes this the more direct assertion: one click, and the host it
      // was holding is gone.
      await page.locator('[data-add-gear-select="rg-tr-plugin"]').click();
      const blocked = "Nothing in this product declares";
      await expect(page.locator("[data-add-gear-host-none]")).toContainText(blocked, {
        timeout: 30_000,
      });
      // The impact repeats the blocking reason instead of resolving a proposal
      // that does not exist.
      await expect(changes).toContainText(blocked, { timeout: 30_000 });
      await expect(changes).not.toContainText("joins the closure");
      await expect(page.locator("[data-add-gear-apply]")).toBeDisabled();

      await page.locator("[data-add-gear-cancel]").click();
      await expect(page.locator("[data-add-gear-flow]")).toHaveCount(0);
    },
  );

  test(
    "an invalid value is refused at the field on the keystroke [plan §9.1: checked where the caret is]",
    async ({ studio }) => {
      // **Half of this claim moved and half of it went away, and the half that
      // went away is worth naming.** It read "an invalid value disables Add
      // before the next debounce": the field said the value was not an integer
      // while the panel's own `Add to Product` stayed live until the 400 ms
      // impact debounce turned it off. Configuration left the add dialog, so
      // there is no Add button beside the field any more -- the field is in the
      // product, and the primary action is Apply, a toolbar control over a whole
      // draft. Apply is *not* disabled by one invalid field today; the engine
      // refuses the value at Apply instead. That is later than the panel managed
      // and is recorded here rather than quietly dropped.
      //
      // What survives is the part the tag is about: the check happens where the
      // caret is, on the keystroke, with no debounce between.
      //
      // `grpc-hub` exposes `internal_auth_cache_ttl_secs`, an integer, and
      // `configurable-gears` names it -- so there is a real closed type to
      // violate rather than a skip dressed as a pass.
      const { page } = studio;
      await openProductById(page, "configurable-gears", "dev");
      const form = await configureGear(page, "grpc-hub");

      const ints = form.locator('[data-config-field-kind="int"]');
      expect(await ints.count(), "grpc-hub exposes an integer field").toBeGreaterThan(0);
      const field = ints.first();
      const name = await field.getAttribute("data-config-field");
      await field.locator("input").fill("1.5");

      // **Read once, not with a retrying matcher, and that is the whole claim.**
      // `expect(...).toBeVisible()` polls for seconds, so it would pass whether
      // the field complains on the keystroke or a render or two later. One
      // snapshot, taken immediately, is the only formulation that can tell those
      // apart. The budget exists at all because React flushes in a microtask
      // rather than synchronously with `fill`.
      const errors = async (): Promise<number> =>
        page.evaluate(
          (f) =>
            document.querySelectorAll(
              `.gbx-composition-settings [data-config-field-error="${f}"]`,
            ).length,
          String(name),
        );

      const started = Date.now();
      let seen = await errors();
      while (seen === 0 && Date.now() - started < 80) {
        seen = await errors();
      }
      const elapsed = Date.now() - started;
      expect(seen, `the field did not say what is wrong ${String(elapsed)}ms after the keystroke`)
        .toBeGreaterThan(0);
      expect(elapsed, "this must be decided without waiting for a debounce").toBeLessThan(200);

      // And it stays said: nothing re-renders the complaint away.
      await page.waitForTimeout(1_200);
      expect(await errors()).toBeGreaterThan(0);

      await page.locator(".gbx-toolbar [data-draft-discard]").click();
      await expect(page.locator(".gbx-toolbar [data-draft-apply]")).toHaveCount(0);
    },
  );

  test("a config key that no field could be is refused at the row [plan §9.1: checked where the caret is]", async ({
    studio,
  }) => {
    // `bad key = "secret-looking"` was accepted and written cleanly -- a config
    // key is a quoted dict key, so the span surgeon has no opinion -- and refused
    // three steps later at resolve, as GBX0115.
    // **Read in the product, because that is where free keys are typed now.**
    // The add dialog chooses a gear and says what adding it would do; config is
    // the gear's own setting and belongs to the gear once it is in the product.
    // The control is the same `ConfigFields`/`GearSettings` pair either way, so
    // the claim -- a key checked where the caret is -- is unchanged.
    const page = studio.page;
    await openProductById(page, "configurable-gears", "dev");
    const form = await configureGear(page, "tenant-resolver");
    await openAdvancedKeys(page, '.gbx-composition-settings [data-gear-config="tenant-resolver"]');
    const key = form.locator("[data-config-new-key]");
    const add = form.locator('[data-add-config="tenant-resolver"]');
    await key.fill("bad key");
    await expect(form.locator("[data-config-key-error]")).toContainText("spaces");
    await expect(add).toBeDisabled();
    await key.fill("namespace");
    await expect(form.locator("[data-config-key-error]")).toHaveCount(0);
    await expect(add).toBeEnabled();
    // Nothing was queued -- the key was never added -- so there is no draft to
    // discard, and `global-teardown` finds `products/` as it left it.
    await expect(page.locator(".gbx-toolbar [data-draft-apply]")).toHaveCount(0);
  });

  test("features are curated, and one that is not for this deployment says so [plan §9.1: features are projected]", async ({
    studio,
  }) => {
    // Three different answers, and telling them apart is the whole point.
    //
    // It began as one: "No features yet" could not be told from "this gear has
    // none", and the box beside it took any string, so a typo became a Cargo
    // feature that does not exist and a build failure two steps later. The
    // projected `[features]` table answered that -- 7 of 14 gear crates declare
    // one -- but uncurated, and `integration` wants a Docker daemon while
    // `default` is not a choice anyone makes. `cargo_features` is the curation.
    // **Read in the product, on a description that names all three gears.**
    // Features belong to a `use_gear` entry -- `set_features` is span surgery on
    // one -- so the surface that edits them is the product's. `payments-demo`
    // could not carry this claim: all three of these gears reach it through the
    // closure, and a gear nothing named has no entry to edit.
    const page = studio.page;
    await openProductById(page, "configurable-gears", "dev");

    // (1) The crate declares no features at all: `cargo_features` absent *and*
    // `available_features` absent, so there is nothing to fall back to either.
    const noneAtAll = await configureGear(page, "tenant-resolver");
    await expect(noneAtAll.locator("[data-features-none]")).toContainText("no Cargo features", {
      timeout: 60_000,
    });
    await expect(noneAtAll.locator("[data-feature-option]")).toHaveCount(0);

    // (2) The crate declares one and the gear offers none of them.
    // `types-registry`'s only feature is `integration`; `cargo_features = []`
    // says so deliberately, which is not the same as saying nothing -- and the
    // wording separates it from (1).
    //
    const curatedEmpty = await configureGear(page, "types-registry");
    await expect(curatedEmpty.locator("[data-features-none]")).toContainText(
      "offers no Cargo features",
      { timeout: 60_000 },
    );
    await expect(curatedEmpty.locator("[data-feature-option]")).toHaveCount(0);

    // (3) The feature exists, is offered, and belongs to another deployment.
    // `grpc-hub` declares `k8s-auth` for `kubernetes`; this product is being
    // shown on its default `dev` profile, which is embedded. It is named rather
    // than hidden, because someone looking for it needs to be told it exists and
    // why it is not on offer here -- a list that silently omitted it would read
    // as a missing feature.
    const embedded = await configureGear(page, "grpc-hub");
    await expect(embedded.locator('[data-feature-elsewhere="k8s-auth"]')).toContainText(
      "kubernetes",
      { timeout: 60_000 },
    );
    await expect(embedded.locator('[data-feature-option="k8s-auth"]')).toHaveCount(0);

    // And the mirror: on the kubernetes profile the same feature is *offered*,
    // which is what makes "not for this deployment" a statement about the view
    // rather than about the gear.
    // Through the helper, because the resolved header it waits on is Overview's
    // and `configureGear` leaves the panel on Composition. The profile switch
    // itself works from any stage -- it sits above the strip -- but knowing the
    // resolution for the new profile has *arrived* is what this needs, and that
    // is what the header says.
    await openProductById(page, "configurable-gears", "prod");
    const onKubernetes = await configureGear(page, "grpc-hub");
    await expect(onKubernetes.locator('[data-feature-option="k8s-auth"]')).toHaveCount(1);
    await expect(onKubernetes.locator('[data-feature-elsewhere="k8s-auth"]')).toHaveCount(0);
    await expect(page.locator(".gbx-toolbar [data-draft-apply]")).toHaveCount(0);
  });

  test("errors warn beside the button and never disable it", async ({ studio }) => {
    // **The error is staged on the gear being added, and it has to be.** This
    // skipped itself for as long as it existed -- "no gear in this corpus makes
    // the resolution fail when added" -- and the obvious fix does not work:
    // planting an error in `product.gdl` puts it in the resolution *before* the
    // add as well, and `impact.ts` subtracts the two sets by `code|message`
    // precisely so that "a resolution that merely re-reports it has changed
    // nothing". The warning reads `newDiagnostics`, so the error must be one the
    // proposal introduces.
    //
    // **The gear itself is the error now, because config left the dialog.**
    // Staging an undeclared free key was the mechanism; configuration belongs to
    // the product, so the diagnostic has to come from the addition alone.
    // `event-broker` supplies it: `EventBrokerConfig` declares no default for
    // `mode` or `default_storage_backend` and nothing in `payments-demo` sets
    // them, so adding it introduces GBX0120 that the current resolution does not
    // have -- which is exactly what `newDiagnostics` subtracts to.
    //
    // Staged, not written -- Cancel ends the test and nothing reaches the file.
    const page = studio.page;
    await configure(page, "event-broker");
    await expect(page.locator("[data-add-gear-impact]")).toBeVisible({ timeout: 60_000 });

    // Decision 1 of the phase: building a product is add-a-gear-then-bind-it, so a
    // resolution that fails in between is a waypoint, not a refusal.
    const submit = page.locator("[data-add-gear-submit]");
    await expect(submit).toBeEnabled();

    const warning = page.locator("[data-add-gear-error-warning]");
    await expect(warning, "an error the proposal introduces must be said").toBeVisible({
      timeout: 60_000,
    });
    // The claim itself: it warns and does not take the button away.
    await expect(submit, "an error in between is a waypoint, not a refusal").toBeEnabled();

    await page.locator("[data-add-gear-cancel]").click();
    await expect(page.locator("[data-add-gear-flow]")).toHaveCount(0);
  });
});
