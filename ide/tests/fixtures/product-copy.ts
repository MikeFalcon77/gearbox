// A product of one claim's own, so that two claims cannot write the same file.
//
// **Restoring is not isolating.** Every mutating claim in this suite edits one
// shipped description and puts it back, and the guards check afterwards that it
// did. That catches damage; it does not stop a claim from reading a file another
// claim is halfway through changing, and it cannot see a write that lands after
// the check. One run left a deliberate typo inside `products/payments-demo`
// mid-run and a later claim took it as its baseline. The carrier is still
// unproven; the exposure does not depend on knowing it.
//
// **The id is the part that isolates, not the directory.** A generated tree
// lives at `.gearbox/<product id>/<profile>/`, keyed on the id the description
// declares -- so a copy that kept `id = "payments-demo"` would share the
// original's lock and share every claim that reads it. The copy is renamed.
//
// **Unique between runs, too.** A leftover from a crashed run must never be
// adopted as this run's baseline, which is the same mistake as restoring from a
// poisoned snapshot. The suffix is random rather than derived, so a leftover
// cannot collide with a live copy; and because it stays untracked, `global-setup`
// refuses the *next* run until someone looks at it, which is the right amount of
// noise for a run that died.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * The copies that exist right now, by id.
 *
 * The per-test guard asks `git status -- products` and refuses anything it did
 * not expect — correctly, and a live copy is untracked, so without this every
 * claim in a file that makes one would be reported for the copy's own existence.
 * A copy is expected only while it is *live*: `dispose` unregisters it, so one a
 * claim forgets to remove is still reported, by the teardown that asks without
 * this filter.
 */
const live = new Set<string>();

/** Porcelain path prefixes the guard should treat as expected. */
export function liveCopies(): string[] {
  return [...live].map((id) => `products/${id}/`);
}

/** One claim's private copy of a shipped product. */
export interface ProductCopy {
  /** The id the copy declares, and therefore the name of its generated tree. */
  readonly id: string;
  /** Absolute path to the copied description. */
  readonly path: string;
  /** Repo-relative, for `git diff` and for messages a reader follows. */
  readonly rel: string;
  /**
   * Write the generated tree for one profile, and return the lock's path.
   *
   * The disk-reading lock claims borrowed the one `global-setup` primes for
   * `payments-demo/dev`, which made three of them depend on each other through a
   * file no guard in this suite can even see -- `.gearbox/` is gitignored, so a
   * restore that failed was undetectable, and the claim that needed a pristine
   * lock turned that into a `test.skip`. A claim that generates its own lock,
   * seconds earlier, can assert the state instead of hoping for it.
   */
  generate: (profile: string) => string;
  /** Remove the copy and everything generated from it. */
  dispose: () => void;
}

/**
 * Copy a shipped product under a fresh id.
 *
 * The text comes from **`git show HEAD:`**, not from the working tree: the whole
 * point is a baseline nothing in this run can have touched, and reading the file
 * would inherit exactly the damage this exists to escape.
 *
 * `slug` names the claim, so a leftover says which one made it.
 */
export function copyProduct(repo: string, source: string, slug: string): ProductCopy {
  const committed = execFileSync("git", ["show", `HEAD:products/${source}/product.gdl`], {
    cwd: repo,
    encoding: "utf8",
  });
  const declared = `id = "${source}"`;
  if (!committed.includes(declared)) {
    throw new Error(
      `products/${source}/product.gdl does not declare \`${declared}\`, so a copy of it ` +
        `cannot be renamed -- and an unrenamed copy shares the original's .gearbox tree.`,
    );
  }
  const id = `conformance-${slug}-${randomBytes(3).toString("hex")}`;
  const dir = join(repo, "products", id);
  const path = join(dir, "product.gdl");
  mkdirSync(dir, { recursive: true });
  live.add(id);
  // One occurrence only. `source(id = "gears-rust", …)` matches the same shape,
  // and renaming *that* would point the copy at a corpus that does not exist.
  writeFileSync(path, committed.replace(declared, `id = "${id}"`));
  return {
    id,
    path,
    rel: `products/${id}/product.gdl`,
    generate: (profile: string) => {
      try {
        execFileSync(
          join(repo, "target/debug/gearbox"),
          ["generate", "--root", "../gears-rust", "--product", `products/${id}/product.gdl`,
           "--profile", profile],
          { cwd: repo, encoding: "utf8", stdio: "pipe" },
        );
      } catch (error) {
        const detail = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        throw new Error(
          `Could not generate \`${id}\` for \`${profile}\`, so this claim has no lock to ` +
            `read.\n\n${detail}`,
        );
      }
      return join(repo, ".gearbox", id, profile, "product.lock");
    },
    dispose: () => {
      // Exactly what this made, and nothing else. Not `git clean -fd -- products`:
      // that is what the guards use, against a tree `global-setup` has already
      // refused to start dirty, and it would delete a product someone is working
      // on that git does not track yet.
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(repo, ".gearbox", id), { recursive: true, force: true });
      live.delete(id);
    },
  };
}
