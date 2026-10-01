// Three questions to ask about an engine failure, and they have different answers.
//
// The sentences are the ones `EngineHandle.request` and `GearboxServiceImpl`
// produce, matched by text because that is all that crosses the wire: Theia's
// error codec carries a message and a `data` payload, and none of these three
// conditions is in `data`. Matching text is a seam, not a design -- it is
// recorded here, once, rather than repeated at four call sites that would each
// get a slightly different set of substrings right.
//
// The distinction that matters, and the reason this file is not one predicate:
//
// * **The engine was not there to ask.** `cannot call X: the engine is not
//   initialized` is thrown *before* anything is sent. Nothing happened, so a
//   write that failed this way did not write.
// * **The engine was asked and never answered.** A missed deadline, or a child
//   that exited mid-request. The request went out, so the outcome of a write is
//   **unknown** -- the engine may well have finished it. Treating this as "it
//   did not happen" is what makes a UI re-send a write that already landed; it
//   has been measured doing exactly that against a real engine.
// * **The session is gone either way.** Both of the above mean everything on
//   screen came from an engine that is no longer answering, which is the
//   question the panel asks before deciding whether to say so.

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The call never left: `this.engine` was undefined or already dead. */
export function isEngineGone(error: unknown): boolean {
  const message = messageOf(error);
  return (
    message.includes("the engine is not initialized") ||
    message.includes("the engine is not running")
  );
}

/**
 * The call went out and was never answered, so what it did is not known.
 *
 * Exactly the two sentences `EngineHandle.request` rejects with once a request
 * is in flight: the timeout's, and the one for a child that died while
 * answering. A write in this state is not re-sendable -- see the header.
 */
export function isOutcomeUnknown(error: unknown): boolean {
  const message = messageOf(error);
  return message.includes("did not answer") || message.includes("while answering");
}

/** Whatever is on screen came from a session that has ended. */
export function isSessionLost(error: unknown): boolean {
  return isEngineGone(error) || isOutcomeUnknown(error);
}
