// The Debug view stays installed and stops opening itself.
//
// `@theia/debug` is not a dependency this application chose: it arrives with
// `@theia/plugin-ext`, which needs it to implement the VS Code debug API. ADR
// 0011 describes exactly this case -- "Several packages it keeps only because
// something else needs them, and then explicitly neuters their presentation" --
// and names the mechanism: "`initializeLayout(): NOOP` is the correct way to hide
// a view. It keeps the package, the command and the keybinding; only the default
// layout changes, so a person can still open the view and their saved layout is
// respected."
//
// Which is the whole difference from removing the package: a `.gdl` product has
// nothing to debug *today*, and the day a generated process is debuggable from
// here, the view is one command away rather than one dependency away.

import { DebugFrontendApplicationContribution } from "@theia/debug/lib/browser/debug-frontend-application-contribution";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class HiddenDebugView extends DebugFrontendApplicationContribution {
  override async initializeLayout(): Promise<void> {
    // NOOP. Not `super.initializeLayout()` with the panel closed afterwards: that
    // opens and then hides, which is the failure this application already hit
    // once -- the widget stays in the DOM, queryable and invisible.
  }
}
