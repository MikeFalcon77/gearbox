// Refuse to start Studio on a Node other than the one `.nvmrc` names.
//
// **Why a check and not a hope.** `.nvmrc` is read only by an explicit
// `nvm use`; `engines` in package.json is checked by `npm install`, never by
// `npm run`. So whatever `node` the shell resolves is the one that runs, and
// nvm's `default` alias decides that, not the tree.
//
// **Why it has to be loud.** The native addons under `node_modules` are built
// for the Node that ran `npm install`. Loaded by another major, `drivelist.node`
// does not throw -- it segfaults (exit 139) while Theia prints "loading
// modules...", so there is no message and no stack. Playwright reports only
// "Process from config.webServer exited early", and its global setup never runs:
// the web server is started first. Measured 2026-10-02 with nvm's default at 20
// against an `.nvmrc` of 26.
//
// The major is compared, not the full version: a patch or minor release keeps
// the module ABI, a major does not.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ide = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Exit with an explanation unless the running Node's major is `.nvmrc`'s. */
export function requireNodeFromNvmrc() {
  let wanted;
  try {
    wanted = readFileSync(join(ide, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  } catch {
    // No pin, nothing to hold the runtime to.
    return;
  }
  const wantedMajor = wanted.split(".")[0];
  const runningMajor = process.versions.node.split(".")[0];
  if (wantedMajor === runningMajor) return;
  process.stderr.write(
    `Studio needs Node ${wanted} (ide/.nvmrc), but this is ${process.version} (${process.execPath}).\n` +
      `Its native addons are built for Node ${wanted}; under another major the backend crashes ` +
      `with no message.\n` +
      `Run \`nvm use\` in ide/ (or \`nvm alias default ${wantedMajor}\`) and start again.\n`,
  );
  process.exit(1);
}
