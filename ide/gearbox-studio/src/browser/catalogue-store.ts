// The frontend's copy of the catalogue as it arrives.
//
// The whole point of this file is the transition: a row starts pending and is
// replaced by a projected one, keyed by `(source, gdl_path)` because `GearId`
// is projected and does not exist at the pending stage (ADR
// cpt-gearbox-adr-staged-catalogue-loading).
//
// `load()` looks sequential and is not: notifications mutate the same `Map`
// during its awaits. Two things keep that honest. Every await resumption is
// guarded by a load epoch, so a superseded load cannot install its pending set
// over a newer one's projections; and failures move the store to an `error`
// state instead of leaving `loading` set forever.

import { Emitter, Event } from "@theia/core/lib/common/event";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { CatalogueDiagnostics } from "../common/generated/CatalogueDiagnostics";
import type { InitializeResult } from "../common/generated/InitializeResult";
import type { ProgressParams } from "../common/generated/ProgressParams";
import { CatalogueState, GearboxClient, GearboxService, Row, keyFor } from "../common/protocol";

/** The state a store starts in and returns to at the head of every load. */
const EMPTY: CatalogueState = {
  status: "idle",
  rows: [],
  diagnostics: [],
  failedRoots: [],
  error: undefined,
  total: 0,
  completed: 0,
};

@injectable()
export class CatalogueStore implements GearboxClient {
  @inject(GearboxService) protected readonly service!: GearboxService;

  protected readonly onChangedEmitter = new Emitter<void>();
  readonly onChanged: Event<void> = this.onChangedEmitter.event;

  protected rowsByKey = new Map<string, Row>();
  protected state: CatalogueState = EMPTY;
  protected capabilities: InitializeResult["capabilities"] | undefined;
  /**
   * Where each source root is on this machine, from `initialize`.
   *
   * Needed because every path the catalogue carries -- `gdl_path`, and every
   * PRD/DESIGN/ADR link -- is relative to its source root, and the root is the
   * one thing only the server knows. Without it those paths cannot be opened,
   * which is exactly how they came to be silently dead.
   */
  protected rootsById = new Map<string, string>();
  protected logLines: string[] = [];

  /**
   * Which load is current.
   *
   * Bumped at the head of every `load()`. A load that resumes from an await
   * with a stale epoch returns without touching anything -- otherwise closing
   * and reopening the panel mid-projection lets the first load's `pending` set
   * land on top of the second load's already-projected rows, and those
   * projections are not resent.
   */
  protected epoch = 0;

  /**
   * The selected row, keyed the way rows are keyed.
   *
   * In the store rather than in the tree widget because the detail panel is a
   * separate widget in the bottom area, and a key that survives the
   * pending-to-projected transition is exactly what a selection needs: choosing
   * a row before it is parsed must not lose the choice when it finishes.
   */
  protected selectedKey: string | undefined;

  get current(): CatalogueState {
    return this.state;
  }

  get engineCapabilities(): InitializeResult["capabilities"] | undefined {
    return this.capabilities;
  }

  get logs(): readonly string[] {
    return this.logLines;
  }

  get selected(): string | undefined {
    return this.selectedKey;
  }

  get selectedRow(): Row | undefined {
    return this.selectedKey === undefined ? undefined : this.rowsByKey.get(this.selectedKey);
  }

  /**
   * Absolute path for a catalogue-relative path, or `undefined` if the source
   * is unknown or the path is not one the catalogue may carry.
   *
   * Returning `undefined` rather than the relative path: a caller that gets a
   * path back will try to open it, and a relative path produces a URI with no
   * scheme that no opener handles -- which fails quietly. Being unable to
   * answer has to look different from answering.
   */
  absolutePath(source: string, relative: string): string | undefined {
    const root = this.rootsById.get(source);
    if (root === undefined || !isCatalogueRelative(relative)) {
      return undefined;
    }
    return join(root, relative);
  }

  select(key: string | undefined): void {
    this.selectedKey = key;
    this.onChangedEmitter.fire();
  }

