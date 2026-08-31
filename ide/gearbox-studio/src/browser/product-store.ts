// The frontend's copy of one resolved product.
//
// Deliberately shaped like `CatalogueStore` and deliberately separate from it.
// The two objects of work do not subordinate one another (ADR 0011), and their
// lifecycles differ: the catalogue is loaded once and streams, a product is
// re-resolved every time the profile changes.
//
// The same two disciplines apply, both learned from the catalogue store:
//
//   - **A failure is a state, not an exception.** Callers are commands and
//     application contributions; a rejected promise from either becomes an
//     unhandled rejection in the console while the panel goes on claiming it is
//     still working.
//   - **Every resumption after an await is epoch-guarded.** Clicking through
//     three profiles starts three resolutions, and without the guard the slowest
//     one wins -- so the panel would show a profile the switch does not say.

import { Emitter, Event } from "@theia/core/lib/common/event";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";

import type { Diagnostic } from "../common/generated/Diagnostic";
import type { LockResult } from "../common/generated/LockResult";
import type { ProductIntent } from "../common/generated/ProductIntent";
import type { ResolveResult } from "../common/generated/ResolveResult";
import { GearboxService, ProductRef } from "../common/protocol";
import {
  isProductSelection,
  type ProductSelection,
  SelectionService,
} from "./shell/selection-service";

export type ProductStatus = "idle" | "loading" | "resolving" | "ready" | "error";

/**
 * What the panel renders.
 *
 * `resolution` and `error` are not exclusive on purpose: a product that resolved
 * *with* errors keeps its partial answer, because the resolver does not abort on
 * a diagnostic and the UI is supposed to show the graph beside the complaint.
 */
export interface ProductState {
  readonly status: ProductStatus;
  readonly products: readonly ProductRef[];
  readonly open: ProductRef | undefined;
  readonly intent: ProductIntent | undefined;
  /** Which profile is being shown. From the intent's default until switched. */
  readonly profile: string | undefined;
  readonly resolution: ResolveResult | undefined;
  /**
   * The canonical lock text, fetched only when something is going to show it.
   *
   * Cleared at the head of every resolution rather than refreshed: a lock from
   * the previous profile is worse than none, because it looks like an answer.
   */
  readonly lock: LockResult | undefined;
  /**
   * Why the lock could not be fetched, if it could not.
   *
   * Its own field rather than `error`, because the two are not the same failure.
   * `error` means the resolution is not to be trusted; this means one panel of
   * several has nothing to show. Sharing the field made a failed `lock` call
   * blank a resolution that had succeeded -- the graph, the diagnostics and the
   * profile all replaced by a red box -- because `ensureLock` runs from the Lock
   * widget's render, long after `resolve` returned.
   */
  readonly lockError: string | undefined;
  readonly diagnostics: readonly Diagnostic[];
  readonly error: string | undefined;
}

const EMPTY: ProductState = {
  status: "idle",
  products: [],
  open: undefined,
  intent: undefined,
  profile: undefined,
  resolution: undefined,
  lock: undefined,
  lockError: undefined,
  diagnostics: [],
  error: undefined,
};

/**
 * What the Inspector is currently answering "why" about.
 *
 * An alias rather than a second declaration: this used to be its own union here
 * while the catalogue held a row key, and one gear selected two ways was two
 * selections. `SelectionService` owns the value now; `Focus` is the name the
 * product side already used for it, kept so the tree and the markers did not have
 * to be rewritten to say the same thing.
 */
export type Focus = ProductSelection;

@injectable()
export class ProductStore {
  @inject(GearboxService) protected readonly service!: GearboxService;

  protected readonly onChangedEmitter = new Emitter<void>();
  readonly onChanged: Event<void> = this.onChangedEmitter.event;

  protected state: ProductState = EMPTY;
  protected epoch = 0;

  /** The discovery in flight, if one is. See `ensureDiscovered`. */
  protected discovering: Promise<void> | undefined;

  /**
   * The selection lives in `SelectionService`, not here.
   *
   * `focus` and `setFocus` are kept because the tree, the markers and the
   * Inspector all speak in them -- but they are a view onto one shared value now,
   * so a gear chosen in the catalogue is the same choice as the same gear chosen
   * in the product tree.
   */
  @inject(SelectionService) protected readonly selection!: SelectionService;
  /**
   * Guards the lazy lock fetch against the render that triggers it.
   *
   * The Lock widget asks on render, and the answer causes another render, so
   * without this the first paint would start a request per frame.
   */
  protected lockInFlight = false;

  @postConstruct()
  protected init(): void {
    this.selection.onDidChange(() => this.onChangedEmitter.fire());
  }

  get current(): ProductState {
    return this.state;
  }

