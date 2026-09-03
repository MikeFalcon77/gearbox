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
//
// Config, features and profile scalars accumulate in a per-product draft and
// commit through `applyEdits` once (Apply), so the preview dialog is not one
// blur away from every field.

import { ConfirmDialog, ConfirmDialogProps } from "@theia/core/lib/browser";
import { Emitter, Event } from "@theia/core/lib/common/event";
import type { Message } from "@theia/core/shared/@lumino/messaging";
import { MessageService } from "@theia/core/lib/common/message-service";
import { URI } from "@theia/core/lib/common/uri";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { EditGearResult } from "../common/generated/EditGearResult";
import type { ProductEdit } from "../common/generated/ProductEdit";
import type { ResolveResult } from "../common/generated/ResolveResult";
import { GearboxService } from "../common/protocol";
import { ProductStore } from "./product-store";
import { ProductSessionService } from "./shell/product-session-service";

@injectable()
export class ProductEditService {
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(ProductStore) protected readonly product!: ProductStore;
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;
  @inject(MessageService) protected readonly messages!: MessageService;

  /** Queued edits for the open product path, awaiting Apply or Discard. */
  protected drafts = new Map<string, ProductEdit[]>();
  protected readonly onDraftChangedEmitter = new Emitter<void>();
  readonly onDraftChanged: Event<void> = this.onDraftChangedEmitter.event;

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

  /** Whether the open product has unapplied draft edits. */
  hasDraft(path?: string): boolean {
    const target = path ?? this.product.current.open?.path;
    if (target === undefined) return false;
    return (this.drafts.get(target)?.length ?? 0) > 0;
  }

  /** The queued edits for a path (open product when omitted). */
  draftEdits(path?: string): readonly ProductEdit[] {
    const target = path ?? this.product.current.open?.path;
    if (target === undefined) return [];
    return this.drafts.get(target) ?? [];
  }

  /**
   * Queue one edit into the open product's draft.
   *
   * Replaces an earlier draft that targets the same config key, feature list, or
   * profile field. Secret-like config keys are refused here so the form never
   * holds a value the engine will reject on Apply.
   */
  queueDraft(edit: ProductEdit): boolean {
    const open = this.product.current.open;
    if (open === undefined) {
      this.messages.warn("Open a product before editing it.");
      return false;
    }
    if (edit.kind === "set_config" && edit.value != null && isSecretConfigKey(edit.key)) {
      this.messages.error(
        `refusing to write config key \`${edit.key}\`: names like this are for external secret references`,
      );
      return false;
    }
    const next = mergeDraft(this.drafts.get(open.path) ?? [], edit);
    this.drafts.set(open.path, next);
    this.onDraftChangedEmitter.fire();
    return true;
  }

  /**
   * Drop the draft for the open product and restore widgets from the store.
   *
   * Returns whether there was anything to discard.
   */
  discardDraft(path?: string): boolean {
    const target = path ?? this.product.current.open?.path;
    if (target === undefined) return false;
    if (!this.drafts.has(target)) return false;
    this.drafts.delete(target);
    this.onDraftChangedEmitter.fire();
    return true;
  }

  /**
   * Dry-run the draft once, confirm once, write once via `applyEdits`.
   */
  async applyDraft(): Promise<boolean> {
    const open = this.product.current.open;
    if (open === undefined) return false;
    const edits = this.drafts.get(open.path) ?? [];
    if (edits.length === 0) {
      this.messages.info("Nothing to change.");
      return false;
    }
    const applied = await this.applyDescriptionEdit({
      title: "Apply changes",
      ok: "Apply",
      summary: `${edits.length} edit${edits.length === 1 ? "" : "s"} on ${open.label}`,
      path: open.path,
      label: open.label,
      dryRun: () => this.service.applyEdits(open.path, edits, true),
      commit: () => this.service.applyEdits(open.path, edits, false),
      log: `apply ${edits.length} draft edit(s)`,
    });
    if (applied) {
      this.drafts.delete(open.path);
      this.onDraftChangedEmitter.fire();
    }
    return applied;
  }

