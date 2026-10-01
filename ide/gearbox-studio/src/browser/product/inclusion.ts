// Why a gear is in a product, in words, in the two registers the screens need.
//
// **Two functions, deliberately not one.** They answer the same question at
// different lengths and under different rules, and merging them would silently
// change text a claim reads back: `prd-product.spec.ts` asserts the exact
// sentence `describeInclusion` produces for a co-located gear.
//
// They live together so the difference is visible rather than discoverable:
// whoever next edits one will see the other and have to mean it.

import type { InclusionReason } from "../../common/generated/InclusionReason";

/**
 * One reason, as a sentence, for a list that shows every reason.
 *
 * Every reason, because a gear can be in a product for more than one -- and the
 * interesting case is an inclusion reason that differs between profiles: dev
 * links the static plugin and prod the OIDC one, from the same description.
 *
 * Moved here from the Product widget's old Gears stage, which the Composition
 * tree replaced: the reasons are the same ones, and the words for them should be
 * too. It now serves a third surface, the settings pane, for the same reason.
 */
export function describeInclusion(reason: InclusionReason): string {
  switch (reason.reason) {
    case "selected":
      return "asked for by the product";
    case "colocated_by":
      return `co-located with ${reason.gear}`;
    case "plugin_of":
      return `plugin of ${reason.host} for ${reason.profile}`;
  }
}

/**
 * The whole inclusion, as a phrase, for a table column that has room for one.
 *
 * **Not `describeInclusion` of the first reason**, and the two differences are
 * both load-bearing. It says `asked for` rather than `asked for by the product`,
 * because the column's heading already supplies the subject. And `selected` wins
 * over everything else when both are recorded: a gear the description names is
 * asked for, whatever else also happens to pull it in -- which matters for the
 * Add Gear preview, where the question is whether a person would have to remove
 * this gear if they did not want it.
 */
export function whyPresent(gear: { selected_by: readonly InclusionReason[] }): string {
  const reasons = gear.selected_by;
  if (reasons.some((reason) => reason.reason === "selected")) return "asked for";
  const first = reasons[0];
  if (first === undefined) return "pulled into the closure";
  switch (first.reason) {
    case "selected":
      return "asked for";
    case "colocated_by":
      return `co-located with ${String(first.gear)}`;
    case "plugin_of":
      return `plugin of ${String(first.host)}`;
    default:
      return "pulled into the closure";
  }
}
