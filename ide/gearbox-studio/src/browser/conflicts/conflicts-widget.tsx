// The resolution's complaints, as a screen of their own.
//
// eCos's Config Tool makes conflicts a domain screen rather than a status line,
// and it is right to: a conflict is the thing a person is *working on* when there
// is one -- read it, go to what caused it, change the description, resolve again.
// A list squeezed under a tree is a list nobody reads.
//
// **A second consumer of `ProductStore.diagnostics`, not a second source.**
// `ResolutionMarkers` already turns the same array into Problems markers, and
// keeping one array with two renderers is what makes the Problems view and this
// panel unable to disagree. What this adds is what a marker cannot carry: the
// `help` sentence, the `evidence` citation, the `related` locations, and the
// `subject` -- which is a graph node, so a click here can point the Inspector at
// the thing being complained about.
//
// `Resolve again` means exactly that. There is no automatic resolver and none is
// promised: the engine reports what it cannot decide, a person edits the
// description, and the next resolution is the answer.

import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { CommandRegistry } from "@theia/core/lib/common";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { Location } from "../../common/generated/Location";
import type { Severity } from "../../common/generated/Severity";
import { ProductStore } from "../product-store";
import { RevealService } from "../reveal-service";
import { Selection, SelectionService } from "../shell/selection-service";
import { RESOLVE_PRODUCT } from "../view-contributions";

/** Worst first. A list that buries the error under three hints is sorted wrong. */
const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

const ICON: Record<Severity, string> = {
  error: "error",
  warning: "warning",
  info: "info",
  hint: "lightbulb",
};

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
  if (kind === "gear" || kind === "process") {
    return { kind, id: payload };
  }
  if (kind === "binding") {
    const bar = payload.indexOf("|");
    if (bar < 0) return undefined;
    return { kind: "binding", consumer: payload.slice(0, bar), contract: payload.slice(bar + 1) };
  }
  return undefined;
}

@injectable()
export class ConflictsWidget extends ReactWidget {
  static readonly ID = "gearbox.conflicts";
  static readonly LABEL = "Gearbox Conflicts";

  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(RevealService) protected readonly reveals!: RevealService;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;

  @postConstruct()
  protected init(): void {
    this.id = ConflictsWidget.ID;
    this.title.label = ConflictsWidget.LABEL;
    this.title.iconClass = codicon("warning");
    this.title.caption = ConflictsWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-conflicts");
    this.toDispose.push(this.products.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const state = this.products.current;
    if (state.open === undefined) {
      return (
        <div className="gbx-conflicts gbx-empty">
          Open a product. Conflicts are what one resolution could not decide.
        </div>
      );
    }

    const diagnostics = [...state.diagnostics].sort(
      (a, b) => ORDER[a.severity] - ORDER[b.severity],
    );
    const errors = diagnostics.filter((d) => d.severity === "error").length;

    return (
      <div className="gbx-conflicts" data-conflicts-count={diagnostics.length}>
        <div className="gbx-conflicts-head">
          <span className="gbx-conflicts-summary">{this.summarise(diagnostics.length, errors)}</span>
          <span className="gbx-badge" data-conflicts-profile={state.profile ?? ""}>
            {state.profile ?? "—"}
          </span>
          <button
            type="button"
            className="gbx-choice"
            data-command={RESOLVE_PRODUCT.id}
            disabled={!this.commands.isEnabled(RESOLVE_PRODUCT.id)}
            // Not "Fix": there is no automatic resolver, and a button that implied
            // one would be the most expensive kind of wrong label. This re-runs the
            // resolution, which is what answers whether an edit worked.
            title="Resolve again, after editing the description"
            onClick={() => void this.commands.executeCommand(RESOLVE_PRODUCT.id)}
          >
            Resolve again
          </button>
        </div>

        {diagnostics.length === 0 ? (
          <div className="gbx-empty">
            Nothing to report: the <code>{state.profile}</code> resolution raised no diagnostics.
          </div>
        ) : (
          <ul className="gbx-conflicts-list">
            {diagnostics.map((diagnostic, index) => this.renderOne(diagnostic, index))}
          </ul>
        )}
      </div>
    );
  }

  /** "3 conflicts" is wrong when two of them are hints. */
  protected summarise(total: number, errors: number): string {
    if (total === 0) return "No conflicts";
    if (errors === 0) return `${total} ${total === 1 ? "diagnostic" : "diagnostics"}, none blocking`;
    const rest = total - errors;
    const head = `${errors} ${errors === 1 ? "conflict" : "conflicts"}`;
    return rest === 0 ? head : `${head}, and ${rest} more ${rest === 1 ? "diagnostic" : "diagnostics"}`;
  }

  protected renderOne(diagnostic: Diagnostic, index: number): React.ReactNode {
    const selection = selectionOf(diagnostic.subject);
    return (
      <li
        className={`gbx-conflict gbx-conflict-${diagnostic.severity}`}
        key={`${diagnostic.code}-${index}`}
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
        {diagnostic.help !== null && diagnostic.help !== undefined && (
          <div className="gbx-conflict-help">{diagnostic.help}</div>
        )}
        {diagnostic.severity === "error" &&
          (diagnostic.help === null || diagnostic.help === undefined) && (
            <div className="gbx-conflict-help gbx-error" role="alert">
              This error carries no help text, which `cpt-gearbox-nfr-actionable-diagnostics`
              requires. That is a defect in the engine, not in the description.
            </div>
          )}

        <div className="gbx-conflict-links">
          {this.renderLocation(diagnostic.location ?? undefined, "in")}
          {(diagnostic.related ?? []).map((related, at) => (
            <span className="gbx-conflict-related" key={`${related.message}-${at}`}>
              {related.message} {this.renderLocation(related.location, "at")}
            </span>
          ))}
          {selection !== undefined && (
            <button
              type="button"
              className="gbx-conflict-explain"
              data-conflict-explain={diagnostic.subject ?? ""}
              // The `subject` field exists for exactly this: "the graph node this
              // concerns, so a client can select it".
              onClick={() => this.selection.select(selection)}
            >
              explain {label(selection)}
            </button>
          )}
          {/* The `file:line` in `gears-rust` that substantiates a claim about a
              runtime limitation (`cpt-gearbox-nfr-evidence-cited`). Shown as text
              rather than as a link: it points into the corpus, which is a
              different tree from the descriptions, and a link that may not open is
              worse than a citation that reads. */}
          {diagnostic.evidence !== null && diagnostic.evidence !== undefined && (
            <span className="gbx-conflict-evidence" title="evidence in gears-rust">
              {diagnostic.evidence}
            </span>
          )}
        </div>
      </li>
    );
  }

  protected renderLocation(
    location: Location | undefined,
    preposition: string,
  ): React.ReactNode {
    if (location === undefined || location === null) return undefined;
    const line = location.range.start.line + 1;
    const name = location.uri.split("/").pop() ?? location.uri;
    return (
      <a
        className="gbx-conflict-where"
        href={location.uri}
        onClick={(event) => {
          event.preventDefault();
          void this.reveals.revealLocation(location);
        }}
      >
        {preposition} {name}:{line}
      </a>
    );
  }
}

function label(selection: Selection): string {
  switch (selection.kind) {
    case "gear":
    case "process":
      return selection.id;
    case "binding":
      return `${selection.consumer} → ${selection.contract}`;
    case "catalogue-row":
      return selection.key;
  }
}
