// The graph panel: four views of the same product, one at a time.
//
// One widget rather than four, because plan section 9 asks for "four views" and
// because the four share a coordinate system, a set of arrowhead markers and a
// layout algorithm. Four widgets would have meant four registrations, four tabs
// and four more entries in a Gearbox menu that was just cleared of duplicates.
//
// The views split by where their data comes from, and that split is the reason the
// switch has to explain itself rather than just toggle:
//
//   * **co-location** reads the *catalogue*. It needs no product, because `deps`
//     is a declared fact and no resolution changes it.
//   * **contracts, processes, cluster** read a *resolution*. They are answers about
//     one profile, and without a resolved product there is nothing to draw -- so
//     each says so, and says how to get one, instead of rendering an empty frame.
//
// Renamed from `DepsGraphWidget`, and the widget id changed with it. A saved
// Theia layout referencing `gearbox.graph.deps` therefore loses this panel on the
// first run after the change; it reopens from the Gearbox menu and is saved under
// the new id. Keeping the old id would have meant a widget called "deps" hosting
// three views that have nothing to do with `deps`.

import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
// The shim is `export = React`, so a namespace import is rejected under
// esModuleInterop; a default import is the form that works.
import React from "@theia/core/shared/react";

import { Row } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";
import { ProductStore } from "../product-store";
import { GraphDefs } from "./graph-defs";
import { ClusterView } from "./views/cluster-view";
import { ContractsView } from "./views/contracts-view";
import { DepsView } from "./views/deps-view";
import { ProcessesView } from "./views/processes-view";

export type GraphView = "deps" | "contracts" | "processes" | "cluster";

interface ViewSpec {
  readonly id: GraphView;
  readonly label: string;
  /** Whether this view needs a resolved product to have anything to say. */
  readonly needsProduct: boolean;
}

const VIEWS: readonly ViewSpec[] = [
  { id: "deps", label: "co-location", needsProduct: false },
  { id: "contracts", label: "contracts", needsProduct: true },
  { id: "processes", label: "processes", needsProduct: true },
  { id: "cluster", label: "cluster", needsProduct: true },
];

@injectable()
export class GraphWidget extends ReactWidget {
  static readonly ID = "gearbox.graph";
  static readonly LABEL = "Gearbox Graph";

  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly product!: ProductStore;

  /** Which view is showing. Kept on the widget, so it survives a re-render. */
  protected view: GraphView = "deps";

  /** The gear whose co-location closure is painted, if any. */
  protected focus: string | undefined;

  /**
   * The product the state above belongs to.
   *
   * A painted closure is a set of gears from one product's resolution, so
   * carrying it into another product would paint an answer about something that
   * is no longer open. The panel is not closed when the product changes -- its
   * co-location view reads the catalogue and is valid with no product at all --
   * so the staleness is cleared here, where it lives.
   *
   * By path, and only on a change of *product*: switching profiles re-resolves
   * the same subject, and dropping the painted closure on every profile click
   * would take away the comparison the three resolution views exist for.
   */
  protected subject: string | undefined;

  @postConstruct()
  protected init(): void {
    this.id = GraphWidget.ID;
    this.title.label = GraphWidget.LABEL;
    this.title.iconClass = codicon("type-hierarchy-sub");
    this.title.closable = true;
    this.addClass("gearbox-graph");
    // Both stores: the co-location view follows the catalogue as it streams, and
    // the other three follow the product as profiles are switched. Subscribing to
    // only one was how the catalogue's in-product toggles failed to appear.
    this.toDispose.push(this.catalogue.onChanged(() => this.update()));
    this.toDispose.push(
      this.product.onChanged(() => {
        this.forgetOtherProduct();
        this.update();
      }),
    );
    this.subject = this.product.current.open?.path;
    this.update();
  }

  protected render(): React.ReactNode {
    return (
      <div className="gbx-root">
        <GraphDefs />
        <div className="gbx-view-switch" role="tablist" aria-label="Graph view">
          {VIEWS.map((spec) => (
            <button
              type="button"
              key={spec.id}
              className={`gbx-view-tab ${this.view === spec.id ? "gbx-view-tab-on" : ""}`}
              data-view={spec.id}
              role="tab"
              aria-selected={this.view === spec.id}
              onClick={() => this.showView(spec.id)}
            >
              {spec.label}
            </button>
          ))}
        </div>
        {this.renderView()}
      </div>
    );
  }

  protected renderView(): React.ReactNode {
    if (this.view === "deps") {
      return (
        <DepsView
          gears={this.catalogue.current.rows.filter(isProjected).map((row) => row.gear)}
          focus={this.focus}
          onToggleFocus={(id) => this.toggleFocus(id)}
        />
      );
    }

    const state = this.product.current;
    const resolved = state.resolution?.product;
    if (!resolved) {
      return this.renderNoProduct();
    }
    const profile = resolved.product.profile;

    switch (this.view) {
      case "contracts":
        return (
          <ContractsView
            bindings={resolved.bindings ?? []}
            candidates={resolved.cuttable_if_declared ?? []}
            profile={profile}
          />
        );
      case "processes":
        return <ProcessesView processes={resolved.processes ?? []} profile={profile} />;
      case "cluster":
        return (
          <ClusterView
            cluster={resolved.cluster ?? []}
            diagnostics={state.resolution?.diagnostics ?? []}
            profile={profile}
          />
        );
    }
  }

  /**
   * What the three resolution views show with no product open.
   *
   * Naming the view is the point. "No product" on its own reads as a failure,
   * when the actual situation is that this particular drawing is an answer about a
   * profile and no profile has been chosen yet.
   */
  protected renderNoProduct(): React.ReactNode {
    const label = VIEWS.find((spec) => spec.id === this.view)?.label ?? this.view;
    const error = this.product.current.error;
    return (
      <div className="gbx-empty">
        The {label} graph draws a <em>resolution</em>, so it needs a product and a
        profile. Open the Product view and it fills in; switching profiles there
        redraws it, which is the point -- these three views are where a profile
        stops being a word and becomes a topology.
        {error !== undefined && (
          <div className="gbx-diagnostic">The last resolution failed: {error}</div>
        )}
      </div>
    );
  }

  /** Named `showView`, not `show`: `Widget.show()` already exists and means
   * something else entirely -- make the panel visible. */
  protected showView(view: GraphView): void {
    this.view = view;
    this.update();
  }

  /** Drop what belonged to the previous product. See [`subject`]. */
  protected forgetOtherProduct(): void {
    const open = this.product.current.open?.path;
    if (open === this.subject) return;
    this.subject = open;
    this.focus = undefined;
  }

  protected toggleFocus(id: string): void {
    this.focus = this.focus === id ? undefined : id;
    this.update();
  }
}

/**
 * Narrow a row to its projected variant.
 *
 * A type predicate rather than `filter(...).map(r => r as {gear})`: the cast
 * asserted the very thing the filter was there to establish, so a change to
 * either side would have compiled.
 */
function isProjected(row: Row): row is Extract<Row, { kind: "projected" }> {
  return row.kind === "projected";
}
