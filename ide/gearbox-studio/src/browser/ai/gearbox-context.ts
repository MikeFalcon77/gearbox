// What the chat knows without being told.
//
// Five context variables, each reading the services that feed Catalogue,
// Inspector and Conflicts. **Not the DOM.** A panel renders a projection of a
// store; reading the rendering back would make the chat's answer depend on which
// widgets happen to be open, and would go stale the moment a re-resolve
// re-rendered under it.
//
// Theia's context variables carry two values, and the split is the whole design:
// `value` is what a person sees on the chip, `contextValue` is what the model
// receives. So the chip says "Static Tenant Resolver Plugin" while the model
// gets `{"kind":"gear","id":"static-tr-plugin"}` -- a label is ambiguous and an
// id is not, and neither one is good at the other's job.
//
// **Resolution is lazy, and that is what keeps it true.** These resolve when a
// request is sent, not when a chip is attached, so a description saved on disk
// (`DescriptionWatchService`) or a profile switched between attaching the chip
// and pressing Enter is reflected rather than remembered.

import { inject, injectable } from "@theia/core/shared/inversify";
import type {
  AIVariable,
  AIVariableContext,
  AIVariableResolutionRequest,
  AIVariableResolver,
  ResolvedAIContextVariable,
} from "@theia/ai-core";
import type {
  AIVariableDropResult,
  FrontendVariableService,
} from "@theia/ai-core/lib/browser/frontend-variable-service";

import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";
import { SelectionService, gearIdOf } from "../shell/selection-service";
import { effectiveConfigOf } from "../inspector/effective-config";
import {
  diagnosticsSnapshot,
  productSnapshot,
  selectionLabel,
  selectionSnapshot,
  topologySnapshot,
} from "./gearbox-snapshot";

/** The drag payload Studio's own rows put on the clipboard. */
export const GEARBOX_DRAG_MIME = "application/vnd.gearbox+json";

/** What a dragged row says about itself. */
export type GearboxDragPayload =
  | { readonly kind: "gear"; readonly id: string }
  | { readonly kind: "diagnostic"; readonly code: string };

export const SELECTION_VARIABLE: AIVariable = {
  id: "gearboxSelection",
  name: "gearboxSelection",
  label: "Gearbox Selection",
  description:
    "The gear, application or binding selected in Studio right now, as the resolver names it.",
  isContextVariable: true,
};

export const PRODUCT_VARIABLE: AIVariable = {
  id: "gearboxProduct",
  name: "gearboxProduct",
  label: "Gearbox Product",
  description: "The open product, the profile being shown, and the resolution's lock hash.",
  isContextVariable: true,
};

export const DIAGNOSTICS_VARIABLE: AIVariable = {
  id: "gearboxDiagnostics",
  name: "gearboxDiagnostics",
  label: "Gearbox Diagnostics",
  description: "Every diagnostic the last resolution and catalogue load reported.",
  isContextVariable: true,
};

export const TOPOLOGY_VARIABLE: AIVariable = {
  id: "gearboxTopology",
  name: "gearboxTopology",
  label: "Gearbox Topology",
  description: "The resolved applications and bindings, as identifiers.",
  isContextVariable: true,
};

export const CONFIG_VARIABLE: AIVariable = {
  id: "gearboxConfig",
  name: "gearboxConfig",
  label: "Gearbox Config",
  description:
    "The effective configuration of the selected gear, with each value's provenance.",
  isContextVariable: true,
};

export const GEARBOX_VARIABLES: readonly AIVariable[] = [
  SELECTION_VARIABLE,
  PRODUCT_VARIABLE,
  DIAGNOSTICS_VARIABLE,
  TOPOLOGY_VARIABLE,
  CONFIG_VARIABLE,
];

@injectable()
export class GearboxContextContribution implements AIVariableResolver {
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;

  registerVariables(service: FrontendVariableService): void {
    for (const variable of GEARBOX_VARIABLES) {
      service.registerVariable(variable);
      service.registerResolver(variable, this);
    }
    service.registerDropHandler(async (event) => this.onDrop(event));
  }

  canResolve(request: AIVariableResolutionRequest): number {
    return GEARBOX_VARIABLES.some((variable) => variable.name === request.variable.name) ? 1 : 0;
  }

