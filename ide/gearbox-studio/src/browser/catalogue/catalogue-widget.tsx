// The catalogue tree, rendered as it arrives.
//
// A `ReactWidget` rather than Theia's `TreeWidget`: the staged behaviour is the
// substance here -- a row changing kind under the reader without the tree
// reshuffling -- and expressing that is clearer with a render function than with
// a tree model whose node identity would have to be taught the same rule.

import { ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
// The shim is `export = React`, so a namespace import is rejected under
// esModuleInterop; a default import is the form that works.
import React from "@theia/core/shared/react";

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
    this.toDispose.push(this.store.onChanged(() => this.update()));
    this.update();
    void this.store.load();
  }

  protected render(): React.ReactNode {
    const state = this.store.current;
    const groups = groupByCategory(state.rows);

    return (
      <div className="gbx-root">
        <div className="gbx-header">
          <strong>{state.rows.length}</strong> gear(s)
          {state.loading && (
            <span className="gbx-progress">
              {" "}
              projecting {state.completed}/{state.total}
            </span>
          )}
        </div>

        {state.rows.length === 0 && !state.loading && (
          <div className="gbx-empty">No gear.gdl found under the source root.</div>
        )}

        {groups.map(([category, rows]) => (
          <div className="gbx-group" key={category}>
            <div className="gbx-group-label">{category}</div>
            {rows.map((row) => this.renderRow(row))}
          </div>
        ))}

      </div>
    );
  }

  protected renderRow(row: Row): React.ReactNode {
    const key = rowKey(row);
    const label =
      row.kind === "pending"
        ? (row.gear.display_name ?? row.gear.gdl_path)
        : row.gear.display_name;

    return (
      <div
        key={key}
        className={`gbx-row ${row.kind === "pending" ? "gbx-pending" : ""} ${
          this.store.selected === key ? "gbx-selected" : ""
        }`}
        // A pending row is never inert: `gdl_path` is known from discovery, so
        // revealing the description works before anything is parsed.
        onClick={() => {
          this.store.select(key);
        }}
        onDoubleClick={() => void this.reveals.reveal(row.gear.source, key)}
        title={key}
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
          <span className="gbx-waiting">parsing…</span>
        )}
      </div>
    );
  }

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
