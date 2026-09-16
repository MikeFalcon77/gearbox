#!/usr/bin/env node
// Pins the error channel the engine's reasons travel on.
//
// The engine attaches its diagnostics to a JSON-RPC error as `data.diagnostics`.
// Theia's msgpack `Error` extension keeps `data` **only** when the thrown value
// is an instance of *its own* `ResponseError` class -- and `vscode-jsonrpc`,
// which talks to the engine, has a different class with the same name. So every
// engine refusal used to reach the browser as a bare `new Error(message)` with
// its reasons stripped, and `ProductStore.diagnosticsOf` always answered
// `undefined`.
//
// Two assertions, and the first is the point: it is a fact about a dependency,
// so an upgrade can change it without anything failing to compile. If it starts
// failing, `withEngineData` may no longer be needed -- or may need to change.
//
// Usage: node ide/scripts/rpc-error-smoke.mjs

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Importing the barrel is what installs the extension; requiring the encoder
// alone leaves msgpackr with no Error handling and both cases lose `data`.
require("@theia/core/lib/common/message-rpc");
const { ResponseError, defaultMsgPack } = require(
  "@theia/core/lib/common/message-rpc/rpc-message-encoder",
);
const { ResponseError: JsonRpcResponseError } = require("vscode-jsonrpc");
const { withEngineData } = require("../gearbox-studio/lib/node/gearbox-service-impl.js");

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures += 1;
}

/** What crossing the Theia proxy does to a value. */
const roundTrip = (error) => defaultMsgPack.decode(defaultMsgPack.encode({ error })).error;

const diagnostics = [{ code: "GBX0102", severity: "error", message: "could not be evaluated" }];
const data = { diagnostics };
const message = "`x/product.gdl` could not be evaluated";

// 1. The dependency fact this exists for.
const raw = roundTrip(new JsonRpcResponseError(-32000, message, data));
check(raw.message === message, "a vscode-jsonrpc error keeps its message across the codec");
check(
  raw.data === undefined,
  "a vscode-jsonrpc error loses `data` across the codec -- the reason withEngineData exists",
);

// 2. Theia's own class survives, which is what the wrapper converts to.
const theia = roundTrip(new ResponseError(-32000, message, data));
check(
  JSON.stringify(theia.data) === JSON.stringify(data),
  "a Theia ResponseError keeps `data` across the codec",
);

// 3. The wrapper closes the gap, end to end.
const wrapped = roundTrip(withEngineData(new JsonRpcResponseError(-32000, message, data)));
check(wrapped.message === message, "withEngineData keeps the message");
check(
  JSON.stringify(wrapped.data?.diagnostics) === JSON.stringify(diagnostics),
  "withEngineData makes the engine's diagnostics survive the proxy",
);

// 4. It must not disturb what it has nothing to add to.
const plain = new Error("the engine is not initialized");
check(withEngineData(plain) === plain, "an error with no `data` is handed back untouched");
const already = new ResponseError(-32000, message, data);
check(withEngineData(already) === already, "a Theia ResponseError is handed back untouched");
check(withEngineData("not an error") === "not an error", "a non-Error is handed back untouched");

console.log(failures === 0 ? "\nrpc-error-smoke: ok" : `\nrpc-error-smoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
