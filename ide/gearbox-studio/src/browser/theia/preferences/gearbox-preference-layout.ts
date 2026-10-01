// A top-level `Gearbox` section in the settings editor.
//
// **Why:** `PreferenceTreeGenerator.getGroupName` asks
// `PreferenceLayoutProvider.hasCategory(labels[0])` and, when the answer is no,
// falls back to `defaultTopLevelCategory = "extensions"`. So without this,
// Studio's own settings appear under *Extensions › Gearbox* -- filed beside
// third-party contributions in an application that does not host any
// (ADR-0011 keeps `@theia/plugin-ext` for the editor, not for extensions).
//
// There is no contribution point for categories: `DEFAULT_LAYOUT` is a const and
// `PreferenceLayoutProvider` is a plain `@injectable()` with no provider behind
// it. Rebinding it is the mechanism ADR-0011 names for exactly this -- "replace a
// Theia service: `rebind(TheiaX).to(MyX)`" -- and the reason this file sits under
// `theia/preferences/`, mirroring the package it overrides.
//
// **Appended rather than spliced.** `[...DEFAULT_LAYOUT, gearbox]` keeps whatever
// Theia adds to its own layout next year; rewriting the array would freeze a copy
// of it here, which is the drift this repository builds guards against elsewhere.

import { injectable } from "@theia/core/shared/inversify";
import {
  DEFAULT_LAYOUT,
  PreferenceLayoutProvider,
} from "@theia/preferences/lib/browser/util/preference-layout";
import type { PreferenceLayout } from "@theia/preferences/lib/browser/util/preference-layout";

/**
 * The section, and the glob that fills it.
 *
 * `settings: ["gearbox.*"]` is what `getLayoutForPreference` matches on, and the
 * provider turns it into `^gearbox\..*$` -- so every present and future
 * `gearbox.` preference lands here without this list being maintained.
 */
export const GEARBOX_SECTION: PreferenceLayout = {
  id: "gearbox",
  label: "Gearbox",
  settings: ["gearbox.*"],
};

@injectable()
export class GearboxPreferenceLayout extends PreferenceLayoutProvider {
  override getLayout(): PreferenceLayout[] {
    return [...DEFAULT_LAYOUT, GEARBOX_SECTION];
  }
}
