#!/usr/bin/env node
// A second Studio backend, for the claims that have to break one.
//
// **Not the one you have open.** The timeout claim ends its engine on purpose
// and then re-initializes; run against a shared backend it would take somebody's
// session down mid-review, and against a *reused* one it would inherit whatever
// engine that session had already wedged. So this is its own process, on its own
// port, with its own Theia configuration directory -- and the Playwright project
// that uses it sets `reuseExistingServer: false`, which is the half of the
// separation a script cannot enforce.
//
// The workspace is passed explicitly rather than restored. `theia start <dir>`
// is the documented positional (`WorkspaceCliContribution`), and the alternative
// is `recentworkspace.json` in the config directory -- which this deliberately
// does not share, so there would be nothing in it. A server that opened no
// workspace finds no products, and the claim would fail on its *first* step for
// a reason that has nothing to do with engines.
//
// Usage: GEARBOX_STUDIO_PORT=3100 node ide/scripts/start-studio-wedge.mjs
//
// Deliberately *not* a copy of `start-studio.mjs`: that script exists to load
// `.env` and to repair a `NODE_OPTIONS` that breaks the AI chat, and neither is
// this server's business -- it answers one claim and never talks to Anthropic.
// What it does share is the refusal to restate the `theia start` invocation; see
// below.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ide = resolve(here, "..");
const repo = resolve(ide, "..");

const port = process.env.GEARBOX_STUDIO_PORT ?? "3100";
const hostname = process.env.GEARBOX_STUDIO_HOSTNAME ?? "127.0.0.1";
const workspace = resolve(process.env.GEARBOX_STUDIO_WORKSPACE ?? repo);

/**
 * The application's own launch arguments, minus the address.
 *
 * Derived rather than restated, for the reason `start-studio.mjs` gives: the
 * plugin directory and every flag the app needs live in
 * `browser-app/package.json`, and a second copy here would be correct until the
 * day somebody changed one of them. Only the address is this script's own,
 * because the whole point is that it is a different one -- and a second `--port`
 * on the command line does not override the first, it makes yargs hand the
 * backend `[3000, 3100]` and listen on a port nobody chose. Measured.
 */
function launchArguments() {
  const pkg = JSON.parse(readFileSync(join(ide, "browser-app/package.json"), "utf8"));
  const start = pkg.scripts?.start ?? "";
  if (!start.startsWith("theia start")) {
    throw new Error(
      `browser-app's \`start\` script is \`${start}\`, which this does not know how to ` +
        `re-address. It expects \`theia start …\`.`,
    );
  }
  if (/['"]/.test(start)) {
    throw new Error(
      `browser-app's \`start\` script quotes an argument (\`${start}\`), and splitting it on ` +
        `whitespace would break the quoted value. Teach this script to tokenize properly.`,
    );
  }
  const tokens = start.split(/\s+/).slice(2);
  if (tokens.some((token) => token === "--port" || token === "--hostname")) {
    throw new Error(
      `browser-app's \`start\` script writes the address as two tokens (\`${start}\`). This ` +
        `strips \`--port=…\` and \`--hostname=…\`; the separated form would leave the value ` +
        `behind as a stray positional, which Theia reads as a second workspace directory.`,
    );
  }
  return tokens.filter((token) => !/^--(port|hostname)=/.test(token));
}

// Its own configuration directory, so nothing here touches `~/.theia`: the
// layout, the recent workspace and the preferences of whatever Studio somebody
// has open are not this server's to rewrite. Fixed rather than temporary, so the
// plugin host does not re-extract the VS Code extensions on every run.
const configDir = process.env.THEIA_CONFIG_DIR ?? join(tmpdir(), "gearbox-studio-wedge", "config");
mkdirSync(configDir, { recursive: true });

const theia = join(ide, "node_modules/@theia/cli/bin/theia.js");
const args = ["start", workspace, ...launchArguments(), `--hostname=${hostname}`, `--port=${port}`];

console.log(`Studio (wedge): ${hostname}:${port}, workspace ${workspace}`);
console.log(`Studio (wedge): config ${configDir}`);
console.log(`Studio (wedge): engine ${process.env.GEARBOX_ENGINE ?? "(the default binary)"}`);

const child = spawn(process.execPath, [theia, ...args], {
  // `theia` resolves the application package from the working directory, so this
  // is not cosmetic: run from `ide` it would find no frontend to serve.
  cwd: join(ide, "browser-app"),
  env: { ...process.env, THEIA_CONFIG_DIR: configDir },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
