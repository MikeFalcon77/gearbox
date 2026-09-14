// ADR cpt-gearbox-adr-domain-specific-ide-shell — Studio's own settings.
//
// **What is asserted here, and what is left to a live pass.** These claims hold
// whether or not a key is configured: the section exists, the field is masked,
// and the command opens the editor on it. The refusal the chat gives when no
// model is ready is deliberately *not* a claim — whether a model is ready
// depends on a key in the environment or the user's settings, so a test for it
// would report on the machine it ran on rather than on the application.

import type { Page } from "@playwright/test";

import { expect, runCommand, test } from "../fixtures/studio";

/** Open the settings editor on Studio's own section. */
async function openGearboxSettings(page: Page): Promise<void> {
  await runCommand(page, "Gearbox: Settings");
  await page.locator(".settings-main, #settings_widget").first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

test.describe("Studio's settings are Theia's settings", () => {
  test("the settings editor has a Gearbox section [ADR-0011 §Amendment: Studio declares its own settings]", async ({
    studio,
  }) => {
    const { page } = studio;
    await openGearboxSettings(page);
    // A section of its own, not a subgroup of Extensions: `gearbox` is in the
    // layout because `PreferenceLayoutProvider` was rebound, and without that
    // `PreferenceTreeGenerator` files unknown namespaces under `extensions`.
    await expect(page.getByText(/^Gearbox \(\d+\)$/).first()).toBeVisible({ timeout: 30_000 });
  });

  test("the Anthropic key is a setting a person can find [ADR-0011 §Amendment: Studio declares its own settings]", async ({
    studio,
  }) => {
    const { page } = studio;
    await openGearboxSettings(page);
    // The claim that motivated the amendment: the key Theia already had was
    // unreachable, because every `ai-features.*` preference is stamped hidden.
    await expect(page.getByText("Api Key").first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/Anthropic API key for the Gearbox chat/).first(),
    ).toBeVisible();
  });

  test("the key field does not show what it holds [ADR-0011 §Amendment: Studio declares its own settings]", async ({
    studio,
  }) => {
    const { page } = studio;
    await openGearboxSettings(page);
    const field = page.locator('input[data-gearbox-secret="true"]').first();
    await expect(field).toBeVisible({ timeout: 30_000 });
    // Theia renders every string preference as `type="text"`; this one is claimed
    // by a higher-scoring renderer keyed on the schema's `typeDetails`, so the
    // next secret is masked without that renderer being edited.
    await expect(field).toHaveAttribute("type", "password");
  });
});
