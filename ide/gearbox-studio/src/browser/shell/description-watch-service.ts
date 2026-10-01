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
// **`gear.gdl` is watched too, and the reason it was not is worth recording,
// because it was half wrong.** This file used to say the source roots "are not
// watched at all" and that picking up a gear edit meant respawning the engine.
// Neither holds:
//
//   * `gears-rust` *is* a Theia workspace root -- `workspaceRoots()` answers
//     with the repository plus the source roots, and `DomainWorkspace` opens
//     all of them, because the two repositories are siblings and no single
//     folder contains both. `gear.gdl` sits outside every
//     `files.watcherExclude` entry, so those events were already arriving and
//     nothing had subscribed. The missing piece was a subscriber.
//
//   * The respawn was a habit of the client, not a rule of the protocol.
//     `gearbox/catalogue/load` re-runs the staged load and replaces the
//     server's cached catalogue on the process already running;
//     `CatalogueStore.load` merely always called `initialize` first, and it is
//     `initialize` that kills the child. `CatalogueStore.refresh` is the same
//     read without that, and it is what this uses.
//
// What *was* right is the cost. A refresh is a full staged rescan -- there is
// no smaller unit, because the duplicate-id rule depends on discovery order,
// contract merging is last-owner-wins across gears, and a root's digest is a
// hash over every description in it. Measured at ~0.7s on the fourteen-gear
// slice and roughly ten times that on a full registry, on the engine's request
// thread. Hence a longer settle here than for a product, and the dirty-buffer
// gate below.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { Disposable, DisposableCollection } from "@theia/core/lib/common/disposable";
import { URI } from "@theia/core/lib/common/uri";
import { FileChangesEvent } from "@theia/filesystem/lib/common/files";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
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

/**
 * The same wait for a gear description, but longer.
 *
 * What sits behind it is a rescan of every source root rather than a resolve of
 * one file, so folding a burst matters more: saving four gears in a batch, or a
 * formatter rewriting a directory, should cost one read and not four. Still
 * short enough that a person who saved and looked up has not started wondering.
 */
const GEAR_SETTLE_MS = 700;

/** The one filename a gear declares itself in. */
const GEAR_DESCRIPTION = "gear.gdl";

