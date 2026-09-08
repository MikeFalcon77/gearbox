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

import { GearboxService, type ProductRef, type StudioSession } from "../../common/protocol";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { CatalogueStore } from "../catalogue-store";
import {
  catalogueUsable,
  openedSuccessfully,
  sourceRootsOf,
  sourcesUsable,
  type OpeningStage,
} from "./opening-outcome";
import { ProductStore } from "../product-store";
import { GearSessionService } from "./gear-session-service";

// The steps and their words live in `opening-outcome.ts`, beside the decisions
// that attribute a failure to one of them. Re-exported because the Product view
// reads them and this is the service it already imports.
export {
  OPENING_LABEL,
  OPENING_STAGES,
  type OpeningStage,
} from "./opening-outcome";

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
 * Whether an open is running, and how far it got.
 *
 * **A discriminated union rather than a stage beside a boolean**, because the
 * two can disagree and did: a bare `openingRef` said only *that* something was
 * happening, so a refusal cleared it and left the panel with nothing to show but
 * the picker again -- the message went to a toast and the screen forgot which
 * step had failed. `failed` keeps both the step and the reason, which is what a
 * person needs in order to try the right thing next.
 */
export type OpeningState =
  | { readonly status: "idle" }
  | { readonly status: "opening"; readonly stage: OpeningStage; readonly product: ProductRef }
  | {
      readonly status: "failed";
      readonly stage: OpeningStage;
      readonly product: ProductRef;
      readonly reason: string;
    };

const IDLE: OpeningState = { status: "idle" };

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
  protected openingState: OpeningState = IDLE;

  protected readonly onDidChangeOpeningEmitter = new Emitter<OpeningState>();

  /** Fires when an open starts, changes step, succeeds, or refuses. */
  readonly onDidChangeOpening: Event<OpeningState> = this.onDidChangeOpeningEmitter.event;

  /** How far the open in flight has got, or why the last one stopped. */
  get openingProgress(): OpeningState {
    return this.openingState;
  }

  /**
   * The product being opened right now, if any.
   *
   * Kept as the narrow question, because that is what the Product view's "may I
   * be on screen" test asks -- and a failed open must answer `undefined` there:
   * the panel should show what went wrong, not go on waiting.
   */
  get opening(): ProductRef | undefined {
    return this.openingState.status === "opening" ? this.openingState.product : undefined;
  }

  /**
   * End the open, unless it refused.
   *
   * **A refusal is left standing**: clearing it would put the panel back to a
   * picker a beat after saying what went wrong, which is how the reason used to
   * survive only as a toast.
   *
   * A method rather than three lines in `open`'s `finally`, because
   * `doOpen` mutates this field and the compiler cannot see that from there --
   * it narrows the field to the value `open` assigned and then reports the
   * `failed` test as unreachable. Reading it where nothing has narrowed it is
   * the honest fix; a cast would have silenced the same question.
   */
  protected settleOpening(): void {
    if (this.openingState.status === "failed") return;
    this.openingState = IDLE;
    this.onDidChangeOpeningEmitter.fire(this.openingState);
  }

  /**
   * Forget a refusal, so the previous subject owns the screen again.
   *
   * Needed because a failure is deliberately left standing: with product A open
   * and B refused at `describe`, the store still holds A while the panel shows
   * B's failure, and without this there is no way back to A short of opening it
   * again. Nothing to do when an open is in flight -- that is not a state a
   * person can dismiss.
   */
  dismissOpening(): void {
    if (this.openingState.status !== "failed") return;
    this.openingState = IDLE;
    this.onDidChangeOpeningEmitter.fire(this.openingState);
  }

  /** Move to the next step of the open in flight. Ignored once it has ended. */
  protected enterStage(stage: OpeningStage): void {
    if (this.openingState.status !== "opening") return;
    this.openingState = { status: "opening", stage, product: this.openingState.product };
    this.onDidChangeOpeningEmitter.fire(this.openingState);
  }

  /**
   * Stop the open at the step that refused, and say why.
   *
   * The message still goes to the message service -- a refusal a person did not
   * see is a refusal that looks like a hang -- and it also stays here, so the
   * panel that was showing the steps can show which one stopped instead of
   * reverting to a picker as though nothing had been attempted.
   */
  protected failStage(stage: OpeningStage, reason: string): false {
    if (this.openingState.status === "opening") {
      this.openingState = { status: "failed", stage, product: this.openingState.product, reason };
      this.onDidChangeOpeningEmitter.fire(this.openingState);
    }
    this.messages.error(reason);
    return false;
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
    this.openingState = { status: "opening", stage: "workspace", product: ref };
    this.onDidChangeOpeningEmitter.fire(this.openingState);
    const started = this.doOpen(ref);
    this.inFlight = started;
    try {
      return await started;
    } finally {
      if (this.inFlight === started) {
        this.inFlight = undefined;
        this.settleOpening();
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
    // **`load` does not reject, and that is the whole reason this line exists.**
    // `CatalogueStore.load` records a failure as `status: "error"` on its own
    // state -- the panel renders it -- and returns normally. So awaiting it and
    // carrying on attributed an engine that would not start to whichever step
    // failed next: `describe` here, `resolve` after the second load.
    const spawned = catalogueUsable(
      this.catalogue.current,
      `The engine could not be started on ${ref.label}'s folder`,
    );
    if (!spawned.ok) return this.failStage("workspace", spawned.reason);

    // Step 2: read what the description declares. `loadProduct` is evaluation
    // only -- nothing is joined against the catalogue -- which is exactly why it
    // works with no roots declared yet.
    this.enterStage("describe");
    let intent;
    try {
      intent = (await this.service.loadProduct(ref.path)).intent;
    } catch (error) {
      return this.failStage(
        "describe",
        `${ref.label} could not be evaluated, so it cannot be opened: ${messageOf(error)}`,
      );
    }

    const sources = sourceRootsOf(intent, (at) => resolveFrom(directory, at));
    const usable = sourcesUsable(ref.label, sources);
    if (!usable.ok) return this.failStage("describe", usable.reason);
    const roots = [...sources.roots];

    // Step 3 and 4: the real session, then the catalogue and the product.
    this.enterStage("catalogue");
    const session: StudioSession = { roots, workspace };
    await this.catalogue.load(session);
    const loaded = catalogueUsable(
      this.catalogue.current,
      `${ref.label}'s gears could not be loaded from ${roots.join(", ")}`,
    );
    if (!loaded.ok) return this.failStage("catalogue", loaded.reason);

    this.enterStage("resolve");
    await this.products.open(ref);
    const resolved = openedSuccessfully(ref, this.products.current);
    if (resolved.ok) {
      await this.remember(ref);
      return true;
    }
    // The store also renders its own error, and that is the surface a person
    // should end up on: this stops the open and says why, and the panel shows
    // the product with its error rather than four steps still in progress.
    return this.failStage("resolve", resolved.reason);
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
