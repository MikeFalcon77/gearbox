import React from "@theia/core/shared/react";
import type { ProductState } from "../product-store";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import { pointKey, pointsOf } from "../../common/extension-points";
import type { InclusionReason } from "../../common/generated/InclusionReason";
import type { Selection } from "../shell/selection-service";
import { RevealLink } from "../reveal-link";
import type { RevealService } from "../reveal-service";

/**
 * Why a gear is in the product, in words.
 *
 * `plugin_of` names the profile as well as the host, because it is the only
 * inclusion reason that differs between profiles -- dev links the static plugin
 * and prod the OIDC one, from the same description.
 *
 * Moved here from the Product widget's old Gears stage, which is what this tree
 * replaced: the reasons are the same ones, and the words for them should be too.
 */
function describeInclusion(reason: InclusionReason): string {
  switch (reason.reason) {
    case "selected":
      return "asked for by the product";
    case "colocated_by":
      return `co-located with ${reason.gear}`;
    case "plugin_of":
      return `plugin of ${reason.host} for ${reason.profile}`;
  }
}

export interface CompositionProps {
  state: ProductState;
  descriptors: readonly GearDescriptor[];
  selection: Selection | undefined;
  select: (selection: Selection) => void;
  add: (host?: string, point?: string) => void;
  remove: (host: string, entryIndex?: number) => void;
  settings: React.ReactNode;
  /** For the links from a gear to its own `gear.gdl`. */
  reveals: RevealService;
}

/**
 * A gear id, as a link to its own `gear.gdl`.
 *
 * `source` and `gdl_path` come from the resolution, so a gear the resolution
 * does not know about renders as plain text rather than a dead link -- which is
 * the ordinary case here, unlike on the old Gears stage: this tree is built from
 * the intent and shows gears whose resolution failed or has not arrived.
 */
function GearLink({ state, id, reveals, select }: {
  state: ProductState; id: string; reveals: RevealService; select: (selection: Selection) => void;
}): React.ReactElement {
  const gear = state.resolution?.product?.gears?.[id];
  if (gear === undefined) return <code>{id}</code>;
  return <span className="gbx-gear-link">
    <RevealLink reveals={reveals} source={gear.source} target={gear.gdl_path} label={id}
      onActivate={() => select({ kind: "gear", id })} />
  </span>;
}

