// The service the frontend talks to, and the callback it registers.
//
// Types crossing the wire come from `generated/`, written by
// `cargo test -p gearbox-rpc --test export_bindings`. Nothing here restates a
// field: a transcribed wire format diverges, and diverges silently
// (cpt-gearbox-nfr-no-type-drift).

import type { CatalogueChanged } from "./generated/CatalogueChanged";
import type { CatalogueLoadResult } from "./generated/CatalogueLoadResult";
import type { Diagnostic } from "./generated/Diagnostic";
import type { GearDescriptor } from "./generated/GearDescriptor";
import type { InitializeResult } from "./generated/InitializeResult";
import type { PendingGear } from "./generated/PendingGear";
import type { ProgressParams } from "./generated/ProgressParams";

export const GEARBOX_SERVICE_PATH = "/services/gearbox";

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

  dispose(): void;
  setClient(client: GearboxClient | undefined): void;
}

export const GearboxClient = Symbol("GearboxClient");
export interface GearboxClient {
  onCatalogueChanged(event: CatalogueChanged): void;
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
 * Both variants carry `gdl_path` precisely so this function does not have to
 * branch: the key has to survive the pending-to-projected transition, and an id
 * cannot, because it does not exist until S2 has run.
 */
export function rowKey(row: Row): string {
  return row.gear.gdl_path;
}

export function rowName(row: Row): string {
  return row.kind === "pending"
    ? (row.gear.display_name ?? row.gear.gdl_path)
    : row.gear.display_name;
}

export function rowCategory(row: Row): string {
  const category = row.kind === "pending" ? row.gear.category : row.gear.category;
  return category ?? "uncategorised";
}

export interface CatalogueState {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly Diagnostic[];
  readonly total: number;
  readonly completed: number;
  readonly loading: boolean;
}
