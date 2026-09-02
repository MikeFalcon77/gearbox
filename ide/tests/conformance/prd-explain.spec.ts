// `cpt-gearbox-fr-explain`:
//
//   For every automatic choice the system MUST record, at the moment the choice
//   is made, the requirement that forced it, the constraints that eliminated
//   alternatives, the preference that ranked it, and the source location of each
//   contributing fact; and MUST expose that provenance as a queryable graph.
//
// The graph arrives with the resolution rather than from a second call, so these
// tests read what is on screen for a selection and never trigger a resolve of
// their own -- which also means the explanation cannot be about a different
// resolution than the one being shown.

import { expect, openExplain, openProduct, test } from "../fixtures/studio";

async function explain(
  page: import("@playwright/test").Page,
  click: string,
): Promise<{ explaining: string; steps: { kind: string; because: string; origin: string | null }[] }> {
  await openExplain(page);
  await page.click(click);
  await page.locator("[data-explaining]").waitFor({ state: "visible" });
  return page.evaluate(() => ({
    explaining: document.querySelector("[data-explaining]")?.getAttribute("data-explaining") ?? "",
    steps: Array.from(document.querySelectorAll(".gbx-step")).map((e) => ({
      kind: e.getAttribute("data-step-kind") ?? "",
      because: (e.querySelector(".gbx-step-because")?.textContent ?? "").trim(),
      origin: e.querySelector(".gbx-step-origin")?.textContent ?? null,
    })),
  }));
}

test.describe("why the resolution is the way it is", () => {
  test("a binding's mode is explained by where its two gears ended up [PRD cpt-gearbox-fr-explain]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "prod");
    const { explaining, steps } = await explain(studio.page, "[data-binding]");
    expect(explaining).toMatch(/^binding:/);

    // The chain a person actually needs: the mode, then the process that caused
    // it, then why that process exists. Each sentence was written by the resolver
    // at the moment it made the choice, which is what makes this an account
    // rather than a reconstruction.
    const because = steps.map((s) => s.because).join(" | ");
    expect(because).toMatch(/Remote because the consumer is in/);
    expect(because).toMatch(/co-location closure/);
    expect(because).toMatch(/named in the product description/);
    expect(steps.map((s) => s.kind)).toContain("derived-from");
  });

  test("a gear pulled in by co-location is explained back to a named gear [PRD cpt-gearbox-fr-explain]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "prod");
    const { explaining, steps } = await explain(
      studio.page,
      '[data-pulled-in="types-registry"] a',
    );
    expect(explaining).toBe("gear:types-registry");
    // `types-registry` is named nowhere in the product. The chain has to reach
    // something that is, or "why is this here" has no answer.
    expect(steps.map((s) => s.kind)).toContain("colocated-by");
    expect(steps.some((s) => /named in the product description/.test(s.because))).toBe(true);
    expect(steps.some((s) => /link-time and cannot be cut/.test(s.because))).toBe(true);
  });

  test("a plugin's inclusion names the host and the profile [PRD cpt-gearbox-fr-plugin-selection]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "prod");
    const { steps } = await explain(
      studio.page,
      '[data-pulled-in="oidc-authn-plugin"] a',
    );
    expect(
      steps.some((s) => /selected as a plugin of `authn-resolver` for profile `prod`/.test(s.because)),
    ).toBe(true);
  });

  test("a selection that this profile does not contain reads as ordinary [PRD cpt-gearbox-fr-explain]", async ({
    studio,
  }) => {
    // A selection survives a profile switch, and `oidc-authn-plugin` is simply
    // not in the dev resolution -- dev links the static plugin instead. The
    // distinction this checks is between two messages that used to be one: "not
    // part of this profile" is an ordinary state, while "in the resolution and
    // missing from its graph" is a defect. Sharing one alarming message for both
    // trains people to ignore the one that matters.
    await openProduct(studio.page, "prod");
    await explain(studio.page, '[data-pulled-in="oidc-authn-plugin"] a');

    await openProduct(studio.page, "dev");
    await expect(
      studio.page.locator('[data-not-in-profile="gear:oidc-authn-plugin"]'),
    ).toBeVisible();
    // And it is not the alarm.
    await expect(studio.page.locator(".gbx-explain .gbx-error")).toHaveCount(0);
  });

  test("each step links to the source location of its fact [PRD cpt-gearbox-fr-explain: the source location of each contributing fact]", async ({
    studio,
  }) => {
    await openProduct(studio.page, "prod");
    const { steps } = await explain(studio.page, '[data-asked-for="api-gateway"] a');
    const withOrigin = steps.filter((s) => s.origin !== null);
    expect(withOrigin.length).toBeGreaterThan(0);

    const gateway = withOrigin.find((s) => s.origin?.includes("product.gdl"));
    expect(gateway?.origin, "selected gear must link into the product description").toMatch(
      /product\.gdl:\d+/,
    );
    expect(
      Number(gateway?.origin?.split(":").pop()),
      "must not open on line 1 of the file",
    ).toBeGreaterThan(1);

    // Colocated into the closure: origin is the declaring gear.gdl, not the product.
    // Re-open Product: selecting a gear can leave the pulled-in row scrolled out of
    // the panel's visible area, and Playwright then waits forever on a hidden link.
    await openProduct(studio.page, "prod");
    const pulled = studio.page.locator('[data-pulled-in="types-registry"] a');
    await pulled.scrollIntoViewIfNeeded();
    const colocated = await explain(studio.page, '[data-pulled-in="types-registry"] a');
    expect(colocated.steps.some((s) => s.origin?.includes("gear.gdl"))).toBe(true);

    // Click opens the product description on the use_gear line, not the top.
    // Scope to the product.gdl model: Generate's diff editors stay in the DOM and
    // `.monaco-editor` alone matches four hosts (strict-mode failure).
    await openProduct(studio.page, "prod");
    await explain(studio.page, '[data-asked-for="api-gateway"] a');
    const link = studio.page.locator(".gbx-step-origin", { hasText: "product.gdl" }).first();
    await link.click();
    const productEditor = studio.page.locator('.monaco-editor[data-uri*="product.gdl"]');
    await expect(productEditor).toContainText('use_gear("api-gateway"', {
      timeout: 30_000,
    });
  });
});
