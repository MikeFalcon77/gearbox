// One product, resolved for one profile.
//
// The clause this answers is "edits and resolves a product across profiles"
// (`cpt-gearbox-fr-studio`). The *editing* is the `.gdl` editor Theia already
// gives us -- there is no form here on purpose, because a form would be a second
// way to express a description and the two would drift. What the panel adds is
// the half a text editor cannot show: what the description *resolves to*, and how
// that answer differs between profiles.
//
// The profile switch is the centre of it. One description, three profiles, three
// distinct locks -- and every difference visible without editing anything, which
// is the property `profiles = [...]` as a data field exists to buy.

import { ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { Choice } from "../../common/generated/Choice";
import type { ClusterResolution } from "../../common/generated/ClusterResolution";
import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { InclusionReason } from "../../common/generated/InclusionReason";
import type { ResolvedBinding } from "../../common/generated/ResolvedBinding";
import type { ResolvedProcess } from "../../common/generated/ResolvedProcess";
import type { ResolvedProduct } from "../../common/generated/ResolvedProduct";
import { ProductStore } from "../product-store";
import { RevealLink, RevealPathLink } from "../reveal-link";
import { RevealService } from "../reveal-service";

@injectable()
export class ProductWidget extends ReactWidget {
  static readonly ID = "gearbox.product";
  static readonly LABEL = "Gearbox Product";

  @inject(ProductStore) protected readonly store!: ProductStore;
  @inject(RevealService) protected readonly reveals!: RevealService;

  /** Which branches are folded away. Widget state; nobody else's business. */
  protected collapsed = new Set<string>();

  @postConstruct()
  protected init(): void {
    this.id = ProductWidget.ID;
    this.title.label = ProductWidget.LABEL;
    this.title.caption = ProductWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-product");
    this.toDispose.push(this.store.onChanged(() => this.update()));
    void this.store.ensureDiscovered();
    this.update();
  }

  protected render(): React.ReactNode {
    const state = this.store.current;

    if (state.status === "error") {
      return (
        <div className="gbx-product">
          <div className="gbx-error" role="alert">
            {state.error}
          </div>
          {renderDiagnostics(state.diagnostics)}
        </div>
      );
    }

    if (state.open === undefined) {
      return (
        <div className="gbx-product">
          {state.products.length === 0 ? (
            <div className="gbx-empty">
              No <code>products/*/product.gdl</code> under the repository root. Open a product
              description in the editor to resolve it.
            </div>
          ) : (
            <div className="gbx-kv">
              <span>product</span>
              <span>
                {state.products.map((ref) => (
                  <button
                    className="gbx-choice"
                    key={ref.path}
                    onClick={() => void this.store.open(ref)}
                  >
                    {ref.label}
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>
      );
    }

    const intent = state.intent;
    const product = state.resolution?.product ?? undefined;

    return (
      <div className="gbx-product">
        <div className="gbx-detail-title">
          {intent?.display_name ?? state.open.label}{" "}
          <span className="gbx-id">{intent?.id}</span>
        </div>

        {intent && (
          <div className="gbx-kv">
            <span>profile</span>
            <span className="gbx-profiles">
              {Object.keys(intent.profiles).map((id) => (
                <button
                  className={`gbx-choice ${id === state.profile ? "gbx-choice-on" : ""}`}
                  key={id}
                  aria-pressed={id === state.profile}
                  data-profile={id}
                  onClick={() => void this.store.setProfile(id)}
                >
                  {id}
                  {id === intent.default_profile ? " (default)" : ""}
                </button>
              ))}
            </span>
          </div>
        )}

        {state.status === "resolving" && <div className="gbx-progress">resolving…</div>}

        {product && this.renderResolved(product)}
        {renderDiagnostics(state.diagnostics)}
      </div>
    );
  }

  protected renderResolved(product: ResolvedProduct): React.ReactNode {
    const entries = Object.entries(product.gears);
    const selected = entries
      .filter(([, gear]) => gear.selected_by.some((reason) => reason.reason === "selected"))
      .map(([id]) => id);
    const pulled = entries
      .filter(([, gear]) => !gear.selected_by.some((reason) => reason.reason === "selected"))
      .map(([id, gear]) => ({ id, why: gear.selected_by.map(describeInclusion).join("; ") }));
    const bindings = product.bindings ?? [];
    const cluster = product.cluster ?? [];

    return (
      <>
        <div className="gbx-kv">
          <span>resolved</span>
          {/* The profile is taken from the *resolved header*, not from the switch
              above. They should agree, and stating both is what makes a
              disagreement visible instead of leaving the panel labelled one way
              and showing another profile's answer.
              *
              The lock hash used to be shown here and is not any more: it told a
              reader nothing they could act on. That the profile matters is already
              visible in the process count, the binding modes and which plugin was
              linked -- all of which say *what* differs, where the digest only said
              *that* something does. It stays on the element as `data-lock-hash`,
              because "three profiles, three distinct locks" is a fact still worth
              asserting, and it stays visible in the Lock view, where the lock is
              the subject rather than a footnote. */}
          <span
            data-resolved-profile={product.product.profile}
            data-lock-hash={product.product.lock_hash}
          >
            {product.product.profile} · {product.product.profile_kind}
          </span>
        </div>

        {/* The panel is about this product and had no way to open it. Same row
            and same shape as the Gear detail panel's, so the two read alike. */}
        <div className="gbx-kv">
          <span>description file</span>
          <span className="gbx-links">
            <RevealPathLink
              reveals={this.reveals}
              path={this.store.current.open?.path ?? ""}
              label={this.store.current.open?.label ?? "—"}
            />
          </span>
        </div>

        {/* Vision §60 sketches the product as a tree -- Deployment, Gears,
            Contracts, Cluster, Edge, Security, Artifacts -- and this is that,
            with three departures worth naming rather than leaving to be noticed.
            *
            There is no Deployment branch: the profile switch above *is* the
            deployment control, and it has to stay reachable while a resolution is
            in flight, which a branch of the resolved product cannot be. Security
            is not modelled in the IR at all. Artifacts need
            `capabilities.generate`, which this engine reports as `false`. */}
        {this.renderBranch("gears", "package", "Gears", entries.length, (
          <>
            {this.renderTwig("asked for", selected.length, (
              <>
                {selected.length === 0
                  ? <div className="gbx-empty">—</div>
                  : selected.map((id) =>
                      this.renderGearNode(product, id, { "data-asked-for": id }),
                    )}
              </>
            ))}
            {this.renderTwig("pulled in by the closure", pulled.length, (
              <>
                {pulled.length === 0
                  ? <div className="gbx-empty">—</div>
                  : pulled.map(({ id, why }) =>
                      this.renderGearNode(product, id, { "data-pulled-in": id }, why),
                    )}
              </>
            ))}
          </>
        ))}

        {this.renderBranch(
          "processes",
          "server-process",
          "Processes",
          product.processes.length,
          <>{product.processes.map((process) => this.renderProcess(process))}</>,
        )}

        {this.renderBranch(
          "contracts",
          "arrow-both",
          "Contracts",
          bindings.length,
          bindings.length === 0 ? (
            <div className="gbx-empty">No contract binding in this profile.</div>
          ) : (
            <>{bindings.map((binding) => this.renderBinding(binding))}</>
          ),
        )}

        {this.renderBranch(
          "cluster",
          "database",
          "Cluster",
          cluster.length,
          cluster.length === 0 ? (
            // Said rather than left blank: no gear in this product requests a
            // cluster scope, which is a fact about the product and not a gap.
            <div className="gbx-empty">No gear here requests a cluster primitive.</div>
          ) : (
            <>
              {cluster.map((binding) => (
                <div className="gbx-kv" key={`${binding.scope}/${binding.primitive}`}>
                  <span>
                    {binding.scope}/{binding.primitive}
                  </span>
                  <span>
                    {/* Asked-for beside resolved, as §9 requires: the two differ
                        whenever nothing was declared for this profile, and a panel
                        showing only the outcome hides that the SDK default is
                        standing in for a provider nobody chose. */}
                    asked {describeChoice(binding.selected.selected)} · got{" "}
                    <code>{describeClusterResolution(binding.resolved)}</code>
                    {" · for "}
                    {binding.requesters.join(", ")}
                    {/* `options` is deliberately not rendered. It carries whatever
                        the description passed -- connection strings among them --
                        and a panel that prints it wholesale is one schema change
                        away from putting a credential on screen
                        (`cpt-gearbox-fr-no-secrets-in-values`). The reference to
                        externally managed credentials is safe to name, because it
                        is a reference and never a credential. */}
                    {binding.secret_ref !== null && binding.secret_ref !== undefined && (
                      <>
                        {" · secret "}
                        <code>{binding.secret_ref}</code>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </>
          ),
        )}
      </>
    );
  }

  /**
   * One top-level branch: an icon, a name, a count, and a fold.
   *
   * The same fold idiom as the catalogue's categories, deliberately -- two panels
   * in one application should not invent two ways to collapse a list.
   */
  protected renderBranch(
    id: string,
    icon: string,
    title: string,
    count: number,
    children: React.ReactNode,
  ): React.ReactNode {
    const folded = this.collapsed.has(id);
    return (
      <div className="gbx-branch" key={id} data-branch={id}>
        <div
          className="gbx-group-label"
          role="button"
          tabIndex={0}
          aria-expanded={!folded}
          data-collapsed={folded ? "true" : "false"}
          onClick={() => this.toggle(id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              this.toggle(id);
            }
          }}
        >
          <span className={`gbx-twistie codicon codicon-chevron-${folded ? "right" : "down"}`} />
          <span className={`gbx-branch-icon codicon codicon-${icon}`} />
          {title}
          <span className="gbx-group-count">{count}</span>
        </div>
        {!folded && <div className="gbx-branch-body">{children}</div>}
      </div>
    );
  }

  /** A second level, without a fold of its own: two twigs do not need chrome. */
  protected renderTwig(title: string, count: number, children: React.ReactNode): React.ReactNode {
    return (
      <div className="gbx-twig" key={title}>
        <div className="gbx-twig-label">
          {title}
          <span className="gbx-group-count">{count}</span>
        </div>
        {children}
      </div>
    );
  }

  protected toggle(id: string): void {
    if (!this.collapsed.delete(id)) {
      this.collapsed.add(id);
    }
    this.update();
  }

  /**
   * One gear as a tree leaf: an icon saying what kind it is, a link to its
   * description, and the reason it is here when that is not "you asked".
   *
   * The icon is chosen from `selected_by`, not from the name: a gear is a plugin
   * because something selected it as one, and `*-plugin` in an id is a convention
   * rather than a fact.
   */
  protected renderGearNode(
    product: ResolvedProduct,
    id: string,
    attributes: Record<string, string>,
    why?: string,
  ): React.ReactNode {
    const gear = product.gears[id];
    const isPlugin = gear?.selected_by.some((reason) => reason.reason === "plugin_of") ?? false;
    return (
      <div className="gbx-leaf" key={id} {...attributes}>
        <span className={`gbx-leaf-icon codicon codicon-${isPlugin ? "plug" : "package"}`} />
        {this.renderGear(product, id)}
        {why !== undefined && <span className="gbx-leaf-why">{why}</span>}
      </div>
    );
  }

  /**
   * A gear id, as a link to its own description.
   *
   * The id used to be a `<code>` that only moved the Explain focus, while the
   * stylesheet gave it a pointer cursor and an underline on hover -- so it
   * promised navigation and delivered nothing visible unless Explain happened to
   * be open. It now opens the gear's `gear.gdl` *and* points Explain at it: both
   * answers to one click, and neither is a surprise.
   *
   * `source` and `gdl_path` come from the resolution itself
   * (`ResolvedGear`), so this needs nothing from the catalogue -- and they agree
   * with the catalogue's, which is what lets one `RevealService` serve both.
   */
  protected renderGear(
    product: ResolvedProduct,
    id: string,
    attributes: Record<string, string> = {},
  ): React.ReactNode {
    const gear = product.gears[id];
    if (gear === undefined) {
      // In the closure and absent from the gear table would be a resolver fault.
      // Rendered plainly rather than as a dead link.
      return (
        <code key={id} {...attributes}>
          {id}
        </code>
      );
    }
    return (
      <span key={id} className="gbx-gear-link" {...attributes}>
        <RevealLink
          reveals={this.reveals}
          source={gear.source}
          target={gear.gdl_path}
          label={id}
          onActivate={() => this.store.setFocus({ kind: "gear", id })}
        />
      </span>
    );
  }

  protected renderProcess(process: ResolvedProcess): React.ReactNode {
    const focus = this.store.focus;
    const selected = focus?.kind === "process" && focus.id === process.name;
    return (
      <div
        className={`gbx-row gbx-process ${selected ? "gbx-selected" : ""}`}
        key={process.name}
        data-process={process.name}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={() => this.store.setFocus({ kind: "process", id: process.name })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.store.setFocus({ kind: "process", id: process.name });
          }
        }}
      >
        <span className="gbx-row-name">{process.name}</span>
        <span className="gbx-badge">{process.kind}</span>
        {process.replicas > 1 && <span className="gbx-badge">×{process.replicas}</span>}
        {/* The gears are listed rather than counted because they may overlap
            another process: co-location is a closure, not a partition, and a
            count hides the gear that is linked into two binaries. */}
        <span className="gbx-process-gears">{process.gears.join(", ")}</span>
      </div>
    );
  }

  protected renderBinding(binding: ResolvedBinding): React.ReactNode {
    const focus = this.store.focus;
    const selected =
      focus?.kind === "binding" &&
      focus.consumer === binding.consumer &&
      focus.contract === binding.contract;
    return (
      <div
        className={`gbx-row gbx-binding ${selected ? "gbx-selected" : ""}`}
        key={`${binding.consumer}/${binding.contract}`}
        data-binding={`${binding.consumer}/${binding.contract}`}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={() =>
          this.store.setFocus({
            kind: "binding",
            consumer: binding.consumer,
            contract: binding.contract,
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.store.setFocus({
              kind: "binding",
              consumer: binding.consumer,
              contract: binding.contract,
            });
          }
        }}
      >
        <span className="gbx-row-name">
          {binding.consumer} → {binding.provider}
        </span>
        <span className="gbx-id">{binding.contract}</span>
        {/* `mode` is derived from placement and never configured, so showing it
            beside the transport is showing a conclusion, not an echo of the
            description (`cpt-gearbox-fr-derive-binding-from-placement`). */}
        <span className="gbx-badge" data-mode={binding.mode}>
          {binding.mode}
        </span>
        <span className="gbx-badge">{binding.transport}</span>
        {/* The mechanism names the real code path rather than an abstraction over
            it, which is what lets a reader check the lock against what the
            runtime does. */}
        <span className="gbx-badge" data-mechanism={binding.mechanism}>
          {binding.mechanism}
        </span>
        {binding.critical && <span className="gbx-badge">critical</span>}
        {/* "You asked for X and got Y, because GBXnnnn." The request lives beside
            the outcome precisely so this is an explanation rather than a
            surprise; the full narrative is Explain's job. */}
        {binding.selected.downgraded_by !== null &&
          binding.selected.downgraded_by !== undefined && (
            <span className="gbx-badge gbx-downgraded" data-downgraded-by={binding.selected.downgraded_by}>
              asked {describeChoice(binding.selected.selected)} · {binding.selected.downgraded_by}
            </span>
          )}
      </div>
    );
  }
}

/**
 * `sdk-cas-default` is not a provider, and saying "provider: x" for it would be
 * wrong in the one case worth noticing: the SDK's content-addressed default
 * layered over a cache, which is what a `dev` profile gets when nothing declared
 * a provider.
 */
function describeClusterResolution(resolution: ClusterResolution): string {
  return resolution.via === "provider"
    ? resolution.name
    : `sdk cas default over ${resolution.over_cache}`;
}

/** `auto` means "you decide", so it has no value to print. */
function describeChoice(choice: Choice<unknown>): string {
  return choice.choice === "explicit" ? String(choice.value) : "auto";
}

/**
 * Why a gear is in the product, in words.
 *
 * `plugin_of` names the profile as well as the host, because it is the only
 * inclusion reason that differs between profiles -- dev links the static plugin
 * and prod the OIDC one, from the same description.
 */
function describeInclusion(reason: InclusionReason): string {
  switch (reason.reason) {
    case "selected":
      return "asked for by the product";
    case "colocated_by":
      return `co-located with ${reason.gear}`;
    case "required_by_profile":
      return `required by profile ${reason.profile} (${reason.why})`;
    case "plugin_of":
      return `plugin of ${reason.host} for ${reason.profile}`;
  }
}

function renderDiagnostics(diagnostics: readonly Diagnostic[]): React.ReactNode {
  if (diagnostics.length === 0) return undefined;
  return (
    <div className="gbx-diagnostics">
      <div className="gbx-diagnostics-label">{diagnostics.length} diagnostic(s)</div>
      {diagnostics.map((diagnostic, index) => (
        <div
          className={`gbx-diagnostic gbx-diagnostic-${String(diagnostic.severity).toLowerCase()}`}
          key={`${diagnostic.code}-${index}`}
        >
          <span className="gbx-id">{diagnostic.code}</span>
          <span className="gbx-diagnostic-message">{diagnostic.message}</span>
        </div>
      ))}
    </div>
  );
}