  /**
   * Bumped every time the store starts a new piece of work.
   *
   * Exposed so a caller that computed something from the state can tell whether
   * that state is still the one on screen. `ProductEditService` needs exactly
   * this: it previews a write, waits for a person to agree, and must not write
   * against a preview computed from a product that has since been re-read,
   * re-resolved, switched to another profile or closed.
   *
   * The epoch is the right value rather than a new counter: it already changes on
   * precisely those events, because it is what abandons a resolution in flight.
   */
  get revision(): number {
    return this.epoch;
  }

  get focus(): Focus | undefined {
    const selection = this.selection.current;
    // A pending catalogue row is not something a resolution can be asked about:
    // it has no `GearId` until S2 has run, and the explanation graph is keyed by
    // id. So it reads as "nothing focused" here, and the Inspector says why.
    return isProductSelection(selection) ? selection : undefined;
  }

  setFocus(focus: Focus | undefined): void {
    this.selection.select(focus);
  }

  /**
   * Find the products worth offering, and open one if it is the only one.
   *
   * Opening the single candidate rather than asking: a picker with one entry is
   * a question with one answer, and the panel exists to show a resolution.
   */
  /**
   * Discover once, for callers that only want it to have happened.
   *
   * The Product widget is closable and transient, so its `postConstruct` runs
   * again on every reopen -- and `discover()` bumps the epoch, which abandons
   * whatever resolve was in flight and leaves the panel on `resolving` with a
   * resolution nobody will ever install. Reopening a panel is not a request to
   * throw away its contents.
   *
   * Not moved to an application `onStart` the way the catalogue load was: the
   * Product view opens on request, and discovering at startup would spend two
   * RPCs and open a product for a panel that may never be looked at.
   */
  async ensureDiscovered(): Promise<void> {
    // **One discovery at a time, and concurrent callers wait for the same one.**
    //
    // Not a nicety: `discover()` bumps the epoch, which is what abandons work in
    // flight, so a second discovery started while the first was in the air made
    // the first one's answer arrive too late to be installed. The Start screen
    // asking on every store change and the session's `ensureOpen` asking once
    // were exactly that pair -- and the symptom was a product that never resolved,
    // sixty seconds of `[data-resolved-profile]` never appearing, with nothing in
    // the console. The same non-reentrancy `ProductSessionService.open` has, and
    // for the same reason.
    const pending = this.discovering;
    if (pending !== undefined) {
      await pending;
      return;
    }

    // Nothing in flight to abandon, and nothing already found to discard.
    if (this.state.status === "loading" || this.state.status === "resolving") {
      return;
    }
    if (this.state.open !== undefined || this.state.products.length > 0) {
      return;
    }
    const started = this.discover();
    this.discovering = started;
    try {
      await started;
    } finally {
      if (this.discovering === started) {
        this.discovering = undefined;
      }
    }
  }

  async discover(): Promise<void> {
    const epoch = ++this.epoch;
    this.update({ status: "loading" });
    let products: ProductRef[];
    try {
      products = await this.service.listProducts();
    } catch (error) {
      this.fail(epoch, error);
      return;
    }
    if (epoch !== this.epoch) return;
    this.update({ status: "idle", products });
    // Listing only. Opening is `ProductSessionService`'s: it re-initializes the
    // engine with the product's own source roots and write boundary, and a store
    // that opened on its own would do it with whatever roots the last session
    // left. The "open it if it is the only one" convenience lives there too, so
    // there is one path in.
  }

  /** Evaluate a product and resolve it for its own default profile. */
  async open(ref: ProductRef): Promise<void> {
    const epoch = ++this.epoch;
    this.update({ status: "loading", open: ref, intent: undefined, resolution: undefined });
    try {
      const loaded = await this.service.loadProduct(ref.path);
      if (epoch !== this.epoch) return;
      this.update({
        intent: loaded.intent,
        // The product's own default, so the first thing shown comes from the
        // description rather than from a guess made here.
        profile: loaded.intent.default_profile,
        diagnostics: loaded.diagnostics ?? [],
      });
      await this.resolveCurrent(epoch);
    } catch (error) {
      this.fail(epoch, error);
    }
  }

  /** Show a different profile of the product already open. */
  async setProfile(profile: string): Promise<void> {
    if (this.state.open === undefined || profile === this.state.profile) return;
    const epoch = ++this.epoch;
    this.update({ profile, resolution: undefined });
    await this.resolveCurrent(epoch);
  }

  /**
   * Forget the open product and everything derived from it.
   *
   * All of it, not the reference alone: a resolution, a lock, diagnostics or a
   * selection surviving a close would render behind an empty panel and read as an
   * answer about a product nobody has open. `EMPTY` is the same value the store
   * starts at, so closing lands exactly where a fresh session does -- including
   * `products`, because the list is discovered per session and a session that has
   * ended has no list.
   *
   * The epoch is bumped first, which abandons any resolve in flight. Without that
   * a resolution begun before the close would call `update` afterwards and put the
   * product back.
   */
  clear(): void {
    this.epoch += 1;
    // State first, then the selection. `SelectionService.select` fires an event that
    // this store forwards as its own `onChanged`, so clearing the selection first
    // published a change while `state` still held the product being closed -- one
    // render of a panel about a product that was on its way out. Converges either
    // way; only one of the two orders never shows the intermediate.
    this.state = EMPTY;
    // The selection goes with the product: a gear still selected behind a closed
    // product would leave the Inspector explaining a resolution nobody has.
    this.selection.select(undefined);
    this.onChangedEmitter.fire();
  }

