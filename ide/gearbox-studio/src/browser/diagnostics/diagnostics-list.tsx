// One diagnostic, rendered one way, wherever it is read.
//
// `Diagnostic[]` had five consumers and four renderers: the Conflicts screen's
// full row, the Product view's counts, the Add Gear panel's key-value lines, the
// catalogue's code-and-message, and `ResolutionMarkers` turning the same array
// into Problems markers. Four renderers of one array is four chances to
// disagree, and they did disagree about what a person is allowed to see: only
// the Conflicts screen showed `help`, `location`, `related` and `evidence`, so
// everywhere else a diagnostic was a sentence with no way to act on it.
//
// This is that row, extracted verbatim -- same DOM, same `data-conflict-*`
// attributes, so the claims that read the Conflicts screen keep reading exactly
// what they read before.
//
// **Density is visual only.** A `compact` list is the same information at a
// smaller weight, not a shorter version of it: the whole reason for one renderer
// is that the panel a diagnostic happens to appear in must not decide whether its
// remedy is visible. What `compact` changes is spacing, which is a CSS concern,
// which is where it lives.

import { codicon } from "@theia/core/lib/browser";
import React from "@theia/core/shared/react";

import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { Location } from "../../common/generated/Location";
import type { Severity } from "../../common/generated/Severity";
import type { Selection } from "../shell/selection-service";

/** Worst first. A list that buries the error under three hints is sorted wrong. */
const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

const ICON: Record<Severity, string> = {
  error: "error",
  warning: "warning",
  info: "info",
  hint: "lightbulb",
};

export type Density = "comfortable" | "compact";

/**
 * The selection a diagnostic's `subject` names, if it names one this can select.
 *
 * `NodeId` is `{kind}:{payload}` and the format is part of the wire contract, so
 * parsing it here is reading the contract rather than guessing. An unrecognised
 * kind returns `undefined` and the row simply is not clickable -- a profile node
 * is a perfectly good subject and there is nothing for the Inspector to say about
 * it, which is different from a parse that failed.
 */
export function selectionOf(subject: string | null | undefined): Selection | undefined {
  if (subject === null || subject === undefined) return undefined;
  const at = subject.indexOf(":");
  if (at < 0) return undefined;
  const kind = subject.slice(0, at);
  const payload = subject.slice(at + 1);
  if (kind === "gear" || kind === "application") {
    return { kind, id: payload };
  }
  if (kind === "binding") {
    const bar = payload.indexOf("|");
    if (bar < 0) return undefined;
    return { kind: "binding", consumer: payload.slice(0, bar), contract: payload.slice(bar + 1) };
  }
  return undefined;
}