  /**
   * Initialize the engine and run one staged load.
   *
   * Never rejects. A failure is a state, not an exception: the only callers are
   * a command and an application contribution, and a rejected promise from
   * either becomes an unhandled rejection in the console while the panel keeps
   * claiming it is still projecting.
   */
  async load(): Promise<void> {
    const epoch = ++this.epoch;
    this.rowsByKey.clear();
    this.state = { ...EMPTY, status: "loading" };
    this.onChangedEmitter.fire();

    try {
      const init = await this.service.initialize();
      if (epoch !== this.epoch) {
        return;
      }
      this.capabilities = init.capabilities;
      this.rootsById = new Map((init.roots ?? []).map((r) => [r.id, r.path]));
      const failedRoots = init.failed_roots ?? [];

      // Resolves at the S1/S2 boundary: the whole tree, none of it projected.
      const loaded = await this.service.loadCatalogue();
      if (epoch !== this.epoch) {
        return;
      }
      for (const gear of loaded.pending) {
        this.rowsByKey.set(keyFor(gear.source, gear.gdl_path), { kind: "pending", gear });
      }
      this.state = {
        status: "loading",
        rows: this.sorted(),
        diagnostics: loaded.diagnostics,
        failedRoots,
        error: undefined,
        total: loaded.total,
        completed: 0,
      };
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.state = {
        ...this.state,
        status: "error",
        rows: [],
        error: describe(error),
      };
      this.rowsByKey.clear();
    }
    this.onChangedEmitter.fire();
  }

  onCatalogueChanged(event: CatalogueChanged): void {
    // `replaces` is the pending `gdl_path`, and the gear carries the source it
    // came from -- together they are the row key. Sent by the server so the
    // client does not have to know how the pending list was built.
    const key = keyFor(event.gear.source, event.replaces);
    this.rowsByKey.set(key, { kind: "projected", gear: event.gear });
    this.state = { ...this.state, rows: this.sorted() };
    this.onChangedEmitter.fire();
  }

  onCatalogueDiagnostics(event: CatalogueDiagnostics): void {
    // Everything the second pass found. A gear that fails to project emits no
    // `catalogueChanged`, so this is the only account of why its row never
    // filled in.
    this.state = {
      ...this.state,
      diagnostics: [...this.state.diagnostics, ...event.diagnostics],
    };
    this.onChangedEmitter.fire();
  }

  onProgress(event: ProgressParams): void {
    // `done` ends the load whatever is left pending. A row still pending at
    // that point did not project, which the widget says rather than leaving it
    // reading `parsing…` under a finished progress bar.
    this.state = {
      ...this.state,
      completed: event.completed,
      total: event.total,
      status: event.done ? "ready" : "loading",
    };
    this.onChangedEmitter.fire();
  }

  onLog(message: string): void {
    this.logLines = [...this.logLines, message];
    this.onChangedEmitter.fire();
  }

  /**
   * Ordered by category then name, so a row does not jump when it is replaced.
   *
   * Sorting by anything that changes at projection -- capabilities, dependency
   * count -- would make the tree reshuffle under the reader as badges arrive,
   * which is the one thing incremental rendering must not do.
   */
  protected sorted(): Row[] {
    const rows = [...this.rowsByKey.values()];
    rows.sort((a, b) => {
      const byCategory = category(a).localeCompare(category(b));
      return byCategory !== 0 ? byCategory : name(a).localeCompare(name(b));
    });
    return rows;
  }
}

function category(row: Row): string {
  return row.gear.category ?? "uncategorised";
}

function name(row: Row): string {
  return row.kind === "pending"
    ? (row.gear.display_name ?? row.gear.gdl_path)
    : row.gear.display_name;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  // A JSON-RPC rejection arrives as a `ResponseError`-shaped object, which is
  // an `Error` in-process but need not be across the Theia proxy.
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Whether a path is one the catalogue is allowed to have produced.
 *
 * `RelPath` on the engine side already rejects `..`, backslashes and leading
 * separators, so a matching engine cannot send anything else. This re-checks it
 * anyway: the engine is a separate process that a `GEARBOX_ENGINE` override can
 * point anywhere, and the answer is fed straight to a file opener.
 */
function isCatalogueRelative(relative: string): boolean {
  if (relative.length === 0 || relative.includes("\\") || relative.startsWith("/")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(relative)) {
    return false;
  }
  return !relative.split("/").includes("..");
}

/**
 * Join a root reported by the engine to a forward-slash catalogue path.
 *
 * The engine sends `Path::display()`, which is `C:\src\gears` on Windows and
 * `/src/gears` elsewhere, so the separator has to come from the root rather
 * than be assumed. String concatenation with `/` produced `C:\src/gears/x`,
 * which `URI.fromFilePath` does not resolve to the file anyone meant.
 */
function join(root: string, relative: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const tail = separator === "\\" ? relative.split("/").join("\\") : relative;
  const base = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root;
  return `${base}${separator}${tail}`;
}