  /** Saved config overlaid with draft set_config edits for `gear`. */
  draftConfig(gear: string, saved: Readonly<Record<string, unknown>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(saved)) {
      out[key] = String(value);
    }
    for (const edit of this.draftEdits()) {
      if (edit.kind !== "set_config" || edit.gear !== gear) continue;
      if (edit.value == null) delete out[edit.key];
      else out[edit.key] = edit.value;
    }
    return out;
  }

  /** Saved features overlaid with the latest draft set_features for `gear`. */
  draftFeatures(gear: string, saved: readonly string[]): string[] {
    let features = [...saved];
    for (const edit of this.draftEdits()) {
      if (edit.kind === "set_features" && edit.gear === gear) {
        features = [...edit.features];
      }
    }
    return features;
  }

  /** Saved profile field overlaid with draft set_profile_field. */
  draftProfileField(
    profile: string,
    field: string,
    saved: string | undefined,
  ): string | undefined {
    let value = saved;
    for (const edit of this.draftEdits()) {
      if (edit.kind === "set_profile_field" && edit.profile === profile && edit.field === field) {
        value = edit.value ?? undefined;
      }
    }
    return value;
  }

  /**
   * Dry-run `addGear` for the Add Gear configurator preview.
   *
   * Returns `undefined` when the edit is refused or impossible; the caller shows
   * the engine's reason via the message service already fired here.
   */
  async previewAddGear(gear: string, source: string): Promise<EditGearResult | undefined> {
    const open = this.product.current.open;
    if (open === undefined) {
      this.messages.warn("Open a product before adding gears to it.");
      return undefined;
    }
    if (this.isDirty(open.path)) {
      this.messages.error(
        `${open.label} has unsaved changes. Save or revert them first — ` +
          `writing now would discard your edit.`,
      );
      return undefined;
    }
    try {
      return await this.service.addGear(open.path, gear, source, true);
    } catch (error) {
      this.messages.error(messageOf(error));
      return undefined;
    }
  }

  /**
   * Resolve the product as it *would* be with this gear and these edits.
   *
   * Answers the question the configurator exists for -- which gears the closure
   * pulls in, which processes change, which bindings stop being local -- before
   * anything is written. Nothing is written: the engine applies the edits to the
   * text in memory and resolves that.
   *
   * The dirty-buffer refusal of the write paths deliberately does **not** apply.
   * Reading a stale file to answer a hypothetical costs nothing, and refusing here
   * would blank the panel for the whole time an editor is open -- exactly when a
   * person most wants to see what their change does.
   *
   * Failure returns `undefined` and says nothing: this runs on every keystroke's
   * debounce, and a message toast per failed preview would be noise. The panel
   * reports it in place.
   */
  async previewResolution(
    gear: string,
    source: string,
    followUps: readonly ProductEdit[],
  ): Promise<ResolveResult | undefined> {
    const open = this.product.current.open;
    if (open === undefined) return undefined;
    try {
      return await this.service.resolvePreview({
        path: open.path,
        profile: this.product.current.profile,
        add: { gear, source },
        edits: followUps,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Commit an Add Gear configurator result: `addGear`, then optional follow-up
   * `applyEdits` for features/config. The configurator is the confirmation UI, so
   * there is no second modal -- the dry-run the panel already showed is the
   * preview ADR-0010 requires.
   */
  async commitAddGear(
    gear: string,
    source: string,
    followUps: readonly ProductEdit[],
  ): Promise<boolean> {
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

    let preview: EditGearResult;
    try {
      preview = await this.service.addGear(open.path, gear, source, true);
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }
    if (!preview.changed) {
      this.messages.info(`${open.label} already names ${gear}.`);
      return false;
    }

    // eslint-disable-next-line no-console
    console.info(`Gearbox: writing add ${gear} to ${open.path}`, new Error("write path").stack);
    try {
      await this.service.addGear(open.path, gear, source, false);
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }

    if (followUps.length > 0) {
      try {
        await this.service.applyEdits(open.path, followUps, false);
      } catch (error) {
        this.messages.error(messageOf(error));
        await this.product.reload();
        return false;
      }
    }

    await this.product.reload();
    return true;
  }

  /** Line-oriented preview text for an edit dry-run. */
  formatDiff(preview: EditGearResult): string {
    return this.diffText(preview);
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

  async createProduct(params: {
    path: string;
    id: string;
    name: string;
    version: string;
    sources: ReadonlyArray<{ id: string; at: string }>;
    profileKind: string;
    profileId: string;
    cloneFrom?: string;
    preview: string;
  }): Promise<boolean> {
    let preview: EditGearResult;
    try {
      preview = await this.service.createProduct({ ...params, dryRun: true });
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }
    if (!(await this.confirmCreate(params.name, preview))) return false;
    try {
      preview = await this.service.createProduct({ ...params, dryRun: true });
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }
    if (preview.after !== params.preview) {
      this.messages.warn("The preview changed while the dialog was open. Try again.");
      return false;
    }
    // eslint-disable-next-line no-console
    console.info(`Gearbox: writing create ${params.path}`, new Error("write path").stack);
    try {
      await this.service.createProduct({ ...params, dryRun: false });
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }
    await this.product.ensureDiscovered();
    await this.session.open({ path: params.path, label: params.name });
    return true;
  }

  async addProfile(
    kind: string,
    id: string,
    fields: ReadonlyArray<{ name: string; value: string }>,
  ): Promise<boolean> {
    const open = this.product.current.open;
    if (open === undefined) return false;
    return this.applyDescriptionEdit({
      title: "Add profile",
      ok: "Add",
      summary: `profile ${id}`,
      path: open.path,
      label: open.label,
      dryRun: () => this.service.addProfile(open.path, kind, id, fields, true),
      commit: () => this.service.addProfile(open.path, kind, id, fields, false),
      log: `add profile ${id}`,
    });
  }

  async removeProfile(id: string): Promise<boolean> {
    const open = this.product.current.open;
    if (open === undefined) return false;
    return this.applyDescriptionEdit({
      title: "Remove profile",
      ok: "Remove",
      summary: `profile ${id}`,
      path: open.path,
      label: open.label,
      dryRun: () => this.service.removeProfile(open.path, id, true),
      commit: () => this.service.removeProfile(open.path, id, false),
      log: `remove profile ${id}`,
    });
  }

  protected async applyDescriptionEdit(args: {
    title: string;
    ok: string;
    summary: string;
    path: string;
    label: string;
    dryRun: () => Promise<EditGearResult>;
    commit: () => Promise<EditGearResult>;
    log: string;
  }): Promise<boolean> {
    if (this.isDirty(args.path)) {
      this.messages.error(
        `${args.label} has unsaved changes. Save or revert them first — writing now would discard your edit.`,
      );
      return false;
    }
    let preview: EditGearResult;
    try {
      preview = await args.dryRun();
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }
    if (!preview.changed) {
      this.messages.info("Nothing to change.");
      return false;
    }
    const at = this.product.revision;
    if (!(await this.confirmEdit(args.title, args.ok, args.summary, preview))) return false;
    const open = this.product.current.open;
    if (this.product.revision !== at || open?.path !== args.path || this.isDirty(args.path)) {
      this.messages.warn("Nothing was written: the product changed while the preview was open.");
      return false;
    }
    let again: EditGearResult;
    try {
      again = await args.dryRun();
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }
    if (!again.changed || again.after !== preview.after) {
      this.messages.warn("Nothing was written: the description on disk is not the one previewed.");
      return false;
    }
    // eslint-disable-next-line no-console
    console.info(`Gearbox: writing ${args.log} to ${args.path}`, new Error("write path").stack);
    try {
      await args.commit();
    } catch (error) {
      this.messages.error(messageOf(error));
      return false;
    }
    await this.product.reload();
    return true;
  }

  protected async confirmEdit(
    title: string,
    ok: string,
    summary: string,
    preview: EditGearResult,
  ): Promise<boolean> {
    const body = document.createElement("div");
    const head = document.createElement("div");
    head.textContent = summary;
    body.appendChild(head);
    const diff = document.createElement("pre");
    diff.className = "gbx-edit-preview";
    diff.textContent = this.diffText(preview);
    body.appendChild(diff);
    return (
      (await new EditPreviewDialog({ title, msg: body, ok, cancel: "Cancel" }).open()) === true
    );
  }

  protected async confirmCreate(name: string, preview: EditGearResult): Promise<boolean> {
    const body = document.createElement("div");
    body.textContent = `Create ${name}:`;
    const pre = document.createElement("pre");
    pre.className = "gbx-create-preview";
    pre.textContent = preview.after;
    body.appendChild(pre);
    return (
      (await new EditPreviewDialog({
        title: "Create product",
        msg: body,
        ok: "Create",
        cancel: "Cancel",
      }).open()) === true
    );
  }

  protected diffText(preview: EditGearResult): string {
    const before = preview.before.split("\n");
    const after = preview.after.split("\n");
    const added = after.filter((line) => !before.includes(line));
    const removed = before.filter((line) => !after.includes(line));
    return [...removed.map((line) => `- ${line.trim()}`), ...added.map((line) => `+ ${line.trim()}`)].join(
      "\n",
    );
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
    const body = document.createElement("div");
    const summary = document.createElement("div");
    summary.textContent = `${add ? "Add" : "Remove"} ${gear} ${add ? "to" : "from"} ${label}:`;
    body.appendChild(summary);

    const diff = document.createElement("pre");
    diff.className = "gbx-edit-preview";
    diff.textContent = this.diffText(preview);
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

/** Mirror of `gearbox_gdl::edit::is_secret_config_key` for draft-time refusal. */
function isSecretConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  const exact = ["password", "secret", "token", "key", "credential"];
  if (exact.includes(lower)) return true;
  return ["_password", "_secret", "_token", "_key", "_credential"].some((suffix) =>
    lower.endsWith(suffix),
  );
}

/** Replace an earlier draft that targets the same slot; append otherwise. */
function mergeDraft(existing: ProductEdit[], edit: ProductEdit): ProductEdit[] {
  const sameSlot = (other: ProductEdit): boolean => {
    if (edit.kind === "set_config" && other.kind === "set_config") {
      return other.gear === edit.gear && other.key === edit.key;
    }
    if (edit.kind === "set_features" && other.kind === "set_features") {
      return other.gear === edit.gear;
    }
    if (edit.kind === "set_profile_field" && other.kind === "set_profile_field") {
      return other.profile === edit.profile && other.field === edit.field;
    }
    return false;
  };
  const without = existing.filter((other) => !sameSlot(other));
  without.push(edit);
  return without;
}
