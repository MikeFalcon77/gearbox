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
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";
import { RevealService } from "../reveal-service";

@injectable()
export class CatalogueWidget extends ReactWidget {
  static readonly ID = "gearbox.catalogue";
  static readonly LABEL = "Gearbox Catalogue";

  @inject(CatalogueStore) protected readonly store!: CatalogueStore;
  @inject(RevealService) protected readonly reveals!: RevealService;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(ProductStore) protected readonly product!: ProductStore;

  /**
   * The filter text, and which categories are folded away.
   *
   * Widget state rather than store state: neither survives a reload and neither
   * is anyone else's business. `gears-rust` has 62 crates carrying
   * `#[toolkit::gear]` against the 14 described today, so this list is going to
   * quadruple -- which is what makes folding and filtering worth having before
   * it does.
   */
  protected filter = "";
  protected collapsed = new Set<string>();

  /**
   * The visible rows in the order the eye reads them, rebuilt on every render.
   *
   * Needed because the tree is not one list: it is a listbox per category, and
   * arrow-key navigation has to cross a group boundary the way the reader's eye
   * does. A flat array of keys is the smallest thing that can answer "what is
   * below this row" when the answer is in the next group -- or nowhere, because
   * the group after it is folded.
   */
  protected navigable: string[] = [];

