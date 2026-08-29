// Everything the projection found about one gear.
//
// A widget of its own, in the bottom area, rather than a section of the tree.
// The reason is not layout taste: this panel is where the substance lives --
// which transports a provider actually wires up, which extension point a plugin
// fills and under what vendor, which GTS types a gear owns -- and a 300px side
// panel clipped all of it. The tree answers "what is there"; this answers "what
// is it", and the two need different amounts of room.

import { ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import { CatalogueStore } from "../catalogue-store";
import { RevealLink } from "../reveal-link";
import { RevealService } from "../reveal-service";

@injectable()
export class GearDetailWidget extends ReactWidget {
  static readonly ID = "gearbox.detail";
  static readonly LABEL = "Gearbox Gear";

  @inject(CatalogueStore) protected readonly store!: CatalogueStore;
  @inject(RevealService) protected readonly reveals!: RevealService;

  @postConstruct()
  protected init(): void {
    this.id = GearDetailWidget.ID;
    this.title.label = GearDetailWidget.LABEL;
    this.title.caption = GearDetailWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-detail");
    this.toDispose.push(this.store.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const row = this.store.selectedRow;
    if (!row) {
      return <div className="gbx-detail gbx-empty">Select a gear in the catalogue.</div>;
    }

    if (row.kind === "pending") {
      // A pending row is not an error state, so it does not read like one. Its
      // description and path are known from S0/S1; the rest is genuinely not
      // known yet, and saying which is which is the whole point of the stage.
      return (
        <div className="gbx-detail">
          <div className="gbx-detail-title">
            {row.gear.display_name ?? row.gear.gdl_path}
            <span className="gbx-waiting">parsing…</span>
          </div>
          <div className="gbx-kv">
            <span>description</span>
            <span>{row.gear.description ?? "—"}</span>
          </div>
          <div className="gbx-kv">
            <span>category</span>
            <span>{row.gear.category ?? "—"}</span>
          </div>
          {this.renderPath(row.gear.source, row.gear.gdl_path)}
          <div className="gbx-empty">
            Capabilities, co-location, contracts and GTS types come from this
            gear's Rust attributes, which have not been read yet.
          </div>
        </div>
      );
    }

    return this.renderProjected(row.gear);
  }

  protected renderProjected(gear: GearDescriptor): React.ReactNode {
    const capabilities = this.store.engineCapabilities;
    return (
      <div className="gbx-detail">
        <div className="gbx-detail-title">
          {gear.display_name} <span className="gbx-id">{gear.id}</span>
        </div>

        <div className="gbx-kv">
          <span>description</span>
          <span>{gear.description ?? "—"}</span>
        </div>
        <div className="gbx-kv">
          <span>capabilities</span>
          <span>
            {(gear.runtime_caps ?? []).map((cap) => (
              <span className="gbx-badge" key={cap}>
                {cap}
              </span>
            ))}
            {(gear.runtime_caps ?? []).length === 0 && "—"}
          </span>
        </div>
        <div className="gbx-kv">
          {/* Named "co-located with", not "depends on": these edges are link-time
              and the resolver can never sever them. */}
          <span>co-located with</span>
          <span>{(gear.colocated_deps ?? []).join(", ") || "—"}</span>
        </div>

        {(gear.extension_points ?? []).length > 0 && (
          <div className="gbx-kv">
            <span>extension points</span>
            <span>
              {(gear.extension_points ?? []).map((point) => (
                <div key={`${point.sdk_lib}::${point.trait_ident}`}>
                  <code>
                    {point.sdk_lib}::{point.trait_ident}
                  </code>
                  {gear.vendor_selector !== null && gear.vendor_selector !== undefined && (
                    <>
                      {" "}
                      selects vendor <code>{gear.vendor_selector}</code>
                    </>
                  )}
                </div>
              ))}
            </span>
          </div>
        )}

        {gear.fills && (
          <div className="gbx-kv">
            <span>fills</span>
            <span>
              <code>{gear.fills.point.trait_ident}</code>
              {gear.fills.default_vendor !== null && gear.fills.default_vendor !== undefined && (
                <>
                  {" "}
                  as vendor <code>{gear.fills.default_vendor}</code>
                </>
              )}
              {gear.fills.default_priority !== null &&
                gear.fills.default_priority !== undefined && (
                  <>, priority {gear.fills.default_priority}</>
                )}
            </span>
          </div>
        )}

        {(gear.provides ?? []).length > 0 && (
          <div className="gbx-kv">
            {/* The transports here are what this provider wires up, which is not
                the same as what the contract could support: api-contracts has a
                gRPC projection but leaves it behind an opt-in Cargo feature. */}
            <span>provides</span>
            <span>
              {(gear.provides ?? []).map((provide) => (
                <div key={provide.contract}>
                  <code>{provide.contract}</code> over{" "}
                  {provide.transports.map((t) => (
                    <span className="gbx-badge" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              ))}
            </span>
          </div>
        )}

        {(gear.gts_types ?? []).length > 0 && (
          <div className="gbx-kv">
            <span>GTS types</span>
            <span>
              {(gear.gts_types ?? []).map((type) => (
                <div key={type.type_id}>
                  <code>{type.type_id}</code>
                </div>
              ))}
            </span>
          </div>
        )}

        {gear.docs && (
          <div className="gbx-kv">
            <span>docs</span>
            <span className="gbx-links">
              {this.renderDocLink(gear.source, "PRD", gear.docs.prd)}
              {this.renderDocLink(gear.source, "DESIGN", gear.docs.design)}
              {(gear.docs.adr ?? []).map((adr) =>
                this.renderDocLink(gear.source, adrLabel(adr), adr),
              )}
              {!gear.docs.prd && !gear.docs.design && (gear.docs.adr ?? []).length === 0 && "—"}
            </span>
          </div>
        )}

        {this.renderPath(gear.source, gear.gdl_path)}

        {capabilities && !capabilities.resolve && (
          // Honest about the gap rather than showing an empty panel that reads as
          // a bug: the engine says it cannot resolve yet, so the UI says so too.
          <div className="gbx-gap">
            Bindings, processes and the lock need the resolver (M4). The engine
            reports <code>resolve: false</code>, so those panels are disabled
            rather than empty.
          </div>
        )}
      </div>
    );
  }

  protected renderPath(source: string, gdlPath: string): React.ReactNode {
    return (
      <div className="gbx-kv">
        <span>description file</span>
        <span className="gbx-links">{this.renderLink(source, gdlPath, gdlPath)}</span>
      </div>
    );
  }

  protected renderDocLink(
    source: string,
    label: string,
    target: string | null | undefined,
  ): React.ReactNode {
    if (target === null || target === undefined) {
      return undefined;
    }
    return this.renderLink(source, target, label);
  }

  /**
   * One link, opened through the opener rather than by the browser.
   *
   * `href` is real so the anchor is focusable, activates on Enter and announces
   * as a link; `preventDefault` keeps the navigation ours, because a `file://`
   * href followed by the browser would leave Theia rather than open a tab in
   * it. Without the href these were divs that only answered a mouse.
   */
  protected renderLink(source: string, target: string, label: string): React.ReactNode {
    // Shared with the Product view. The reasoning for a real `href` rather than a
    // div with an `onClick` lives with the component.
    return (
      <RevealLink key={target} reveals={this.reveals} source={source} target={target} label={label} />
    );
  }
}

/**
 * `ADR 001` rather than `001-provider-compatibility-and-performance.md`.
 *
 * `cluster` has nine ADRs and `types-registry` fifteen, with names long enough
 * that the full filenames wrapped to three lines and read as a paragraph rather
 * than as a list. The number is the part anyone actually cites; the filename
 * stays in the link's tooltip.
 */
function adrLabel(target: string): string {
  const file = basename(target);
  const numbered = /^(\d+)/.exec(file);
  return numbered ? `ADR ${numbered[1]}` : file.replace(/\.md$/, "");
}

function basename(target: string): string {
  const parts = target.split("/");
  return parts[parts.length - 1] ?? target;
}
