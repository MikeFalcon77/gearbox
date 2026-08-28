// The backend half: owns the engine process, forwards its notifications.
//
// Notifications are relayed rather than accumulated here. The frontend holds the
// catalogue state, because it is the frontend that renders it and a second copy
// on the backend would be a second thing to keep correct.

import { ILogger } from "@theia/core/lib/common/logger";
import { inject, injectable } from "@theia/core/shared/inversify";
import * as fs from "fs";
import * as path from "path";

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { CatalogueLoadResult } from "../common/generated/CatalogueLoadResult";
import type { InitializeResult } from "../common/generated/InitializeResult";
import type { LogParams } from "../common/generated/LogParams";
import type { ProgressParams } from "../common/generated/ProgressParams";
import { GearboxClient, GearboxService } from "../common/protocol";
import { EngineHandle, spawnEngine } from "./gearbox-engine-process";

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
    this.engine?.dispose();
    const roots_ = roots();
    const engine = spawnEngine(enginePath(), roots_, this.logger);
    this.engine = engine;

    engine.connection.onNotification("gearbox/catalogueChanged", (event: CatalogueChanged) =>
      this.client?.onCatalogueChanged(event),
    );
    engine.connection.onNotification("$/progress", (event: ProgressParams) =>
      this.client?.onProgress(event),
    );
    engine.connection.onNotification("gearbox/log", (event: LogParams) =>
      this.client?.onLog(event.message),
    );

    const result: InitializeResult = await engine.connection.sendRequest("initialize", {
      roots: roots_,
    });
    engine.connection.sendNotification("initialized", {});
    return result;
  }

  async loadCatalogue(): Promise<CatalogueLoadResult> {
    const engine = this.engine;
    if (!engine) {
      throw new Error("engine not initialized");
    }
    return engine.connection.sendRequest("gearbox/catalogue/load", {});
  }

  dispose(): void {
    this.engine?.dispose();
    this.engine = undefined;
  }
}
