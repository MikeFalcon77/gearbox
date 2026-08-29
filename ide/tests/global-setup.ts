// Two preconditions the suite cannot discover for itself, checked before any
// browser opens so that a stale tree fails as a setup error rather than as a
// puzzling conformance failure.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";


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
        `Run \`npm run build\`. Testing the old bundle would report on code that is not there.`,
    );
  }
}
