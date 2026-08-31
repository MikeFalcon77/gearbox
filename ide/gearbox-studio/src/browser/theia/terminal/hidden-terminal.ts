// The terminal stays installed and stops opening itself.
//
// The same trade ADR-0011 records for Debug and Test, for the same reason: the
// package is kept because the work ends in generated crates a person will want to
// build, and `initializeLayout(): NOOP` keeps the command, the keybinding and any
// saved layout while changing only what a fresh shell shows.
//
// **Written after getting it wrong the other way.** A layout migration closed the
// boot terminal instead, and that broke the capability outright: `widget.close()`
// disposes the widget while `WidgetManager` keeps its entry under the same id, so
// the next `Terminal: Create New Terminal` handed back the disposed instance and
// nothing appeared -- silently, by command and by keybinding alike. Not opening
// one is a different act from closing one, and only the first is reversible.

import { TerminalFrontendContribution } from "@theia/terminal/lib/browser/terminal-frontend-contribution";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class HiddenTerminal extends TerminalFrontendContribution {
  override async initializeLayout(): Promise<void> {
    // NOOP. A shell is a tool this application offers, not one of the two things
    // it is about, so it appears when asked for.
  }
}
