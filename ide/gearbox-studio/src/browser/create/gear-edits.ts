// What putting a newly scaffolded gear into a product actually writes.
//
// **Separated because a plugin is not a selected gear, and adding it as one is
// wrong twice over.** In the corpus a plugin appears only as a `plugin("id")`
// entry inside its host's `use_gear` -- never as a top-level `use_gear` of its
// own -- so `[add_source, add_gear]` leaves it attached to nothing, which the
// resolver rightly reports (GBX0518), *and* makes it a gear the product selected
// in its own right.
//
// Pure, and for the reason `shell/opening-outcome.ts` is: the widget that owns
// this decision cannot be constructed outside a browser, and the decision is the
// part worth checking. Writing to `products/` is what the conformance harness
// refuses, so a browser claim cannot reach the write either.

import type { ProductEdit } from "../../common/generated/ProductEdit";

/**
 * Where the host stands in the product this plugin is being added to.
 *
 * The engine's own refusal is what names these: attaching needs a `use_gear`
 * naming the host in `gears`, so "in the closure" is not the same as "named".
 */
export type HostStanding = "named" | "closure-only" | "absent";

export interface NewGearPlacement {
  readonly gearId: string;
  /** The source id the new folder is declared under. */
  readonly sourceId: string;
  /** Where that folder is, relative to the description. */
  readonly at: string;
  /**
   * The host this gear plugs into, when it is a plugin and one was chosen.
   *
   * Absent covers both "not a plugin" and "a plugin whose host is not decided
   * yet" -- the second is a real state a person is in when they open the wizard,
   * and the honest thing to do with it is add the gear and let the resolver say
   * it fills nothing.
   */
  readonly host?: {
    readonly id: string;
    /** The source the *host* is read from, needed only to promote it. */
    readonly source: string;
    readonly standing: HostStanding;
  };
}

export type Placement =
  | { readonly ok: true; readonly edits: readonly ProductEdit[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The one batch that declares the folder and puts the gear where it belongs.
 *
 * One batch rather than a sequence, because `applyEdits` folds them onto the
 * same text and fails the whole thing on any refusal -- a half-added gear is the
 * state this wizard used to be able to produce.
 */
export function placeNewGear(placement: NewGearPlacement, productLabel: string): Placement {
  const declare: ProductEdit = {
    kind: "add_source",
    id: placement.sourceId,
    at: placement.at,
  };

  const host = placement.host;
  if (host === undefined) {
    return { ok: true, edits: [declare, select(placement.gearId, placement.sourceId)] };
  }

  if (host.standing === "absent") {
    // Adding the host is a decision about the product, not about this gear, so
    // it is refused with the name of the thing to do rather than done quietly.
    return {
      ok: false,
      reason:
        `${productLabel} does not use ${host.id}, which is the gear ${placement.gearId} plugs ` +
        `into. Add ${host.id} to the product first, then create this plugin.`,
    };
  }

  // A host the closure pulled in has no `use_gear` to attach to, so it is
  // promoted to an explicit one first. That is a visible change to the
  // description, which is why it is part of the previewed batch rather than a
  // side effect.
  const promote: readonly ProductEdit[] =
    host.standing === "closure-only" ? [select(host.id, host.source)] : [];

  return {
    ok: true,
    edits: [
      declare,
      ...promote,
      // **The plugin goes inside the host, and appends.** `set_plugins` would
      // rewrite the host's list as bare `plugin("id")` entries and drop the
      // `profiles` and `config` the other entries carry.
      { kind: "add_plugin", gear: host.id, plugin: placement.gearId },
    ],
  };
}

function select(gear: string, source: string): ProductEdit {
  return { kind: "add_gear", gear, source };
}
