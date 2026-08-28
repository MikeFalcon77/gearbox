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
import type { InitializeResult } from "../common/generated/InitializeResult";
import type { LogParams } from "../common/generated/LogParams";
import type { ProductLoadResult } from "../common/generated/ProductLoadResult";
import type { ResolveResult } from "../common/generated/ResolveResult";
import type { ValidateResult } from "../common/generated/ValidateResult";
import type { ProgressParams } from "../common/generated/ProgressParams";
import { GearboxClient, GearboxService, method } from "../common/protocol";
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
  return path.join(findRepoRoot(__dirname), "target", "debug", "gearbox");
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

  async initialize(): Promise<InitializeResult> {
    this.disposeEngine();
    const roots_ = roots();
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
    });

    const result = await engine.request<InitializeResult>(
      method.INITIALIZE,
      { roots: roots_ },
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

  async loadProduct(path: string): Promise<ProductLoadResult> {
    return this.request("gearbox/product/load", { path });
  }

  async resolve(path: string, profile?: string): Promise<ResolveResult> {
    return this.request("gearbox/product/resolve", { path, profile });
  }

  async validate(product?: string): Promise<ValidateResult> {
    return this.request("gearbox/validate", { product });
  }

  /**
   * One place that refuses when the engine is not up.
   *
   * Without it each method would either repeat the guard or let
   * `this.engine!` throw a `TypeError` the client cannot act on.
   */
  private async request<T>(method: string, params: unknown): Promise<T> {
    const engine = this.engine;
    if (!engine) {
      throw new Error(`cannot call ${method}: the engine is not initialized`);
    }
    return engine.connection.sendRequest<T>(method, params);
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
