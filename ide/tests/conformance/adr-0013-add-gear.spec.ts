// Product-session chrome and the Add Gear configurator (Phases 4–5).

import type { Page } from "@playwright/test";

import {
  expect,
  openAdvancedKeys,
  openProduct,
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

    const toggle = studio.page.locator('[data-toggle-gear="cluster"]');
    await expect(toggle).toHaveAttribute("data-in-product", "false");
    await toggle.click();

    await expect(studio.page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });
    await expect(
      studio.page.locator(".dialogBlock", { has: studio.page.locator(".gbx-edit-preview") }),
    ).toHaveCount(0);
    await expect(studio.page.locator("[data-add-gear-flow] .gbx-edit-preview")).toContainText(
      "cluster",
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
    await page.locator("[data-add-gear-select]").selectOption(gear);
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

    // Free keys live under "Other keys" now -- see `openAdvancedKeys`.
    await openAdvancedKeys(page, "[data-add-gear-config]");
    await page.locator("[data-add-gear-config-key]").fill("namespace");
    await page.locator("[data-add-gear-config-value]").fill("demo");
    await page.locator("[data-add-gear-config-add]").click();
    await page.locator("[data-add-gear-plugin-pick]").selectOption("single-tenant-tr-plugin");
    await page.locator("[data-add-gear-plugin-add]").click();

    await expect(preview).toContainText("namespace", { timeout: 60_000 });
    await expect(preview).toContainText("single-tenant-tr-plugin");
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
      const { page } = studio;
      await openProduct(page, "dev");
      await revealCatalogue(page);
      await resetCatalogueView(page);
      await page.locator('[data-toggle-gear="cluster"]').click();
      await expect(page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });

      // Folded, and the free-key input is not reachable until it is opened.
      const advanced = page.locator("[data-add-gear-config] details.gbx-advanced");
      await expect(advanced).toHaveCount(1);
      expect(
        await advanced.evaluate((e) => (e as HTMLDetailsElement).open),
        "free-form keys should start folded",
      ).toBe(false);
      await expect(page.locator("[data-add-gear-config-key]")).toBeHidden();

      await openAdvancedKeys(page, "[data-add-gear-config]");
      await expect(page.locator("[data-add-gear-config-key]")).toBeVisible();

      // An enum whose value is not one of its variants is refused where it was
      // typed, and the variants come from the engine's own list rather than from
      // a rule written here.
      const enums = page.locator('[data-config-field-kind="enum"]');
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
      await expect(page.locator(`[data-config-field-error="${String(name)}"]`)).toHaveCount(0);

      await page.locator("[data-add-gear-cancel]").click();
      await expect(page.locator("[data-add-gear-flow]")).toHaveCount(0);
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
      await page.locator("[data-add-gear-change]").click();
      await page.locator("[data-add-gear-select]").selectOption("rg-tr-plugin");
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
    "an invalid value disables Add before the next debounce [plan §9.1: checked where the caret is]",
    async ({ studio }) => {
      // The window this closes: the field said `internal_auth_cache_ttl_secs is
      // an integer` while `Add to Product` stayed live until the next 400 ms
      // debounce turned it off. Asserted immediately after the keystroke, which
      // is the only moment that distinguishes the fix from what it replaced.
      const { page } = studio;
      await openProduct(page, "dev");
      await revealCatalogue(page);
      await resetCatalogueView(page);
      await page.locator('[data-toggle-gear="grpc-hub"]').click();
      await expect(page.locator("[data-add-gear-flow]")).toBeVisible({ timeout: 30_000 });

      const add = page.locator("[data-add-gear-apply]");
      await expect(add).toBeEnabled({ timeout: 60_000 });

      const ints = page.locator('[data-config-field-kind="int"]');
      const count = await ints.count();
      test.skip(count === 0, "this gear exposes no integer field to make invalid");
      const field = ints.first();
      const name = await field.getAttribute("data-config-field");
      await field.locator("input").fill("1.5");

      // **Read once, not with a retrying matcher, and that is the whole claim.**
      // `expect(...).toBeDisabled()` polls for seconds, so it passes whether the
      // button goes dead on the keystroke or 400 ms later when the debounce
      // fires -- which is exactly the window this closes. One snapshot of both
      // facts, taken immediately, is the only formulation that can tell the two
      // apart.
      //
      // `IMPACT_DEBOUNCE_MS` is 400; the budget here is a fifth of that, and it
      // exists at all because React flushes its render in a microtask rather
      // than synchronously with `fill`.
      const snapshot = async (): Promise<{ error: number; disabled: boolean }> =>
        page.evaluate((field) => {
          const button = document.querySelector("[data-add-gear-apply]");
          return {
            error: document.querySelectorAll(`[data-config-field-error="${field}"]`).length,
            disabled: button instanceof HTMLButtonElement ? button.disabled : false,
          };
        }, String(name));

      const started = Date.now();
      let seen = await snapshot();
      while ((seen.error === 0 || !seen.disabled) && Date.now() - started < 80) {
        seen = await snapshot();
      }
      const elapsed = Date.now() - started;
      expect(seen.error, "the field did not say what is wrong with the value").toBeGreaterThan(0);
      expect(seen.disabled, `Add was still live ${String(elapsed)}ms after the keystroke`).toBe(
        true,
      );
      expect(elapsed, "this must be decided well inside the 400ms debounce").toBeLessThan(200);

      // And still disabled once the debounce has been and gone -- the guard is
      // not something the next preview undoes.
      await page.waitForTimeout(1_200);
      expect((await snapshot()).disabled).toBe(true);

      await page.locator("[data-add-gear-cancel]").click();
      await expect(page.locator("[data-add-gear-flow]")).toHaveCount(0);
    },
  );

  test("a config key that no field could be is refused at the row [plan §9.1: checked where the caret is]", async ({
    studio,
  }) => {
    // `bad key = "secret-looking"` was accepted and written cleanly -- a config
    // key is a quoted dict key, so the span surgeon has no opinion -- and refused
    // three steps later at resolve, as GBX0115.
    const page = studio.page;
    await configure(page, "tenant-resolver");
    await openAdvancedKeys(page, "[data-add-gear-config]");
    await page.locator("[data-add-gear-config-key]").fill("bad key");
    await expect(page.locator("[data-config-key-error]")).toContainText("spaces");
    await expect(page.locator("[data-add-gear-config-add]")).toBeDisabled();
    await page.locator("[data-add-gear-config-key]").fill("namespace");
    await expect(page.locator("[data-config-key-error]")).toHaveCount(0);
    await expect(page.locator("[data-add-gear-config-add]")).toBeEnabled();
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("features are the crate's own, and absence says so [plan §9.1: features are projected]", async ({
    studio,
  }) => {
    // "No features yet" could not be told from "this gear has none", and the box
    // beside it took any string -- so a typo became a Cargo feature that does not
    // exist and a build failure two steps later. Measured across the corpus: 7 of
    // 14 gear crates declare a `[features]` table.
    const page = studio.page;
    await configure(page, "tenant-resolver");
    await expect(page.locator("[data-add-gear-features-none]")).toContainText(
      "no Cargo features",
      { timeout: 60_000 },
    );
    await expect(page.locator("[data-add-gear-feature-option]")).toHaveCount(0);

    // `types-registry` declares exactly one -- `integration`, which gates tests
    // needing a Docker daemon. It is offered *and* the panel says the list is the
    // crate's own rather than a curated one, because nobody has curated it.
    //
    // Through "Choose a different gear", because the picker is not on screen once
    // a gear is chosen -- the overview replaces it, which is also what makes the
    // staged features, config and plugins safe to clear on a change of subject.
    await page.locator("[data-add-gear-change]").click();
    await page.locator("[data-add-gear-select]").selectOption("types-registry");
    await expect(page.locator('[data-add-gear-feature-option="integration"]')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator("[data-add-gear-features]")).toContainText("declares");
    await page.locator("[data-add-gear-cancel]").click();
  });

  test("errors warn beside the button and never disable it", async ({ studio }) => {
    const page = studio.page;
    await configure(page, "tenant-resolver");
    await expect(page.locator("[data-add-gear-impact]")).toBeVisible({ timeout: 60_000 });

    // Decision 1 of the phase: building a product is add-a-gear-then-bind-it, so a
    // resolution that fails in between is a waypoint, not a refusal.
    const submit = page.locator("[data-add-gear-submit]");
    await expect(submit).toBeEnabled();

    const warning = page.locator("[data-add-gear-error-warning]");
    if ((await warning.count()) === 0) {
      test.skip(
        true,
        "no gear in this corpus makes the resolution fail when added, so the warning cannot be observed here",
      );
    }
    await expect(warning).toBeVisible();
    await expect(submit).toBeEnabled();
    await page.locator("[data-add-gear-cancel]").click();
  });
});
