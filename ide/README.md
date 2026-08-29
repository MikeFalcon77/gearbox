# Gearbox Studio (Eclipse Theia)

The editor front end for the Gearbox engine. Three views exist today: the **Catalogue**, a
**Gear detail** panel, and the **co-location Graph**. Product, Explain, Lock and Generate need the
resolver (M4) and say so in the UI, driven by the engine's own reported capabilities rather than by
a hard-coded string.

## Running it

Node 24 (see `.nvmrc`). Theia 1.75 asks for `>= 24` in its own `doc/Developing.md`, and its
`ci-cd.yml` builds only `[24.x, 26.x]`, which is what `engines.node` here repeats. The `@theia/*`
packages declare no `engines` of their own, so nothing catches a wrong runtime for you.

```bash
nvm use                               # or any Node 24
cargo build -p gearbox-cli            # the engine the backend spawns
cd ide && npm ci && npm run build
npm run start:browser                 # http://127.0.0.1:3000
```

The backend finds the engine at `<repo>/target/debug/gearbox` and the source root at
`../gears-rust`, both overridable:

```bash
GEARBOX_ENGINE=/path/to/gearbox GEARBOX_ROOT=/path/to/gears npm run start:browser
```

## Checking it

```bash
npm run engine       # cargo build -p gearbox-cli -- the binary the backend spawns
npm run smoke        # JSON-RPC over real vscode-jsonrpc framing, no browser
npm run conformance  # Playwright; starts the app itself
npm run verify       # all of the above, plus the build and two more smokes
```

The browser is one explicit step, once: `npx playwright install chromium`. Playwright has no
postinstall of its own, so npm's install-script gate does not apply to it -- and nothing fetches
100 MB behind your back either.

**`npm run conformance` is organised by document, not by feature.** Each test in
`tests/conformance/` is named for one claim in the PRD, an ADR or §9 of the plan, and carries its
source in the title; a documented claim that is not implemented is a `test.fixme` with the same
name, so it is present, counted and traceable rather than absent. The run writes
`docs/conformance.md`. The number of collected claims is pinned: a claim that stops being collected
fails the run, because the script this replaced had eleven checks inside `if` guards and reported a
smaller denominator as "all passed".

The staged-loading tests sample the DOM on a timeline rather than after loading finishes, because
the claim under test is that a row is useful *before* it is complete. A snapshot taken at the end
would pass even if the tree had appeared all at once. The sampler is installed with
`addInitScript`, so it starts before Theia's own scripts.

**Every test gets a fresh browser context, and that is load-bearing.** Theia persists its layout,
and `initializeLayout` runs only when there is no saved layout -- deliberately, so that a closed
panel stays closed. An empty `localStorage` is what makes the panels open as designed, so setting
`storageState` or reusing a profile would fail half the suite for a reason unrelated to any claim.

**`npm run build` does not rebuild the engine.** The backend spawns
`../target/debug/gearbox`, so a change on the Rust side is invisible to the
TypeScript build -- and the symptom is a client that reports something the engine
was already taught to send. The suite's `globalSetup` builds it, and also fails if the frontend
bundle is older than `gearbox-studio/src` -- testing a stale bundle reports on code that is not
there, and reports it as success.

## The `.gdl` language

Syntax highlighting is a native Theia contribution
(`gearbox-studio/src/browser/gdl/`), not a bundled VS Code extension: this app
has no plugin host, so the `--plugins=local-dir:../plugins` flag in
`browser-app/package.json` is inert.

**The vocabulary it colours is generated, not written.**
`gearbox-studio/src/browser/gdl/generated/vocabulary.ts` comes from
`cargo test -p gearbox-gdl --test export_grammar`, which reads the globals the
interpreter actually evaluates against -- so the editor cannot colour a function
the engine does not have, nor miss one it does. Add a function to
`gdl_vocabulary` and `make grammar-check` fails until you run `make grammar` and
commit the result, exactly like `make ts-check`.

The regexes in `gdl-grammar.ts` are hand-written and stay that way: the volatile
part of a grammar is its word lists, the hard part is its patterns, and only the
first can drift.

## Three things that will bite

**One pinned `@theia/*` version, repeated in the root `overrides`.** The version lives in
`theia-version.txt`. A transitive `^` pulls a second `@theia/core` copy, which breaks inversify
identity -- the most common Theia build failure. Check with `npm ls @theia/core`: exactly one entry.

**`npm install` needs the corporate CA in `NODE_EXTRA_CA_CERTS`.** Nine packages have install
scripts, and two of them -- `drivelist` and `@theia/ffmpeg` -- compile from source through
`node-gyp`, which downloads Node headers over TLS and does *not* pick up the `cafile` npm itself
uses. Behind a TLS-intercepting proxy the download fails with `unable to get local issuer
certificate`, npm aborts, and the tree is left incomplete:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem
```

**One of those native modules is load-bearing, despite the browser target.** `@theia/core`'s
backend requires `drivelist/build/Release/drivelist.node` unconditionally, so skipping install
scripts -- with `ignore-scripts`, or by leaving npm's `allowScripts` gate unapproved -- produces a
backend that dies at startup with `Cannot find module`. `drivelist` publishes no prebuild for
darwin-arm64, so on Apple Silicon it is always compiled. `keytar` and `node-pty` really are unused
and `esbuild`'s binary really does arrive through its platform package; the mistake to avoid is
generalising from those to the whole list.

npm 11 warns that these scripts are "not yet covered by allowScripts" and then runs them anyway --
the warning is advice to codify the approvals, not a statement that nothing executed.
