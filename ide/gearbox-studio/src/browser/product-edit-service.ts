// Adding a gear to the open product, and everything that has to be true first.
//
// A service rather than a handler in the catalogue widget: the policy here is not
// about rendering, and there are four separate reasons to refuse before anything
// is written. Keeping them in the widget would mean the next widget that wants to
// edit a description reimplements the checks, and the checks are the substance.
//
// The order is deliberate:
//
//   1. a product must be open, or there is nothing to add to;
//   2. the description must not have unsaved changes in the editor -- see below;
//   3. the engine must agree the edit is possible, which is the dry run;
//   4. the person must agree, which is the preview.
//
// **The unsaved-buffer check is the one worth arguing for.** If a person has
// `product.gdl` open and modified, writing under them destroys their edit -- which
// is precisely the failure ADR `cpt-gearbox-adr-authoring-ownership-tiers` exists
// to prevent, and worse than the one it worries about, because the tool would be
// the author of the loss. Saving on their behalf is not the answer either: that
// commits an edit they had not finished. So this refuses and says which file.
//
// **The checks run twice, and the second time is not paranoia.** Steps 1 to 3
// establish facts; step 4 waits for a person, for as long as they like. Nothing
// keeps the world still in between -- a profile switch, a re-resolve, a close or
// an editor going dirty all happen while the dialog is up. So every fact is
// re-established after the dialog returns, and the dry run is re-run and
// compared: an answer about a state that has gone is refused rather than applied
// to whatever is there now.

import { ConfirmDialog, ConfirmDialogProps } from "@theia/core/lib/browser";
import type { Message } from "@theia/core/shared/@lumino/messaging";
import { MessageService } from "@theia/core/lib/common/message-service";
import { URI } from "@theia/core/lib/common/uri";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { EditGearResult } from "../common/generated/EditGearResult";
import { GearboxService } from "../common/protocol";
import { ProductStore } from "./product-store";

@injectable()
export class ProductEditService {
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(ProductStore) protected readonly product!: ProductStore;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;
  @inject(MessageService) protected readonly messages!: MessageService;

  /** Whether the open product names this gear directly. */
  inProduct(gear: string): boolean {
    const product = this.product.current.resolution?.product;
    return (
      product?.gears[gear]?.selected_by.some((reason) => reason.reason === "selected") ?? false
    );
  }

  /** Whether an edit is possible at all right now. */
  get editable(): boolean {
    return this.product.current.open !== undefined;
  }

  /**
   * Add or remove `gear`, asking first.
   *
   * Returns whether the description changed, so a caller can avoid a needless
   * reload -- and so "nothing happened" is distinguishable from "you cancelled".
   */
  async toggle(gear: string, source: string): Promise<boolean> {
    const open = this.product.current.open;
    if (open === undefined) {
      this.messages.warn("Open a product before adding gears to it.");
      return false;
    }

    if (this.isDirty(open.path)) {
      this.messages.error(
        `${open.label} has unsaved changes. Save or revert them first — ` +
          `writing now would discard your edit.`,
      );
      return false;
    }

    const add = !this.inProduct(gear);
    let preview: EditGearResult;
    try {
      preview = add
        ? await this.service.addGear(open.path, gear, source, true)
        : await this.service.removeGear(open.path, gear, true);
    } catch (error) {
      // The engine's refusals carry their own reasons -- a `gears` list built by a
      // helper, a path outside the workspace -- and they are more useful than
      // anything this could invent.
      this.messages.error(messageOf(error));
      return false;
    }

    if (!preview.changed) {
      this.messages.info(
        add
          ? `${open.label} already names ${gear}.`
          : `${open.label} does not name ${gear}.`,
      );
      return false;
    }

    // Captured before the dialog, compared after it. See the header.
    const at = this.product.revision;
    if (!(await this.confirm(add, gear, open.label, preview))) {
      return false;
    }
    if (!(await this.stillTrue(at, open.path, gear, source, add, preview))) {
      return false;
    }

    try {
      if (add) {
        await this.service.addGear(open.path, gear, source, false);
      } else {
        await this.service.removeGear(open.path, gear, false);
      }
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }

    // Re-read and re-resolve: the description changed, so every answer on screen
    // is about the previous one until this finishes.
    await this.product.reload();
    return true;
  }

