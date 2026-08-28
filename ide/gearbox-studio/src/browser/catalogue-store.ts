// The frontend's copy of the catalogue as it arrives.
//
// The whole point of this file is the transition: a row starts pending and is
// replaced by a projected one, keyed by `gdl_path` because `GearId` is projected
// and does not exist at the pending stage (ADR
// cpt-gearbox-adr-staged-catalogue-loading).

import { Emitter, Event } from "@theia/core/lib/common/event";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { InitializeResult } from "../common/generated/InitializeResult";
import type { ProgressParams } from "../common/generated/ProgressParams";
import {
  CatalogueState,
  GearboxClient,
  GearboxService,
  Row,
  rowKey,
} from "../common/protocol";

@injectable()
export class CatalogueStore implements GearboxClient {
  @inject(GearboxService) protected readonly service!: GearboxService;

  protected readonly onChangedEmitter = new Emitter<void>();
  readonly onChanged: Event<void> = this.onChangedEmitter.event;

  protected rowsByKey = new Map<string, Row>();
  protected state: CatalogueState = {
    rows: [],
    diagnostics: [],
    total: 0,
    completed: 0,
    loading: false,
  };
  protected capabilities: InitializeResult["capabilities"] | undefined;
  protected logLines: string[] = [];

  /**
   * The selected row, keyed the way rows are keyed -- by `gdl_path`.
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

  select(key: string | undefined): void {
    this.selectedKey = key;
    this.onChangedEmitter.fire();
  }

  /** Initialize the engine and run one staged load. */
  async load(): Promise<void> {
    this.rowsByKey.clear();
    this.state = { ...this.state, loading: true, completed: 0, total: 0, rows: [] };
    this.onChangedEmitter.fire();

    const init = await this.service.initialize();
    this.capabilities = init.capabilities;

    // Resolves at the S1/S2 boundary: the whole tree, none of it projected.
    const loaded = await this.service.loadCatalogue();
    for (const gear of loaded.pending) {
      this.rowsByKey.set(gear.gdl_path, { kind: "pending", gear });
    }
    this.state = {
      rows: this.sorted(),
      diagnostics: loaded.diagnostics,
      total: loaded.total,
      completed: 0,
      loading: true,
    };
    this.onChangedEmitter.fire();
  }

  onCatalogueChanged(event: CatalogueChanged): void {
    // `replaces` is the pending key. Sent by the server so the client does not
    // have to know that `gdl_path` was the key.
    this.rowsByKey.set(event.replaces, { kind: "projected", gear: event.gear });
    this.state = { ...this.state, rows: this.sorted() };
    this.onChangedEmitter.fire();
  }

  onProgress(event: ProgressParams): void {
    this.state = {
      ...this.state,
      completed: event.completed,
      total: event.total,
      loading: !event.done,
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
  return (row.kind === "pending" ? row.gear.category : row.gear.category) ?? "uncategorised";
}

function name(row: Row): string {
  return row.kind === "pending"
    ? (row.gear.display_name ?? row.gear.gdl_path)
    : row.gear.display_name;
}

export function keyOf(row: Row): string {
  return rowKey(row);
}
