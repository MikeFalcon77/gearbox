// The four things the suite cannot discover for itself, settled before any
// browser opens so that a stale tree fails as a setup error rather than as a
// puzzling conformance failure.
//
// Two are prepared and two are checked, and the split is not arbitrary: what
// the tool owns is brought up to date, what a person owns is only reported on.
// The engine binary and the generated tree are the tool's; the frontend bundle
// and the product descriptions are built and edited by people, so a stale one
// is said out loud and left alone.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { productsStatus, restoreCommand } from "./fixtures/products-tree";
import { corpusStatus, restoreCorpusCommand } from "./fixtures/corpus-files";
import { startWatching } from "./fixtures/description-watch";
import { resetWriteTraces } from "./fixtures/write-traces";

/** The newest mtime under a directory tree. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

export default function globalSetup(): void {
  // `__dirname`, not `import.meta.url`: Playwright transpiles to CJS, so
  // `import.meta` is a syntax error here. And not `config.rootDir` either --
  // that is `ide/tests`, because Playwright roots the config at `testDir`.
  const IDE = join(__dirname, "..");
  const BUNDLE = join(IDE, "browser-app/lib/frontend/bundle.js");
  const STUDIO_SRC = join(IDE, "gearbox-studio/src");

  // The backend spawns `../target/debug/gearbox`, so a change on the Rust side
  // is invisible to `npm run build`. Leaving the two out of step has already
  // cost a debugging session once: the client reported a missing source root
  // that the engine had been taught to send.
  execFileSync("cargo", ["build", "--manifest-path", "../Cargo.toml", "-p", "gearbox-cli"], {
    cwd: IDE,
    stdio: "inherit",
  });

  // A conformance suite run against a stale bundle reports on code that is no
  // longer there, and reports it as success. This is the same failure `make
  // ts-check` and `make grammar-check` exist to prevent, one layer out.
  if (!existsSync(BUNDLE)) {
    throw new Error(`No frontend bundle at ${BUNDLE}. Run \`npm run build\` first.`);
  }
  const built = statSync(BUNDLE).mtimeMs;
  const source = newestMtime(STUDIO_SRC);
  if (source > built) {
    throw new Error(
      `The frontend bundle is older than gearbox-studio/src ` +
        `(source ${new Date(source).toISOString()} > bundle ${new Date(built).toISOString()}).\n` +
        `Run \`npm run build\`. Testing the old bundle would report on code that is not there.\n` +
        `\nThis also fires after \`make ts\` or \`make ts-check\` even when nothing changed: ` +
        `ts-rs rewrites every file under src/common/generated on each run, so their mtimes move ` +
        `while their contents do not. The comparison is by mtime and errs towards rebuilding, ` +
        `which is the safe direction and costs about two seconds. \`npm run verify\` builds first, ` +
        `so it never sees this.`,
    );
  }

  // The product descriptions must match HEAD before anything runs.
  //
  // Two claims edit `products/payments-demo/product.gdl` and put it back, and
  // several more assert on the resolution it produces. A description that is
  // already modified when the suite starts therefore fails in two unrelated
  // files at once -- the tier-3 claim refusing to run, and a co-location claim
  // reporting a gear as `asked for` that it expects to be `pulled in` -- and
  // neither failure names the cause. That happened: a stray
  // `use_gear("grpc-hub", ...)` left behind by something outside the suite, and
  // the two failures sent the reader looking at the graph work instead.
  //
  // Checked here rather than in a fixture so it fails once, before any browser
  // opens, and says what to do. Restoring the file automatically would be worse:
  // the edit might be someone's work in progress.
  // `cwd` is the repository, not `ide`: `products/` is its sibling, and a
  // pathspec git cannot find matches nothing and reports clean -- which is how
  // this guard silently passed the first time it was written.
  const dirty = productsStatus(join(IDE, ".."));
  if (dirty !== "") {
    throw new Error(
      `The product descriptions differ from HEAD:\n${dirty}\n\n` +
        `Two claims edit \`products/payments-demo/product.gdl\` and restore it, and others assert ` +
        `on the resolution it produces, so a modified description fails claims that have nothing ` +
        `to do with the change.\n` +
        // The remedy is computed, not fixed. This guard spent a while refusing
        // every run over an untracked `products/new-product/` left by the Create
        // wizard while telling the reader to run `git checkout`, which cannot
        // remove one.
        `Commit the edit, or run \`${restoreCommand(dirty)}\` if it is a leftover.`,
    );
  }

  // The gear descriptions this suite edits must match HEAD too.
  //
  // Same reason as `products/` above, one repository over: two claims rewrite a
  // `gear.gdl` in the corpus and put it back, and a file already modified when
  // the suite starts makes an unrelated claim fail. Named files only -- the
  // corpus is a separate checkout with its own work in progress, so asking
  // whether *it* is clean would refuse every run on most machines. See
  // `fixtures/corpus-files.ts`.
  const dirtyCorpus = corpusStatus(join(IDE, ".."));
  if (dirtyCorpus !== "") {
    throw new Error(
      `A gear description this suite edits differs from HEAD:\n${dirtyCorpus}\n\n` +
        `Two claims rewrite a \`gear.gdl\` and restore it, and others read the catalogue it ` +
        `produces.\n` +
        `Commit the edit, or run \`${restoreCorpusCommand()}\` if it is a leftover.`,
    );
  }

  // The generated tree is brought up to date rather than reported on.
  //
  // `.gearbox/` is gitignored, machine-local output, so how old it is says
  // something about whoever last ran `generate` on this checkout and nothing
  // about the code under test. Two claims read it from disk: one asserts the
  // badge reads `current`, and the other skips itself with "regenerate it to
  // observe the matching case". So a commit that changes `product.gdl` -- which
  // is an ordinary commit -- turns the first red and the second unobserved in a
  // run where the application is behaving perfectly. That is not hypothetical:
  // it cost an investigation that began in the wrong file, and the suite's own
  // table was what eventually said so.
  //
  // Prepared rather than checked for the same reason the engine above is built
  // rather than checked. It is the tool's own output -- tier 2 in ADR-0010's
  // terms -- and never anybody's work in progress, which is exactly the
  // argument that stops the guard above from restoring `products/` for you.
  //
  // **After that guard, never before it.** Generating from a modified
  // description would write a lock for a resolution no claim is about to
  // assert on, and the disk comparison would then be current and wrong.
  //
  // `dev` alone: it is the profile both disk-reading claims name. Every other
  // lock assertion reads the widget, which resolves for itself.
  //
  // The output is captured rather than inherited, because a successful prime
  // has nothing to say and a failed one has to say all of it -- so the message
  // carries the engine's own stderr instead of leaving it above a stack trace.
  try {
    execFileSync(
      join(IDE, "../target/debug/gearbox"),
      [
        "generate",
        "--root",
        "../gears-rust",
        "--product",
        "products/payments-demo/product.gdl",
        "--profile",
        "dev",
      ],
      { cwd: join(IDE, ".."), encoding: "utf8", stdio: "pipe" },
    );
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    throw new Error(
      `Could not generate \`payments-demo\` for \`dev\`, so the lock on disk cannot be ` +
        `trusted to describe the current description.\n\n` +
        `If the errors below are \`names a gear that is not in the catalogue\`, the source root ` +
        `is the thing to look at rather than the description: the gears live in the ` +
        `\`gears-rust\` checkout beside this one, on its \`feature/gearbox\` branch, and a ` +
        `checkout sitting on another branch has no \`gear.gdl\` in it at all. The whole suite ` +
        `reads that catalogue, so this fails here rather than as a hundred and sixty ` +
        `unexplained claims.\n${detail}`,
    );
  }

  resetWriteTraces();
  // **Last, after every guard.** The watcher records writes; starting it before
  // the generate step above would log that step as one, which is exactly the
  // noise a reader would have to learn to ignore.
  startWatching(join(IDE, ".."));
}
