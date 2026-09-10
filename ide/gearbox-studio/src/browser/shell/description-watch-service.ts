// The open product's description, re-read when it changes on disk.
//
// **Nothing in this application listened to the filesystem before this.** Every
// Gearbox surface renders from `ProductStore` or `CatalogueStore`, so editing
// `product.gdl` in the editor beside them and saving left all twelve showing the
// previous resolution -- the Inspector, the Product tree, the Graph, Validation,
// the toolbar's counts, the Problems markers. The complaint arrives as "the
// Inspector does not update", but the Inspector is not special; it is one of the
// twelve.
//
// The detector already existed. Theia watches the workspace, and
// `files.watcherExclude` names only `.git`, `node_modules`, `target` and
// `.gearbox` -- so `product.gdl` events were being delivered and nobody had
// subscribed. What follows is the subscription.
//
// **Why this is not the thing the plan calls out of scope.** That passage is
// about `.gearbox/**`, which is excluded from the watcher on purpose because
// generated output is rewritten wholesale, and about the catalogue's source
// roots, which are not watched at all. Neither argument reaches a description
// inside the workspace, and conflating them is what left this gap looking
// decided.
//
// **And why `gear.gdl` is deliberately not included.** The engine caches the
// catalogue for the lifetime of its process (`catalogue_for`) and drops it only
// on `initialize`, so picking up a gear edit means respawning the engine. Doing
// that silently on every keystroke-save of a file in `gears-rust` is not a
// refresh, it is a restart. `Reload Catalogue` stays the affordance for that,
// and the asymmetry is stated here so the next reader does not read it as an
// omission.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { Disposable, DisposableCollection } from "@theia/core/lib/common/disposable";
import { URI } from "@theia/core/lib/common/uri";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import { ProductStore } from "../product-store";
import { hasUnsavedEdits } from "./unsaved";

/**
 * How long to wait after a change before re-reading.
 *
 * A resolution is two engine calls and is not free, and an editor save can
 * arrive as several events. Long enough to fold those together, short enough
 * that a person who saved and looked up has not started wondering.
 */
const SETTLE_MS = 300;

@injectable()
export class DescriptionWatchService implements FrontendApplicationContribution {
  @inject(FileService) protected readonly files!: FileService;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;

  protected readonly toDispose = new DisposableCollection();
  protected timer: ReturnType<typeof setTimeout> | undefined;

  onStart(): void {
    this.toDispose.push(
      this.files.onDidFilesChange((event) => {
        const open = this.products.current.open;
        if (open === undefined) return;
        if (!event.contains(URI.fromFilePath(open.path))) return;
        this.schedule(open.path);
      }),
    );
    this.toDispose.push(Disposable.create(() => this.cancel()));
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  /**
   * Re-read once the writes have stopped.
   *
   * The path is re-checked when the timer fires rather than captured as a
   * decision: a change to A that lands while the person is opening B must not
   * re-resolve anything, and the three hundred milliseconds are long enough for
   * that to happen.
   */
  protected schedule(path: string): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const open = this.products.current.open;
      if (open?.path !== path) return;
      // **Not while a buffer holds unsaved edits.** The write gates in
      // `ProductEditService` refuse for the same reason: the file on disk is
      // not what the person is looking at, so re-resolving it would show them
      // an answer about text they have already moved past. Their own save
      // fires this again.
      if (hasUnsavedEdits(this.models, path)) return;
      void this.products.reload();
    }, SETTLE_MS);
  }

  protected cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