  async resolve(
    request: AIVariableResolutionRequest,
    _context: AIVariableContext,
  ): Promise<ResolvedAIContextVariable | undefined> {
    switch (request.variable.name) {
      case SELECTION_VARIABLE.name:
        return this.resolved(request, this.selectionLabel(), this.selectionValue());
      case PRODUCT_VARIABLE.name:
        return this.resolved(request, this.productLabel(), productSnapshot(this.products.current));
      case DIAGNOSTICS_VARIABLE.name: {
        const snapshot = diagnosticsSnapshot(this.products.current, this.catalogue.current);
        const label =
          snapshot.total === 0
            ? "no diagnostics"
            : `${snapshot.total} diagnostic${snapshot.total === 1 ? "" : "s"}` +
              (snapshot.errors > 0 ? `, ${snapshot.errors} error` : "");
        return this.resolved(request, label, snapshot);
      }
      case TOPOLOGY_VARIABLE.name: {
        const snapshot = topologySnapshot(this.products.current);
        if (snapshot === undefined) {
          return this.resolved(request, "not resolved", {
            resolved: false,
            why: "Nothing has resolved yet, so there is no topology to report.",
          });
        }
        return this.resolved(
          request,
          `${snapshot.applications.length} application${
            snapshot.applications.length === 1 ? "" : "s"
          }, ${snapshot.gearCount} gears`,
          snapshot,
        );
      }
      case CONFIG_VARIABLE.name:
        return this.resolveConfig(request);
      default:
        return undefined;
    }
  }

  /**
   * Both halves of a context variable, with the model's half as JSON.
   *
   * JSON rather than prose: these are facts with names, and a model asked to
   * parse a sentence back into a gear id will sometimes parse it wrong. The
   * chip keeps the prose.
   */
  protected resolved(
    request: AIVariableResolutionRequest,
    value: string,
    contextValue: unknown,
  ): ResolvedAIContextVariable {
    return {
      variable: request.variable,
      ...(request.arg === undefined ? {} : { arg: request.arg }),
      value,
      contextValue: JSON.stringify(contextValue, undefined, 1),
    };
  }

  protected selectionValue(): unknown {
    return selectionSnapshot(this.selection.current, (key) => this.catalogue.row(key));
  }

  protected selectionLabel(): string {
    return selectionLabel(this.selection.current, (key) => this.catalogue.row(key));
  }

  protected productLabel(): string {
    const state = this.products.current;
    const name = state.intent?.id ?? state.open?.label;
    if (name === undefined) return "no product open";
    return state.profile === undefined ? name : `${name} (${state.profile})`;
  }

  /**
   * The selected gear's effective configuration.
   *
   * A stated absence rather than an empty object when there is nothing to
   * answer about: `{}` reads as "this gear configures nothing", which is a
   * different claim from "nothing is selected" and the one a model would repeat.
   */
  protected resolveConfig(
    request: AIVariableResolutionRequest,
  ): ResolvedAIContextVariable | undefined {
    const selection = this.selection.current;
    // The subject, not the act: what a gear is configured to is the same
    // question whether the person picked it in the catalogue or in the product.
    const selected = gearIdOf(selection);
    if (selected === undefined) {
      return this.resolved(request, "no gear selected", {
        gear: null,
        why:
          selection === undefined
            ? "Nothing is selected."
            : `The selection is a ${selection.kind}, which has no gear configuration.`,
      });
    }
    const gearId = selected;
    const declared = this.products.current.intent?.selected_gears?.find(
      (entry) => entry.gear === gearId,
    )?.config;
    const entries = effectiveConfigOf(
      { edits: this.edits, products: this.products },
      gearId,
      declared ?? {},
    );
    return this.resolved(request, `${gearId} config`, { gear: gearId, config: entries });
  }

  /**
   * A row dragged from Catalogue or Conflicts into the chat.
   *
   * Only Studio's own payload is recognised. A dragged file is Theia's business
   * and `FileVariableContribution` already handles it; claiming the event here
   * would take it away from that.
   */
  protected async onDrop(event: DragEvent): Promise<AIVariableDropResult | undefined> {
    const raw = event.dataTransfer?.getData(GEARBOX_DRAG_MIME);
    if (raw === undefined || raw === "") return undefined;
    let payload: GearboxDragPayload;
    try {
      payload = JSON.parse(raw) as GearboxDragPayload;
    } catch {
      return undefined;
    }
    if (payload.kind === "gear") {
      // Dropped from the catalogue, which is where the gear drag comes from.
      this.selection.select({ kind: "catalogue-gear", id: payload.id });
      return { variables: [{ variable: SELECTION_VARIABLE }] };
    }
    if (payload.kind === "diagnostic") {
      return {
        variables: [{ variable: DIAGNOSTICS_VARIABLE }],
        // The code as text alongside the chip: the variable carries every
        // diagnostic, and the drop said which one the person meant.
        text: payload.code,
      };
    }
    return undefined;
  }
}
