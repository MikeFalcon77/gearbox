// The one thing Studio has selected, wherever it was selected.
//
// There used to be two selections. `CatalogueStore` held a row key and the Gear
// panel rendered from it; `ProductStore` held a focus and the Explain panel
// rendered from that. Two panels side by side in the bottom bar, answering about
// two different things, and no way to tell from either which one it was about:
// choosing `api-gateway` in the product tree left "what is it" blank, because
// that panel was still waiting to be given a catalogue row.
//
// So the selection moves out of both stores and becomes one value. The stores
// keep their accessors -- `selected`, `focus` -- and delegate here, which is what
// makes this a single source of truth rather than a third place to look.
//
// **Selecting the same gear two ways is one selection.** A projected catalogue row
// is normalised to `{ kind: "gear" }` at the moment it is chosen, so picking
// `cluster` in the catalogue and picking it in the product tree produce the same
// value -- and both views highlight it. `catalogue-row` survives only for a row
// that has no `GearId` yet, which under ADR `cpt-gearbox-adr-staged-catalogue-loading`
// is every row until S2 has run on it.

import { Emitter, Event } from "@theia/core/lib/common/event";
import { injectable } from "@theia/core/shared/inversify";

/**
 * What is selected.
 *
 * The three product-side variants are what the explanation graph can answer
 * about, and their shape is `NodeId`'s convention (`{kind}:{payload}`), which is
 * part of the wire contract rather than a local invention.
 */
export type Selection =
  | { readonly kind: "gear"; readonly id: string }
  | { readonly kind: "application"; readonly id: string }
  | { readonly kind: "binding"; readonly consumer: string; readonly contract: string }
  /** A catalogue row with no id yet: still pending, so nothing can be joined to it. */
  | { readonly kind: "catalogue-row"; readonly key: string };

/** The three the resolution knows about. Named because `ProductStore` speaks it. */
export type ProductSelection = Exclude<Selection, { kind: "catalogue-row" }>;

export function isProductSelection(
  selection: Selection | undefined,
): selection is ProductSelection {
  return selection !== undefined && selection.kind !== "catalogue-row";
}

@injectable()
export class SelectionService {
  protected readonly onDidChangeEmitter = new Emitter<Selection | undefined>();
  readonly onDidChange: Event<Selection | undefined> = this.onDidChangeEmitter.event;

  protected selection: Selection | undefined;

  get current(): Selection | undefined {
    return this.selection;
  }

  /**
   * Select, or clear.
   *
   * Fires unconditionally rather than only on a change. The stores re-render from
   * this event, and a selection re-asserted after the underlying row was replaced
   * -- a pending row projecting is exactly that -- has the same value and a
   * different meaning.
   */
  select(selection: Selection | undefined): void {
    this.selection = selection;
    this.onDidChangeEmitter.fire(selection);
  }
}

/** Whether two selections are the same choice. */
export function sameSelection(a: Selection | undefined, b: Selection | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "gear":
    case "application":
      return a.id === (b as { id: string }).id;
    case "catalogue-row":
      return a.key === (b as { key: string }).key;
    case "binding": {
      const other = b as { consumer: string; contract: string };
      return a.consumer === other.consumer && a.contract === other.contract;
    }
  }
}