  @postConstruct()
  protected init(): void {
    this.id = CatalogueWidget.ID;
    this.title.label = CatalogueWidget.LABEL;
    this.title.caption = CatalogueWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-catalogue");
    this.node.tabIndex = -1;
    this.toDispose.push(this.store.onChanged(() => this.update()));
    // And the product's, because each row now shows whether *this product* names
    // the gear. Without this the toggles would appear only after some unrelated
    // catalogue change, which is how they failed to appear at all the first time.
    this.toDispose.push(this.product.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const state = this.store.current;
    const matching = state.rows.filter((row) => matches(row, this.filter));
    const groups = groupByCategory(matching);
    this.navigable = groups
      .filter(([category]) => !this.isFolded(category))
      .flatMap(([, rows]) => rows.map(rowKey));
    const loading = state.status === "loading";
    // A row still pending once the load is over did not project. Saying so is
    // the difference between "still working" and "this gear failed, and the
    // diagnostics below say why".
    const unprojected = state.status === "ready" ? state.rows.filter(isPending).length : 0;

    return (
      <div className="gbx-root">
        <div className="gbx-header">
          <strong>{matching.length}</strong>
          {matching.length === state.rows.length ? " gear(s)" : ` of ${state.rows.length} gear(s)`}
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

        {/* A plain substring filter over name, id and category. Not Theia's
            `fuzzySearch`: on 62 entries fuzziness mostly buys surprising matches,
            and a predictable filter is easier to trust when what you are looking
            for is an id you already know. */}
        <input
          className="gbx-filter"
          type="search"
          placeholder="Filter gears"
          aria-label="Filter gears"
          value={this.filter}
          onChange={(event) => {
            this.filter = event.target.value;
            this.update();
          }}
        />

        {state.status === "error" && (
          <div className="gbx-error" role="alert">
            The catalogue could not be loaded: {state.error}
          </div>
        )}

        {state.failedRoots.map((root) => this.renderFailedRoot(root))}

        {state.rows.length === 0 && state.status === "ready" && (
          <div className="gbx-empty">No gear.gdl found under the source root.</div>
        )}

        {matching.length === 0 && state.rows.length > 0 && (
          <div className="gbx-empty">Nothing matches “{this.filter}”.</div>
        )}

        {groups.map(([category, rows]) => this.renderGroup(category, rows, state.status))}

        {state.diagnostics.length > 0 && this.renderDiagnostics(state.diagnostics)}
      </div>
    );
  }

  /**
   * The "in this product" toggle.
   *
   * Only on a projected row: adding a gear needs its id, and a pending row has
   * none -- `GearId` is projected at S2 (ADR
   * `cpt-gearbox-adr-staged-catalogue-loading`). And only when a product is open,
   * because otherwise the control would promise something it cannot do, which is
   * the mistake the Product view's fake links already made once.
   *
   * `stopPropagation`, because the row's own click selects it and this button
   * sits inside the row: without it, adding a gear would also move the selection.
   */
  protected renderInProduct(row: Row): React.ReactNode {
    if (row.kind !== "projected" || !this.edits.editable) {
      return undefined;
    }
    const id = row.gear.id;
    const inside = this.edits.inProduct(id);
    return (
      <button
        className={`gbx-in-product ${inside ? "gbx-in-product-on" : ""}`}
        data-in-product={inside ? "true" : "false"}
        // `data-toggle-gear` rather than `data-gear`: the graph widget's nodes
        // carry `data-gear`, and the co-location tests reach them with an
        // unscoped `querySelector`. Reusing the name here made a click meant for
        // a graph node land on a catalogue button instead -- and that button
        // opens a write confirmation, so the collision was worse than a wrong
        // selection. One attribute, one meaning per document.
        data-toggle-gear={id}
        title={inside ? `Remove ${id} from the product` : `Add ${id} to the product`}
        aria-pressed={inside}
        onClick={(event) => {
          event.stopPropagation();
          void this.edits.toggle(id, row.gear.source);
        }}
      >
        <span className={`codicon codicon-${inside ? "check" : "add"}`} />
      </button>
    );
  }

  protected renderGroup(category: string, rows: Row[], status: string): React.ReactNode {
    const folded = this.isFolded(category);
    return (
      <div className="gbx-group" key={category} data-category={category}>
        <div
          className="gbx-group-label"
          role="button"
          tabIndex={0}
          aria-expanded={!folded}
          data-collapsed={folded ? "true" : "false"}
          onClick={() => this.toggle(category)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              this.toggle(category);
            }
          }}
        >
          <span
            className={`gbx-twistie codicon codicon-chevron-${folded ? "right" : "down"}`}
          />
          {category}
          <span className="gbx-group-count">{rows.length}</span>
        </div>
        {!folded && (
          <div role="listbox" aria-label={category}>
            {rows.map((row) => this.renderRow(row, status))}
          </div>
        )}
      </div>
    );
  }

  /**
   * Whether a category is folded away.
   *
   * Folding is ignored while a filter is active. A match hidden inside a
   * collapsed category is the one thing a filter must never do: the reader
   * concludes the gear is not there.
   */
  protected isFolded(category: string): boolean {
    return this.filter.length === 0 && this.collapsed.has(category);
  }

  protected toggle(category: string): void {
    if (!this.collapsed.delete(category)) {
      this.collapsed.add(category);
    }
    this.update();
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
        data-row-key={key}
        // One tab stop for the whole tree, not one per row. `tabIndex={0}`
        // everywhere put 62 stops between the filter box and the rest of the
        // shell today and will put hundreds there as the catalogue grows, which
        // is the ARIA listbox pattern's whole reason for existing: Tab reaches
        // the list, the arrow keys move inside it.
        tabIndex={this.isTabbable(key) ? 0 : -1}
        onClick={() => {
          this.store.select(key);
        }}
        onKeyDown={(event) => this.onRowKey(event, row, key, selected)}
        // A pending row is never inert: `gdl_path` is known from discovery, so
        // revealing the description works before anything is parsed.
        onDoubleClick={() => void this.reveals.reveal(row.gear.source, row.gear.gdl_path)}
        title={row.gear.gdl_path}
      >
        {this.renderInProduct(row)}
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

  /**
   * Which row carries the tree's single tab stop.
   *
   * The selected row, so returning to the list by Tab lands where the reader
   * left off; the first row otherwise, because a list no key can reach is a list
   * that is not keyboard-operable at all. Falling back matters when the
   * selection is filtered out or sits in a folded group -- the selection
   * survives both, and the tab stop cannot.
   */
  protected isTabbable(key: string): boolean {
    const selected = this.store.selected;
    if (selected !== undefined && this.navigable.includes(selected)) {
      return key === selected;
    }
    return key === this.navigable[0];
  }

  protected onRowKey(
    event: React.KeyboardEvent<HTMLDivElement>,
    row: Row,
    key: string,
    selected: boolean,
  ): void {
    const moved = this.neighbour(event.key, key);
    if (moved !== undefined) {
      event.preventDefault();
      this.store.select(moved);
      // Focused now rather than after the re-render. React keeps the same DOM
      // node for the same row key, so the element is already there and moving
      // focus into it survives the patch -- whereas focusing afterwards needs a
      // hook into an update that `select()` only schedules.
      this.focusRow(moved);
      return;
    }
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

  /**
   * The row a navigation key moves to, or `undefined` if the key is not one.
   *
   * Clamped rather than wrapped at both ends: a list that jumps from the last
   * gear back to the first reads as a bug the first time it happens, and there
   * is no long list here to make wrapping worth the surprise.
   */
  protected neighbour(pressed: string, from: string): string | undefined {
    const rows = this.navigable;
    if (rows.length === 0) {
      return undefined;
    }
    const at = rows.indexOf(from);
    const last = rows.length - 1;
    switch (pressed) {
      case "ArrowDown":
        return rows[Math.min(at + 1, last)];
      case "ArrowUp":
        return at <= 0 ? rows[0] : rows[at - 1];
      case "Home":
        return rows[0];
      case "End":
        return rows[last];
      default:
        return undefined;
    }
  }

  protected focusRow(key: string): void {
    // Matched on the dataset rather than interpolated into a selector. A row key
    // is `<source>:<gdl_path>`, so it carries `:` and `/` and whatever else the
    // filesystem allows, and getting CSS string escaping right for arbitrary
    // path text is a worse problem than a loop over a few dozen elements.
    const rows = Array.from(this.node.querySelectorAll<HTMLElement>("[data-row-key]"));
    rows.find((node) => node.dataset["rowKey"] === key)?.focus();
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
            gears", and the conformance suite reads it as exactly that. */}
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

/**
 * Whether a row survives the filter.
 *
 * Matches the display name, the id and the category, because those are the three
 * things a person has in hand when they go looking. A pending row has no id yet,
 * which is why this reads what the row actually carries rather than assuming a
 * projected one.
 */
function matches(row: Row, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [
    row.kind === "pending" ? (row.gear.display_name ?? "") : row.gear.display_name,
    row.kind === "projected" ? row.gear.id : "",
    row.gear.category ?? "",
    row.gear.gdl_path,
  ];
  return haystack.some((field) => field.toLowerCase().includes(needle));
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
