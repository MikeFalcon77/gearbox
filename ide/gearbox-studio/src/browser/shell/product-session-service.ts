// Opening a product, and everything that has to be true for it to be editable.
//
// A product is a directory and the unit of work, so opening one is not "point a
// panel at a file": it decides **where the engine looks and where it may write**.
// Until this existed the backend fixed both -- `../gears-rust` as the only source
// root, the repository as the write boundary -- which meant a product anywhere
// else could be read and then silently refused on every edit and every generate,
// because `writable_path` and `writable_out_root` both measure from the declared
// workspace.
//
// **The order is forced, and one step of it is not obvious.** Source roots come
// from the product's own `sources`, and reading those means evaluating the
// description, which needs a running engine. So the engine starts twice:
//
//   1. initialize with the product's directory as the workspace and no roots --
//      enough to evaluate a description, which `load_product` does without any
//      catalogue;
//   2. read `sources`, resolve each `path(at = ...)` against the description's
//      own directory, as the IR documents it;
//   3. initialize again with those roots, which respawns the engine;
//   4. load the catalogue, then load and resolve the product.
//
// Two spawns per open is the price of deriving roots from the thing being opened
// rather than from a constant. It is the same cost `Reload Catalogue` already
// pays, and the alternative -- a client that guesses the roots -- is what this
// replaces.
//
// `git(...)` sources are refused rather than skipped. Materialising a repository
// is not built, and a catalogue quietly missing a source is indistinguishable
// from a product whose gears do not exist.

import { StorageService } from "@theia/core/lib/browser/storage-service";
import { URI } from "@theia/core/lib/common/uri";
import { Emitter, Event } from "@theia/core/lib/common/event";
import { MessageService } from "@theia/core/lib/common/message-service";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { SourceDecl } from "../../common/generated/SourceDecl";
import { GearboxService, type ProductRef, type StudioSession } from "../../common/protocol";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { CatalogueStore } from "../catalogue-store";
import { ProductStore } from "../product-store";
import { GearSessionService } from "./gear-session-service";

/** Where the Recent list lives. Per browser profile, like any other Theia state. */
const RECENT_KEY = "gearbox.recentProducts";

/**
 * A remembered product, and when it was last opened.
 *
 * `openedAt` is optional because entries written before it existed have none,
 * and a Continue card that said "last opened just now" for a week-old entry
 * would be worse than one that says nothing.
 */
export interface RecentEntry extends ProductRef {
  readonly openedAt?: number;
}

/**
 * How many to keep.
 *
 * Short on purpose: a Recent list is a shortcut, and one that needs scrolling has
 * stopped being one. `Open Product` is the answer for anything older.
 */
const RECENT_LIMIT = 8;

@injectable()
export class ProductSessionService {
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;
  @inject(StorageService) protected readonly storage!: StorageService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(GearSessionService) protected readonly gears!: GearSessionService;

  /**
   * The open in flight, if any.
   *
   * **An open is not reentrant.** It respawns the engine twice, and two of them
   * interleaved leave the catalogue loading against one set of roots while the
   * product resolves against another -- which presents as a panel that never
   * finishes resolving. Several callers ask independently -- the Continue card,
   * the picker, `File > Open Product...`, a Recent entry -- so concurrent callers
   * wait for the same answer rather than starting a second sequence.
   */
  protected inFlight: Promise<boolean> | undefined;

  /**
   * Which product is being opened, while it is being opened.
   *
   * An open takes two engine spawns and a catalogue load -- measured at roughly
   * three seconds on this corpus -- and until this existed nothing on screen said
   * so. The shell's answer arrived only at the end, when `ProductStore` finally
   * had a product, so the person watched Home sit there and concluded the click
   * had missed. This is what lets the Product view open *first*, with the name of
   * the thing it is waiting for.
   */
  protected openingRef: ProductRef | undefined;

  protected readonly onDidChangeOpeningEmitter = new Emitter<ProductRef | undefined>();

  /** Fires when an open starts and when it finishes, successfully or not. */
  readonly onDidChangeOpening: Event<ProductRef | undefined> =
    this.onDidChangeOpeningEmitter.event;

  /** The product being opened right now, if any. */
  get opening(): ProductRef | undefined {
    return this.openingRef;
  }

  /**
   * The products opened before, most recent first.
   *
   * Read through, not cached: the list is short and a stale one is the whole
   * failure mode of a Recent menu.
   */
  async recent(): Promise<ProductRef[]> {
    return (await this.recentEntries()).map(({ path, label }) => ({ path, label }));
  }

