// Whether `products/` still matches HEAD, and how to put it back.
//
// Three guards ask the same question -- `global-setup` before the run,
// `global-teardown` after it, and a hook in the fixture after every test -- and
// all three used to answer it with `git checkout -- products`. That restores a
// *tracked* file and does nothing at all to an untracked one, so a Create-product
// flow writing outside the suite's own `conformance-*` ids left a tree that only
// `git clean` could fix. The setup guard then refused every later run while
// suggesting the command that could not help.
//
// So the knowledge lives here once: what dirty means, which half of it each
// remedy reaches, and which command to name.

import { execFileSync } from "node:child_process";

/** `git status --porcelain` for `products/`, or `""` when it matches HEAD. */
export function productsStatus(repo: string): string {
  return execFileSync("git", ["status", "--porcelain", "--", "products"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

/** Whether any line of a porcelain status is an untracked entry. */
export function hasUntracked(status: string): boolean {
  return status.split("\n").some((line) => line.startsWith("??"));
}

/** Whether any line of a porcelain status is a change to a tracked file. */
export function hasTracked(status: string): boolean {
  return status.split("\n").some((line) => line !== "" && !line.startsWith("??"));
}

/**
 * The command that actually restores this particular dirt.
 *
 * Named rather than guessed, because a reader follows it: `git checkout` for a
 * modified description, `git clean` for a product directory nothing tracks, and
 * both when the tree has both.
 */
export function restoreCommand(status: string): string {
  const parts: string[] = [];
  if (hasTracked(status)) parts.push("git checkout -- products");
  if (hasUntracked(status)) parts.push("git clean -fd -- products");
  return parts.join(" && ");
}

/**
 * Put `products/` back exactly as HEAD has it.
 *
 * Both halves, and removing the untracked half is safe *here* specifically:
 * `global-setup` refuses to start against a dirty `products/`, so anything
 * untracked in it by the time a test or the teardown looks was created by the
 * run itself. A work-in-progress product directory never reaches this code --
 * it stops the run before any browser opens.
 */
export function restoreProducts(repo: string): void {
  execFileSync("git", ["checkout", "--", "products"], { cwd: repo });
  execFileSync("git", ["clean", "-fdq", "--", "products"], { cwd: repo });
}

/**
 * What changed, for a message a reader can act on.
 *
 * `git diff` only speaks about tracked files, so an untracked leftover produced
 * an empty diff under a status line that said something was wrong. The porcelain
 * status is the part that names it, and this says so rather than printing
 * nothing.
 */
export function productsDiff(repo: string, status: string): string {
  const diff = execFileSync("git", ["diff", "--", "products"], {
    cwd: repo,
    encoding: "utf8",
  });
  if (!hasUntracked(status)) return diff;
  return `${diff}\n(entries marked \`??\` above are untracked, so no diff exists for them)\n`;
}
