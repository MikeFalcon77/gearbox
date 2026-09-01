// The backend half: owns the engine process, forwards its notifications.
//
// Notifications are relayed rather than accumulated here. The frontend holds the
// catalogue state, because it is the frontend that renders it and a second copy
// on the backend would be a second thing to keep correct.
//
// One instance per frontend connection (see `gearbox-studio-backend-module.ts`),
// so a second window gets its own engine rather than stealing the first's.

import { ILogger } from "@theia/core/lib/common/logger";
import { inject, injectable } from "@theia/core/shared/inversify";
import * as fs from "fs";
import * as path from "path";

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { CatalogueDiagnostics } from "../common/generated/CatalogueDiagnostics";
import type { CatalogueLoadResult } from "../common/generated/CatalogueLoadResult";
import type { EditGearResult } from "../common/generated/EditGearResult";
import type { GenerateApplyResult } from "../common/generated/GenerateApplyResult";
import type { GenerateFileResult } from "../common/generated/GenerateFileResult";
import type { GeneratePlanResult } from "../common/generated/GeneratePlanResult";
import type { InitializeResult } from "../common/generated/InitializeResult";
import type { LockResult } from "../common/generated/LockResult";
import type { LogParams } from "../common/generated/LogParams";
import type { ProductLoadResult } from "../common/generated/ProductLoadResult";
import type { StudioSession } from "../common/protocol";
import type { ResolveResult } from "../common/generated/ResolveResult";
import type { ValidateResult } from "../common/generated/ValidateResult";
import type { ProgressParams } from "../common/generated/ProgressParams";
import { GearboxClient, GearboxService, ProductRef, method } from "../common/protocol";
import { EngineHandle, spawnEngine } from "./gearbox-engine-process";

/**
 * How long the engine gets to answer before the request is abandoned.
 *
 * A cap, not an expectation: the measured staged load of the 14-gear slice is
 * ~1.3s. The point is that a wedged engine -- a pathological parse, a hung
 * network filesystem -- becomes an error the panel can show and retry from,
 * rather than a spinner with no end. The load is generous because it is the one
 * call whose cost grows with the tree.
 */
const INITIALIZE_TIMEOUT_MS = 20_000;
const LOAD_TIMEOUT_MS = 120_000;
/**
 * And the same cap for the product methods.
 *
 * Between the two: a resolve reads the cached catalogue rather than rescanning
 * the tree, so it is nowhere near a load's cost, but it is not a constant-time
 * call either -- it evaluates a description, resolves a profile and may
 * serialize a lock. Generous enough that a real answer is never cut off, short
 * enough that the Resolve button stops spinning while someone still cares.
 */
const PRODUCT_TIMEOUT_MS = 60_000;

/**
 * The repository root, found by looking for the Cargo workspace manifest.
 *
 * Deliberately not a fixed number of `..` from `__dirname`: this file runs both
 * from `gearbox-studio/lib/node` under tsc and from `browser-app/lib/backend`
 * after webpack bundles it. Those happen to sit at the same depth today, so a
 * counted path works by coincidence -- and would break the moment either layout
 * moved. Searching for a marker cannot drift that way.
 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    const manifest = path.join(dir, "Cargo.toml");
    if (fs.existsSync(manifest) && fs.readFileSync(manifest, "utf8").includes("[workspace]")) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`no Cargo workspace above ${start}; set GEARBOX_ENGINE`);
    }
    dir = parent;
  }
}

/**
 * Where the engine binary and the roots come from for this prototype.
 *
 * Both are overridable by environment, and neither is read from preferences: the
 * slice exists to show the catalogue, and a preferences page is a separate piece
 * of work with its own failure modes. Stated here so it is a known simplification
 * and not a mystery.
 */
function enginePath(): string {
  const fromEnv = process.env.GEARBOX_ENGINE;
  if (fromEnv) {
    return fromEnv;
  }
  // `.exe` on Windows, because `spawn` does not add it and the failure is a
  // whole-IDE ENOENT for a binary that is sitting right there.
  const binary = process.platform === "win32" ? "gearbox.exe" : "gearbox";
  return path.join(findRepoRoot(__dirname), "target", "debug", binary);
}

function roots(): string[] {
  const fromEnv = process.env.GEARBOX_ROOT;
  if (fromEnv) {
    return [fromEnv];
  }
  return [path.resolve(findRepoRoot(__dirname), "..", "gears-rust")];
}

@injectable()
export class GearboxServiceImpl implements GearboxService {
  @inject(ILogger) protected readonly logger!: ILogger;

  protected client: GearboxClient | undefined;
  protected engine: EngineHandle | undefined;