/** The saved intent is the tree; resolution only annotates it. */
export function Composition({ state, descriptors, selection, select, add, remove, settings, reveals }: CompositionProps): React.ReactElement {
  // A composition is a view of one open document; without one there is nothing
  // to address a connection in. `explicit` is empty in that case anyway, so the
  // tree renders its empty state rather than a non-null assertion.
  const openPath = state.open?.path ?? "";
  const explicit = state.intent?.selected_gears ?? [];
  const descriptor = (id: string) => descriptors.find(d => d.id === id);
  const named = new Set(explicit.map(g => g.gear));
  const plugins = new Set(explicit.flatMap(g => (g.plugins ?? []).map(p => p.gear)));
  const automatic = Object.entries(state.resolution?.product?.gears ?? {}).filter(([id]) => !named.has(id) && !plugins.has(id));
  return <div className="gbx-composition" data-composition>
    <nav className="gbx-composition-tree" aria-label="Product composition">
      <h3>Selected gears ({explicit.length})</h3>
      {explicit.length === 0 && <div className="gbx-empty">Your product has no gears yet. Choose a gear, then configure it here.
        <button className="gbx-start-primary" onClick={() => add()}>Add gear</button>
      </div>}
      {explicit.map(host => {
        const d = descriptor(host.gear);
        const points = d ? pointsOf(d).map(p => ({ key: pointKey(p), label: p.trait_ident })) : [];
        // Keyed by `entry_index`, the position the entry is written at, because
        // that is the address the editor resolves. It equals the array position
        // for every product that loads today -- an entry evaluation cannot use
        // takes the whole intent down with it -- but reading the field keeps the
        // tree and the editor speaking about the same entry if that changes.
        const connections = (host.plugins ?? []).map(p => ({
          p,
          entryIndex: p.entry_index,
          point: descriptor(p.gear)?.fills?.point,
        }));
        const unassigned = connections.filter(c => !c.point || !points.some(p => p.key === pointKey(c.point!)));
        const renderConnections = (entries: typeof connections) => entries.map(({ p, entryIndex }) => {
          const active = !p.profiles?.length || p.profiles.includes(state.profile ?? "");
          const selected =
            selection?.kind === "plugin" &&
            selection.host === host.gear &&
            selection.entryIndex === entryIndex;
          return <div className="gbx-composition-connection" key={entryIndex} data-plugin-host={host.gear} data-plugin-index={entryIndex} data-plugin-id={p.gear} data-plugin-active={active}>
            <button aria-pressed={selected} className={`gbx-choice ${selected ? "gbx-choice-on" : ""}`} onClick={() => select({ kind: "plugin", host: host.gear, id: p.gear, entryIndex, path: openPath })}>{p.gear}</button>
            <small>Profiles: {p.profiles?.join(", ") || "All profiles"}{!active ? " · inactive here" : ""}</small>
          </div>;
        });
        return <details open key={host.gear} className="gbx-composition-host" data-asked-for={host.gear}>
          {/* The icon says what kind of gear this is, read from the resolution
              rather than from the id: `*-plugin` is a naming convention, being a
              plugin is a fact about what selected it. */}
          <summary>
            <span className="gbx-leaf-icon codicon codicon-package" />
            <span>{d?.display_name || host.gear}</span>
            <GearLink state={state} id={host.gear} reveals={reveals} select={select} />
          </summary>
          <div className="gbx-composition-host-actions">
            <button data-composition-gear={host.gear} className={`gbx-choice ${selection?.kind === "gear" && selection.id === host.gear ? "gbx-choice-on" : ""}`} onClick={() => select({ kind: "gear", id: host.gear })}>Configure {host.gear}</button>
            <button aria-label={`Remove ${host.gear} from product`} onClick={() => remove(host.gear)}>Remove</button>
          </div>
          {!d && <small>Descriptor unavailable or still loading. This gear remains in your product.</small>}
          {points.map(point => <section className="gbx-composition-slot" key={point.key}>
            <h4>{point.label}</h4>
            {renderConnections(connections.filter(c => c.point && pointKey(c.point) === point.key))}
            <button onClick={() => add(host.gear, point.key)}>Add compatible plugin</button>
          </section>)}
          {unassigned.length > 0 && <section className="gbx-composition-slot"><h4>Connections needing review</h4>{renderConnections(unassigned)}</section>}
        </details>;
      })}
      {/* Open by default. The group is *collapsible* because a long closure is
          noise once it is understood -- not because what the product pulled in
          should be hidden until asked for. Closed by default also put every
          pulled-in gear behind a click, which is one more than the old Gears
          stage needed to show the same thing. */}
      {automatic.length > 0 && <details open className="gbx-composition-automatic"><summary>Automatically included ({automatic.length})</summary>
        {automatic.map(([id, gear]) => <div key={id} className="gbx-leaf" data-pulled-in={id}>
          <span className={`gbx-leaf-icon codicon codicon-${gear.selected_by.some(r => r.reason === "plugin_of") ? "plug" : "package"}`} />
          <GearLink state={state} id={id} reveals={reveals} select={select} />
          {/* The words are `describeInclusion`'s in every case -- a co-location
              reason additionally *goes* to the gear it names, but saying so is
              not the same as saying something else, and "why is this here" is
              answered by the sentence rather than by the button being there. */}
          {gear.selected_by.map((reason, i) => <div key={i} className="gbx-leaf-why">
            {reason.reason === "colocated_by"
              ? <button className="gbx-choice" onClick={() => select({ kind: "gear", id: reason.gear })}>{describeInclusion(reason)}</button>
              : describeInclusion(reason)}
          </div>)}
          {descriptor(id)?.extension_points?.length ? <button onClick={() => add(id)}>Add plugin (select host explicitly)</button> : null}
        </div>)}
      </details>}
    </nav>
    <section className="gbx-composition-settings" aria-label="Selected object settings" tabIndex={-1}>{settings}</section>
  </div>;
}
