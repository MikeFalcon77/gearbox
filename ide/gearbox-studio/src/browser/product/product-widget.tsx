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

import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { CommandRegistry } from "@theia/core/lib/common";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { Choice } from "../../common/generated/Choice";
import type { DeploymentProfileDecl } from "../../common/generated/DeploymentProfileDecl";
import type { ClusterResolution } from "../../common/generated/ClusterResolution";
import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { Discovery } from "../../common/generated/Discovery";
import type { InclusionReason } from "../../common/generated/InclusionReason";
import type { ResolvedBinding } from "../../common/generated/ResolvedBinding";
import type { ResolvedProcess } from "../../common/generated/ResolvedProcess";
import type { ResolvedProduct } from "../../common/generated/ResolvedProduct";
import {
  DiagnosticsList,
  errorsIn,
  summarise,
  worstFirst,
} from "../diagnostics/diagnostics-list";
import { ProductStore } from "../product-store";
import { ProductEditService } from "../product-edit-service";
import { PendingCreateGear } from "../create/pending-create-gear";
import { ProductSessionService } from "../shell/product-session-service";
import { ADD_GEAR, NEW_GEAR, SHOW_CONFLICTS, SHOW_GENERATE } from "../shell/session-command-ids";
import { RevealLink, RevealPathLink } from "../reveal-link";
import { RevealService } from "../reveal-service";
import { SelectionService } from "../shell/selection-service";

/**
 * The stages of a product, in the order they are worked through.
 *
 * `generate` is deliberately absent: it is a view, and a tab that duplicated its
 * file plan and its Apply button would be a second place to answer the same
 * question. The strip links to it.
 */
export type ProductSection = "overview" | "gears" | "topology" | "validation";

const SECTIONS: readonly { readonly id: ProductSection; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "gears", label: "Gears" },
  { id: "topology", label: "Topology" },
  { id: "validation", label: "Validation" },
];

@injectable()
export class ProductWidget extends ReactWidget {
  static readonly ID = "gearbox.product";
  static readonly LABEL = "Gearbox Product";

  @inject(ProductStore) protected readonly store!: ProductStore;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  // Opening is the session's, not the store's: it decides the engine's roots and
  // write boundary, which is what makes a product outside this checkout editable.
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(RevealService) protected readonly reveals!: RevealService;
  // For the `explain` control on a diagnostic row: `Diagnostic.subject` names a
  // graph node so that a client can select it, and the Inspector is what answers
  // about a selection.
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
  @inject(PendingCreateGear) protected readonly pendingGear!: PendingCreateGear;

  /** Which branches are folded away. Widget state; nobody else's business. */
  protected collapsed = new Set<string>();

  /**
   * Which stage of the product a person is looking at.
   *
   * The panel had grown to the whole product on one strip -- header, profile
   * switch, profile fields, four foldable branches and a diagnostics line -- and
   * a UX pass reported it as a very long screen with no sense of where one is.
   * The four names are the stages of composing a product: what it *is*, what it
   * is *made of*, how that *deploys*, and what is *wrong with it*. Generate is
   * the fifth stage and stays a view of its own; the strip links to it rather
   * than reproducing a file plan and an Apply button in two places.
   *
   * Folds are kept underneath: a section with three processes and eight bindings
   * still wants them, and the two mechanisms answer different questions --
   * "which stage" and "how much of this stage".
   */
  protected section: ProductSection = "overview";
  protected addingProfile = false;
  protected newProfileId = "";
  protected newProfileKind: "embedded" | "host_workers" | "kubernetes" = "embedded";

  @postConstruct()
  protected init(): void {
    this.id = ProductWidget.ID;
    this.title.label = ProductWidget.LABEL;
    this.title.iconClass = codicon("project");
    this.title.caption = ProductWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-product");
    this.toDispose.push(this.store.onChanged(() => this.update()));
    this.toDispose.push(this.edits.onDraftChanged(() => this.update()));
    // An open takes two engine spawns; without this the panel renders its
    // "choose a product" list for three seconds while one is already opening.
    this.toDispose.push(this.session.onDidChangeOpening(() => this.update()));
    // **Constructing this panel no longer opens a product.** It used to call
    // `session.ensureOpen()`, which opened the only product it could find -- so
    // the application effectively had no Home: a reload, or anything that built
    // this widget, put a product back on screen with nobody having asked for one.
    // Home is a deliberate starting point now, and a product arrives by an
    // explicit act: the Continue card, the picker, or `File > Open Product...`.
    this.update();
  }