  /** The same list, with the times the Continue card reads. */
  async recentEntries(): Promise<RecentEntry[]> {
    return (await this.storage.getData<RecentEntry[]>(RECENT_KEY)) ?? [];
  }

  /**
   * Open a remembered product, dropping the entry if it is gone.
   *
   * A Recent list is the one place where a path is expected to have rotted, and
   * the honest response is to say so and forget it -- not to open an empty panel
   * and leave the reader wondering. Checked by asking the engine to list what it
   * can find rather than by touching the filesystem, which the frontend cannot do.
   */
  async openRecent(ref: ProductRef): Promise<boolean> {
    if (await this.open(ref)) return true;
    await this.forget(ref);
    this.messages.warn(`${ref.label} could not be opened, so it was removed from Recent.`);
    return false;
  }

  /**
   * Remember a product that opened.
   *
   * **Only after a successful open**, which is the difference between a Recent
   * list and a list of things once attempted. Canonicalised on the path the
   * engine reported, so the same product reached two ways is one entry.
   */
  protected async remember(ref: ProductRef): Promise<void> {
    const kept = (await this.recentEntries()).filter((entry) => entry.path !== ref.path);
    kept.unshift({ ...ref, openedAt: Date.now() });
    await this.storage.setData(RECENT_KEY, kept.slice(0, RECENT_LIMIT));
  }

  protected async forget(ref: ProductRef): Promise<void> {
    const kept = (await this.recentEntries()).filter((entry) => entry.path !== ref.path);
    await this.storage.setData(RECENT_KEY, kept);
  }

  /**
   * Close the open product, unless doing so would lose an edit.
   *
   * **Refuses rather than asking.** `ProductEditService` already takes this
   * position for a write -- it will not touch a description with unsaved changes,
   * and it will not save on the author's behalf either, because that commits an
   * edit they had not finished. Closing is the same shape of decision, so it gets
   * the same answer until there is a reason for a three-way dialog. The full
   * Save / Close without saving / Cancel set is a later choice, not a missing one.
   *
   * Returns whether it closed.
   */
  async close(): Promise<boolean> {
    const open = this.products.current.open;
    if (open === undefined) return true;

    if (this.isDirty(open.path)) {
      this.messages.error(
        `${open.label} has unsaved changes. Save or revert them before closing -- ` +
          `closing now would leave an edit nobody asked to discard.`,
      );
      return false;
    }

    // Everything the product was, not just the reference. A stale resolution
    // behind a closed product is worse than an empty panel: it looks like an
    // answer. `ProductStore.clear` drops the resolution, the diagnostics, the
    // lock, the selection and the profile together.
    this.products.clear();
    return true;
  }

  /**
   * Whether the description is open in an editor with unsaved changes.
   *
   * By URI rather than by path string, because a model's URI is normalised and a
   * path is not: `/a/./b` and `/a/b` are the same file and different strings.
   */
  protected isDirty(path: string): boolean {
    const wanted = URI.fromFilePath(path).toString();
    return this.models.models.some((model) => model.uri === wanted && model.dirty);
  }

  // `ensureOpen()` used to live here: "one product is a question with one answer,
  // so it opens". It was called from `ProductWidget`'s constructor, which made it
  // a rule about *widget construction* rather than about intent -- a reload, or a
  // restored layout naming the Product view, opened a product nobody had asked
  // for, and the Home screen could not be reached with a product in the
  // workspace. Discovery still happens (`ProductStore.ensureDiscovered`); acting
  // on it is the Start screen's Continue card and the picker.

  /**
   * The write boundary for a product: the workspace folder that contains it.
   *
   * **Not the product's own directory**, and the difference is a generated tree in
   * the wrong place. The engine derives its output root from the workspace, so a
   * workspace of `products/payments-demo` put the generated crates in
   * `products/payments-demo/.gearbox/payments-demo/dev` -- inside the descriptions
   * folder, and *not* the tree the CLI writes when it is run from the repository
   * root. One product, two trees, which is exactly the divergence removed when
   * Studio stopped generating into a tree of its own (plan 9.1).
   *
   * The containing workspace folder is the honest boundary: it contains the
   * description, so an edit is inside it; it is the root the CLI would be run
   * from, so both write the same `.gearbox/<product>/<profile>`; and it is what
   * the person opened, so it is a boundary they chose rather than one derived.
   *
   * The longest containing root wins, because Theia allows several and they may
   * nest. A product outside every root falls back to its own directory -- a
   * narrower boundary than the person expects is safe, and refusing to open it
   * would be worse.
   */
  protected workspaceFor(path: string, directory: string): string {
    const containing = this.workspace
      .tryGetRoots()
      .map((stat) => stat.resource.path.fsPath())
      .filter((root) => path.startsWith(`${root}/`))
      .sort((a, b) => b.length - a.length);
    return containing[0] ?? directory;
  }

