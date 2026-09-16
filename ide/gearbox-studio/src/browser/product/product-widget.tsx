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
import type { ResolvedApplication } from "../../common/generated/ResolvedApplication";
import type { ResolvedProduct } from "../../common/generated/ResolvedProduct";
import type { ProductRef } from "../../common/protocol";
import {
  DiagnosticsList,
  errorsIn,
  summarise,
  worstFirst,
  worstOf,
} from "../diagnostics/diagnostics-list";
import { ProductStore } from "../product-store";
import { GenerateService } from "../generate/generate-service";
import { ProductEditService } from "../product-edit-service";
import { PendingCreateGear } from "../create/pending-create-gear";
import {
  OPENING_LABEL,
  OPENING_STAGES,
  ProductSessionService,
  type OpeningState,
} from "../shell/product-session-service";
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
  // Read only. Overview reports whether a plan exists; it never asks for one --
  // see `renderGenerationStatus`.
  @inject(GenerateService) protected readonly generate!: GenerateService;
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
   * Folds are kept underneath: a section with three applications and eight bindings
   * still wants them, and the two mechanisms answer different questions --
   * "which stage" and "how much of this stage".
   */
  protected section: ProductSection = "overview";

  /**
   * The product whose errors have already chosen a stage.
   *
   * Keyed on the open product's path, so the landing below happens when a
   * product arrives and not again while it is being worked on.
   *
   * **Per resolution was the obvious key and it was wrong.** `ProductStore`
   * bumps its revision on every piece of work it starts, and editing a
   * description is a stream of them -- so a draft that momentarily resolved with
   * an error moved the stage out from under someone who was typing into it.
   * `adr-0013-create-product` caught it: the config key input went from visible
   * to detached mid-`fill`, and the failure read as a timeout on an element that
   * was plainly there. Arriving at a product is the event this is about.
   */
  protected stagedFor: string | undefined;
  protected addingProfile = false;
  protected newProfileId = "";
  protected newProfileKind: "embedded" | "self_hosted" | "kubernetes" = "embedded";

  @postConstruct()
  protected init(): void {
    this.id = ProductWidget.ID;
    this.title.label = ProductWidget.LABEL;
    this.title.iconClass = codicon("project");
    this.title.caption = ProductWidget.LABEL;
    this.title.closable = true;
    this.addClass("gbx-widget-product");
    this.toDispose.push(
      this.store.onChanged(() => {
        this.landOnErrors();
        this.update();
      }),
    );
    this.toDispose.push(this.edits.onDraftChanged(() => this.update()));
    // Overview reports whether a generated tree exists, so it has to hear when
    // that answer changes -- a plan arriving, an apply writing, or the plan being
    // dropped as stale. Subscribing rather than polling, and reading rather than
    // asking: see `renderGenerationStatus`.
    this.toDispose.push(this.generate.onChanged(() => this.update()));
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
   * A resolution that carries errors opens on the stage that shows them.
   *
   * **Only for errors, and only once.** Warnings and hints are the ordinary
   * state of a healthy product -- the demo resolves with four of them under two
   * profiles -- so moving for those would move for everything and stop meaning
   * anything. An error is different: it is what stops the lock being written.
   *
   * Moves *to* Validation and never away from it: the stage a person chose is
   * theirs, and a later store event must not take it back. Guarded by the open
   * product rather than by the store revision -- see `stagedFor` for why the
   * narrower key is the correct one and what the wider one broke.
   *
   * The second panel is deliberately not opened. `ConflictsViewContribution`
   * argues that a panel appearing at startup to say "no conflicts" says
   * nothing, and it is withdrawn on every product change besides. Showing the
   * stage that is already there is the cheaper answer to the same need.
   *
   * **The positive path is unobserved on this corpus, and saying so is the
   * point.** No product in the tree resolves with an error -- the demo carries
   * two warnings and an info under `embedded` and four and an info under the
   * other two -- so no suite reaches the branch that moves the stage. What is
   * asserted is that it does *not* fire for warnings, which is the half that
   * broke something. Producing the other half would mean writing an error into
   * `products/`, which the three guards on the descriptions exist to prevent and
   * rightly; it returns as soon as the corpus has a product that resolves with
   * one.
   */
  protected landOnErrors(): void {
    const state = this.store.current;
    const path = state.open?.path;
    if (path === undefined) return;
    // Mid-flight: the diagnostics on screen still describe the previous answer.
    if (state.status === "loading" || state.status === "resolving") return;
    // Never while an edit is pending. A draft is a person mid-sentence, and its
    // resolution is a question about what they have typed so far -- not an
    // answer to move the screen for.
    if (this.edits.hasDraft()) return;
    if (this.stagedFor === path) return;
    this.stagedFor = path;
    if (errorsIn(state.diagnostics) > 0) {
      this.section = "validation";
    }
  }

  /**
   * How many diagnostics the Validation stage holds, and how bad the worst is.
   *
   * **A signpost, not a second summary.** The list, the per-severity counts and
   * the explain controls all already live on that stage; what was missing was
   * any reason to go there. The strip drew four bare labels, Overview reported
   * no number at all, and the one visible affordance -- `Show conflicts` -- sent
   * a person to a separate panel at the bottom rather than to the stage that
   * answers the same question in place.
   *
   * Nothing when there is nothing: a tab that always carries a `0` trains the
   * reader to stop seeing it, which is the same argument that keeps the
   * Conflicts panel from opening at startup to say "no conflicts".
   */
  protected renderStageCount(diagnostics: readonly Diagnostic[]): React.ReactNode {
    if (diagnostics.length === 0) return undefined;
    const worst = worstOf(diagnostics) ?? "info";
    return (
      <span
        className={`gbx-stage-count gbx-stage-count-${worst}`}
        data-validation-count={diagnostics.length}
        data-validation-worst={worst}
        // The words, because the colour alone cannot say which of four
        // severities this is -- the same rule the config fields follow.
        title={summarise(diagnostics.length, errorsIn(diagnostics))}
      >
        {diagnostics.length}
      </span>
    );
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

  /**
   * Leave a refused open, and put the session back where it was.
   *
   * **Re-opening, not merely dismissing, and the difference is not cosmetic.**
   * The first step of an open re-initializes the engine on the *new* product's
   * folder -- that is what the `workspace` step is -- so a refusal at `describe`
   * or `catalogue` leaves the store holding A while the engine is pointed at B.
   * Clearing the screen alone would show A looking perfectly healthy while
   * Resolve, an edit and Generate all went through a session configured for a
   * product that never opened, with B's write boundary.
   *
   * So the way out of a refusal is the same act as opening A in the first place:
   * it re-runs the four steps and the engine ends up where the screen says it is.
   * With no previous product there is no session to restore and dismissing is the
   * whole of it.
   */
  protected leaveFailedOpen(previous: ProductRef | undefined): void {
    this.session.dismissOpening();
    if (previous === undefined) return;
    void this.session.open(previous);
  }

  protected render(): React.ReactNode {
    const state = this.store.current;

    // Opening, and saying which part of it. `ProductSessionService` restarts the
    // engine twice to derive this product's source roots and write boundary,
    // which is around three seconds on this corpus -- long enough that a person
    // who sees the previous screen concludes the click missed. The name is the
    // product's, because "Loading..." with no subject is what an application that
    // has lost track of itself says.
    //
    // **By identity, not by "nothing is open".** Testing `state.open ===
    // undefined` meant that switching from one product to another showed the
    // *old* product for the whole three seconds -- and, if the new one refused,
    // hid the refusal completely: the store still held the previous product, so
    // the panel had something to render and rendered that.
    //
    // **And before the error branch, which is the other half of the same
    // mistake.** A store holding a *failed* A answered `status === "error"` first,
    // so opening B kept A's error on screen for the whole open and then in place
    // of B's own refusal. A product's error is the product's; it must not outlive
    // the moment another product becomes the subject.
    //
    // Once the store holds the product being opened, the panel is that product's
    // and its own `resolving…` line and error box take over -- which is why a
    // refusal at `resolve` is not shown here: by then the product *is* the
    // subject, and its error belongs beside it rather than in a checklist.
    const opening = this.session.openingProgress;
    if (opening.status !== "idle" && state.open?.path !== opening.product.path) {
      return (
        <div className="gbx-product">
          {renderOpening(opening, state.open, (previous) => this.leaveFailedOpen(previous))}
        </div>
      );
    }

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
              {/* **The signpost that was missing.** Validation already renders
                  the whole list with its counts, one click away, and nothing
                  said so: the strip drew four bare labels, and the only visible
                  affordance sent people to a second panel at the bottom
                  instead. The count is on the tab because that is where a
                  person looks to decide which stage to open. */}
              {section.id === "validation" && this.renderStageCount(state.diagnostics)}
            </button>
          ))}
          {/* **Still a link out, now a visible one.** That it navigates rather
              than being a fifth stage is deliberate and unchanged -- "a tab
              holding a file plan and an Apply button would be a second answer to
              a question the Generate view already answers". What changes is the
              weight: `gbx-start-link` drew the last step of composing a product
              as body text in link colour, at the end of a row of four tabs. */}
          <button
            type="button"
            className="gbx-view-tab gbx-view-tab-next"
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

  /** Move to a stage, from somewhere other than the strip. */
  protected showSection(section: ProductSection): void {
    this.section = section;
    this.update();
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
            <option value="self_hosted">self_hosted</option>
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
              visible in the application count, the binding modes and which plugin was
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

        {this.renderShape(product)}
        {this.renderGenerationStatus()}
        {this.renderSources()}
      </>
    );
  }

  /**
   * What this product *is*, in the four numbers the other stages each hold one of.
   *
   * The stage was two rows -- the profile and a link to the file -- which made
   * Overview the emptiest screen in the application and the one every open lands
   * on. Every number here is already in `ProductStore.current`, so this reads
   * rather than asks; each one links to the stage that can be acted on, because a
   * count with no way through is trivia.
   *
   * Asked-for against pulled-in is the same split `renderGears` computes, from
   * the same field, for the reason that split exists at all: a closure that a
   * person did not ask for is the thing about this model that surprises people.
   */
  protected renderShape(product: ResolvedProduct): React.ReactNode {
    const entries = Object.entries(product.gears);
    const asked = entries.filter(([, gear]) =>
      gear.selected_by.some((reason) => reason.reason === "selected"),
    ).length;
    const applications = product.applications.length;
    const bindings = (product.bindings ?? []).length;
    const cluster = (product.cluster ?? []).length;
    return (
      <div className="gbx-overview-figures" data-overview-figures>
        <button
          type="button"
          className="gbx-figure"
          data-figure="gears"
          onClick={() => this.showSection("gears")}
        >
          <span className="gbx-figure-value" data-overview-gears={entries.length}>
            {entries.length}
          </span>
          <span className="gbx-figure-label">
            gears — {asked} asked for, {entries.length - asked} pulled in
          </span>
        </button>
        <button
          type="button"
          className="gbx-figure"
          data-figure="applications"
          onClick={() => this.showSection("topology")}
        >
          <span className="gbx-figure-value" data-overview-applications={applications}>
            {applications}
          </span>
          <span className="gbx-figure-label">
            {applications === 1 ? "application" : "applications"}
            {bindings > 0 && `, ${bindings} ${bindings === 1 ? "binding" : "bindings"}`}
            {cluster > 0 && `, ${cluster} in the cluster`}
          </span>
        </button>
      </div>
    );
  }

  /**
   * Whether a generated tree exists for this resolution.
   *
   * **Read from the cache, never planned from here.** `GenerateService.ensurePlan`
   * is a round trip to the engine, and calling it from a render would make
   * arriving on a screen do work -- once per paint, on a panel that repaints on
   * every store change. So this reports what the service happens to know: "not
   * planned yet" is an honest answer and a link, not a reason to go and find out.
   */
  protected renderGenerationStatus(): React.ReactNode {
    const generate = this.generate.current;
    const plans = generate.plan?.plans ?? [];
    const writes = plans.filter((plan) => plan.action !== "unchanged").length;
    const summary =
      generate.status === "planning"
        ? "planning…"
        : generate.status === "error"
          ? (generate.error ?? "the last plan failed")
          : generate.plan === undefined
            ? "not planned for this resolution yet"
            : writes === 0
              ? `${plans.length} files, all unchanged`
              : `${writes} of ${plans.length} files would change`;
    return (
      <div className="gbx-kv">
        <span>generated tree</span>
        <span className="gbx-links" data-overview-generate={generate.status}>
          {summary}{" "}
          <button
            type="button"
            className="gbx-conflict-explain"
            data-overview-open-generate
            onClick={() => this.showGenerate()}
          >
            open Generate
          </button>
        </span>
      </div>
    );
  }

  /**
   * The source roots this product declares, as written.
   *
   * From the *intent* rather than from the resolution: what a person can change
   * is what the description says, and a root that failed to load is exactly the
   * one worth seeing named. `at` is relative to the description's own directory,
   * which is how the IR defines it, so it is shown as written rather than
   * resolved -- the resolved form is an absolute path nobody typed.
   *
   * **Not links, and the earlier version of this comment promised otherwise.** A
   * source root is a directory, and `RevealPathLink` opens a file in the editor;
   * a link that resolves to a folder either does nothing or opens something
   * arbitrary inside it. The description itself is one row above and is openable,
   * which is where a person goes to change any of this.
   */
  protected renderSources(): React.ReactNode {
    const intent = this.store.current.intent;
    const sources = Object.entries(intent?.sources ?? {});
    if (sources.length === 0) return undefined;
    return (
      <div className="gbx-kv">
        <span>{sources.length === 1 ? "source" : "sources"}</span>
        <span className="gbx-links" data-overview-sources={sources.length}>
          {sources.map(([id, source]) => (
            <span className="gbx-badge" key={id} data-overview-source={id}>
              {id} · {source.kind === "path" ? source.at : source.kind}
            </span>
          ))}
        </span>
      </div>
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
   * of which applications its ends landed in, and a reader checking that needs both
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
   * How the product deploys: applications, the bindings between them, and the
   * cluster primitives it asks for.
   *
   * One section rather than three tabs, because the three are read together --
   * a binding's `mode` is a consequence of which applications its ends landed in,
   * and a reader checking that needs both on screen.
   */
  protected renderTopology(product: ResolvedProduct): React.ReactNode {
    const bindings = product.bindings ?? [];
    const cluster = product.cluster ?? [];

    return (
      <>
        {this.renderBranch(
          "applications",
          "server-process",
          "Applications",
          product.applications.length,
          <>{product.applications.map((application) => this.renderApplication(application))}</>,
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

  protected renderApplication(application: ResolvedApplication): React.ReactNode {
    const focus = this.store.focus;
    const selected = focus?.kind === "application" && focus.id === application.name;
    return (
      <div
        className={`gbx-row gbx-application ${selected ? "gbx-selected" : ""}`}
        key={application.name}
        data-application={application.name}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={() => this.store.setFocus({ kind: "application", id: application.name })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.store.setFocus({ kind: "application", id: application.name });
          }
        }}
      >
        <span className="gbx-row-name">{application.name}</span>
        <span className="gbx-badge">{application.kind}</span>
        {application.replicas > 1 && <span className="gbx-badge">×{application.replicas}</span>}
        {/* The gears are listed rather than counted because they may overlap
            another application: co-location is a closure, not a partition, and a
            count hides the gear that is linked into two binaries. */}
        <span className="gbx-application-gears">{application.gears.join(", ")}</span>
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
    case "self_hosted":
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
/**
 * The four steps of an open, and which one it is on.
 *
 * **A checklist rather than a spinner, because three seconds is long enough for
 * "which three seconds" to matter.** Opening a product restarts the engine twice
 * and loads a catalogue; a person watching one line that says `Loading
 * payments-demo…` cannot tell a slow catalogue from a description that will
 * never evaluate. Each step says what it is waiting for, in the words a person
 * would use rather than the method names underneath.
 *
 * And a refusal stops the list at the step that refused, with its reason. The
 * message service still gets it -- a refusal nobody saw looks like a hang -- but
 * the screen that was counting the steps is where the answer belongs, rather
 * than the screen reverting to a picker as though nothing had been tried.
 */
type StepState = "done" | "busy" | "waiting" | "failed";

/**
 * The icon per step state, as literal `codicon(...)` calls.
 *
 * A table rather than a conditional inside the call, so that the names are
 * statically visible: `regression.spec.ts` reads `codicon("x")` out of these
 * sources and checks each against the codicon stylesheet, and a name assembled
 * from a ternary escapes that check silently.
 *
 * `waiting` is an outline and `done` is a tick, and the difference is the point:
 * a checklist that pre-ticks its steps is a progress bar in a costume.
 */
const STEP_ICON: Readonly<Record<StepState, string>> = {
  done: codicon("pass"),
  busy: codicon("circle-large-outline"),
  waiting: codicon("circle-large-outline"),
  failed: codicon("error"),
};

function renderOpening(
  opening: Exclude<OpeningState, { status: "idle" }>,
  previous: ProductRef | undefined,
  leave: (previous: ProductRef | undefined) => void,
): React.ReactNode {
  const at = OPENING_STAGES.indexOf(opening.stage);
  const failed = opening.status === "failed";
  return (
    <div
      className="gbx-opening"
      data-product-opening={opening.product.label}
      data-opening-stage={opening.stage}
      data-opening-status={opening.status}
      aria-busy={!failed}
      role={failed ? "alert" : "status"}
    >
      <div className="gbx-opening-head">
        {failed ? `Could not open ${opening.product.label}` : `Opening ${opening.product.label}…`}
      </div>
      <ol className="gbx-opening-steps">
        {OPENING_STAGES.map((stage, index) => {
          // Three states, and the third is why this is not a progress bar: done,
          // the one in flight, and not yet reached. A step that never ran must
          // not read as a step that passed.
          const state: StepState =
            index < at ? "done" : index === at ? (failed ? "failed" : "busy") : "waiting";
          return (
            <li key={stage} className={`gbx-opening-step gbx-opening-${state}`} data-step={stage}>
              <span className={`${STEP_ICON[state]} gbx-opening-icon`} />
              <span>{OPENING_LABEL[stage]}</span>
            </li>
          );
        })}
      </ol>
      {failed && (
        <>
          <div className="gbx-error" data-opening-reason>
            {opening.reason}
          </div>
          {/* A refusal is left standing, which means it has to be leavable: with
              another product still open in the store, this screen is the only
              thing between a person and the product they had -- and getting back
              to it means re-opening it, not just clearing this. See
              `leaveFailedOpen`. */}
          <button
            type="button"
            className="gbx-choice"
            data-opening-dismiss
            data-opening-reopen={previous?.path ?? ""}
            onClick={() => leave(previous)}
          >
            {previous === undefined ? "Dismiss" : `Back to ${previous.label}`}
          </button>
        </>
      )}
      {!failed && (
        <div className="gbx-skeleton" aria-hidden="true">
          <span className="gbx-skeleton-row" />
          <span className="gbx-skeleton-row" />
          <span className="gbx-skeleton-row" />
        </div>
      )}
    </div>
  );
}

function renderDiagnosticsSummary(
  diagnostics: readonly Diagnostic[],
  show: () => void,
): React.ReactNode {
  if (diagnostics.length === 0) return undefined;
  const errors = errorsIn(diagnostics);
  // `worstOf`, not `diagnostics[0].severity`. The engine orders by `(code,
  // message)` for determinism, so the first element is the lowest code: a
  // product carrying `GBX0504` (info) and `GBX0602` (warning) painted itself
  // info-coloured. The `errors > 0` branch was covering for that and only for
  // the top severity.
  const worst = worstOf(diagnostics) ?? "info";
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