  async reload(): Promise<void> {
    const ref = this.state.open;
    if (ref === undefined) {
      await this.discover();
      return;
    }
    await this.open(ref);
  }

  /**
   * Resolve whatever is open, for whatever profile is selected.
   *
   * The profile is passed explicitly even when it equals the default. Omitting
   * it would also be correct -- the engine falls back to the description's own
   * default -- but then the request would not say which profile the answer is
   * for, and the panel's label and the lock's header could disagree without
   * anything noticing.
   */
  protected async resolveCurrent(epoch: number): Promise<void> {
    const ref = this.state.open;
    const profile = this.state.profile;
    if (ref === undefined || profile === undefined) return;
    this.update({ status: "resolving", lock: undefined, lockError: undefined });
    try {
      const resolution = await this.service.resolve(ref.path, profile);
      if (epoch !== this.epoch) return;
      this.update({
        status: "ready",
        resolution,
        diagnostics: resolution.diagnostics ?? [],
        error: undefined,
      });
    } catch (error) {
      this.fail(epoch, error);
    }
  }

  /**
   * Fetch the canonical lock text for what is on screen, once.
   *
   * Lazy because the lock costs a TOML serialization the other panels never
   * need, and idempotent because the widget that wants it asks on every render.
   */
  /**
   * Forget the lock and fetch it again.
   *
   * Narrower than a re-resolve on purpose: the resolution on screen is still the
   * answer, and only the comparison against disk can have gone stale. Re-solving
   * would also redraw four other panels for a file that changed outside them.
   */
  async refreshLock(): Promise<void> {
    this.update({ lock: undefined, lockError: undefined });
    await this.ensureLock();
  }

  async ensureLock(): Promise<void> {
    const ref = this.state.open;
    const profile = this.state.profile;
    if (
      this.lockInFlight ||
      this.state.lock !== undefined ||
      // Once per resolution, failure included. The Lock widget asks from its
      // render and a failure leaves `lock` undefined, so without this a lock the
      // engine refuses is re-requested on every frame for as long as the panel
      // is open.
      //
      // A resolve is no longer the only thing that can change the answer: the
      // result now carries a comparison against the lock **on disk**, and that
      // file changes when generation applies or when someone runs the CLI in a
      // terminal. `.gearbox/**` is deliberately excluded from Theia's file
      // watcher -- generated output is rewritten wholesale and watching it
      // reports churn nobody acts on -- so nothing notices on its own. Hence
      // `refreshLock`, called by the Generate view after an apply and by the
      // Lock view's own control.
      this.state.lockError !== undefined ||
      this.state.status !== "ready" ||
      ref === undefined ||
      profile === undefined
    ) {
      return;
    }
    this.lockInFlight = true;
    const epoch = this.epoch;
    try {
      const lock = await this.service.lock(ref.path, profile);
      if (epoch === this.epoch) {
        this.update({ lock, lockError: undefined });
      }
    } catch (error) {
      // Recorded against the lock, not against the product. See
      // `ProductState.lockError`: the resolution this lock belongs to succeeded,
      // and demoting it to `error` would throw away a correct answer over a
      // failed serialization.
      if (epoch === this.epoch) {
        this.update({ lockError: messageOf(error) });
      }
    } finally {
      this.lockInFlight = false;
    }
  }

  /**
   * Record a failure, keeping the diagnostics the engine attached to it.
   *
   * A refused `product/load` carries its reasons in `data.diagnostics`, and the
   * message alone ("product load failed") is useless without them -- which is
   * exactly why the engine was taught to attach them.
   */
  protected fail(epoch: number, error: unknown): void {
    if (epoch !== this.epoch) return;
    this.update({
      status: "error",
      error: messageOf(error),
      diagnostics: diagnosticsOf(error) ?? this.state.diagnostics,
    });
  }

  protected update(patch: Partial<ProductState>): void {
    this.state = { ...this.state, ...patch };
    this.onChangedEmitter.fire();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `data.diagnostics` a JSON-RPC error may carry, if it carried any. */
function diagnosticsOf(error: unknown): Diagnostic[] | undefined {
  const data = (error as { data?: unknown } | undefined)?.data;
  const list = (data as { diagnostics?: unknown } | undefined)?.diagnostics;
  return Array.isArray(list) ? (list as Diagnostic[]) : undefined;
}
