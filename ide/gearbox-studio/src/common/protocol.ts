// The service the frontend talks to, and the callback it registers.
//
// Types crossing the wire come from `generated/`, written by
// `cargo test -p gearbox-rpc --test export_bindings`. Nothing here restates a
// field: a transcribed wire format diverges, and diverges silently
// (cpt-gearbox-nfr-no-type-drift).

import type { CatalogueChanged } from "./generated/CatalogueChanged";
import type { CatalogueDiagnostics } from "./generated/CatalogueDiagnostics";
import type { CatalogueLoadResult } from "./generated/CatalogueLoadResult";
import type { ProductLoadResult } from "./generated/ProductLoadResult";
import type { ResolveResult } from "./generated/ResolveResult";
import type { ValidateResult } from "./generated/ValidateResult";
import type { Diagnostic } from "./generated/Diagnostic";
import type { FailedRoot } from "./generated/FailedRoot";
import type { GearDescriptor } from "./generated/GearDescriptor";
import type { InitializeResult } from "./generated/InitializeResult";
import type { PendingGear } from "./generated/PendingGear";
import type { ProgressParams } from "./generated/ProgressParams";

export const GEARBOX_SERVICE_PATH = "/services/gearbox";

/**
 * The engine's JSON-RPC method names, in one place.
 *
 * ts-rs exports types, not constants, so these cannot be generated from
 * `gearbox_rpc::protocol::method` the way the payloads are. One table is the
 * next best thing: a rename then breaks in one place rather than in whichever
 * `sendRequest("...")` string was missed, which compiles and fails at runtime.
 * **Keep in sync with `crates/gearbox-rpc/src/protocol.rs`.**
 */
export const method = {
  INITIALIZE: "initialize",
  INITIALIZED: "initialized",
  CATALOGUE_LOAD: "gearbox/catalogue/load",
  CATALOGUE_CHANGED: "gearbox/catalogueChanged",
  CATALOGUE_DIAGNOSTICS: "gearbox/catalogueDiagnostics",
  PROGRESS: "$/progress",
  LOG: "gearbox/log",
} as const;

/**
 * A product description the client offered to open.
 *
 * A client-side convenience, not part of the engine's contract: the engine only
 * ever receives an explicit absolute path. Discovery lives here for the same
 * reason `InitializeResult.roots` does -- where the repository is on this
 * machine is the one thing only the server knows -- and for the reason an IDE
 * lists sketches rather than making a person type a path.
 */
export interface ProductRef {
  /** Absolute path, which is what `loadProduct` and `resolve` take. */
  readonly path: string;
  /** Relative to the repository root, which is what a person recognises. */
  readonly label: string;
}

export const GearboxService = Symbol("GearboxService");
export interface GearboxService {
  /** Start the engine and hand back what it can do. */
  initialize(): Promise<InitializeResult>;

  /**
   * Begin a staged load. Resolves at the boundary between the two passes: the
   * whole tree by name, none of it projected. Projections arrive on the client
   * callback.
   */
  loadCatalogue(): Promise<CatalogueLoadResult>;

  /**
   * The product descriptions under the repository root.
   *
   * Does not touch the engine: this is the Theia backend answering "what could I
   * open", so it works before `initialize` and does not fail when the engine is
   * down.
   */
  listProducts(): Promise<ProductRef[]>;

  /** Evaluate a `product.gdl`. Evaluation only; nothing is joined against the
   * catalogue. */
  loadProduct(path: string): Promise<ProductLoadResult>;

  /**
   * Resolve a product for one profile.
   *
   * `profile` omitted uses the product's own default, so the answer still comes
   * from the description rather than from a guess made in the client.
   */
  resolve(path: string, profile?: string): Promise<ResolveResult>;

  /** Everything checkable without resolving. `product` omitted checks only the
   * catalogue. */
  validate(product?: string): Promise<ValidateResult>;

  dispose(): void;
  setClient(client: GearboxClient | undefined): void;
}

export const GearboxClient = Symbol("GearboxClient");
export interface GearboxClient {
  onCatalogueChanged(event: CatalogueChanged): void;
  /** Diagnostics the second pass produced, after the load response went out. */
  onCatalogueDiagnostics(event: CatalogueDiagnostics): void;
  onProgress(event: ProgressParams): void;
  onLog(message: string): void;
}

/**
 * One row of the catalogue tree.
 *
 * A row is pending or projected, and the union is what keeps the two apart at
 * every use site: there is no way to read `runtime_caps` off a pending row,
 * because a pending row has no such field. That is the same reason the engine
 * keeps unprojected gears in a separate list rather than as a state on
 * `GearDescriptor` (ADR cpt-gearbox-adr-staged-catalogue-loading).
 */
export type Row =
  | { readonly kind: "pending"; readonly gear: PendingGear }
  | { readonly kind: "projected"; readonly gear: GearDescriptor };

/**
 * What a row is keyed by, and it is never the id.
 *
 * Both variants carry `source` and `gdl_path` precisely so this function does
 * not have to branch: the key has to survive the pending-to-projected
 * transition, and an id cannot, because it does not exist until S2 has run.
 *
 * `source` is part of the key because `gdl_path` alone is not unique. It is
 * relative to *one* source root, and the engine accepts several -- two roots
 * with the same layout both hold `foo/gear.gdl`, and keying on the path alone
 * collapses them into one row that the second projection then overwrites.
 */
export function rowKey(row: Row): string {
  return keyFor(row.gear.source, row.gear.gdl_path);
}

/** The row key for a `(source, gdl_path)` pair, as the notification sends it. */
export function keyFor(source: string, gdlPath: string): string {
  return `${source}:${gdlPath}`;
}

export function rowName(row: Row): string {
  return row.kind === "pending"
    ? (row.gear.display_name ?? row.gear.gdl_path)
    : row.gear.display_name;
}

export function rowCategory(row: Row): string {
  return row.gear.category ?? "uncategorised";
}

/**
 * Where a load has got to.
 *
 * A discriminant rather than a `loading: boolean`, because the boolean could
 * not say "the load failed": a rejected `load()` left it stuck at `true`, and
 * the empty state is gated on it, so a missing engine rendered as an eternal
 * `0 gear(s) projecting 0/0` with no error anywhere.
 */
export type CatalogueStatus = "idle" | "loading" | "ready" | "error";

export interface CatalogueState {
  readonly status: CatalogueStatus;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly Diagnostic[];
  /** Roots `initialize` was asked for and could not open. */
  readonly failedRoots: readonly FailedRoot[];
  /** Set only when `status === "error"`. */
  readonly error: string | undefined;
  readonly total: number;
  readonly completed: number;
}
