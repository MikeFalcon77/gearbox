# Gearbox Studio (Eclipse Theia)

The editor front end for the Gearbox engine. Three views exist today: the **Catalogue**, a
**Gear detail** panel, and the **co-location Graph**. Product, Explain, Lock and Generate need the
resolver (M4) and say so in the UI, driven by the engine's own reported capabilities rather than by
a hard-coded string.

## Running it

```bash
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
npm run smoke        # JSON-RPC over real vscode-jsonrpc framing, no browser
npm run ui-smoke     # headless Chrome against a running app (start it first)
npm run verify       # smoke + build + ui-smoke
```

`ui-smoke.mjs` samples the DOM on a timeline rather than after loading finishes, because the claim
under test is that a row is useful *before* it is complete. A snapshot taken at the end would pass
even if the tree had appeared all at once.

## Two things that will bite

**One pinned `@theia/*` version, repeated in the root `overrides`.** The version lives in
`theia-version.txt`. A transitive `^` pulls a second `@theia/core` copy, which breaks inversify
identity -- the most common Theia build failure. Check with `npm ls @theia/core`: exactly one entry.

**`npm install` reports install scripts it did not run** (`esbuild`, `node-pty`, `puppeteer`,
`@parcel/watcher`, and others; npm 11 blocks them by default). None are needed: esbuild's native
binary arrives through its platform package, and the browser target does not use `node-pty` or
electron assets. Approving them runs arbitrary postinstall code, so leave them blocked unless
something actually fails.
