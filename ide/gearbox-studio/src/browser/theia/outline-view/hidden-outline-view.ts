// The Outline view stays installed and stops opening itself.
//
// `@theia/outline-view` arrives with the editor stack rather than by choice, and
// an outline of a `product.gdl` is a list of the four calls in it -- which the
// Product view already renders as a tree, with what each one resolved to. So the
// panel is surface without a subject, and it was taking a slot in the left bar on
// first run.
//
// `LayoutMigration` already closes a restored `outline-view` widget once; that is
// for a layout somebody's browser profile is holding, and is not a substitute for
// not opening it. The two are different acts -- §9.1 records the session that
// lesson cost -- and only this one is what a person's own saved layout can
// override.

import { OutlineViewContribution } from "@theia/outline-view/lib/browser/outline-view-contribution";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class HiddenOutlineView extends OutlineViewContribution {
  override async initializeLayout(): Promise<void> {
    // NOOP, as for Debug, Test and Problems.
  }
}
