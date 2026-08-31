// What there is to do when no product is open.
//
// The Home context used to have an empty main area with the catalogue beside it,
// which said "this is an IDE with nothing loaded" rather than "this is a tool for
// building products, and you have not chosen one". STM32CubeMX opens on exactly
// three things -- New, Load, Recent -- and only then shows domain views; this is
// that screen minus the one that is not built.
//
// **No `Create Product`.** It needs a skeleton -- which sources, which profiles,
// what the first `product.gdl` says -- and it is a new write path, which the P0
// stray-write investigation has not cleared. A button promising a product it
// cannot create is worse than no button, and a disabled one with a tooltip is the
// same promise in a quieter voice.
//
// The two lists are deliberately not merged. `Open Product…` offers one list
// because a picker is a question with one answer; here there is room to say which
// products are *in this workspace* and which were *opened before*, and those are
// different facts about a product.

import { ReactWidget } from "@theia/core/lib/browser";
import { CommandRegistry } from "@theia/core/lib/common";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { ProductRef } from "../../common/protocol";
import { ProductStore } from "../product-store";
import { ProductSessionService } from "../shell/product-session-service";
import { OPEN_PRODUCT } from "../shell/session-commands";

@injectable()
export class StartWidget extends ReactWidget {
  static readonly ID = "gearbox.start";
  static readonly LABEL = "Gearbox Studio";

  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;

  /**
   * Recent products, read once and after every change.
   *
   * Held rather than read in `render`: `recent()` is asynchronous -- it goes to
   * `StorageService` -- and a render that starts a promise starts one per frame.
   */
  protected recent: readonly ProductRef[] = [];

  @postConstruct()
  protected init(): void {
    this.id = StartWidget.ID;
    this.title.label = StartWidget.LABEL;
    this.title.caption = "Gearbox Studio";
    // Not closable. Every other view can be closed because the shell still makes
    // sense without it; closing this one leaves the Home context with an empty
    // main area, which is the state it exists to replace.
    this.title.closable = false;
    this.addClass("gearbox-start");
    this.toDispose.push(this.products.onChanged(() => this.refresh()));
    this.refresh();
  }

  /**
   * Ask what there is to offer, then render.
   *
   * `ensureDiscovered` and not `discover`: it returns immediately when a list is
   * already in hand or a load is in flight, so this can be called from every
   * change event without turning a re-render into a request.
   */
  protected refresh(): void {
    void this.products.ensureDiscovered();
    void this.session.recent().then((recent) => {
      this.recent = recent;
      this.update();
    });
    this.update();
  }

  protected render(): React.ReactNode {
    const found = this.products.current.products;
    const remembered = this.recent.filter(
      (ref) => !found.some((candidate) => candidate.path === ref.path),
    );

    return (
      <div className="gbx-start">
        <div className="gbx-start-head">
          <div className="gbx-start-title">Gearbox Studio</div>
          <div className="gbx-start-subtitle">
            Compose a product from gears, resolve it for a profile, and generate what runs.
          </div>
        </div>

        <button
          type="button"
          className="gbx-start-primary"
          data-start-action="open"
          onClick={() => void this.commands.executeCommand(OPEN_PRODUCT.id)}
        >
          Open Product…
        </button>

        {this.renderList("In this workspace", "workspace", found)}
        {this.renderList("Recent", "recent", remembered)}

        {found.length === 0 && remembered.length === 0 && (
          <div className="gbx-empty" data-start-empty>
            Nothing in this workspace declares a product. A product is a{" "}
            <code>product.gdl</code> naming the gears it wants and the profiles it deploys under.
          </div>
        )}
      </div>
    );
  }

  protected renderList(
    label: string,
    kind: string,
    refs: readonly ProductRef[],
  ): React.ReactNode {
    if (refs.length === 0) return undefined;
    return (
      <div className="gbx-start-section" data-start-list={kind}>
        <div className="gbx-start-label">{label}</div>
        <ul className="gbx-start-items">
          {refs.map((ref) => (
            <li key={ref.path}>
              <button
                type="button"
                className="gbx-start-item"
                data-start-product={ref.path}
                onClick={() => void this.open(kind, ref)}
              >
                <span className="gbx-start-item-name">{ref.label}</span>
                <span className="gbx-start-item-path">{ref.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  /**
   * Open it, through the session rather than the store.
   *
   * A remembered path is the one place a path is expected to have rotted, and
   * `openRecent` is what forgets it and says so; a discovered one was listed by
   * the engine a moment ago, so `open` is the honest call for it.
   */
  protected async open(kind: string, ref: ProductRef): Promise<void> {
    if (kind === "recent") {
      await this.session.openRecent(ref);
      // The list may be one shorter now, if the path had rotted.
      this.refresh();
      return;
    }
    await this.session.open(ref);
  }
}
