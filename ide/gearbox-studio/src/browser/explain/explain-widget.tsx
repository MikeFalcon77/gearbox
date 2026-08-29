// Why the resolution is the way it is, for whatever is selected in the Product
// view.
//
// The one thing this widget does *not* do is compose an explanation. Every step
// it shows is a `because` sentence the resolver wrote at the moment it created
// the edge, while it still knew the specifics -- which is what makes this an
// account of what happened rather than a plausible story about it
// (`cpt-gearbox-fr-explain`). The widget walks edges and prints sentences.
//
// §9 of the plan expected a `gearbox/product/explain` call. There is none, and
// there does not need to be: `ResolveResult` carries the whole
// `ExplanationGraph` with the resolution, so "why" costs no second round trip
// and cannot answer about a different resolution than the one on screen.

import { ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { ExplanationGraph } from "../../common/generated/ExplanationGraph";
import type { ExplanationNode } from "../../common/generated/ExplanationNode";
import type { Location } from "../../common/generated/Location";
import type { ProvenanceEdge } from "../../common/generated/ProvenanceEdge";
import type { ResolvedProduct } from "../../common/generated/ResolvedProduct";
import { Focus, ProductStore } from "../product-store";
import { RevealService } from "../reveal-service";

/** One rendered step: an edge, with both of its nodes resolved. */
interface Step {
  readonly edge: ProvenanceEdge;
  readonly from: ExplanationNode | undefined;
  readonly to: ExplanationNode | undefined;
  /** How many edges from the focus. Used only to indent. */
  readonly depth: number;
}

/**
 * The node id for a selection.
 *
 * `NodeId` is documented as `{kind}:{payload}` and content-derived, so the
 * format is part of the wire contract rather than an internal detail. It is
 * still a second place where the convention is written down, which is why
 * [`ExplainWidget.render`] says so out loud when the lookup fails instead of
 * rendering an empty list -- a silent "no explanation" is exactly how a drifted
 * id format would hide.
 */
function nodeIdOf(focus: Focus): string {
  switch (focus.kind) {
    case "gear":
      return `gear:${focus.id}`;
    case "process":
      return `process:${focus.id}`;
    case "binding":
      return `binding:${focus.consumer}|${focus.contract}`;
  }
}

function describeFocus(focus: Focus): string {
  switch (focus.kind) {
    case "gear":
      return `gear ${focus.id}`;
    case "process":
      return `process ${focus.id}`;
    case "binding":
      return `binding ${focus.consumer} → ${focus.contract}`;
  }
}

/**
 * Every reason reachable from `start`, nearest first.
 *
 * Breadth-first, and the direction matters: an edge runs *from* the thing being
 * explained *to* what explains it, so `gear:x -> profile:prod` reads "x is
 * selected-by prod". Following `from === current` therefore walks towards the
 * reasons; following the other way would walk towards the consequences, which
 * answers a different question.
 *
 * Nodes are visited once. The graph is a DAG by construction, but a repeated
 * node would still produce a repeated subtree, and "because api-gateway declares
 * it" printed four times is noise that hides the one line that matters.
 */
function reasonsFrom(graph: ExplanationGraph, start: string): Step[] {
  const steps: Step[] = [];
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; frontier.length > 0 && depth < 12; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of graph.edges) {
        if (edge.from !== current) continue;
        steps.push({
          edge,
          from: graph.nodes[edge.from],
          to: graph.nodes[edge.to],
          depth,
        });
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          next.push(edge.to);
        }
      }
    }
    frontier = next;
  }
  return steps;
}

/** Whether the resolution on screen contains the thing being explained. */
function isInResolution(product: ResolvedProduct, focus: Focus): boolean {
  switch (focus.kind) {
    case "gear":
      return Object.prototype.hasOwnProperty.call(product.gears, focus.id);
    case "process":
      return product.processes.some((process) => process.name === focus.id);
    case "binding":
      return (product.bindings ?? []).some(
        (binding) =>
          binding.consumer === focus.consumer && binding.contract === focus.contract,
      );
  }
}

@injectable()
export class ExplainWidget extends ReactWidget {
  static readonly ID = "gearbox.explain";
  static readonly LABEL = "Gearbox Explain";

  @inject(ProductStore) protected readonly store!: ProductStore;
  @inject(RevealService) protected readonly reveals!: RevealService;

