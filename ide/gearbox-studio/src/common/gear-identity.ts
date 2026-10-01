// What a new gear's id and version may be, checked where they are typed.
//
// Both rules live in the engine and are enforced there -- `GearId::new` refuses
// a non-kebab id (`scaffold_gear`, GBX-shaped refusal) and `is_semver` refuses
// anything but `X.Y.Z` -- and that is where they must stay: a client is not a
// boundary. What the client owes is *saying so at the field*, because the only
// feedback before this was a scaffold dry run whose error landed in the preview
// pane on the other side of the screen, four hundred milliseconds later.
//
// Mirrored, therefore, and deliberately narrower in one direction: these accept
// nothing the engine would refuse. If they ever disagree, the engine wins and
// the dry run still says so.

/** Why this gear id cannot be used, or `undefined` if it can. */
export function gearIdProblem(id: string): string | undefined {
  const trimmed = id.trim();
  if (trimmed === "") return "a gear needs an id";
  if (trimmed !== id) return "a gear id cannot start or end with a space";
  // The same shape `GearId::new` accepts: lowercase kebab-case, no leading or
  // trailing dash, no doubled dash.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed)) {
    return "a gear id is lowercase words joined by single dashes, like `payments-audit`";
  }
  return undefined;
}

/**
 * Why this version cannot be used, or `undefined` if it can.
 *
 * `X.Y.Z`, digits only, which is what `is_semver` checks. Pre-release and build
 * metadata are refused rather than accepted-and-dropped: the value goes into a
 * generated `Cargo.toml`, and a version cargo reads differently from the way
 * this tool wrote it is worse than a refusal at the field.
 */
export function gearVersionProblem(version: string): string | undefined {
  const trimmed = version.trim();
  if (trimmed === "") return "a gear needs a version";
  if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
    return "a version is three numbers, like `0.1.0`";
  }
  return undefined;
}
