#!/usr/bin/env node
// Starts Studio with an environment the AI chat can actually use.
//
// Two things went wrong often enough to be worth automating, and both presented
// as the same useless symptom -- the chat answering `Connection error.` to every
// question, with no clue that the failure was TLS and not the key.
//
// **The key was on disk and nothing read it.** `README.md` says the chat reads
// `ANTHROPIC_API_KEY` from the backend's environment, and a `.env` at the repo
// root holds one -- but nothing loaded it. `theia start` reads no dotfile, there
// is no `dotenv` in this tree, and no script sourced it. So the key reached the
// backend only if it happened to be exported in the launching shell.
//
// **A broken trust store looked like a network outage.** A `NODE_OPTIONS` of
// `--use-openssl-ca` tells Node to drop its bundled roots and read OpenSSL's
// store instead. The Node binaries used here bundle their own OpenSSL with no
// `openssl_system_ca_path` compiled in, so when neither `SSL_CERT_FILE` nor
// `SSL_CERT_DIR` names one either, the store is *empty* and every HTTPS request
// from the backend fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. The Anthropic
// SDK sees a rejected `fetch` -- no status, no headers -- and reports its default
// `APIConnectionError` message, which is the bare string `Connection error.`
//
// Usage: node ide/scripts/start-studio.mjs      (or: npm run start:browser)

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ide = resolve(here, "..");
const repo = resolve(ide, "..");

/**
 * Parse a dotenv file well enough for `KEY=value`, and no further.
 *
 * Hand-rolled rather than a dependency: `README.md` devotes a section to how
 * fragile this dependency tree is -- one stray `^` on a `@theia/*` package
 * duplicates `@theia/core` and breaks inversify identity -- and a new runtime
 * package for twenty lines of splitting on `=` is not a trade worth making.
 *
 * Unparseable lines are skipped rather than fatal: a malformed comment should
 * not stop the IDE from starting.
 */
function parseEnv(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, which is how a value with spaces is
    // written; anything more (escapes, interpolation) is a shell feature and a
    // dotenv file is not a shell.
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) value = value.slice(1, -1);
    out.set(key, value);
  }
  return out;
}

const env = { ...process.env };
const notes = [];

// --- the key -----------------------------------------------------------------

const dotenv = resolve(repo, ".env");
if (existsSync(dotenv)) {
  let loaded = 0;
  let shadowed = 0;
  for (const [key, value] of parseEnv(readFileSync(dotenv, "utf8"))) {
    // **The shell wins over the file.** Overriding an explicitly exported
    // variable would make `ANTHROPIC_API_KEY=... npm run start:browser` -- the
    // documented way to use a different key for one run -- silently do nothing.
    if (env[key] !== undefined) {
      shadowed += 1;
      continue;
    }
    env[key] = value;
    loaded += 1;
  }
  notes.push(
    `loaded ${loaded} variable(s) from .env` +
      (shadowed > 0 ? `, left ${shadowed} already set in the environment alone` : ""),
  );
} else {
  notes.push("no .env at the repo root (see .env.example)");
}

// --- the trust store ---------------------------------------------------------

/**
 * Is `--use-openssl-ca` provably pointing at nothing?
 *
 * Decided offline, from facts about this binary, rather than by opening a
 * connection: a launcher that needs the network to decide how to launch fails
 * in a new way when the network is down. `openssl_system_ca_path` is empty in
 * every Node that bundles its own OpenSSL without a configured store, and with
 * no `SSL_CERT_FILE`/`SSL_CERT_DIR` to name one, OpenSSL has no certificates to
 * load at all.
 */
function opensslStoreIsEmpty() {
  const configured = process.config?.variables?.openssl_system_ca_path;
  if (configured) return false;
  return !env.SSL_CERT_FILE && !env.SSL_CERT_DIR;
}

const nodeOptions = env.NODE_OPTIONS ?? "";
if (/(^|\s)--use-openssl-ca(\s|$)/.test(nodeOptions) && opensslStoreIsEmpty()) {
  // **Strip just this flag, and say so.** Silently rewriting somebody's
  // `NODE_OPTIONS` is worse than the bug it works around, so the removal is
  // printed and everything else in the variable is preserved.
  env.NODE_OPTIONS = nodeOptions.replace(/(^|\s)--use-openssl-ca(?=\s|$)/, "$1").trim();
  if (env.NODE_OPTIONS === "") delete env.NODE_OPTIONS;
  console.warn(
    "\n!! Removed `--use-openssl-ca` from NODE_OPTIONS for this process.\n" +
      "   This Node bundles its own OpenSSL with no CA store configured, and neither\n" +
      "   SSL_CERT_FILE nor SSL_CERT_DIR names one, so the flag leaves an empty trust\n" +
      "   store and every HTTPS request fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY.\n" +
      "   The chat reports that as `Connection error.`\n" +
      "   To keep the flag, point SSL_CERT_FILE at a real bundle (/etc/ssl/cert.pem on\n" +
      "   macOS). To trust an extra corporate root, prefer NODE_EXTRA_CA_CERTS, which\n" +
      "   appends to Node's bundled roots instead of replacing them.\n",
  );
}

// A single corporate root in SSL_CERT_FILE *replaces* the default store on Node
// >= 22, which trades "cannot verify the corporate proxy" for "cannot verify
// anything public". Warned about rather than unset: it may be load-bearing for
// an internal host, and that is the operator's call, not the launcher's.
if (env.SSL_CERT_FILE && existsSync(env.SSL_CERT_FILE)) {
  const certs = (readFileSync(env.SSL_CERT_FILE, "utf8").match(/BEGIN CERTIFICATE/g) ?? []).length;
  if (certs > 0 && certs < 5) {
    console.warn(
      `\n!! SSL_CERT_FILE=${env.SSL_CERT_FILE} holds only ${certs} certificate(s).\n` +
        "   On Node >= 22 this replaces the whole trust store, so public hosts such as\n" +
        "   api.anthropic.com will fail to verify. Use NODE_EXTRA_CA_CERTS for an extra\n" +
        "   root, and leave SSL_CERT_FILE for a full bundle.\n",
    );
  }
}

// --- launch ------------------------------------------------------------------

console.log(`Studio: ${notes.join("; ")}`);
console.log(`Studio: AI chat key ${env.ANTHROPIC_API_KEY ? "present in the backend environment" : "not in the environment (the gearbox.ai.apiKey setting is the other way in)"}`);

// Delegated rather than restated: the `theia start` invocation, its plugin
// directory, host and port live in `browser-app/package.json`, and a second copy
// here would be correct until the day somebody changed one of them.
const child = spawn("npm", ["run", "start", "--workspace", "browser-app"], {
  cwd: ide,
  env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  // Re-raise rather than translate, so `npm start` and CI see what really
  // happened to the backend.
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