  setClient(client: GearboxClient | undefined): void {
    this.client = client;
  }

  async initialize(session?: StudioSession): Promise<InitializeResult> {
    this.disposeEngine();
    // Empty `roots` means "use the defaults", not "open nothing". The frontend
    // reaches that after a reload, when `CatalogueStore.rootPaths()` is still
    // empty because the boot load has not installed `rootsById` yet; passing the
    // empty list through used to spawn an engine with no `--root`, and
    // `product/load` then answered `no source root is open`. The RPC side already
    // treats an empty `initialize.roots` as "keep the CLI defaults" -- match it.
    const roots_ =
      session === undefined || session.roots.length === 0 ? roots() : [...session.roots];
    const engine = spawnEngine(enginePath(), roots_, this.logger);
    this.engine = engine;

    engine.connection.onNotification(method.CATALOGUE_CHANGED, (event: CatalogueChanged) =>
      this.client?.onCatalogueChanged(event),
    );
    engine.connection.onNotification(
      method.CATALOGUE_DIAGNOSTICS,
      (event: CatalogueDiagnostics) => this.client?.onCatalogueDiagnostics(event),
    );
    engine.connection.onNotification(method.PROGRESS, (event: ProgressParams) =>
      this.client?.onProgress(event),
    );
    engine.connection.onNotification(method.LOG, (event: LogParams) =>
      this.client?.onLog(event.message),
    );

    // A child that dies on its own has to stop being this service's engine, or
    // the next `loadCatalogue` sends a request into a disposed connection and
    // reports "engine not initialized" for something that was.
    void engine.exited.then((reason) => {
      if (this.engine === engine) {
        this.engine = undefined;
      }
      this.client?.onLog(`engine ${reason}`);
      // And told as an event, not only as a log line. `loadCatalogue` answers at
      // the S1/S2 boundary, so an engine that dies during projection has no
      // outstanding request left to reject and the `$/progress done` that would
      // have ended the load died with it. Only the client knows whether a load
      // was live, so the decision is left there.
      this.client?.onEngineExit(reason);
    });

    const result = await engine.request<InitializeResult>(
      method.INITIALIZE,
      {
        roots: roots_,
        // Declared, because this client edits descriptions on a person's
        // instruction (`cpt-gearbox-fr-rpc-writes-opt-in`). The engine refuses
        // every mutating call until someone claims this, and claiming it is a
        // statement about the client, not about the engine.
        allow_writes: true,
        // And the boundary those writes may not leave. A product description
        // lives beside the products rather than inside a gear source root, so the
        // roots alone would refuse every legitimate edit.
        //
        // From the session when there is one. The fixed repository root is only a
        // default for the catalogue-only case: a product opened from elsewhere
        // would otherwise be readable and unwritable, which is the worst of both.
        workspace: session?.workspace ?? findRepoRoot(__dirname),
      },
      INITIALIZE_TIMEOUT_MS,
    );
    engine.connection.sendNotification(method.INITIALIZED, {});
    return result;
  }

  async loadCatalogue(): Promise<CatalogueLoadResult> {
    const engine = this.engine;
    if (!engine || engine.dead) {
      throw new Error("the engine is not running; reload the catalogue to start it");
    }
    return engine.request<CatalogueLoadResult>(method.CATALOGUE_LOAD, {}, LOAD_TIMEOUT_MS);
  }

  async workspaceRoots(): Promise<string[]> {
    const candidates = [findRepoRoot(__dirname), ...roots()];
    const seen = new Set<string>();
    return candidates
      .map((dir) => path.resolve(dir))
      .filter((dir) => {
        // Deduped and existence-checked: `GEARBOX_ROOT` can point at something
        // inside the repository, and a root that is not there would make Theia
        // open a workspace with a broken folder in it.
        if (seen.has(dir) || !fs.existsSync(dir)) return false;
        seen.add(dir);
        return true;
      });
  }

