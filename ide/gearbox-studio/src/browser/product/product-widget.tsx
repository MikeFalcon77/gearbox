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
import { CatalogueStore } from "../catalogue-store";
import { Composition } from "./composition";
import { GearBlurb, GearDocs, GearHeading, InclusionReasons } from "../gear/gear-facts";
import { GearSettings } from "./gear-settings";
import { PluginSettings } from "./plugin-settings";
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
import { RevealPathLink } from "../reveal-link";
import { RevealService } from "../reveal-service";
import { SelectionService, type Selection } from "../shell/selection-service";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";

/**
 * The stages of a product, in the order they are worked through.
 *
 * `generate` is deliberately absent: it is a view, and a tab that duplicated its
 * file plan and its Apply button would be a second place to answer the same
 * question. The strip links to it.
 */
export type ProductSection = "overview" | "composition" | "topology" | "validation";

const SECTIONS: readonly { readonly id: ProductSection; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "composition", label: "Composition" },
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
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(PendingCreateGear) protected readonly pendingGear!: PendingCreateGear;

  /** Which branches are folded away. Widget state; nobody else's business. */
  protected collapsed = new Set<string>();
  /**
   * Which Composition hosts are folded shut.
   *
   * A second set rather than a prefix in `collapsed`: the two trees fold
   * different things -- a topology branch is an application, a composition host
   * is a gear -- and one id can legitimately be both.
   */
  protected foldedHosts = new Set<string>();

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
  protected section: ProductSection = "composition";

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
  protected newProfileHost = "localhost";
  protected newProfileDiscovery = "static";
  protected newProfileKind: "embedded" | "self_hosted" | "kubernetes" = "embedded";

  @postConstruct()
  protected init(): void {
    this.toDispose.push(this.selection.onDidChange(() => this.update()));
    this.toDispose.push(this.catalogue.onChanged(() => this.update()));
    this.id = ProductWidget.ID;
    this.title.label = ProductWidget.LABEL;
    this.title.iconClass = codicon("project");
    this.title.caption = ProductWidget.LABEL;
    this.title.closable = true;
    this.addClass("gbx-widget-product");
    this.toDispose.push(
      this.store.onChanged(() => {
        this.stageForOpenProduct();
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
    //
    // **Staged before the first render, not only on the next store event.** The
    // subscription above covers the common path, where this panel exists and a
    // product arrives afterwards. It does not cover a panel built while a
    // product is *already* resolved -- closing and reopening the Product view --
    // because no store event follows, and the widget would sit on Overview with
    // the errors one tab away. Idempotent by the guards inside: `stagedFor`
    // fires once per open product.
    this.stageForOpenProduct();
    this.update();
  }

  /**
   * A newly opened product starts on Composition.
   *
   * **This used to move to Validation when the resolution carried errors, and
   * deliberately no longer does.** Sending someone to a list of problems is the
   * right answer when the screen they came from cannot show them anything; it is
   * the wrong one now that the screen they came from *is* the product. An error
   * does not stop a product having a composition, and a person who opened a
   * product asked to see the product. The count on the Validation tab and the
   * summary line are the way there, and they name the object, so the trip is
   * chosen rather than imposed.
   *
   * **Once per product, not once per store event.** Keyed on the open path, so a
   * re-resolve, a profile switch or an Apply cannot pull the stage out from
   * under someone mid-edit. Reopening the panel over a product that is already
   * resolved runs this too -- no store event follows that, and the widget would
   * otherwise come back on whatever stage the field initialiser named.
   *
   * Idempotent by the `stagedFor` guard, so both call sites can be unconditional.
   */
  protected stageForOpenProduct(): void {
    const path = this.store.current.open?.path;
    if (path !== this.stagedFor) {
      this.stagedFor = path;
      this.section = "composition";
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

    // Nothing could be read, so there is no composition to fall back to: the
    // panel is the recovery state until a reload or an edit produces an intent.
    if (state.status === "error" && !state.intent) {
      return (
        <div className="gbx-product">
          {this.renderRecovery(state.error)}
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
        {/* **The id, on the panel, as a marker.** Which *kind* of context is
            current is on the toolbar (`data-context`), but which product is
            open was nowhere a reader could ask -- the display name is prose and
            the path is long. The id is the thing the description names itself
            by, so it is the thing to expose. */}
        <div className="gbx-detail-title" data-product-name={intent?.id}>
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

        {/* The product was read but something after it was not -- a failed
            resolve, most often. The composition below is still this product's,
            so the failure is reported beside it rather than replacing it. */}
        {state.error !== undefined && this.renderRecovery(state.error)}
        {/* Composition and Validation render from the intent and the
            diagnostics, so they survive a resolution that did not arrive.
            Overview and Topology are views *of* a resolution and wait for one. */}
        {this.section === "composition"
          ? this.renderComposition()
          : this.section === "validation"
            ? this.renderValidation()
            : product && this.renderSection(product)}

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

  /**
   * What went wrong, and the two things that can be done about it.
   *
   * One renderer for both places it appears -- the panel-wide recovery state
   * when nothing could be read, and the line above a composition that survived
   * whatever failed after it. Reload and Open GDL are the whole repertoire:
   * everything else a person might do about a broken description happens in the
   * description.
   */
  protected renderRecovery(error: string | undefined): React.ReactNode {
    const path = this.store.current.open?.path;
    return (
      <div className="gbx-error" role="alert" data-product-error>
        <span>{error}</span>
        <button type="button" onClick={() => void this.store.reload()}>
          Retry
        </button>
        {path !== undefined && (
          <button type="button" onClick={() => void this.reveals.revealPath(path)}>
            Open GDL
          </button>
        )}
      </div>
    );
  }

  /** Move to a stage, from somewhere other than the strip. */
  public showSection(section: ProductSection): void {
    this.section = section;
    this.update();
  }


  protected renderComposition(): React.ReactNode {
    const state = this.store.current;
    const selection = this.selection.current;
    return <>
      {/* **The count, not a second pair of buttons.** Apply and Discard live in
          the toolbar, once, because the draft is product-wide: two pairs gated
          on the same `hasDraft()` is the defect
          `adr-0013-create-product.spec.ts` already pins -- discarding through
          one of them remounted that panel's inputs and left the other showing
          text the file did not contain. What this line adds is *how much* is
          pending, beside the composition the pending edits are about. */}
      <div className="gbx-composition-draft" aria-live="polite">
        {this.edits.hasDraft() ? (
          <span>
            {this.edits.draftEdits().length} pending change
            {this.edits.draftEdits().length === 1 ? "" : "s"} — Apply or Discard above
          </span>
        ) : (
          <span>Saved</span>
        )}
      </div>
      <Composition state={state} descriptors={this.catalogue.current.rows.flatMap(row => row.kind === "projected" ? [row.gear] : [])}
        selection={selection} select={selected => { this.selection.select(selected); this.update(); }}
        add={(host, point) => void this.commands.executeCommand(ADD_GEAR.id, { host, point })}
        remove={(host, index) => void this.edits.removeComposition(host, index).then(ok => { if (ok) this.selection.select(undefined); })}
        settings={this.renderSettings(selection)} reveals={this.reveals}
        folded={this.foldedHosts}
        toggleFold={host => {
          if (!this.foldedHosts.delete(host)) this.foldedHosts.add(host);
          this.update();
        }} />
    </>;
  }

  /**
   * The settings half of Composition, for whatever is selected.
   *
   * **Rendered here, not borrowed from the Inspector.** This used to call
   * `InspectorWidget.renderContent()` on an injected instance, which made the
   * right-hand panel and this pane one widget with one set of half-typed boxes.
   * They are components now, so each surface holds its own.
   *
   * Keyed on the draft epoch for the same reason the Inspector keys them: a
   * Discard or an Apply must take the scratch boxes with it.
   */
  protected renderSettings(selection: Selection | undefined): React.ReactNode {
    const state = this.store.current;
    const descriptorFor = (id: string): GearDescriptor | undefined => {
      const row = this.catalogue.current.rows.find(
        (row) => row.kind === "projected" && row.gear.id === id,
      );
      return row?.kind === "projected" ? row.gear : undefined;
    };

    if (selection?.kind === "plugin") {
      return (
        <PluginSettings
          key={`plugin-${selection.host}-${selection.entryIndex}-${this.edits.epoch}`}
          selection={selection}
          state={state}
          descriptor={descriptorFor(selection.id)}
          edits={this.edits}
          openGdl={() => {
            if (state.open) void this.reveals.revealPath(state.open.path);
          }}
          remove={() =>
            void this.edits
              .removeComposition(selection.host, selection.entryIndex)
              .then((ok) => {
                if (ok) this.selection.select({ kind: "gear", id: selection.host });
              })
          }
        />
      );
    }

    if (selection?.kind === "gear") {
      return this.renderGearSettings(selection.id, descriptorFor(selection.id));
    }

    // **A catalogue click is answered, not ignored.** It is a different act from
    // choosing a gear in this product -- the pane must not start editing on it --
    // but falling through to "select something" over a pane that plainly has a
    // selection reads as a panel that broke. So it says which act happened, and
    // offers the one that would change this product.
    if (selection?.kind === "catalogue-gear") {
      const picked = state.intent?.selected_gears.some((e) => e.gear === selection.id) === true;
      return (
        <div className="gbx-detail" data-catalogue-selected={selection.id}>
          <GearHeading id={selection.id} descriptor={descriptorFor(selection.id)} />
          <GearBlurb descriptor={descriptorFor(selection.id)} />
          <div className="gbx-empty">
            <code>{selection.id}</code> is selected in the catalogue.
          </div>
          {picked ? (
            <button
              type="button"
              className="gbx-choice"
              data-configure-in-product={selection.id}
              onClick={() => {
                this.selection.select({ kind: "gear", id: selection.id });
                this.update();
              }}
            >
              Configure in product
            </button>
          ) : (
            state.open !== undefined && (
              <button
                type="button"
                className="gbx-choice"
                data-add-to-product={selection.id}
                onClick={() =>
                  void this.commands.executeCommand(ADD_GEAR.id, { gearId: selection.id })
                }
              >
                Add to product
              </button>
            )
          )}
        </div>
      );
    }

    return (
      <div className="gbx-empty">
        Select a gear or a plugin connection in the tree to configure it.
      </div>
    );
  }

  /**
   * One named gear, and the truth about why it is on this screen.
   *
   * **Four answers, because there were four questions and one sentence.** This
   * decided everything from `picked === undefined` -- no `use_gear` entry in the
   * intent -- and then said "`X` is included by another gear, so it has no
   * settings of its own." That is true of a gear the closure pulled in. It is
   * false of a gear that exists only in the catalogue, where no such other gear
   * is named because there is none, and false again when no product is open at
   * all, which reaches the same branch through the optional chain.
   *
   * The resolution can tell them apart and was not being asked: a gear in the
   * closure has an entry in `resolution.product.gears` carrying `selected_by`;
   * a gear that is merely in the catalogue does not.
   *
   * Every branch names the object first. The form used to open with the words
   * "in this product" and never said which gear they were about.
   */
  protected renderGearSettings(id: string, descriptor?: GearDescriptor): React.ReactNode {
    const state = this.store.current;
    const picked = state.intent?.selected_gears.find((entry) => entry.gear === id);
    const resolved = state.resolution?.product?.gears?.[id];
    const selectGear = (gear: string): void => {
      this.selection.select({ kind: "gear", id: gear });
      this.update();
    };
    const heading = (
      <>
        <GearHeading id={id} descriptor={descriptor} />
        <GearBlurb descriptor={descriptor} />
        <GearDocs descriptor={descriptor} reveals={this.reveals} />
      </>
    );

    // Asked for by name: the one case with a `use_gear` entry to write into.
    if (picked !== undefined) {
      return (
        <div className="gbx-detail" data-settings-for={id}>
          {heading}
          <InclusionReasons reasons={resolved?.selected_by ?? []} onSelectGear={selectGear} />
          {descriptor === undefined ? (
            <div className="gbx-empty">
              No catalogue descriptor for <code>{id}</code> yet. It stays in your product;
              its fields appear once the catalogue has read it.
            </div>
          ) : (
            <GearSettings
              key={`gear-${id}-${this.edits.epoch}`}
              descriptor={descriptor}
              picked={picked}
              edits={this.edits}
              sources={{ edits: this.edits, products: this.store }}
              profileKind={state.resolution?.product?.product.profile_kind}
            />
          )}
        </div>
      );
    }

    // In the closure, and genuinely not editable here -- now said with the gear
    // that requires it named, and reachable.
    if (resolved !== undefined) {
      const host = resolved.selected_by.flatMap((reason) =>
        reason.reason === "colocated_by"
          ? [reason.gear]
          : reason.reason === "plugin_of"
            ? [reason.host]
            : [],
      )[0];
      return (
        <div className="gbx-detail" data-pulled-in-settings={id}>
          {heading}
          <InclusionReasons reasons={resolved.selected_by} onSelectGear={selectGear} />
          <div className="gbx-empty">
            It has no <code>use_gear</code> entry of its own, so what it is set to is the
            business of whatever requires it.
          </div>
          {host !== undefined && (
            <button
              type="button"
              className="gbx-choice"
              data-configure-host={host}
              onClick={() => selectGear(host)}
            >
              Configure {host}
            </button>
          )}
        </div>
      );
    }

    // Known to the catalogue and in no product -- reachable after a removal
    // while selected, or under a profile that does not take it.
    if (state.open !== undefined) {
      return (
        <div className="gbx-detail" data-not-in-product={id}>
          {heading}
          <div className="gbx-empty">
            <code>{id}</code> is in the catalogue and not in {state.open.label}.
          </div>
          <button
            type="button"
            className="gbx-choice"
            data-add-to-product={id}
            onClick={() => void this.commands.executeCommand(ADD_GEAR.id, { gearId: id })}
          >
            Add to product
          </button>
        </div>
      );
    }

    return (
      <div className="gbx-detail" data-not-in-product={id}>
        {heading}
        <div className="gbx-empty">Open a product to configure this gear in one.</div>
      </div>
    );
  }

  /** Whichever stage is selected, rendered from the same resolution. */
  protected renderSection(product: ResolvedProduct): React.ReactNode {
    switch (this.section) {
      case "overview":
        return this.renderOverview(product);
      case "topology":
        return this.renderTopology(product);
      // Both are rendered by `render` before it reaches here, because both work
      // without a resolution and this method is only called once there is one.
      case "composition":
      case "validation":
        return undefined;
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
        {this.newProfileKind === "self_hosted" && <label>Host (required)
          <input value={this.newProfileHost} onChange={e => { this.newProfileHost = e.target.value; this.update(); }} />
        </label>}
        {this.newProfileKind !== "embedded" && <label>Discovery (required)
          <select value={this.newProfileDiscovery} onChange={e => { this.newProfileDiscovery = e.target.value; this.update(); }}>
            <option value="static">static</option><option value="directory">directory</option>
          </select>
        </label>}
        <button
          type="button"
          className="gbx-choice"
          data-profile-add-confirm
          disabled={!this.newProfileId.trim() || (this.newProfileKind === "self_hosted" && !this.newProfileHost.trim())}
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
    const fields = profileFields(profile).map(({ wire, label, value, choices, required }) => ({
      wire,
      label,
      choices,
      required,
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
        {fields.map(({ wire, label, value, choices, required }) => (
          <div className="gbx-kv" key={wire} data-profile-field-row={wire}>
            <label htmlFor={`gbx-profile-${id}-${wire}`}>
              {label}
              {required === true && (
                /* Said in words as well as by the glyph, the same way the config
                   form marks a required field -- a bare `title` reaches no
                   screen reader. */
                <span className="gbx-config-required" data-profile-field-required={wire}>
                  <span className="gbx-sr-only">required</span>
                </span>
              )}
            </label>
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
                  {/* **No "not set" for a required field.** Unsetting removes
                      the argument, and these arguments are non-`Option` in the
                      grammar -- so the option was a way to make the open product
                      refuse to evaluate, after which this form is not rendered
                      and the value cannot be put back. The comment here used to
                      claim "a profile that declares no discovery gets the SDK's
                      default", which is true of no kind that has this field:
                      `embedded` is the one with no discovery, and it has no
                      fields at all. Optional fields keep the option. */}
                  {required !== true && <option value="">not set</option>}
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
                onChange={(e) => {
                  // **The same rule as the select, and the easier one to hit.**
                  // `host` is a plain text box, so emptying it queued a removal
                  // with no dropdown involved -- the quickest accidental route
                  // to a product that will not open. An empty required box is
                  // not an edit; the field keeps what it had until something
                  // replaces it.
                  if (required === true && e.target.value.trim() === "") return;
                  this.edits.queueDraft({
                    kind: "set_profile_field",
                    profile: id,
                    field: wire,
                    value: e.target.value === "" ? null : e.target.value,
                  });
                }}
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
    const fields = this.newProfileKind === "embedded" ? [] : this.newProfileKind === "self_hosted"
      ? [{ name: "host", value: this.newProfileHost.trim() }, { name: "worker_discovery", value: this.newProfileDiscovery }]
      : [{ name: "discovery", value: this.newProfileDiscovery }];
    const ok = await this.edits.addProfile(this.newProfileKind, id, fields);
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
          onClick={() => this.showSection("composition")}
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
          this.renderNothingToReport()
        ) : (
          <>
            <DiagnosticsList
              diagnostics={diagnostics}
              sorted
              onReveal={(location) => void this.reveals.revealLocation(location)}
              onExplain={(selection) => this.selection.select(selection)}
              // **To the control, in one act.** `onReveal` ends in a text editor
              // and `onExplain` ends in a panel saying why; neither is the box
              // that sets the value. Without this the way from a warning about
              // `mode` to the field named `mode` was to remember the gear, go to
              // Composition, and find it again.
              onConfigure={(gear) => {
                this.selection.select({ kind: "gear", id: gear });
                this.showSection("composition");
                requestAnimationFrame(() =>
                  document.querySelector<HTMLElement>(".gbx-composition-settings")?.focus(),
                );
              }}
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
   * The empty half of Validation, which is only empty for one reason.
   *
   * **An empty array is not a clean bill of health.** This rendered "this
   * profile resolved with nothing to report" from `diagnostics.length === 0`
   * alone, and three states produce an empty array without meaning it: `open()`
   * clears the array while `status` is `loading`, `resolveCurrent` sets
   * `resolving` without clearing anything, and `fail()` stores
   * `diagnosticsOf(error) ?? []` -- so an engine error carrying no structured
   * diagnostics rendered as success.
   *
   * Observed as `0 errors / 0 warnings` and the success sentence, with three
   * warnings arriving a moment later. A screen whose job is to say whether
   * anything is wrong must not say "no" while it is still finding out.
   */
  protected renderNothingToReport(): React.ReactNode {
    const { status, error } = this.store.current;
    if (status === "loading" || status === "resolving") {
      return (
        <div className="gbx-empty" role="status" data-validation-pending={status}>
          {status === "loading" ? "Reading the description…" : "Resolving this profile…"} Nothing is
          known about this profile yet.
        </div>
      );
    }
    if (status === "error") {
      return (
        <div className="gbx-empty gbx-error" role="alert" data-validation-failed>
          This profile could not be resolved, so there is nothing to report *yet* rather than
          nothing to report. {error ?? "The engine gave no reason."}
        </div>
      );
    }
    return (
      <div className="gbx-empty" data-validation-clean>
        This profile resolved with nothing to report. Another profile may not: the same description
        resolves differently under each one.
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

  /** Fold or unfold one branch of the topology tree. */
  protected toggle(id: string): void {
    if (!this.collapsed.delete(id)) {
      this.collapsed.add(id);
    }
    this.update();
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
 *
 * **`required` is why a control may not offer to clear itself.** These three --
 * `self_hosted`'s `host` and `worker_discovery`, `kubernetes`'s `discovery` --
 * are non-`Option` named arguments in `gearbox-gdl`'s `product.rs`, so starlark
 * refuses the call outright when one is missing and the product stops opening.
 * Unsetting a field *removes* the argument, so for these the control was a way
 * to make the open product unopenable, on a screen that then stopped rendering:
 * the form was gone, and with it the only way to put the value back.
 *
 * Mirror of `gearbox_gdl::edit_call::required_profile_fields`, which is also
 * where the scaffold values live, and which now refuses the same removal on the
 * engine side for callers that are not this form. Stated twice because one is a
 * form and the other is a grammar, and they must not disagree -- the same
 * arrangement `isSecretConfigKey` has with `is_secret_config_key`.
 */
function profileFields(
  profile: DeploymentProfileDecl,
): ReadonlyArray<{
  wire: string;
  label: string;
  value: string | null | undefined;
  choices?: readonly string[];
  required?: boolean;
}> {
  // Named once: both profile kinds carry a `discovery`, under two different wire
  // names, and the set of values is the same `Discovery` in both.
  const discovery: readonly Discovery[] = ["static", "directory"];
  switch (profile.profile) {
    case "embedded":
      return [];
    case "self_hosted":
      return [
        { wire: "host", label: "host", value: profile.host, required: true },
        {
          wire: "worker_discovery",
          label: "worker_discovery",
          value: profile.discovery,
          choices: discovery,
          required: true,
        },
        { wire: "target_dir", label: "target_dir", value: profile.target_dir },
        { wire: "cargo_profile", label: "cargo_profile", value: profile.cargo_profile },
      ];
    case "kubernetes":
      return [
        {
          wire: "discovery",
          label: "discovery",
          value: profile.discovery,
          choices: discovery,
          required: true,
        },
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
