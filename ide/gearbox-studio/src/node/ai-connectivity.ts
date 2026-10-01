// Asks the one question `Connection error.` refuses to answer.
//
// When the chat fails at the transport -- TLS, DNS, a dead proxy -- the Anthropic
// SDK raises `APIConnectionError`, and because there is no HTTP status and no
// headers, its message is the SDK's default: the bare string `Connection
// error.` Theia's `formatProviderError` looks for a leading status code to parse,
// finds none, and renders the string verbatim with no Details expander. So the
// most common class of failure arrives with strictly less information than the
// operating system already had.
//
// This probe recovers it. The cause chain that names the real fault --
// `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `ENOTFOUND`, `ECONNREFUSED` -- is read in
// the process that owns the socket, because it does not survive being thrown
// across Theia's RPC boundary.

import type { AiConnectivityResult } from "../common/protocol";

/** The SDK's own default, which it derives the same way from the same variable. */
const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * Long enough for a handshake behind a slow proxy, short enough that a hung
 * probe does not look like a hung chat. A certificate failure returns in
 * milliseconds; this bound is for the network being unreachable rather than
 * refusing.
 */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Flatten `error.cause` into one line per link, outermost first.
 *
 * `fetch` reports every transport fault as the same `TypeError: fetch failed`
 * and puts the truth one level down, so the chain is the payload here -- not
 * decoration on a message that already said something.
 */
function causeChain(error: unknown): string[] {
  const lines: string[] = [];
  let link: unknown = error;
  // Cycles are possible in hand-built error chains, and a probe that hangs
  // while diagnosing a hang would be its own joke.
  const seen = new Set<unknown>();
  while (link !== undefined && link !== null && !seen.has(link)) {
    seen.add(link);
    if (link instanceof Error) {
      const code = (link as Error & { code?: string }).code;
      lines.push(code ? `${code}: ${link.message}` : `${link.name}: ${link.message}`);
      link = (link as Error & { cause?: unknown }).cause;
    } else {
      lines.push(String(link));
      break;
    }
  }
  return lines;
}

/**
 * The innermost `code`, which is the specific one.
 *
 * Innermost rather than outermost because the outer link is always
 * `TypeError: fetch failed`, which is true of every failure and therefore
 * distinguishes none of them.
 */
function specificCode(error: unknown): string | undefined {
  let code: string | undefined;
  let link: unknown = error;
  const seen = new Set<unknown>();
  while (link instanceof Error && !seen.has(link)) {
    seen.add(link);
    const candidate = (link as Error & { code?: string }).code;
    if (typeof candidate === "string") code = candidate;
    link = (link as Error & { cause?: unknown }).cause;
  }
  return code;
}

/**
 * Probe the provider with no credentials.
 *
 * `GET /v1/models` unauthenticated, so **401 is a pass**: the question is
 * whether a request completes, and the check has to be usable before a key is
 * configured -- which is exactly when somebody is trying to find out why the
 * chat is silent. Spending a key to learn that the socket works would also make
 * this the one diagnostic you cannot afford to run twice.
 */
export async function checkAiConnectivity(): Promise<AiConnectivityResult> {
  const base = (process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/v1/models`;

  const env = {
    nodeOptions: process.env.NODE_OPTIONS,
    extraCaCerts: process.env.NODE_EXTRA_CA_CERTS,
    sslCertFile: process.env.SSL_CERT_FILE,
    sslCertDir: process.env.SSL_CERT_DIR,
    nodeVersion: process.version,
  };

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Nothing here reads the body, and an undrained one holds the socket open.
    await response.body?.cancel();
    return { ok: true, url, status: response.status, env };
  } catch (error) {
    return { ok: false, url, code: specificCode(error), detail: causeChain(error), env };
  }
}
