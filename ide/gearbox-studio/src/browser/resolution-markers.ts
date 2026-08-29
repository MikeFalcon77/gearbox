// Resolution diagnostics as Problems markers.
//
// `cpt-gearbox-fr-editor-diagnostics`: "resolution diagnostics MUST be surfaced
// as editor problem markers replaced atomically on each resolution", because
// "a diagnostic nobody sees is a diagnostic nobody acts on; stale markers are
// worse than none".
//
// **Atomically** is the part that takes work. `ProblemManager.setMarkers` already
// replaces every marker for one `(uri, owner)` pair, so a single file is easy.
// The hazard is the second file: a resolution that complains about two
// descriptions, followed by one that complains about one, leaves the first
// resolution's markers on the file it no longer mentions. So this tracks the URIs
// it wrote and clears the ones that drop out -- and clears them by owner, never
// with `cleanAllMarkers`, which would take other contributors' markers too.
//
// Only *resolution* diagnostics. The requirement's other half -- description-file
// diagnostics with source ranges over a language-server interface -- is a
// different mechanism and is not built; nothing here should look like it is.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { URI } from "@theia/core/lib/common/uri";
import {
  Diagnostic as LspDiagnostic,
  DiagnosticSeverity,
} from "@theia/core/shared/vscode-languageserver-protocol";
import { inject, injectable } from "@theia/core/shared/inversify";
import { ProblemManager } from "@theia/markers/lib/browser/problem/problem-manager";

import type { Diagnostic } from "../common/generated/Diagnostic";
import type { Severity } from "../common/generated/Severity";
import { ProductStore } from "./product-store";

/**
 * The marker owner.
 *
 * One string, used for both writing and clearing, so a rename cannot leave
 * markers behind that nothing knows how to remove.
 */
const OWNER = "gearbox";

/** The top of a file, for a diagnostic that names no position. */
const TOP: LspDiagnostic["range"] = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

function severityOf(severity: Severity): DiagnosticSeverity {
  switch (severity) {
    case "error":
      return DiagnosticSeverity.Error;
    case "warning":
      return DiagnosticSeverity.Warning;
    case "info":
      return DiagnosticSeverity.Information;
    case "hint":
      return DiagnosticSeverity.Hint;
  }
}

/**
 * One engine diagnostic as an editor marker.
 *
 * `help` is folded into the message rather than dropped. The Problems view shows
 * one line per marker, and for an error `help` is required precisely because the
 * message alone does not say what to do -- so omitting it here would discard the
 * actionable half (`cpt-gearbox-nfr-actionable-diagnostics`).
 */
function toMarker(diagnostic: Diagnostic): LspDiagnostic {
  const message =
    diagnostic.help === null || diagnostic.help === undefined
      ? diagnostic.message
      : `${diagnostic.message} — ${diagnostic.help}`;
  return {
    range: diagnostic.location?.range ?? TOP,
    severity: severityOf(diagnostic.severity),
    code: diagnostic.code,
    source: OWNER,
    message,
    relatedInformation: (diagnostic.related ?? []).map((related) => ({
      location: { uri: related.location.uri, range: related.location.range },
      message: related.message,
    })),
  };
}

@injectable()
export class ResolutionMarkers implements FrontendApplicationContribution {
  @inject(ProductStore) protected readonly store!: ProductStore;
  @inject(ProblemManager) protected readonly problems!: ProblemManager;

  /** Every URI this contributor wrote markers to on the previous resolution. */
  protected written = new Set<string>();

  onStart(): void {
    this.store.onChanged(() => this.publish());
  }

  protected publish(): void {
    const state = this.store.current;
    // Nothing is published while a resolution is in flight. Clearing first would
    // make the Problems view flicker empty on every profile switch, and leaving
    // the old markers up for the moment it takes is the lesser of the two: they
    // are about the same product, and they are replaced when the answer lands.
    if (state.status === "loading" || state.status === "resolving") return;

    // Where a diagnostic that names no position belongs. The wire type says
    // resolution diagnostics "often have no location and are anchored by the
    // client", and the product description is the only file the whole resolution
    // is about.
    const anchor = state.open === undefined ? undefined : URI.fromFilePath(state.open.path);

    const byUri = new Map<string, LspDiagnostic[]>();
    for (const diagnostic of state.diagnostics) {
      const uri = diagnostic.location?.uri ?? anchor?.toString();
      if (uri === undefined) continue;
      const list = byUri.get(uri) ?? [];
      list.push(toMarker(diagnostic));
      byUri.set(uri, list);
    }

    for (const [uri, markers] of byUri) {
      this.problems.setMarkers(new URI(uri), OWNER, markers);
    }
    // The files this resolution does not mention and the last one did. Cleared by
    // owner, so another contributor's markers on the same file survive.
    for (const uri of this.written) {
      if (!byUri.has(uri)) {
        this.problems.setMarkers(new URI(uri), OWNER, []);
      }
    }
    this.written = new Set(byUri.keys());
  }
}
