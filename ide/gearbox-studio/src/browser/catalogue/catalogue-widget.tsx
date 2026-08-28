// The catalogue tree, rendered as it arrives.
//
// A `ReactWidget` rather than Theia's `TreeWidget`: the staged behaviour is the
// substance here -- a row changing kind under the reader without the tree
// reshuffling -- and expressing that is clearer with a render function than with
// a tree model whose node identity would have to be taught the same rule.
//
// The widget starts no load. It is closable and transient, so `postConstruct`
// running a load meant closing and reopening the panel mid-projection started a
// second one over the first. The load belongs to the application
// (`CatalogueViewContribution`) and to the reload command; this only subscribes.

import { ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
// The shim is `export = React`, so a namespace import is rejected under
// esModuleInterop; a default import is the form that works.
import React from "@theia/core/shared/react";

import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { FailedRoot } from "../../common/generated/FailedRoot";
import { Row, rowKey } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";
import { RevealService } from "../reveal-service";

@injectable()
export class CatalogueWidget extends ReactWidget {
  static readonly ID = "gearbox.catalogue";
  static readonly LABEL = "Gearbox Catalogue";

  @inject(CatalogueStore) protected readonly store!: CatalogueStore;
  @inject(RevealService) protected readonly reveals!: RevealService;

  @postConstruct()
  protected init(): void {
    this.id = CatalogueWidget.ID;
    this.title.label = CatalogueWidget.LABEL;
    this.title.caption = CatalogueWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-catalogue");
    this.node.tabIndex = -1;
    this.toDispose.push(this.store.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const state = this.store.current;
    const groups = groupByCategory(state.rows);
    const loading = state.status === "loading";
    // A row still pending once the load is over did not project. Saying so is
    // the difference between "still working" and "this gear failed, and the
    // diagnostics below say why".
    const unprojected = state.status === "ready" ? state.rows.filter(isPending).length : 0;

    return (
      <div className="gbx-root">
        <div className="gbx-header">
          <strong>{state.rows.length}</strong> gear(s)
          {loading && (
            <span className="gbx-progress">
              {" "}
              projecting {state.completed}/{state.total}
            </span>
          )}
          {unprojected > 0 && (
            <span className="gbx-error">
              {" "}
              — {unprojected} did not project
            </span>
          )}
        </div>

        {state.status === "error" && (
          <div className="gbx-error" role="alert">
            The catalogue could not be loaded: {state.error}
          </div>
        )}

        {state.failedRoots.map((root) => this.renderFailedRoot(root))}

        {state.rows.length === 0 && state.status === "ready" && (
          <div className="gbx-empty">No gear.gdl found under the source root.</div>
        )}

        {groups.map(([category, rows]) => (
          <div className="gbx-group" key={category}>
            <div className="gbx-group-label">{category}</div>
            <div role="listbox" aria-label={category}>
              {rows.map((row) => this.renderRow(row, state.status))}
            </div>
          </div>
        ))}

        {state.diagnostics.length > 0 && this.renderDiagnostics(state.diagnostics)}
      </div>
    );
  }

  protected renderRow(row: Row, status: string): React.ReactNode {
    const key = rowKey(row);
    const selected = this.store.selected === key;
    const label =
      row.kind === "pending"
        ? (row.gear.display_name ?? row.gear.gdl_path)
        : row.gear.display_name;
    // Pending after the load finished is a failure, not a stage.
    const stalled = row.kind === "pending" && status === "ready";

    return (
      <div
        key={key}
        className={`gbx-row ${row.kind === "pending" ? "gbx-pending" : ""} ${
          selected ? "gbx-selected" : ""
        } ${stalled ? "gbx-stalled" : ""}`}
        // Operable from the keyboard, because a panel in an IDE that only
        // answers the mouse is unusable for anyone who does not use one.
        // Enter/Space select; Enter on an already-selected row reveals, which is
        // the keyboard counterpart of the double-click.
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={() => {
          this.store.select(key);
        }}
        onKeyDown={(event) => this.onRowKey(event, row, key, selected)}
        // A pending row is never inert: `gdl_path` is known from discovery, so
        // revealing the description works before anything is parsed.
        onDoubleClick={() => void this.reveals.reveal(row.gear.source, row.gear.gdl_path)}
        title={row.gear.gdl_path}
      >
        <span className="gbx-row-name">{label}</span>
        {row.kind === "projected" ? (
          <>
            <span className="gbx-id">{row.gear.id}</span>
            {(row.gear.runtime_caps ?? []).map((cap) => (
              <span className="gbx-badge" key={cap}>
                {cap}
              </span>
            ))}
          </>
        ) : (
          // No id and no badges, because neither exists yet. Saying so beats an
          // empty space that reads as "this gear has none".
          <span className="gbx-waiting">{stalled ? "did not project" : "parsing…"}</span>
        )}
      </div>
    );
  }

  protected onRowKey(
    event: React.KeyboardEvent<HTMLDivElement>,
    row: Row,
    key: string,
    selected: boolean,
  ): void {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    if (event.key === "Enter" && selected) {
      void this.reveals.reveal(row.gear.source, row.gear.gdl_path);
      return;
    }
    this.store.select(key);
  }

  protected renderFailedRoot(root: FailedRoot): React.ReactNode {
    return (
      <div className="gbx-error" role="alert" key={root.path}>
        Source root <code>{root.path}</code> could not be opened: {root.error}
      </div>
    );
  }

  /**
   * What the engine had to say about the tree.
   *
   * These used to be stored and never rendered, which is how a gear that fails
   * to project became a row that says `parsing…` under a finished progress bar
   * with no explanation anywhere.
   */
  protected renderDiagnostics(diagnostics: readonly Diagnostic[]): React.ReactNode {
    return (
      <div className="gbx-diagnostics">
        {/* Its own class, not `gbx-group-label`: that one means "a category of
            gears", and ui-smoke reads it as exactly that. */}
        <div className="gbx-diagnostics-label">diagnostics ({diagnostics.length})</div>
        {diagnostics.map((diagnostic, index) => (
          <div
            className={`gbx-diagnostic gbx-diagnostic-${diagnostic.severity}`}
            key={`${diagnostic.code}:${index}`}
          >
            <span className="gbx-id">{diagnostic.code}</span>
            <span className="gbx-diagnostic-message">{diagnostic.message}</span>
            {diagnostic.help !== null && diagnostic.help !== undefined && (
              <span className="gbx-diagnostic-help">{diagnostic.help}</span>
            )}
          </div>
        ))}
      </div>
    );
  }
}

function isPending(row: Row): boolean {
  return row.kind === "pending";
}

function groupByCategory(rows: readonly Row[]): [string, Row[]][] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const category = row.gear.category ?? "uncategorised";
    const list = groups.get(category) ?? [];
    list.push(row);
    groups.set(category, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