/** Windows separators folded, so one path has one spelling to compare. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "");
}

@injectable()
export class DescriptionWatchService implements FrontendApplicationContribution {
  @inject(FileService) protected readonly files!: FileService;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;

  protected readonly toDispose = new DisposableCollection();
  protected timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * A second timer, not a shared one.
   *
   * The two subjects settle at different rates and cost different amounts, and
   * one timer would let a product save cancel a pending gear read -- which is
   * exactly the pair of events an Add Gear that writes both produces.
   */
  protected gearTimer: ReturnType<typeof setTimeout> | undefined;
  protected pendingGears = new Set<string>();

  onStart(): void {
    this.toDispose.push(
      this.files.onDidFilesChange((event) => {
        const open = this.products.current.open;
        if (open !== undefined && event.contains(URI.fromFilePath(open.path))) {
          this.schedule(open.path);
        }
        // **Not gated on an open product.** The Catalogue and the Inspector
        // render with none, and a gear's declared facts are exactly what they
        // show, so a gear edit has to be picked up whether or not a product is
        // being worked on.
        for (const path of this.changedGearDescriptions(event)) {
          this.scheduleGear(path);
        }
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
    // The product timer only. Cancelling both here is the mistake the two
    // timers exist to avoid: an Add Gear writes a description and a gear file
    // in one act, and a product save that wiped the pending gear read would
    // drop the half of the change the catalogue owns.
    this.cancelProduct();
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
      // **Nor while a draft is queued, which is the rule the gear path below
      // already states.** The two paths disagreed, and the product one was
      // wrong: `ProductStore.reload` bumps the store's revision, and
      // `ProductEditService` refuses a write whose preview was computed against
      // an older one. So a second Apply started within the settle window of the
      // first was refused with "the product changed while the preview was open"
      // -- when the only thing that had changed was that the application
      // re-read its own write. Measured: two runs in three, from a claim that
      // queues an edit during a write and then applies it.
      //
      // Nothing is lost by waiting. A write re-reads the product itself when it
      // lands, so the change that woke this watcher is already on screen; and
      // applying or discarding the draft re-resolves anyway. An edit made in the
      // editor while a draft is open waits for the same moment, which is the
      // trade-off the gear path took for the same reason.
      if (this.edits.hasDraft(path)) return;
      void this.products.reload();
    }, SETTLE_MS);
  }

  protected cancelProduct(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Both timers, for shutdown. */
  protected cancel(): void {
    this.cancelProduct();
    if (this.gearTimer !== undefined) clearTimeout(this.gearTimer);
    this.gearTimer = undefined;
    this.pendingGears.clear();
  }

  /**
   * The `gear.gdl` paths this event touched that belong to the open catalogue.
   *
   * Filtered by source root rather than by filename alone. Theia watches every
   * workspace folder, and a `gear.gdl` under one the engine does not have open
   * is not in the catalogue, so re-reading for it would be a rescan that
   * changes nothing. A *new* file under a known root does count -- that is a
   * gear being scaffolded, and it is the same staleness with a different cause.
   */
  protected changedGearDescriptions(event: FileChangesEvent): string[] {
    const roots = this.catalogue.rootPaths().map(normalize);
    if (roots.length === 0) return [];
    const hits = new Set<string>();
    for (const change of event.changes) {
      const path = normalize(change.resource.path.fsPath());
      if (!path.endsWith(`/${GEAR_DESCRIPTION}`)) continue;
      if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) continue;
      hits.add(path);
    }
    return [...hits];
  }

  /**
   * Re-read the catalogue once the writes have stopped.
   *
   * The paths are accumulated rather than replaced: a burst touching several
   * gears is one rescan, and every one of them has to clear the dirty-buffer
   * gate before it runs -- a formatter mid-write on any of them means the read
   * would be about text nobody is looking at yet.
   */
  protected scheduleGear(path: string): void {
    this.pendingGears.add(path);
    if (this.gearTimer !== undefined) clearTimeout(this.gearTimer);
    this.gearTimer = setTimeout(() => {
      this.gearTimer = undefined;
      const paths = [...this.pendingGears];
      this.pendingGears.clear();
      if (paths.some((p) => hasUnsavedEdits(this.models, p))) return;
      void this.refresh();
    }, GEAR_SETTLE_MS);
  }

  /**
   * The catalogue first, then the product that was resolved against it.
   *
   * Both, and in that order. `ProductStore.reload` re-runs `product/load` and
   * `product/resolve` against the engine's *cached* catalogue -- it never
   * reloads one -- so a refresh alone would leave the Catalogue and the
   * Inspector showing the new facts while the Product tree, the Lock, Conflicts
   * and the Problems markers still answered from the old ones. Two surfaces
   * disagreeing about the same file is worse than both being stale.
   */
  protected async refresh(): Promise<void> {
    // Swallowed, because the only caller is `void`-ed off a timer and a
    // rejection there is an unhandled one in the console -- which
    // `regression.spec.ts` fails on, and rightly. `CatalogueStore.refresh`
    // already reports its own failures as state; `ProductStore.reload` is the
    // one that can throw, and a description that no longer resolves is the
    // ordinary way for it to happen. The Problems view is where that belongs,
    // not a red banner from a background read nobody asked for.
    try {
      await this.catalogue.refresh();
      // **Not while a draft is open, and this is the same rule as the buffer
      // gate, one level up.** A draft is config and profile edits the person
      // has queued and not applied; `ProductStore.reload` re-opens the product
      // from disk and the widgets rebuild from the store, so a reload landing
      // mid-compose discards them. Creating a gear while editing config is
      // exactly that pair of events -- Create Gear writes a `gear.gdl`, this
      // watcher wakes, and the draft would vanish while its owner was typing.
      // A conformance claim caught it doing precisely that.
      //
      // The catalogue is still refreshed above: the new gear belongs in it, and
      // nothing about a draft makes that untrue. Only the re-resolve waits, and
      // applying or discarding the draft re-resolves anyway.
      if (this.products.current.open !== undefined && !this.edits.hasDraft()) {
        await this.products.reload();
      }
    } catch {
      // Left to the stores: both record failures where the panels can show them.
    }
  }
}
