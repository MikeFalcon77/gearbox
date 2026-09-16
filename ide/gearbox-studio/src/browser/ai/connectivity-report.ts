// Turns a connectivity probe into something an integrator can act on.
//
// Pure and separate from the agent because two callers need it: the chat, when a
// request dies in the transport, and `Gearbox: Check AI Connection`, for somebody
// who would rather ask than first provoke a failure. Keeping it out of the agent
// also keeps it testable without a chat session.

import type { AiConnectivityResult } from "../../common/protocol";

/**
 * Codes that mean "the certificate chain did not verify", which on a developer
 * machine is nearly always the trust store and not the server.
 */
const CERTIFICATE_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
]);

const TRANSPORT_HINTS =
  /connection error|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPROTO|certificate|self.signed|UNABLE_TO_|DEPTH_ZERO|socket hang up|network/i;

/**
 * Is this the transport failing rather than the API answering?
 *
 * An error from the API always arrives with a leading status code, and those
 * explain themselves -- a 401 names the key, a 400 names the field. The ones
 * worth intercepting are precisely those with no status at all.
 */
export function looksLikeTransportFailure(error: Error): boolean {
  if (/^\s*\d{3}\b/.test(error.message)) return false;
  return TRANSPORT_HINTS.test(error.message);
}

/** The remedy for the failure actually observed, named from the environment that produced it. */
function remedyFor(check: AiConnectivityResult): string | undefined {
  const code = check.code ?? "";
  const { nodeOptions, sslCertFile, extraCaCerts, nodeVersion } = check.env;

  if (CERTIFICATE_CODES.has(code)) {
    if (nodeOptions !== undefined && /(^|\s)--use-openssl-ca(\s|$)/.test(nodeOptions)) {
      return (
        "`NODE_OPTIONS` contains `--use-openssl-ca`, which makes Node drop its bundled root " +
        "certificates and read OpenSSL's store instead. When that store is not configured, it " +
        "is *empty*, and nothing verifies. Remove the flag, or point `SSL_CERT_FILE` at a full " +
        "bundle (`/etc/ssl/cert.pem` on macOS). To trust one extra corporate root, use " +
        "`NODE_EXTRA_CA_CERTS`, which appends rather than replaces."
      );
    }
    if (sslCertFile !== undefined) {
      return (
        `\`SSL_CERT_FILE=${sslCertFile}\` replaces the whole trust store on Node >= 22 (this ` +
        `backend runs ${nodeVersion}). If that file holds a single corporate root, public hosts ` +
        "cannot verify. Use `NODE_EXTRA_CA_CERTS` for the extra root and leave `SSL_CERT_FILE` " +
        "for a complete bundle."
      );
    }
    return (
      "Behind a TLS-intercepting proxy the chain has to be trusted explicitly: start the " +
      "backend with `NODE_EXTRA_CA_CERTS` pointing at the corporate root." +
      (extraCaCerts === undefined ? "" : ` It is currently \`${extraCaCerts}\`, which did not cover this chain.`)
    );
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "The host does not resolve, so this is DNS or an offline machine rather than the key.";
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET") {
    return (
      "The connection was refused or dropped. If this network needs a proxy, set `https_proxy` " +
      "for the backend -- it is read once when the model is registered, so the page needs a reload."
    );
  }
  if (code === "UND_ERR_CONNECT_TIMEOUT" || /timeout|abort/i.test(code)) {
    return "Nothing answered before the timeout: the endpoint is unreachable from here, not unauthorised.";
  }
  return undefined;
}

/** Turn the probe into something an integrator can act on. */
export function explainConnectivity(check: AiConnectivityResult): string {
  if (check.ok) {
    return (
      `That request failed, but \`${check.url}\` answers from Studio's backend right now ` +
      `(HTTP ${check.status}), so the endpoint is reachable. The cause is more specific than the ` +
      `network: retry, and if it repeats, the backend log holds the provider's own words.`
    );
  }

  const parts = [`**Studio's backend cannot reach \`${check.url}\`.**`];
  if (check.code !== undefined) {
    parts.push(
      `The failure is \`${check.code}\` -- the request never got an answer, which is why the ` +
        `chat could only say "Connection error.": with no status, there is nothing to explain itself.`,
    );
  }
  const remedy = remedyFor(check);
  if (remedy !== undefined) parts.push(remedy);
  if (check.detail !== undefined && check.detail.length > 0) {
    parts.push(["```", ...check.detail, "```"].join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * One line plus the remedy, for a notification.
 *
 * A toast has no room for the fenced cause chain the chat shows, and truncating
 * that report would drop the half that says what to do. So this keeps the
 * verdict, the code and the fix, and leaves the evidence to the chat.
 */
export function summariseConnectivity(check: AiConnectivityResult): string {
  if (check.ok) {
    return `AI endpoint reachable: ${check.url} answered HTTP ${check.status}.`;
  }
  const remedy = remedyFor(check);
  return (
    `AI endpoint unreachable: ${check.url} failed with ${check.code ?? "no response"}.` +
    (remedy === undefined ? "" : ` ${remedy.replace(/`/g, "")}`)
  );
}