/** Worst first, without mutating the caller's array. */
export function worstFirst(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

export function errorsIn(diagnostics: readonly Diagnostic[]): number {
  return diagnostics.filter((d) => d.severity === "error").length;
}

/** "3 conflicts" is wrong when two of them are hints. */
export function summarise(total: number, errors: number): string {
  if (total === 0) return "No conflicts";
  if (errors === 0) return `${total} ${total === 1 ? "diagnostic" : "diagnostics"}, none blocking`;
  const rest = total - errors;
  const head = `${errors} ${errors === 1 ? "conflict" : "conflicts"}`;
  return rest === 0
    ? head
    : `${head}, and ${rest} more ${rest === 1 ? "diagnostic" : "diagnostics"}`;
}

export interface DiagnosticsListProps {
  readonly diagnostics: readonly Diagnostic[];
  /** Spacing only -- see the note at the top of this file. */
  readonly density?: Density;
  /** Open the description at a location. Omitted where nothing can be opened. */
  readonly onReveal?: (location: Location) => void;
  /**
   * Point another panel at the node a diagnostic is about.
   *
   * Omitted where there is nothing to point: the `explain` control then does not
   * render, rather than rendering and doing nothing.
   */
  readonly onExplain?: (selection: Selection) => void;
  /** Sorted worst-first unless the caller has already ordered it. */
  readonly sorted?: boolean;
}

export function DiagnosticsList(props: DiagnosticsListProps): React.ReactElement {
  const rows = props.sorted === true ? [...props.diagnostics] : worstFirst(props.diagnostics);
  const density = props.density ?? "comfortable";
  return (
    <ul className={`gbx-conflicts-list gbx-conflicts-${density}`}>
      {rows.map((diagnostic, index) => (
        <DiagnosticRow
          key={`${diagnostic.code}-${index}`}
          diagnostic={diagnostic}
          onReveal={props.onReveal}
          onExplain={props.onExplain}
        />
      ))}
    </ul>
  );
}

export interface DiagnosticRowProps {
  readonly diagnostic: Diagnostic;
  readonly onReveal?: (location: Location) => void;
  readonly onExplain?: (selection: Selection) => void;
}

export function DiagnosticRow({
  diagnostic,
  onReveal,
  onExplain,
}: DiagnosticRowProps): React.ReactElement {
  const selection = selectionOf(diagnostic.subject);
  const help = diagnostic.help ?? undefined;
  return (
    <li
      className={`gbx-conflict gbx-conflict-${diagnostic.severity}`}
      data-conflict-code={diagnostic.code}
      data-conflict-severity={diagnostic.severity}
      data-conflict-subject={diagnostic.subject ?? ""}
    >
      <div className="gbx-conflict-head">
        <span className={`${codicon(ICON[diagnostic.severity])} gbx-conflict-icon`} />
        <span className="gbx-id">{diagnostic.code}</span>
        <span className="gbx-conflict-message">{diagnostic.message}</span>
      </div>

      {/* `help` is required for errors (`cpt-gearbox-nfr-actionable-diagnostics`),
          so its absence on one is worth seeing rather than smoothing over. */}
      {help !== undefined && <div className="gbx-conflict-help">{help}</div>}
      {diagnostic.severity === "error" && help === undefined && (
        <div className="gbx-conflict-help gbx-error" role="alert">
          This error carries no help text, which `cpt-gearbox-nfr-actionable-diagnostics` requires.
          That is a defect in the engine, not in the description.
        </div>
      )}

      <div className="gbx-conflict-links">
        <Where location={diagnostic.location ?? undefined} preposition="in" onReveal={onReveal} />
        {(diagnostic.related ?? []).map((related, at) => (
          <span className="gbx-conflict-related" key={`${related.message}-${at}`}>
            {related.message}{" "}
            <Where location={related.location} preposition="at" onReveal={onReveal} />
          </span>
        ))}
        {selection !== undefined && onExplain !== undefined && (
          <button
            type="button"
            className="gbx-conflict-explain"
            data-conflict-explain={diagnostic.subject ?? ""}
            // The `subject` field exists for exactly this: "the graph node this
            // concerns, so a client can select it".
            onClick={() => onExplain(selection)}
          >
            explain {label(selection)}
          </button>
        )}
        {/* The `file:line` in `gears-rust` that substantiates a claim about a
            runtime limitation (`cpt-gearbox-nfr-evidence-cited`). Shown as text
            rather than as a link: it points into the corpus, which is a different
            tree from the descriptions, and a link that may not open is worse than
            a citation that reads. */}
        {diagnostic.evidence !== null && diagnostic.evidence !== undefined && (
          <span className="gbx-conflict-evidence" title="evidence in gears-rust">
            {diagnostic.evidence}
          </span>
        )}
      </div>
    </li>
  );
}

function Where(props: {
  readonly location: Location | undefined;
  readonly preposition: string;
  readonly onReveal?: (location: Location) => void;
}): React.ReactElement | null {
  const { location, preposition, onReveal } = props;
  // eslint-disable-next-line no-null/no-null
  if (location === undefined || location === null || onReveal === undefined) return null;
  const line = location.range.start.line + 1;
  const name = location.uri.split("/").pop() ?? location.uri;
  return (
    <a
      className="gbx-conflict-where"
      href={location.uri}
      onClick={(event) => {
        event.preventDefault();
        onReveal(location);
      }}
    >
      {preposition} {name}:{line}
    </a>
  );
}

function label(selection: Selection): string {
  switch (selection.kind) {
    case "gear":
    case "application":
      return selection.id;
    case "binding":
      return `${selection.consumer} → ${selection.contract}`;
    case "catalogue-row":
      return selection.key;
  }
}
