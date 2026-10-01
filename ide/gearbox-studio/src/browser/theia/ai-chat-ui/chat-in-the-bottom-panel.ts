// The chat sits in the bottom panel, because the right one is already spoken for.
//
// **Why:** `AIChatContribution` asks for `area: "right", rank: 100`, and so does
// `InspectorViewContribution`. Two widgets in one Theia side panel are tabs, and
// the Inspector does not wait to be asked for: it calls
// `openView({ activate: true, reveal: true })` from `selection.onDidChange`, on
// every selection that is not a pending catalogue row. So opening the chat and
// then clicking a gear -- the exact motion the chat exists to support -- put the
// Inspector in front of it every single time. Observed, not reasoned about: a
// live pass clicked one row and the chat input went from visible to hidden while
// its context chip updated correctly behind the Inspector.
//
// **Why the bottom and not somewhere else.** Every side area already has an
// occupant, so the question is which neighbour steals the panel and how often:
//
//   - `right` holds the Inspector, which takes the panel on *every* selection.
//   - `left` holds the Catalogue, which is the thing a person clicks to make a
//     selection -- covering it with a chat would cost a tab switch per gear.
//   - `bottom` holds Conflicts, which opens only when a command asks for it. It
//     is the one area where nothing ever takes the panel automatically.
//
// The Inspector's own comment argues that a *configurator's* form belongs beside
// the tree and was badly served by the bottom strip, and that argument is about
// form fields needing height in a two-column layout. A chat transcript is one
// column that scrolls by nature, so it pays much less for a short viewport --
// and the panel is resizable, with Theia remembering the height.
//
// A saved layout keeps the chat wherever it already was, so moving it needs the
// migration in `shell/layout-migration.ts` to close it once.

import { ApplicationShell } from "@theia/core/lib/browser";
import { injectable } from "@theia/core/shared/inversify";
import { AIChatContribution } from "@theia/ai-chat-ui/lib/browser/ai-chat-ui-contribution";

/** Where the chat goes instead. After Conflicts, which was in the bottom first. */
export const CHAT_AREA: ApplicationShell.WidgetOptions = { area: "bottom", rank: 200 };

@injectable()
export class ChatInTheBottomPanel extends AIChatContribution {
  constructor() {
    super();
    // Rewritten after `super()` rather than passed into it: the base class calls
    // `super({...})` with these values hardcoded and takes no arguments, so
    // there is nothing to pass. `options` is `readonly` to TypeScript and a
    // plain field at run time, which is what the cast says out loud.
    (this.options as { defaultWidgetOptions: ApplicationShell.WidgetOptions }).defaultWidgetOptions =
      CHAT_AREA;
  }
}
