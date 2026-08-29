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

import { ConfirmDialog } from "@theia/core/lib/browser";
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

    if (!(await this.confirm(add, gear, open.label, preview))) {
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
      (await new ConfirmDialog({
        title: add ? "Add gear to product" : "Remove gear from product",
        msg: body,
        ok: add ? "Add" : "Remove",
        cancel: "Cancel",
      }).open()) === true
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
