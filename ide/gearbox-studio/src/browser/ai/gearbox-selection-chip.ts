// The chip that says what Studio has selected, without anyone attaching it.
//
// Two halves of one behaviour, which is why they share a file.
//
// **The label provider, because otherwise the chip is blank.** Theia renders a
// context chip's title from `LabelProvider.getName(request)`, and the only
// contribution shipped for that handles `ai-variable://` URIs -- nothing handles
// a bare `AIVariableResolutionRequest`. So a variable contributed without a
// label provider appears as an empty pill.
//
// **One chip, not one per selection.** `AIChatInputWidget.deleteContextElement`
// is protected, so a contribution outside the widget cannot remove what it
// added; a chip attached on every selection change would pile up and there would
// be no way to clear it. Instead the `#gearboxSelection` chip is attached once
// and means "whatever is selected", resolved when the request is sent. The
// label provider reads the live selection too, so the pill still reads
// `static-tr-plugin` and changes as the selection does -- the chip names the
// current answer without pinning a stale one.
//
// That is also why `update()` is called on the input widget: the label is
// recomputed during render, so the widget has to be told a render is due.

import { inject, injectable } from "@theia/core/shared/inversify";
import type { FrontendApplicationContribution, LabelProviderContribution } from "@theia/core/lib/browser";
import { WidgetManager } from "@theia/core/lib/browser";
import { AIVariableResolutionRequest } from "@theia/ai-core";
import { ChatViewWidget } from "@theia/ai-chat-ui/lib/browser/chat-view-widget";

import { CatalogueStore } from "../catalogue-store";
import { SelectionService, sameSelection } from "../shell/selection-service";
import type { Selection } from "../shell/selection-service";
import { selectionLabel } from "./gearbox-snapshot";
import {
  DIAGNOSTICS_VARIABLE,
  GEARBOX_VARIABLES,
  SELECTION_VARIABLE,
} from "./gearbox-context";

/** Names the chips Studio contributes, so they are not blank pills. */
@injectable()
export class GearboxVariableLabelProvider implements LabelProviderContribution {
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;

  protected isMine(element: object): element is AIVariableResolutionRequest {
    return (
      AIVariableResolutionRequest.is(element) &&
      GEARBOX_VARIABLES.some((variable) => variable.name === element.variable.name)
    );
  }

  canHandle(element: object): number {
    // Above `AIVariableUriLabelProvider`'s 150 is unnecessary -- that one only
    // claims URIs -- but a positive number is required to be consulted at all.
    return this.isMine(element) ? 160 : -1;
  }

  getName(element: object): string | undefined {
    if (!this.isMine(element)) return undefined;
    if (element.variable.name === SELECTION_VARIABLE.name) {
      // Read live, so the one attached chip tracks the selection instead of
      // naming whatever was selected when it was attached.
      return selectionLabel(this.selection.current, (key) => this.catalogue.row(key));
    }
    return element.variable.label ?? element.variable.name;
  }

  getLongName(element: object): string | undefined {
    if (!this.isMine(element)) return undefined;
    return element.variable.description;
  }

  getIcon(element: object): string | undefined {
    if (!this.isMine(element)) return undefined;
    return element.variable.name === DIAGNOSTICS_VARIABLE.name
      ? "codicon codicon-warning"
      : "codicon codicon-circuit-board";
  }
}

/**
 * Keeps the selection chip attached to the chat input, and current.
 *
 * Deliberately does nothing when the chat has never been opened: creating the
 * widget to attach a chip nobody asked for would open a panel as a side effect
 * of clicking a catalogue row.
 */
@injectable()
export class GearboxSelectionChip implements FrontendApplicationContribution {
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;

  protected last: Selection | undefined;

  onStart(): void {
    this.selection.onDidChange((selection) => this.onSelectionChanged(selection));
    // **Also when the chat appears, not only when the selection moves.** A
    // person who selects a gear and *then* opens the chat has already had their
    // one `onDidChange`, and selecting the same gear again is deduplicated
    // below -- so without this the chip never arrived for the commonest order
    // of all. Found by the conformance suite: the claim passed alone and failed
    // in a full run, because by then an earlier spec had already made a
    // selection.
    this.widgets.onDidCreateWidget(({ widget }) => {
      if (widget.id === ChatViewWidget.ID) this.sync();
    });
  }

  protected onSelectionChanged(selection: Selection | undefined): void {
    // `SelectionService.select` fires unconditionally, even for an unchanged
    // value, and `DescriptionWatchService` re-resolves on every save -- so
    // without this the same work would run on every keystroke-triggered save.
    if (sameSelection(selection, this.last)) return;
    this.last = selection;
    this.sync();
  }

  /**
   * Put the chip on the chat input, if there is a chat and something selected.
   *
   * Idempotent, and called from both directions -- the selection changing and
   * the chat opening -- because either can happen first.
   */
  protected sync(): void {
    if (this.selection.current === undefined) return;
    const view = this.widgets.tryGetWidget<ChatViewWidget>(ChatViewWidget.ID);
    if (view === undefined) return;
    const input = view.inputWidget;
    const attached = input
      .getAllVariablesForRequest()
      .some((request) => request.variable.name === SELECTION_VARIABLE.name);
    if (!attached) input.addContext({ variable: SELECTION_VARIABLE });
    // The label is computed during render, so a selection change is only
    // visible once a render happens.
    input.update();
  }
}
