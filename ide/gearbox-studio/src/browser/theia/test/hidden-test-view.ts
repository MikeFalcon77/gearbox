// The Testing view stays installed and stops opening itself.
//
// Same reasoning as `HiddenDebugView`: `@theia/test` arrives with
// `@theia/plugin-ext` for the VS Code testing API, and a domain IDE for
// composing gears has no test explorer of its own to put there. The package,
// its command and its keybinding all remain.

import { TestViewContribution } from "@theia/test/lib/browser/view/test-view-contribution";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class HiddenTestView extends TestViewContribution {
  override async initializeLayout(): Promise<void> {
    // NOOP -- see the comment in HiddenDebugView.
  }
}
