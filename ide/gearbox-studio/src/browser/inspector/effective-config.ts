// What a gear will actually run with, and where each value came from.
//
// Both halves used to live inside `InspectorWidget`: `nodeIdOf` as a file-local
// function, `provenanceOf` as a protected method. That was fine while the
// Inspector was the only thing asking. It stopped being fine when a second
// caller appeared -- the chat's context variables and tools, which must answer
// about the *same* configuration the Inspector renders or they are answering
// about a different product than the one on screen.
//
// So this is an extraction, not a new computation. The rules are the ones the
// Inspector already applied, moved rather than restated, for the reason
// `shell/unsaved.ts` exists: three byte-identical copies of a delicate
// comparison is how a normalisation drifts between them without anything
// noticing.
//
// **The draft is part of the answer.** A value typed into a control but not yet
// applied is what this product will say once Apply runs, so it outranks the
// file. A tool that read only the file would tell the model the old value while
// the operator is looking at the new one.

import type { ConfigProvenance } from "../add-gear/config-fields";
import type { ProductEditService } from "../product-edit-service";
import type { ProductStore, Focus } from "../product-store";

/**
 * The node id for a selection.
 *
 * `NodeId` is documented as `{kind}:{payload}` and content-derived, so the
 * format is part of the wire contract rather than an internal detail. It is
 * still a second place where the convention is written down, which is why the
 * Inspector's render says so out loud when the lookup fails instead of showing
 * an empty list -- a silent "no explanation" is exactly how a drifted id format
 * would hide.
 *
 * That alarm earned itself. The process-to-application rename (ADR-0016)
 * rewrote `` `process:${focus.id}` `` to `` `application:` ``, eating the
 * interpolation and leaving every application's node id as a bare prefix.
 */
export function nodeIdOf(focus: Focus): string {
  switch (focus.kind) {
    case "gear":
      return `gear:${focus.id}`;
    case "application":
      return `application:${focus.id}`;
    case "binding":
      return `binding:${focus.consumer}|${focus.contract}`;
  }
}

/** The same selection as a phrase, for a sentence a person reads. */
export function describeFocus(focus: Focus): string {
  switch (focus.kind) {
    case "gear":
      return `gear ${focus.id}`;
    case "application":
      return `application ${focus.id}`;
    case "binding":
      return `binding ${focus.consumer} → ${focus.contract}`;
  }
}

/** The two services a provenance answer is derived from. */
export interface ConfigSources {
  readonly edits: ProductEditService;
  readonly products: ProductStore;
}

/**
 * Where one config value came from.
 *
 * Derived from what is already on screen, with no new wire field: the intent
 * says what the *description* sets, the resolution says what the product will
 * run with, and the difference between them is what the resolver decided.
 * `GBX0114` is the engine's opinion about the overlap -- setting a key an
 * endpoint derives -- and this is the same fact rendered before the warning.
 */
export function provenanceOf(
  sources: ConfigSources,
  gearId: string,
  key: string,
  declared: Readonly<Record<string, unknown>>,
): ConfigProvenance {
  // The draft wins over the file, because it is what this product will say once
  // Apply runs: a control just typed into must not read as "the gear's
  // default", and a key a reset has queued for removal must not still read as
  // "set by this product".
  const drafted = sources.edits.draftConfigState(gearId, key);
  if (drafted === "set") return "explicit";
  // Reset queues removal: the value on disk (and therefore in the last
  // resolution) is about to go, so do not label it "derived by the resolver"
  // just because the resolved product still holds the old key.
  if (drafted === "removed") return "default";
  if (drafted === undefined && Object.prototype.hasOwnProperty.call(declared, key)) {
    return "explicit";
  }
  const resolved = sources.products.current.resolution?.product?.gears?.[gearId]?.config ?? {};
  if (Object.prototype.hasOwnProperty.call(resolved, key)) return "derived";
  return "default";
}

/** One key of a gear's effective configuration. */
export interface EffectiveConfigEntry {
  readonly key: string;
  readonly value: unknown;
  readonly provenance: ConfigProvenance;
  /** Whether an unapplied edit is the reason this reads the way it does. */
  readonly drafted: boolean;
}

/**
 * Every config key a gear will run with, with each one's provenance.
 *
 * The union of what the description declares (as the draft would leave it) and
 * what the resolution derived, which is wider than either: a key the resolver
 * added is not in the description, and a key just typed is not yet in the
 * resolution. Sorted by name, because a caller that renders this wants a stable
 * order and a caller that sends it to a model wants a deterministic one.
 *
 * **A key queued for removal is absent rather than stale.** `draftConfigValues`
 * has already dropped it, but the last resolution still holds it, and reporting
 * that value beside a `default` provenance would be two halves of the answer
 * disagreeing.
 */
export function effectiveConfigOf(
  sources: ConfigSources,
  gearId: string,
  declared: Readonly<Record<string, unknown>>,
): EffectiveConfigEntry[] {
  // Scalars only, and that is `draftConfigValues`' documented bargain: a
  // non-scalar has no typed control. It stays visible here because the raw
  // maps below are consulted when the typed overlay has no entry.
  const drafted = sources.edits.draftConfigValues(gearId, declared);
  const resolved = sources.products.current.resolution?.product?.gears?.[gearId]?.config ?? {};
  const keys = new Set<string>([
    ...Object.keys(resolved),
    ...Object.keys(declared),
    ...drafted.keys(),
  ]);
  const entries: EffectiveConfigEntry[] = [];
  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    if (sources.edits.draftConfigState(gearId, key) === "removed") continue;
    entries.push({
      key,
      // Same precedence as `provenanceOf`: the draft wins, then what the
      // resolver produced, then what the description says on disk.
      value: drafted.has(key) ? drafted.get(key) : (resolved[key] ?? declared[key]),
      provenance: provenanceOf(sources, gearId, key, declared),
      drafted: sources.edits.isDraftedConfig(gearId, key),
    });
  }
  return entries;
}
