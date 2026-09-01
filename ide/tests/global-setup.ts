// Three preconditions the suite cannot discover for itself, checked before any
// browser opens so that a stale tree fails as a setup error rather than as a
// puzzling conformance failure.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "products"], {
    cwd: join(IDE, ".."),
    encoding: "utf8",
  }).trim();
  if (dirty !== "") {
    throw new Error(
      `The product descriptions differ from HEAD:\n${dirty}\n\n` +
        `Two claims edit \`products/payments-demo/product.gdl\` and restore it, and others assert ` +
        `on the resolution it produces, so a modified description fails claims that have nothing ` +
        `to do with the change.\n` +
        `Commit the edit, or run \`git checkout -- products\` if it is a leftover.`,
    );
  }

  resetWriteTraces();
}