  /**
   * Whether everything the preview assumed is still true.
   *
   * Four things, and each of them has a different way of going wrong while a
   * modal dialog is up:
   *
   *   - the **store's revision**, which changes on a re-read, a re-resolve, a
   *     profile switch and a close. A preview computed before any of those is an
   *     answer about a product that is no longer the one on screen.
   *   - the **open product**, by path, because it may now be a different one.
   *   - the **buffer**, because an editor can go dirty while the dialog waits,
   *     and writing then is the loss the first check exists to prevent.
   *   - the **dry run**, re-run and compared byte for byte. This is the one that
   *     catches a change made outside Studio: the same edit against a file that
   *     someone else has since altered produces different text, and applying the
   *     old intention to the new file is how surgery becomes damage.
   *
   * There is a specific hazard behind all of this and it is worth naming, because
   * it is not hypothetical. `DialogOverlayService` binds Enter on
   * **`document.body`** (`@theia/core/lib/browser/dialogs.js:82`), so while this
   * dialog is open *any* Enter anywhere in the application accepts it. A keystroke
   * meant for something else can therefore answer a question the person has
   * forgotten is on screen. `EditPreviewDialog` below takes that away; this makes
   * a late answer harmless even if some other path finds its way to one.
   */
  protected async stillTrue(
    at: number,
    path: string,
    gear: string,
    source: string,
    add: boolean,
    preview: EditGearResult,
  ): Promise<boolean> {
    const stale = (why: string): false => {
      this.messages.warn(
        `Nothing was written: ${why}. The preview described a state that has changed, ` +
          `so ${add ? "adding" : "removing"} ${gear} was not applied. Try again.`,
      );
      return false;
    };

    if (this.product.revision !== at) {
      return stale("the product was re-read while the preview was open");
    }
    const open = this.product.current.open;
    if (open === undefined || open.path !== path) {
      return stale("the product was closed or replaced while the preview was open");
    }
    if (this.isDirty(path)) {
      return stale("the description now has unsaved changes in the editor");
    }

    let again: EditGearResult;
    try {
      again = add
        ? await this.service.addGear(path, gear, source, true)
        : await this.service.removeGear(path, gear, true);
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }
    if (!again.changed || again.after !== preview.after) {
      return stale("the description on disk is not the one the preview was computed from");
    }

    // Only reached when the write is about to happen for real. Logged rather than
    // silent because a write to a description nobody asked for is the one defect
    // in this application whose cause has not been found, and a stack trace at the
    // moment of the write is the evidence that would name it. `console.info` and
    // not `debug`: the test harness collects info and above.
    // eslint-disable-next-line no-console
    console.info(
      `Gearbox: writing ${add ? "add" : "remove"} ${gear} to ${path}`,
      new Error("write path").stack,
    );
    return true;
  }

  /**
   * Whether the file is open in an editor with unsaved changes.
   *
   * Compared by URI rather than by path string, because a model's URI is
   * normalised and a path is not -- `/a/./b` and `/a/b` are the same file and
   * different strings.
   */
  protected isDirty(path: string): boolean {
    const wanted = URI.fromFilePath(path).toString();
    return this.models.models.some((model) => model.uri === wanted && model.dirty);
  }

  /**
   * The preview, as the lines that change.
   *
   * A line diff computed here purely to be shown: both sides came from the engine
   * in the same response, and nothing is decided from this. The edit is one line
   * by construction, so a full diff algorithm would be machinery for a result
   * that fits on one screen.
   */
  protected async confirm(
    add: boolean,
    gear: string,
    label: string,
    preview: EditGearResult,
  ): Promise<boolean> {
    const before = preview.before.split("\n");
    const after = preview.after.split("\n");
    const added = after.filter((line) => !before.includes(line));
    const removed = before.filter((line) => !after.includes(line));

    const body = document.createElement("div");
    const summary = document.createElement("div");
    summary.textContent = `${add ? "Add" : "Remove"} ${gear} ${add ? "to" : "from"} ${label}:`;
    body.appendChild(summary);

    const diff = document.createElement("pre");
    diff.className = "gbx-edit-preview";
    diff.textContent = [
      ...removed.map((line) => `- ${line.trim()}`),
      ...added.map((line) => `+ ${line.trim()}`),
    ].join("\n");
    body.appendChild(diff);

    return (
      (await new EditPreviewDialog({
        title: add ? "Add gear to product" : "Remove gear from product",
        msg: body,
        ok: add ? "Add" : "Remove",
        cancel: "Cancel",
      }).open()) === true
    );
  }
}

/**
 * A confirmation that a stray Enter cannot answer.
 *
 * Theia's `DialogOverlayService` adds its Enter listener to **`document.body`**
 * (`@theia/core/lib/browser/dialogs.js:82`) and `AbstractDialog.handleEnter`
 * accepts unless the event came from a textarea. Together with
 * `onActivateRequest` focusing the accept button, that makes Enter -- pressed
 * anywhere, for any reason, by anything -- write to a description.
 *
 * That is the right default for "Do you want to reload?" and the wrong one for a
 * dialog whose Yes edits a file. So:
 *
 *   - `handleEnter` no longer accepts. A focused button still activates on Enter,
 *     natively, because that is what a button does -- so the keyboard path to Yes
 *     survives and only the *ambient* one is gone.
 *   - the **cancel** button takes the initial focus, so that path leads to No.
 *
 * Escape is untouched: cancelling on a stray keystroke costs a person one click.
 */
class EditPreviewDialog extends ConfirmDialog {
  constructor(props: ConfirmDialogProps) {
    super(props);
  }

  protected override handleEnter(): boolean {
    return false;
  }

  protected override onActivateRequest(msg: Message): void {
    // `AbstractDialog.onActivateRequest` focuses `acceptButton`; skipping it and
    // going to the base of *that* is what puts focus on cancel instead. Falls
    // back to the accept button only if there is no cancel button to focus,
    // which would mean a dialog with one control and nothing to protect.
    if (this.closeButton !== undefined) {
      this.closeButton.focus();
      return;
    }
    super.onActivateRequest(msg);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