  @postConstruct()
  protected init(): void {
    this.id = ExplainWidget.ID;
    this.title.label = ExplainWidget.LABEL;
    this.title.caption = ExplainWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-explain");
    this.toDispose.push(this.store.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const focus = this.store.focus;
    const graph = this.store.current.resolution?.explanation ?? undefined;

    if (graph === undefined) {
      return (
        <div className="gbx-explain gbx-empty">
          Resolve a product to ask why. The explanation arrives with the resolution.
        </div>
      );
    }
    if (focus === undefined) {
      return (
        <div className="gbx-explain gbx-empty">
          Select a process, a binding or a gear in the Product view.
        </div>
      );
    }

    const id = nodeIdOf(focus);
    const node = graph.nodes[id];
    if (node === undefined) {
      // Three different situations used to share one alarming message, and the
      // ordinary one is by far the most common: a selection survives a profile
      // switch, and `oidc-authn-plugin` simply is not in the dev resolution. That
      // is not a fault, and reading like one trains people to ignore the message
      // that does matter.
      const product = this.store.current.resolution?.product ?? undefined;
      const profile = product?.product.profile ?? this.store.current.profile ?? "this profile";
      if (product !== undefined && !isInResolution(product, focus)) {
        return (
          <div className="gbx-explain gbx-empty" data-not-in-profile={id}>
            {describeFocus(focus)} is not part of the <code>{profile}</code> resolution. Select
            something in this profile, or switch back.
          </div>
        );
      }
      // In the resolution and still absent from the graph: either the resolver
      // recorded no provenance for it, or the `{kind}:{payload}` convention --
      // which the client writes down a second time -- has drifted. Worth an
      // alarm, because both are defects.
      return (
        <div className="gbx-explain">
          <div className="gbx-error" role="alert">
            <code>{id}</code> is in the {profile} resolution but has no node in its
            explanation graph, which has {Object.keys(graph.nodes).length}. Either no
            provenance was recorded for it or the node-id convention has changed.
          </div>
        </div>
      );
    }

    const steps = reasonsFrom(graph, id);
    return (
      <div className="gbx-explain" data-explaining={id}>
        <div className="gbx-detail-title">
          why {describeFocus(focus)} <span className="gbx-id">{node.kind}</span>
        </div>
        {steps.length === 0 ? (
          <div className="gbx-empty">
            Nothing follows from this node: it is a root of the explanation.
          </div>
        ) : (
          <ol className="gbx-narrative">{steps.map((step, index) => this.renderStep(step, index))}</ol>
        )}
      </div>
    );
  }

  protected renderStep(step: Step, index: number): React.ReactNode {
    const { edge, to, depth } = step;
    const downgrade = edge.kind === "downgraded-by";
    return (
      <li
        className={`gbx-step ${downgrade ? "gbx-step-downgrade" : ""}`}
        key={`${edge.from}->${edge.to}-${edge.kind}-${index}`}
        style={{ marginLeft: `${depth * 14}px` }}
        data-step-kind={edge.kind}
        data-step-to={edge.to}
      >
        {/* The sentence first and the machinery second. The `because` string is
            the answer; the kind and the target are how to check it. */}
        <div className="gbx-step-because">{edge.because}</div>
        <div className="gbx-step-meta">
          <span className="gbx-badge">{edge.kind}</span>
          <span className="gbx-id">{to?.label ?? edge.to}</span>
          {this.renderOrigin(to?.origin ?? undefined)}
        </div>
      </li>
    );
  }

  /**
   * A link to the file the fact was declared in.
   *
   * An `<a>` with a real `href`, not a div with an onClick: the href is what
   * gives keyboard activation, a focus ring, a status-bar target and something
   * for a screen reader to announce. `preventDefault` keeps the navigation
   * inside Theia.
   */
  protected renderOrigin(origin: Location | undefined): React.ReactNode {
    if (origin === undefined || origin === null) return undefined;
    const line = origin.range.start.line + 1;
    const name = origin.uri.split("/").pop() ?? origin.uri;
    return (
      <a
        className="gbx-step-origin"
        href={origin.uri}
        onClick={(event) => {
          event.preventDefault();
          void this.reveals.revealLocation(origin);
        }}
      >
        {name}:{line}
      </a>
    );
  }
}
