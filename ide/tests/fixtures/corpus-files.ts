// Whether the gear descriptions this suite edits still match HEAD, and how to
// put them back.
//
// The sibling twin of `products-tree.ts`, and deliberately narrower. Two claims
// rewrite a `gear.gdl` in `../gears-rust` -- one to prove an open panel follows a
// saved description, one to prove the catalogue renders the diagnostics a load
// produced -- and until this existed nothing noticed a `gear.gdl` left rewritten.
// The precedent said so in a comment: "`global-setup` guards `products/` only, so
// nothing else in this suite would notice".
//
// **Scoped to named files, never to the tree, and that is not fastidiousness.**
// `../gears-rust` is a separate repository with its own branch and its own
// work in progress -- ten unrelated dirty files when this was written -- so a
// guard asking "does the corpus match HEAD" would refuse to start the suite on
// every machine that has any. It asks only about the files the suite itself
// touches.
//
// **And it restores with `checkout` only, never `clean`.** `products-tree.ts`
// may remove untracked entries because `global-setup` refuses to start against a
// dirty `products/`, so anything untracked there was made by the run. Nothing of
// the kind is true next door: an untracked file in the corpus is somebody's work,
// and this code will not touch it.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * The corpus checkout, as a sibling of the repository.
 *
 * The same relationship `products/payments-demo/product.gdl` declares as
 * `../../../gears-rust`, and the same default the backend uses when
 * `GEARBOX_ROOT` is unset.
 */
export function corpusRepo(repo: string): string {
  return join(repo, "..", "gears-rust");
}

/**
 * Every corpus file a claim in this suite rewrites.
 *
 * Add to this list when a claim starts editing another one, or the guard will not
 * be watching the file that broke.
 */
export const GUARDED_CORPUS_FILES: readonly string[] = [
  "gears/system/api-gateway/gear.gdl",
];

/** `git status --porcelain` for the guarded files, or `""` when they match HEAD. */
export function corpusStatus(repo: string): string {
  const corpus = corpusRepo(repo);
  try {
    return execFileSync(
      "git",
      ["status", "--porcelain", "--", ...GUARDED_CORPUS_FILES],
      { cwd: corpus, encoding: "utf8" },
    ).trim();
  } catch {
    // No corpus, or not a git checkout. Not this guard's business to complain:
    // `global-setup` already fails on a missing corpus with a better message,
    // and a corpus that is not a repository cannot be guarded or restored.
    return "";
  }
}

/** What changed in the guarded files, for a message a reader can act on. */
export function corpusDiff(repo: string): string {
  try {
    return execFileSync("git", ["diff", "--", ...GUARDED_CORPUS_FILES], {
      cwd: corpusRepo(repo),
      encoding: "utf8",
    });
  } catch {
    return "";
  }
}

/**
 * Put the guarded files back exactly as HEAD has them.
 *
 * Tracked-only, by path. See the header for why there is no `clean` here.
 */
export function restoreCorpus(repo: string): void {
  execFileSync("git", ["checkout", "--", ...GUARDED_CORPUS_FILES], {
    cwd: corpusRepo(repo),
  });
}

/** The command that restores this dirt, named so a reader can run it. */
export function restoreCorpusCommand(): string {
  return `git -C ../gears-rust checkout -- ${GUARDED_CORPUS_FILES.join(" ")}`;
}
