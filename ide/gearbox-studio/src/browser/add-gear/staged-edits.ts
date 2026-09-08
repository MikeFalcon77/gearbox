// What the Add Gear panel proposes, as edits.
//
// **One array, and the same one three times over**: the resolution preview, the
// dry run and the write all get it. They used not to -- the preview took the gear
// and its source as a separate `add` parameter, which is a second description of
// the proposal, and the two disagreed the moment a proposal stopped being a
// top-level addition.
//
// Pure, for the reason `create/gear-edits.ts` is: the panel cannot be
// constructed outside a browser, and on this corpus a *successful* new attach is
// not reachable through the UI at all -- every plugin whose host the product has
// is already attached to it, and every other host is absent. So the composition
// is checked here.

import type { ProductEdit } from "../../common/generated/ProductEdit";
import type { HostStanding } from "../create/gear-edits";

export interface Proposal {
  readonly gearId: string;
  /** The source the gear is read from, for a top-level selection. */
  readonly source: string;
  /**
   * Whether this gear is a plugin, and if so which host it is being attached to.
   *
   * `undefined` means an ordinary gear. A plugin whose host is not chosen yet is
   * `{ host: undefined }` -- distinct, because it proposes nothing rather than
   * proposing a selection.
   */
  readonly plugin?: {
    readonly host?: { readonly id: string; readonly source: string; readonly standing: HostStanding };
  };
  /** `set_features`, `set_plugins` and `set_config`, for an ordinary gear. */
  readonly followUps: readonly ProductEdit[];
}

/**
 * The edits this proposal is.
 *
 * An empty array means there is nothing to propose yet, which is a state rather
 * than an error: a plugin whose host is undecided. Callers show the reason and
 * ask the engine nothing -- an empty proposal is not a question it can answer.
 *
 * **A plugin is attached, not selected.** In the corpus a plugin appears only as
 * a `plugin("id")` entry inside its host's `use_gear`, so a top-level `add_gear`
 * would leave it filling nothing *and* make it a gear the product selected in
 * its own right. The follow-ups do not apply to it either: `set_config` and
 * `set_features` are span surgery on a `use_gear` entry, and a plugin has none.
 */
export function stagedEditsFor(proposal: Proposal): readonly ProductEdit[] {
  const plugin = proposal.plugin;
  if (plugin === undefined) {
    return [
      { kind: "add_gear", gear: proposal.gearId, source: proposal.source },
      ...proposal.followUps,
    ];
  }
  const host = plugin.host;
  if (host === undefined) return [];
  // A host the closure pulled in has no `use_gear` to attach to, so it is
  // promoted first -- a visible change to the description, and part of the
  // previewed batch rather than a side effect.
  const promote: readonly ProductEdit[] =
    host.standing === "closure-only"
      ? [{ kind: "add_gear", gear: host.id, source: host.source }]
      : [];
  return [...promote, { kind: "add_plugin", gear: host.id, plugin: proposal.gearId }];
}
