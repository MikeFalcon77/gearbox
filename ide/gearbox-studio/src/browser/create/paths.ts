// Relating two paths, and the two different questions that asks.
//
// A pure module because these are the parts worth checking and the widget that
// uses them cannot be constructed outside a browser -- the same reason
// `shell/opening-outcome.ts` and `create/gear-edits.ts` are separate. Two of the
// cases below were wrong when they lived inline, and neither was reachable from
// the platform this was written on.

/**
 * A path split into the volume it is on and the segments below it.
 *
 * **The root is kept, and losing it was a bug.** Splitting on `/` and dropping
 * empty segments turns `/a/b` into `["a","b"]`, which makes two POSIX absolute
 * paths with different first directories look like they share no volume -- so
 * `relativePath("/a/b", "/x/y")` answered "there is no path between these" when
 * the answer is `../../x/y`. And it turns `//server/one/a` and `//server/two/b`
 * into paths that appear to share `server`, which produces a relative path
 * across two different shares.
 *
 * So the volume is parsed rather than inferred: `/` for POSIX, `C:` for a drive,
 * `//server/share` for UNC. Case is folded for the two Windows forms and kept
 * for POSIX, because `C:` and `c:` are one drive while `/Users` and `/users` are
 * two directories.
 *
 * `undefined` for a relative input: this exists to relate two absolute paths,
 * and guessing a base for one that has none would be inventing an answer.
 */
export function volumeOf(value: string): { root: string; segments: string[] } | undefined {
  const slashed = value.replace(/\\/g, "/");
  const below = (rest: string): string[] =>
    rest.split("/").filter((part) => part !== "" && part !== ".");

  const unc = /^\/\/([^/]+)\/([^/]+)(\/.*)?$/.exec(slashed);
  if (unc !== null) {
    return { root: `//${unc[1]}/${unc[2]}`.toLowerCase(), segments: below(unc[3] ?? "") };
  }
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(slashed);
  if (drive !== null) {
    return { root: (drive[1] ?? "").toLowerCase(), segments: below(drive[2] ?? "") };
  }
  if (slashed.startsWith("/")) {
    return { root: "/", segments: below(slashed) };
  }
  return undefined;
}

/**
 * The path from one directory to another, `..` segments included.
 *
 * **Unlike [`relativeTo`], which refuses to leave its base.** That one answers
 * "is this inside the product's folder", and its `undefined` means "no, and that
 * is a refusal". A `cargo(path = ...)` legitimately climbs out -- the corpus
 * writes `../../tenant-resolver-sdk` -- so this one climbs, and the code it
 * replaced assumed a fixed two levels rather than counting.
 *
 * **Both sides are normalised, and that is not defensive.** One of them comes
 * from `CatalogueStore.absolutePath`, which joins with the separator the engine's
 * own root used -- so on Windows it hands back `C:\...` while the destination
 * this panel built is `C:/...`. Comparing those found no common segment, and the
 * locator silently stayed a comment: a feature that works on one platform and
 * quietly does not on another.
 *
 * `undefined` means the two are on different volumes and there is no relative
 * path to write -- two drives, or two UNC shares.
 */
export function relativePath(from: string, to: string): string | undefined {
  const a = volumeOf(from);
  const b = volumeOf(to);
  if (a === undefined || b === undefined || a.root !== b.root) return undefined;
  let shared = 0;
  while (
    shared < a.segments.length &&
    shared < b.segments.length &&
    a.segments[shared] === b.segments[shared]
  ) {
    shared += 1;
  }
  const parts = [
    ...new Array<string>(a.segments.length - shared).fill(".."),
    ...b.segments.slice(shared),
  ];
  return parts.length === 0 ? "." : parts.join("/");
}

export function relativeTo(descriptionPath: string, to: string): string | undefined {
  const directory = descriptionPath.replace(/\/[^/]+$/, "");
  const normalise = (value: string): string => value.replace(/\/+$/, "");
  const base = normalise(directory);
  const target = normalise(to);
  if (target === base) return ".";
  if (!target.startsWith(`${base}/`)) return undefined;
  return target.slice(base.length + 1);
}

