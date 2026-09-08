// Folding the side panels for a screen that wants the room.
//
// A separate service, and the separation is not taste: `ScreenScopeService` has
// to reach the view contributions to put a context's own screen in front, and
// the view contributions have to reach *this* to fold the panels before opening
// a wizard. Importing both ways closed a module cycle, and the symptom was not
// subtle -- inversify reported `@inject called with undefined` and the frontend
// did not start at all. So the piece both sides need lives at the bottom, with
// no domain imports of its own.
//
// The complaint this answers: on Add Gear the catalogue, a bottom panel and an
// Inspector still showing the *previously* selected gear left the configurator
// about half the window. "Graph -- maximum space" falls out of the same
// mechanism rather than needing a preset of its own.

import { ApplicationShell, FrontendApplicationContribution } from "@theia/core/lib/browser";
import { inject, injectable } from "@theia/core/shared/inversify";

export type PanelArea = "left" | "right" | "bottom";

export const PANELS: readonly PanelArea[] = ["left", "right", "bottom"];

@injectable()
export class FocusModeService implements FrontendApplicationContribution {
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;

  /**
   * The panels a focus episode folded, and which of them it may put back.
   *
   * `undefined` means no episode is running. An entry is `true` when the panel
   * was expanded on the way in and this service collapsed it -- the only case
   * where restoring it is right, because expanding a panel the person had
   * already closed is not a restoration.
   */
  protected folded: Map<PanelArea, boolean> | undefined;

  /** The screen an episode was opened for, so its close can end the episode. */
  protected episodeFor: string | undefined;

  onStart(): void {
    // **An episode ends when its screen is closed, not when the person looks at
    // something else**, and that is the second half of the same lesson as
    // `enterFocus`. Restoring three panels relayouts the shell, and Theia
    // animates a panel resize -- so a restore triggered by "the current tab
    // changed" lands its animation exactly on the screen the person has just
    // navigated to and is about to click. Measured: leaving the Graph for the
    // Product view made the Product view's stage tabs refuse to switch.
    //
    // Closing is both later and more deliberate: the wizard is finished, Lumino
    // is already relayouting for the tab that went, and the expansion is part of
    // that settling rather than an event of its own. Stepping away from an open
    // wizard keeps the room, which is also the better answer -- the flow is not
    // over, and coming back to a re-folded panel would be its own annoyance.
    this.shell.onDidRemoveWidget((widget) => {
      if (widget.id === this.episodeFor) this.restore();
    });
  }

  /**
   * Fold the side panels for a screen that wants the room, **before** it opens.
   *
   * The complaint this answers: on Add Gear the catalogue, a bottom panel and an
   * Inspector still showing the *previously* selected gear left the configurator
   * about half the window. "Graph -- maximum space" falls out of the same
   * mechanism rather than needing a preset of its own.
   *
   * Called by the view contribution that is about to open a focus screen, and
   * awaited by it -- which is the whole design, arrived at by breaking it the
   * other way first.
   *
   * The first version folded reactively, from `onDidChangeCurrentWidget`, and it
   * could **swallow a click**: collapsing relayouts the shell, React replaces the
   * node under the pointer, mousedown and mouseup land on different elements and
   * no click event is produced at all. The symptom was a button that took focus
   * and did nothing -- the Graph's own view switch, measured, and the same shape
   * as the `Open Product...` quick-input the context preset used to dismiss.
   * (It also tripled a spec file's runtime, which is what an unawaited collapse
   * per focus change costs.)
   *
   * So the room is arranged first and the screen appears into a settled layout.
   * Entering is explicit; only *leaving* is reactive, because by then the person
   * is looking at something else and the restore is what they expect.
   */
  enterFocus(widgetId: string): void {
    if (this.folded !== undefined) return;
    this.episodeFor = widgetId;
    const folded = new Map<PanelArea, boolean>();
    this.folded = folded;
    for (const area of PANELS) {
      const expanded = this.shell.isExpanded(area);
      folded.set(area, expanded);
      // **Not awaited, and it does not need to be.** `collapsePanel` applies the
      // layout change synchronously -- `currentTitle = null` for a side panel,
      // `hide()` for the bottom -- and the promise it returns only waits for the
      // next animation frame, which is the *animation*, not the change. Awaiting
      // it made this hang: a headless browser can throttle `requestAnimationFrame`
      // to the point where the promise does not settle, and every caller of a
      // focus screen then waited on a frame that never came.
      if (expanded) void this.shell.collapsePanel(area);
    }
  }


  /**
   * Put back what this service folded, and nothing else.
   *
   * Only panels it folded, and only if they are still folded: a panel the person
   * had already closed is not "restored" by opening it, and one they reopened
   * during the episode is theirs -- an expanded panel here means a deliberate
   * act, which outranks anything this was going to do.
   */
  protected restore(): void {
    const folded = this.folded;
    this.folded = undefined;
    this.episodeFor = undefined;
    if (folded === undefined) return;
    for (const area of PANELS) {
      if (folded.get(area) !== true) continue;
      if (this.shell.isExpanded(area)) continue;
      this.shell.expandPanel(area);
    }
  }

  /**
   * End an episode without restoring anything.
   *
   * For a context transition, which decides all three panels itself: a restore
   * racing the preset would leave the layout depending on which finished last.
   */
  suspend(): void {
    this.folded = undefined;
    this.episodeFor = undefined;
  }
}