  /**
   * The Conflicts screen, by command, so the panel does not have to be injected.
   *
   * `SHOW_CONFLICTS`, not the view toggle: a summary line that hides the screen
   * when clicked is the defect `BROWSE_CATALOGUE` was introduced to avoid, and
   * here the thing being hidden is the reason the line exists.
   */
  protected showConflicts(): void {
    void this.commands.executeCommand(SHOW_CONFLICTS.id);
  }

  /** New Gear with destination under this product, then Add Gear for selection. */
  /**
   * New Gear, for *this* product.
   *
   * The product travels as a path and a label. A bare flag used to be the whole
   * context, so the panel knew a product existed and nothing about which one --
   * which is why the flow used to end in a notification asking the person to add
   * the gear themselves.
   */
  protected createGearForProduct(): void {
    const open = this.store.current.open;
    if (open === undefined) return;
    const productDir = open.path.replace(/\/[^/]+$/, "");
    this.pendingGear.state = {
      destinationDir: `${productDir}/gears`,
      product: { path: open.path, label: this.store.current.intent?.display_name ?? open.label },
    };
    void this.commands.executeCommand(NEW_GEAR.id);
  }

  /** Generate, by command that opens rather than toggles -- see `SHOW_GENERATE`. */
  protected showGenerate(): void {
    void this.commands.executeCommand(SHOW_GENERATE.id);
  }