  /**
   * `products/<name>/product.gdl` under the repository root.
   *
   * One level deep and one fixed filename, deliberately: this is a picker, not a
   * discovery mechanism, and a recursive walk would make the client's idea of
   * "the products" differ from what anyone typed on a command line. A product
   * outside this layout is still resolvable -- open it in the editor.
   */
  async listProducts(): Promise<ProductRef[]> {
    const root = findRepoRoot(__dirname);
    const dir = path.join(root, "products");
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // No `products/` directory is an ordinary state, not a failure: a checkout
      // that has none simply has nothing to offer.
      return [];
    }
    return entries
      .map((name) => path.join(dir, name, "product.gdl"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort()
      .map((candidate) => ({ path: candidate, label: path.relative(root, candidate) }));
  }

  async loadProduct(path: string): Promise<ProductLoadResult> {
    return this.request(method.PRODUCT_LOAD, { path });
  }

  async resolve(path: string, profile?: string): Promise<ResolveResult> {
    return this.request(method.PRODUCT_RESOLVE, { path, profile });
  }

  async lock(path: string, profile?: string): Promise<LockResult> {
    return this.request(method.PRODUCT_LOCK, { path, profile });
  }

  async addGear(path: string, gear: string, source: string, dryRun: boolean): Promise<EditGearResult> {
    return this.request(method.PRODUCT_ADD_GEAR, {
      path,
      gear,
      source,
      dry_run: dryRun,
    });
  }

  async removeGear(path: string, gear: string, dryRun: boolean): Promise<EditGearResult> {
    return this.request(method.PRODUCT_REMOVE_GEAR, { path, gear, dry_run: dryRun });
  }

  async setConfig(
    path: string,
    gear: string,
    key: string,
    value: string | undefined,
    dryRun: boolean,
  ): Promise<EditGearResult> {
    return this.request(method.PRODUCT_SET_CONFIG, {
      path,
      gear,
      key,
      value,
      dry_run: dryRun,
    });
  }

  async setFeatures(
    path: string,
    gear: string,
    features: readonly string[],
    dryRun: boolean,
  ): Promise<EditGearResult> {
    return this.request(method.PRODUCT_SET_FEATURES, {
      path,
      gear,
      features: [...features],
      dry_run: dryRun,
    });
  }

  async addProfile(
    path: string,
    kind: string,
    id: string,
    fields: ReadonlyArray<{ name: string; value: string }>,
    dryRun: boolean,
  ): Promise<EditGearResult> {
    return this.request(method.PRODUCT_ADD_PROFILE, {
      path,
      kind,
      id,
      fields: [...fields],
      dry_run: dryRun,
    });
  }

  async removeProfile(path: string, id: string, dryRun: boolean): Promise<EditGearResult> {
    return this.request(method.PRODUCT_REMOVE_PROFILE, { path, id, dry_run: dryRun });
  }

  async setProfileField(
    path: string,
    id: string,
    field: string,
    value: string | undefined,
    dryRun: boolean,
  ): Promise<EditGearResult> {
    return this.request(method.PRODUCT_SET_PROFILE_FIELD, {
      path,
      id,
      field,
      value,
      dry_run: dryRun,
    });
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
    dryRun: boolean;
  }): Promise<EditGearResult> {
    return this.request(method.PRODUCT_CREATE, {
      path: params.path,
      id: params.id,
      name: params.name,
      version: params.version,
      sources: [...params.sources],
      profile_kind: params.profileKind,
      profile_id: params.profileId,
      clone_from: params.cloneFrom,
      dry_run: params.dryRun,
    });
  }

  async validate(product?: string): Promise<ValidateResult> {
    return this.request(method.VALIDATE, { product });
  }

  async planGenerate(path: string, profile?: string, out?: string): Promise<GeneratePlanResult> {
    return this.request(method.GENERATE_PLAN, { path, profile, out });
  }

  async applyGenerate(path: string, profile?: string, out?: string): Promise<GenerateApplyResult> {
    return this.request(method.GENERATE_APPLY, { path, profile, out });
  }

  async generateFile(
    path: string,
    file: string,
    profile?: string,
    out?: string,
  ): Promise<GenerateFileResult> {
    return this.request(method.GENERATE_FILE, { path, profile, out, file });
  }

  /**
   * One place that refuses when the engine is not up, and one that always
   * settles when it is.
   *
   * Through `EngineHandle.request` rather than `connection.sendRequest`, which
   * is the whole point: `sendRequest` on a wedged engine never settles, and a
   * promise that never settles crosses the Theia proxy as a Resolve button that
   * spins for the rest of the session with nothing to retry from and nothing in
   * the log. `initialize` and `catalogue/load` have had the death/timeout race
   * since the supervisor was written; these methods were reaching past it.
   */
  private async request<T>(method: string, params: unknown): Promise<T> {
    const engine = this.engine;
    if (!engine || engine.dead) {
      throw new Error(`cannot call ${method}: the engine is not initialized`);
    }
    return engine.request<T>(method, params, PRODUCT_TIMEOUT_MS);
  }

  dispose(): void {
    this.client = undefined;
    this.disposeEngine();
  }

  protected disposeEngine(): void {
    const engine = this.engine;
    this.engine = undefined;
    engine?.dispose();
  }
}
