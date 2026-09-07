// The Problems view stays installed and stops opening itself.
//
// Markers are load-bearing here -- `ResolutionMarkers` puts every resolve
// diagnostic into `ProblemManager` under one owner string, and the `.gdl`
// language client publishes the rest -- so `@theia/markers` is a package this
// application chose. What it did not choose is the *panel* opening at startup:
// on Home there is no resolution to report on, and a panel that says "No
// problems have been detected in the workspace" is the empty-domain-panel §9.1
// calls worse than an absent one.
//
// And the domain already has a better surface for the same array. Conflicts is
// the screen: it carries the `help` sentence, the `related` locations, the
// evidence citation and the `subject` link, none of which a marker can hold. The
// Product view keeps a one-line summary that opens it. Problems remains for the
// file-anchored GDL diagnostics Monaco renders natively, one command away, which
// is what `initializeLayout(): NOOP` preserves -- the mechanism ADR-0011 names
// for exactly this case.

import { ProblemContribution } from "@theia/markers/lib/browser/problem/problem-contribution";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class HiddenProblemsView extends ProblemContribution {
  override async initializeLayout(): Promise<void> {
    // NOOP. Not `super` followed by a close: that opens and then hides, leaving
    // the widget in the DOM -- queryable and invisible, which this application
    // has been bitten by twice.
  }
}
