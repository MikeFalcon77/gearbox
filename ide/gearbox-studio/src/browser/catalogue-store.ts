// The frontend's copy of the catalogue as it arrives.
//
// The whole point of this file is the transition: a row starts pending and is
// replaced by a projected one, keyed by `(source, gdl_path)` because `GearId`
// is projected and does not exist at the pending stage (ADR
// cpt-gearbox-adr-staged-catalogue-loading).
//
// `load()` looks sequential and is not: notifications mutate the same `Map`
// during its awaits. Three things keep that honest. Every await resumption in
// `load()` is guarded by a load epoch, so a superseded load cannot install its
// pending set over a newer one's projections; notifications are accepted only
// while a load is *streaming*, so an abandoned load's late projections cannot
// walk an error back to `ready`; and failures move the store to an `error` state
// instead of leaving `loading` set forever.

import { Emitter, Event } from "@theia/core/lib/common/event";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { CatalogueDiagnostics } from "../common/generated/CatalogueDiagnostics";
import type { InitializeResult } from "../common/generated/InitializeResult";
import type { ProgressParams } from "../common/generated/ProgressParams";
import {
  CatalogueState,
  GearboxClient,
  GearboxService,
  Row,
  type StudioSession,
  keyFor,
} from "../common/protocol";

/**
 * How many engine log lines are kept.
 *
 * A window's worth of context, not a transcript: the engine's own stderr goes to
 * the backend log, which is where a full history belongs.
 */
const LOG_LIMIT = 500;

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
  /** The session the last load ran under, reused by a bare `load()`. */
  protected session: StudioSession | undefined;

  protected epoch = 0;

  /**
   * The epoch of the load currently streaming projections, if one is.
   *
   * The epoch alone could not do this job. It says which load is *newest*; this
   * says whether the newest one is still entitled to be spoken for -- and the
   * notifications carry no epoch, because the engine has no idea one exists.
   *
   * Set when `loadCatalogue` answers at the S1/S2 boundary, which is the moment
   * projections start arriving, and cleared by anything that ends the load:
   * terminal progress, a failure, the engine dying, or the head of a newer load.
   * Without it a load abandoned on timeout stays visible in its consequences --
   * the engine goes on projecting into a store that has already reported the
   * error, and the final `$/progress done` sets `ready` over the top of it, so
   * the panel ends up showing a tree for a load it told the person had failed.
   */
  protected streaming: number | undefined;

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
  async load(session?: StudioSession): Promise<void> {
    // Remembered, because `Reload Catalogue` and the reconnect path both call
    // `load()` with nothing: without this they would quietly re-initialize with
    // the built-in roots and the product's own sources would disappear from the
    // catalogue while the product stayed open.
    if (session !== undefined) {
      this.session = session;
    }
    const epoch = ++this.epoch;
    this.streaming = undefined;
    this.rowsByKey.clear();
    this.state = { ...EMPTY, status: "loading" };
    this.onChangedEmitter.fire();

    try {
      // The session, when a product session drives the load. `initialize`
      // disposes and respawns the engine, so this is also what makes the roots
      // and the write boundary change wholesale rather than drift.
      const init = await this.service.initialize(this.session);
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
      // The boundary is passed: projections for *this* load are now welcome.
      this.streaming = epoch;
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      this.streaming = undefined;
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
    if (!this.isStreaming()) {
      return;
    }
    // `replaces` is the pending `gdl_path`, and the gear carries the source it
    // came from -- together they are the row key. Sent by the server so the
    // client does not have to know how the pending list was built.
    const key = keyFor(event.gear.source, event.replaces);
    this.rowsByKey.set(key, { kind: "projected", gear: event.gear });
    this.state = { ...this.state, rows: this.sorted() };
    this.onChangedEmitter.fire();
  }

  onCatalogueDiagnostics(event: CatalogueDiagnostics): void {
    if (!this.isStreaming()) {
      return;
    }
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
    if (!this.isStreaming()) {
      return;
    }
    // `done` ends the load whatever is left pending. A row still pending at
    // that point did not project, which the widget says rather than leaving it
    // reading `parsing…` under a finished progress bar.
    if (event.done) {
      this.streaming = undefined;
    }
    this.state = {
      ...this.state,
      completed: event.completed,
      total: event.total,
      status: event.done ? "ready" : "loading",
    };
    this.onChangedEmitter.fire();
  }

  onLog(message: string): void {
    // Capped, and deliberately *not* firing `onChanged`.
    //
    // Two costs, neither of which buys anything today. The list grew without
    // bound for the life of the window, and nothing reads it -- there is no log
    // view yet. And every line re-rendered all six panels, the dependency graph
    // among them, which relays its whole SVG: an engine that logs while
    // projecting made the graph the most expensive thing in the application.
    // When a log view exists it gets its own emitter; a shared one would put
    // this cost back.
    this.logLines = [...this.logLines.slice(1 - LOG_LIMIT), message];
  }

  onEngineExit(reason: string): void {
    // Only a load in flight has anything to lose. An engine that exits between
    // loads -- disposed on reconnect, killed on the way out -- is ordinary, and
    // reporting it as a catalogue error would put a red panel in front of a
    // tree that is perfectly good.
    if (!this.isStreaming()) {
      return;
    }
    this.streaming = undefined;
    this.state = {
      ...this.state,
      status: "error",
      error: `the engine ${reason} while projecting; reload the catalogue`,
    };
    // The rows are kept, unlike a failed `load()`. Everything projected before
    // the engine died is still true, and a partial tree beside "reload" is more
    // use than an empty panel.
    this.onChangedEmitter.fire();
  }

  /** Whether the newest load is at the stage where projections belong to it. */
  protected isStreaming(): boolean {
    return this.streaming === this.epoch;
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
