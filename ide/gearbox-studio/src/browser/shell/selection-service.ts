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
// **Selecting the same gear two ways is one subject and two acts.** This used to
// say one *selection*: a projected catalogue row was normalised to
// `{ kind: "gear" }` the moment it was chosen, so picking `cluster` in the
// catalogue and picking it in the product tree produced the same value. The
// subject really is one -- the explanation graph, the catalogue highlight and
// the chat answer about the same gear either way, and `gearIdOf` is how a reader
// that wants only the subject says so.
//
// The act is not one, and collapsing it cost the Composition pane its meaning: a
// catalogue click replaced the open product's settings with a message about a
// gear the product does not contain. Browsing a catalogue and configuring a
// product are different things to be doing, and only the second may write.
//
// So `gear` narrows to "chosen in the open product" and `catalogue-gear` is the
// other act. A new *kind* rather than an `origin` field on `gear`, deliberately:
// `sameSelection` compares a `gear` by `id` and nothing else, so an added field
// would leave it compiling and still answering `true` across the two -- the same
// defect, now silent. A kind makes every exhaustive switch refuse to compile
// until it states an answer.
//
// `catalogue-row` survives only for a row that has no `GearId` yet, which under
// ADR `cpt-gearbox-adr-staged-catalogue-loading` is every row until S2 has run
// on it.

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
  /**
   * One `plugin(...)` connection, addressed the way the editor addresses it.
   *
   * `entryIndex` is `PluginSelection.entry_index` -- the position the entry is
   * *written* at in the host's `plugins = [...]`, not its position in the list
   * that survived evaluation. `path` is here because this is the only selection
   * an edit can invalidate rather than a re-resolve, so it has to say which
   * document it counted in.
   */
  | {
      readonly kind: "plugin";
      readonly host: string;
      readonly id: string;
      readonly entryIndex: number;
      readonly path: string;
    }
  /** A gear chosen in the open product: the tree, a diagnostic, a graph node. */
  | { readonly kind: "gear"; readonly id: string }
  /**
   * A gear chosen while browsing the catalogue.
   *
   * The same gear as a `gear` selection would name, and not the same act. It may
   * not be in the open product, there may be no open product, and nothing
   * reached this way may be edited in place.
   */
  | { readonly kind: "catalogue-gear"; readonly id: string }
  | { readonly kind: "application"; readonly id: string }
  | { readonly kind: "binding"; readonly consumer: string; readonly contract: string }
  /** A catalogue row with no id yet: still pending, so nothing can be joined to it. */
  | { readonly kind: "catalogue-row"; readonly key: string };

/** The three the resolution knows about. Named because `ProductStore` speaks it. */
export type ProductSelection = Exclude<
  Selection,
  { kind: "catalogue-row" | "plugin" | "catalogue-gear" }
>;

export function isProductSelection(
  selection: Selection | undefined,
): selection is ProductSelection {
  return (
    selection !== undefined &&
    selection.kind !== "catalogue-row" &&
    selection.kind !== "plugin" &&
    selection.kind !== "catalogue-gear"
  );
}

/**
 * The gear a selection is about, whichever act chose it.
 *
 * For readers that want the *subject* and genuinely do not care which surface
 * named it: what a gear's effective config is, which catalogue row to highlight,
 * what the chat is being asked about. Keeping the distinction out of those is
 * the point of having it in the kind.
 */
export function gearIdOf(selection: Selection | undefined): string | undefined {
  if (selection === undefined) return undefined;
  return selection.kind === "gear" || selection.kind === "catalogue-gear"
    ? selection.id
    : undefined;
}

/**
 * The selection as the resolution's question, or nothing.
 *
 * A catalogue gear flattens to a product gear here on purpose: "why is this gear
 * the way it is" is answerable about any gear in the closure, and refusing to
 * answer it because the question came from the catalogue would make the
 * explanation panel blank exactly where it is most useful. What does *not*
 * flatten is the right to edit, and that is decided by the kind, elsewhere.
 */
export function asFocus(selection: Selection | undefined): ProductSelection | undefined {
  if (selection === undefined) return undefined;
  if (selection.kind === "catalogue-gear") return { kind: "gear", id: selection.id };
  return isProductSelection(selection) ? selection : undefined;
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
    case "plugin": {
      const other = b as Extract<Selection, { kind: "plugin" }>;
      return (
        a.path === other.path &&
        a.host === other.host &&
        a.entryIndex === other.entryIndex &&
        a.id === other.id
      );
    }
    case "gear":
    case "catalogue-gear":
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