  protected render(): React.ReactNode {
    const state = this.store.current;

    if (state.status === "error") {
      return (
        <div className="gbx-product">
          <div className="gbx-error" role="alert">
            {state.error}
          </div>
          {renderDiagnosticsSummary(state.diagnostics, () => this.showConflicts())}
        </div>
      );
    }

    // Opening, and saying so. `ProductSessionService` restarts the engine twice
    // to derive this product's source roots and write boundary, which is around
    // three seconds on this corpus -- long enough that a person who sees the
    // previous screen concludes the click missed. The name is the product's,
    // because "Loading..." with no subject is what an application that has lost
    // track of itself says.
    const opening = this.session.opening;
    if (state.open === undefined && opening !== undefined) {
      return (
        <div className="gbx-product">
          <div className="gbx-progress" data-product-opening={opening.label} aria-busy="true">
            Loading {opening.label}…
          </div>
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
                    type="button"
                    className="gbx-choice"
                    key={ref.path}
                    onClick={() => void this.session.open(ref)}
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

        <div className="gbx-product-actions">
          <button
            type="button"
            className="gbx-start-primary"
            data-add-gear
            onClick={() => void this.commands.executeCommand(ADD_GEAR.id)}
          >
            Add Gear
          </button>
          <button
            type="button"
            className="gbx-start-primary gbx-start-secondary"
            data-create-gear
            onClick={() => this.createGearForProduct()}
          >
            Create Gear
          </button>
        </div>

        {/* The stages, and a link to the fifth. `role="tablist"` with the same
            keyboard behaviour as the Graph's view switch, because two panels in
            one application should not invent two ways to do this. */}
        <div className="gbx-product-nav" role="tablist" aria-label="Product">
          {SECTIONS.map((section) => (
            <button
              type="button"
              key={section.id}
              role="tab"
              aria-selected={this.section === section.id}
              className={`gbx-view-tab ${this.section === section.id ? "gbx-view-tab-on" : ""}`}
              data-product-section={section.id}
              onClick={() => {
                this.section = section.id;
                this.update();
              }}
            >
              {section.label}
            </button>
          ))}
          <button
            type="button"
            className="gbx-start-link"
            data-product-section-generate
            onClick={() => this.showGenerate()}
          >
            Generate →
          </button>
        </div>

        {/* **Above the strip, on every stage.** The profile switch has to be
            reachable while a resolution is in flight -- §9 keeps it out of the
            resolved tree for exactly that reason -- and a person on Topology
            switching profiles is the ordinary way to compare two topologies. The
            per-profile *fields* are a different thing and live in Overview,
            because editing them is describing the product rather than reading
            it. */}
        {intent && (
          <>
            <div className="gbx-kv">
              <span>profile</span>
              <span className="gbx-profiles">
                {Object.keys(intent.profiles).map((id) => (
                  <button
                    type="button"
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
                <button
                  type="button"
                  className="gbx-choice"
                  data-add-profile
                  onClick={() => {
                    this.addingProfile = true;
                    this.newProfileId = "";
                    this.newProfileKind = "embedded";
                    this.update();
                  }}
                >
                  Add profile…
                </button>
              </span>
            </div>
            {this.addingProfile && this.renderAddProfile()}
            {this.section === "overview" &&
              state.profile !== undefined &&
              this.renderProfileEdit(
                intent.profiles[state.profile],
                state.profile,
                intent.default_profile,
              )}
          </>
        )}

        {state.status === "resolving" && <div className="gbx-progress">resolving…</div>}

        {product && this.renderSection(product)}

        {/* The summary line stays on every section **except Validation**. It is
            one line, it is the only thing on this panel that says something is
            wrong, and a person who has navigated to Topology is exactly the
            person who needs to know that the resolution complained. On Validation
            it would be a second, smaller copy of the summary that stage now opens
            with, next to a button duplicating the link below it -- which is the
            pair a UX pass called two nearly identical buttons. */}
        {this.section !== "validation" &&
          renderDiagnosticsSummary(state.diagnostics, () => this.showConflicts())}
      </div>
    );
  }

  /** Whichever stage is selected, rendered from the same resolution. */
  protected renderSection(product: ResolvedProduct): React.ReactNode {
    switch (this.section) {
      case "overview":
        return this.renderOverview(product);
      case "gears":
        return this.renderGears(product);
      case "topology":
        return this.renderTopology(product);
      case "validation":
        return this.renderValidation();
    }
  }

  protected renderAddProfile(): React.ReactNode {
    return (
      <div className="gbx-profile-add" data-profile-add>
        <label>
          id
          <input
            data-profile-new-id
            value={this.newProfileId}
            onChange={(e) => {
              this.newProfileId = e.target.value;
              this.update();
            }}
          />
        </label>
        <label>
          kind
          <select
            data-profile-new-kind
            value={this.newProfileKind}
            onChange={(e) => {
              this.newProfileKind = e.target.value as typeof this.newProfileKind;
              this.update();
            }}
          >
            <option value="embedded">embedded</option>
            <option value="host_workers">host_workers</option>
            <option value="kubernetes">kubernetes</option>
          </select>
        </label>
        <button
          type="button"
          className="gbx-choice"
          data-profile-add-confirm
          onClick={() => void this.confirmAddProfile()}
        >
          Add
        </button>
        <button
          type="button"
          className="gbx-choice"
          data-profile-add-cancel
          onClick={() => {
            this.addingProfile = false;
            this.update();
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  protected renderProfileEdit(
    profile: DeploymentProfileDecl | undefined,
    id: string,
    defaultProfile: string,
  ): React.ReactNode {
    if (profile === undefined) return undefined;
    const fields = profileFields(profile).map(({ wire, label, value, choices }) => ({
      wire,
      label,
      choices,
      value: this.edits.draftProfileField(id, wire, value ?? undefined),
    }));
    return (
      <div
        className="gbx-profile-edit"
        data-profile-edit={id}
        // Keyed on the *service's* epoch, not on a counter of this widget's own.
        // The draft is one object shared with the Inspector, and a Discard from
        // either place has to remount both -- see `ProductEditService.epoch`.
        key={`profile-${id}-${this.edits.epoch}`}
      >
        <div className="gbx-kv">
          <span>kind</span>
          <span title="Profile kind is fixed at creation; remove and re-add to change it.">
            {profile.profile}
          </span>
        </div>
        {fields.map(({ wire, label, value, choices }) => (
          <div className="gbx-kv" key={wire}>
            <label htmlFor={`gbx-profile-${id}-${wire}`}>{label}</label>
            <span>
              {choices !== undefined ? (
                <select
                  id={`gbx-profile-${id}-${wire}`}
                  value={value ?? ""}
                  aria-label={label}
                  data-profile-field={wire}
                  data-field-modified={
                    this.edits.isDraftedProfileField(id, wire) ? "true" : undefined
                  }
                  onChange={(e) =>
                    this.edits.queueDraft({
                      kind: "set_profile_field",
                      profile: id,
                      field: wire,
                      value: e.target.value === "" ? null : e.target.value,
                    })
                  }
                >
                  {/* The unset case is a value: a profile that declares no
                      discovery gets the SDK's default, and offering only the two
                      named ones would make "not set" unreachable once something
                      had been chosen. */}
                  <option value="">not set</option>
                  {choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              ) : (
              <input
                id={`gbx-profile-${id}-${wire}`}
                value={value ?? ""}
                aria-label={label}
                data-profile-field={wire}
                // Which control the unapplied edit is in. The `Apply changes` /
                // `Discard` pair is one per product and lives in the header, so
                // the marker is what says *here*.
                data-field-modified={this.edits.isDraftedProfileField(id, wire) ? "true" : undefined}
                onChange={(e) =>
                  this.edits.queueDraft({
                    kind: "set_profile_field",
                    profile: id,
                    field: wire,
                    value: e.target.value === "" ? null : e.target.value,
                  })
                }
              />
              )}
            </span>
          </div>
        ))}
        {id !== defaultProfile && (
          <button
            type="button"
            className="gbx-choice"
            data-remove-profile={id}
            onClick={() => void this.edits.removeProfile(id).then(() => this.update())}
          >
            Remove profile
          </button>
        )}
      </div>
    );
  }

  protected async confirmAddProfile(): Promise<void> {
    const id = this.newProfileId.trim();
    if (id === "") return;
    const ok = await this.edits.addProfile(this.newProfileKind, id, []);
    if (ok) {
      this.addingProfile = false;
      this.newProfileId = "";
      this.update();
    }
  }

  /**
   * The resolved header and the description's own file.
   *
   * What the product *is*: which profile answered, which lock that produced, and
   * where the description lives. The profile switch is rendered above this, not
   * here -- it has to be reachable while a resolution is in flight, which a row
   * rendered from the resolved product cannot be.
   */
  protected renderOverview(product: ResolvedProduct): React.ReactNode {
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

      </>
    );
  }

  /**
   * What the product is made of, in two lists that mean different things.
   *
   * `asked for` is the description's own `use_gear` entries; everything else is
   * here because the closure pulled it in, and each of those carries the reason.
   * Keeping them apart is the panel's most-praised property and predates the
   * sections.
   */
  /*
   * Vision §60 sketches the product as a tree -- Deployment, Gears, Contracts,
   * Cluster, Edge, Security, Artifacts -- and the sections are that, with four
   * departures worth naming rather than leaving to be noticed.
   *
   * There is no Deployment section: the profile switch above the strip *is* the
   * deployment control, and it has to stay reachable while a resolution is in
   * flight, which anything rendered from the resolved product cannot be.
   * Security is not modelled in the IR at all. Artifacts live in the Generate
   * view, which the strip links to. And Contracts and Cluster are inside
   * Topology rather than beside it, because a binding's `mode` is a consequence
   * of which processes its ends landed in, and a reader checking that needs both
   * at once.
   */
  protected renderGears(product: ResolvedProduct): React.ReactNode {
    const entries = Object.entries(product.gears);
    const selected = entries
      .filter(([, gear]) => gear.selected_by.some((reason) => reason.reason === "selected"))
      .map(([id]) => id);
    const pulled = entries
      .filter(([, gear]) => !gear.selected_by.some((reason) => reason.reason === "selected"))
      .map(([id, gear]) => ({ id, why: gear.selected_by.map(describeInclusion).join("; ") }));

    return (
      <>
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

      </>
    );
  }

  /**
   * How the product deploys: processes, the bindings between them, and the
   * cluster primitives it asks for.
   *
   * One section rather than three tabs, because the three are read together --
   * a binding's `mode` is a consequence of which processes its ends landed in,
   * and a reader checking that needs both on screen.
   */
  protected renderTopology(product: ResolvedProduct): React.ReactNode {
    const bindings = product.bindings ?? [];
    const cluster = product.cluster ?? [];

    return (
      <>
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
   * What the resolution could not decide, and the way to the screen about it.
   *
   * Deliberately thin: `ConflictsWidget` is the domain screen for this array --
   * it carries the code, the help sentence, the related locations and the
   * evidence -- and §9.1 already recorded why the Product view keeps a summary
   * rather than a second full list. This section is the summary with room for the
   * sentence that says where to go.
   */
  /**
   * The diagnostics, read here rather than pointed at.
   *
   * **This stage used to be a doorway.** It rendered two counts and two nearly
   * identical buttons -- `Open Conflicts` and `Show conflicts` -- while the rows
   * that carry the code, the remedy and the location lived only on the Conflicts
   * screen. A stage whose entire content is a way to leave it is not a stage, and
   * a person who navigated to Validation had navigated to the wrong place by
   * definition. eCos shows the list with its counts; DaVinci treats validation as
   * a step of its own before generation. This is that.
   *
   * Summary first, then the list. The counts are the orientation -- how bad is
   * this, and is it blocking -- and orientation before detail is the order every
   * screen in this application reads in.
   *
   * `Open Conflicts` stays, demoted to one link, because the bottom panel is
   * still where the list is read *while* looking at the tree that caused it.
   * Duplication was never the objection; a screen made only of navigation was.
   */
  protected renderValidation(): React.ReactNode {
    const diagnostics = worstFirst(this.store.current.diagnostics);
    const errors = errorsIn(diagnostics);
    const warnings = diagnostics.filter((d) => d.severity === "warning").length;
    return (
      <div className="gbx-validation" data-product-validation>
        <div className="gbx-validation-head">
          <span className="gbx-conflicts-summary">{summarise(diagnostics.length, errors)}</span>
          <div className="gbx-kv">
            <span>errors</span>
            <span data-validation-errors={errors}>{errors}</span>
          </div>
          <div className="gbx-kv">
            <span>warnings</span>
            <span data-validation-warnings={warnings}>{warnings}</span>
          </div>
        </div>
        {diagnostics.length === 0 ? (
          <div className="gbx-empty">
            This profile resolved with nothing to report. Another profile may not: the same
            description resolves differently under each one.
          </div>
        ) : (
          <>
            <DiagnosticsList
              diagnostics={diagnostics}
              sorted
              onReveal={(location) => void this.reveals.revealLocation(location)}
              onExplain={(selection) => this.selection.select(selection)}
            />
            <button
              type="button"
              className="gbx-choice"
              data-validation-open-conflicts
              title="The same list in the bottom panel, readable beside the tree"
              onClick={() => this.showConflicts()}
            >
              Open beside the tree
            </button>
          </>
        )}
      </div>
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
 * The fields a profile of this kind has, with the values it holds.
 *
 * `choices` is what turns a text box into a select. It is only ever a closed set
 * the wire already declares -- `Discovery` is `"static" | "directory"` -- and the
 * point is not tidiness: a free-text field for a two-valued enum invites a typo
 * that reaches the description, and the refusal for it comes from the evaluator
 * on the next resolve rather than from the control.
 */
function profileFields(
  profile: DeploymentProfileDecl,
): ReadonlyArray<{
  wire: string;
  label: string;
  value: string | null | undefined;
  choices?: readonly string[];
}> {
  // Named once: both profile kinds carry a `discovery`, under two different wire
  // names, and the set of values is the same `Discovery` in both.
  const discovery: readonly Discovery[] = ["static", "directory"];
  switch (profile.profile) {
    case "embedded":
      return [];
    case "host_workers":
      return [
        { wire: "host", label: "host", value: profile.host },
        {
          wire: "worker_discovery",
          label: "worker_discovery",
          value: profile.discovery,
          choices: discovery,
        },
        { wire: "target_dir", label: "target_dir", value: profile.target_dir },
        { wire: "cargo_profile", label: "cargo_profile", value: profile.cargo_profile },
      ];
    case "kubernetes":
      return [
        { wire: "discovery", label: "discovery", value: profile.discovery, choices: discovery },
        { wire: "namespace", label: "namespace", value: profile.namespace },
        { wire: "image_registry", label: "image_registry", value: profile.image_registry },
      ];
  }
}

/**
 * `sdk-cas-default` is not a provider, and saying "provider: x" for it would be
 * wrong in the one case worth noticing: the SDK's content-addressed default
 * layered over a cache, which is what a `dev` profile gets when nothing declared
 * a provider.
 */
function describeClusterResolution(resolution: ClusterResolution): string {
  switch (resolution.via) {
    case "provider":
      return resolution.name;
    case "sdk-cas-default":
      return `sdk cas default over ${resolution.over_cache}`;
    // A named provider with an empty name used to stand here, which read as a
    // provider called nothing. A switch rather than a ternary so the next
    // variant is a compile error in this file instead of a blank cell.
    case "unsatisfied":
      return "unsatisfied";
  }
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

/**
 * A summary that leads to the conflicts, rather than the conflicts themselves.
 *
 * This used to print every diagnostic under the tree, and the Conflicts screen now
 * prints the same ones with the parts that matter for acting on them -- the help
 * sentence, the related locations, the evidence, the subject to explain. Two full
 * lists is duplication, and the version squeezed under a tree was the one nobody
 * could act on. eCos's Config Tool makes conflicts a screen for exactly this
 * reason.
 *
 * §9 asks the Product view for "a diagnostics summary", which is what this is: a
 * count, the worst severity, and the way to the detail.
 */
function renderDiagnosticsSummary(
  diagnostics: readonly Diagnostic[],
  show: () => void,
): React.ReactNode {
  if (diagnostics.length === 0) return undefined;
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const worst = errors > 0 ? "error" : (diagnostics[0]?.severity ?? "info");
  return (
    <div className={`gbx-diagnostics gbx-diagnostics-${String(worst).toLowerCase()}`}>
      <div className="gbx-diagnostics-label">
        {diagnostics.length} diagnostic(s)
        {errors > 0 && `, ${errors} blocking`}
      </div>
      <button type="button" className="gbx-choice" data-show-conflicts onClick={show}>
        Show conflicts
      </button>
    </div>
  );
}