  /**
   * Open `ref` as the session's product.
   *
   * Returns whether it opened. A refusal is reported to the person rather than
   * thrown: every reason is something they can act on -- a description that does
   * not evaluate, a `git(...)` source, no local sources at all.
   */
  async open(ref: ProductRef): Promise<boolean> {
    const pending = this.inFlight;
    if (pending !== undefined) return pending;
    const started = this.doOpen(ref);
    this.inFlight = started;
    this.openingRef = ref;
    this.onDidChangeOpeningEmitter.fire(ref);
    try {
      return await started;
    } finally {
      if (this.inFlight === started) {
        this.inFlight = undefined;
        this.openingRef = undefined;
        this.onDidChangeOpeningEmitter.fire(undefined);
      }
    }
  }

  protected async doOpen(ref: ProductRef): Promise<boolean> {
    const directory = parentOf(ref.path);
    const workspace = this.workspaceFor(ref.path, directory);

    if (this.gears.current !== undefined) {
      await this.gears.close();
    }

    // Step 1: an engine whose workspace is the product's, so a later edit is
    // inside the write boundary before anything reads the description.
    //
    // **Keeping the roots already open, not asking for none.** Passing `roots: []`
    // on purpose used to leave an engine that refused `product/load` with
    // `no source root is open` (measured). Whatever is open now is the right set
    // to carry: at boot it is the backend's defaults, and after a previous product
    // it is that product's -- either way a description can be evaluated, and step
    // 4 replaces them with the ones this product actually declares.
    //
    // After a page reload `rootPaths()` can still be empty while the boot catalogue
    // load has not finished. `initialize` treats that empty list as "use defaults"
    // rather than "open nothing", so this step stays safe in that window.
    await this.catalogue.load({ roots: this.catalogue.rootPaths(), workspace });

    // Step 2: read what the description declares. `loadProduct` is evaluation
    // only -- nothing is joined against the catalogue -- which is exactly why it
    // works with no roots declared yet.
    let intent;
    try {
      intent = (await this.service.loadProduct(ref.path)).intent;
    } catch (error) {
      this.messages.error(
        `${ref.label} could not be evaluated, so it cannot be opened: ${messageOf(error)}`,
      );
      return false;
    }

    const roots: string[] = [];
    const refused: string[] = [];
    // Typed explicitly: `sources` is a mapped type keyed by `SourceId`, and
    // `Object.entries` widens its values to `unknown`.
    const declared = Object.entries(intent.sources ?? {}) as [string, SourceDecl][];
    for (const [id, source] of declared) {
      if (source.kind === "path") {
        roots.push(resolveFrom(directory, source.at));
      } else {
        refused.push(id);
      }
    }

    if (refused.length > 0) {
      // Named, not counted: which source cannot be reached is the actionable part.
      this.messages.error(
        `${ref.label} declares ${refused.join(", ")} as a git source, and fetching one is not ` +
          `built yet. Point it at a local path, or open a product that does.`,
      );
      return false;
    }
    if (roots.length === 0) {
      this.messages.error(`${ref.label} declares no source roots, so there are no gears to compose.`);
      return false;
    }

    // Step 3 and 4: the real session, then the catalogue and the product.
    const session: StudioSession = { roots, workspace };
    await this.catalogue.load(session);
    await this.products.open(ref);
    const opened = this.products.current.open !== undefined;
    if (opened) {
      await this.remember(ref);
    }
    return opened;
  }
}

/** The directory a `product.gdl` sits in. */
function parentOf(file: string): string {
  const at = file.lastIndexOf("/");
  return at <= 0 ? "/" : file.slice(0, at);
}

/**
 * `at` resolved against the description's directory.
 *
 * Hand-rolled because the browser has no `path`: the inputs are a POSIX absolute
 * directory and a relative path out of a `.gdl`, which is the only case this has
 * to be right for. `..` is honoured because that is how every real product points
 * at a sibling checkout -- `path("../../../gears-rust")` in the demo.
 */
function resolveFrom(directory: string, at: string): string {
  if (at.startsWith("/")) return at;
  const parts = directory.split("/").filter((p) => p.length > 0);
  for (const segment of at.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
