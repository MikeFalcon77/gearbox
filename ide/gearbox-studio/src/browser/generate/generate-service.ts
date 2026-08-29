// Policy in front of Apply, and the plan the Generate view renders.
//
// A service rather than a handler in the widget: there are four independent
// reasons to refuse a write, and they have to be named in the UI when they
// fail. "Apply is disabled" with no reason is a dead end. Keeping the checks
// here means the next surface that wants to apply a plan does not reimplement
// them.
//
// The four, in the order a person can do something about them:
//
//   1. `capabilities.generate` -- otherwise the view is not offered at all;
//   2. `capabilities.writes` -- the client must have declared the right;
//   3. no resolution errors -- the engine refuses those on the server too;
//   4. no `FileAction::Conflict` -- GBX0701; a partial apply is forbidden.
//
// The plan is fetched lazily, the way the lock is: the other panels never need
// it, and a plan from the previous profile is worse than none.

import { Emitter, Event } from "@theia/core/lib/common/event";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { FilePlan } from "../../common/generated/FilePlan";
import type { GenerateApplyResult } from "../../common/generated/GenerateApplyResult";
import type { GenerateFileResult } from "../../common/generated/GenerateFileResult";
import type { GeneratePlanResult } from "../../common/generated/GeneratePlanResult";
import { GearboxService } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";
import { ProductStore } from "../product-store";

export type GenerateStatus = "idle" | "planning" | "ready" | "error";

export interface GenerateState {
  readonly status: GenerateStatus;
  readonly plan: GeneratePlanResult | undefined;
  /**
   * How many files the last apply wrote. `undefined` until one has run for
   * this plan; `0` is a real answer (a second apply of an unchanged tree).
   */
  readonly written: number | undefined;
  readonly error: string | undefined;
}

export interface ApplyBlock {
  readonly id: "generate" | "writes" | "resolution" | "conflict";
  readonly reason: string;
}

const EMPTY: GenerateState = {
  status: "idle",
  plan: undefined,
  written: undefined,
  error: undefined,
};

@injectable()
export class GenerateService {
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(ProductStore) protected readonly product!: ProductStore;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(MessageService) protected readonly messages!: MessageService;

  protected readonly onChangedEmitter = new Emitter<void>();
  readonly onChanged: Event<void> = this.onChangedEmitter.event;

  protected state: GenerateState = EMPTY;
  protected epoch = 0;
  protected inFlight = false;
  /**
   * The `(path, profile)` the current plan answers about. A plan for a
   * different resolution is discarded rather than shown.
   */
  protected forKey: string | undefined;

  get current(): GenerateState {
    return this.state;
  }

  /**
   * Why Apply is off, named so the button is never just grey.
   *
   * Empty means every gate passed. `capabilities.generate` being false is
   * included for completeness; the view itself is not offered in that case.
   */
  get blocks(): readonly ApplyBlock[] {
    const caps = this.catalogue.engineCapabilities;
    const blocks: ApplyBlock[] = [];
    if (caps !== undefined && !caps.generate) {
      blocks.push({
        id: "generate",
        reason: "the engine does not advertise generation",
      });
    }
    if (caps !== undefined && !caps.writes) {
      blocks.push({
        id: "writes",
        reason: "this session has no write capability",
      });
    }
    const diagnostics = this.product.current.resolution?.diagnostics ?? [];
    if (diagnostics.some((d) => d.severity === "error")) {
      blocks.push({
        id: "resolution",
        reason: "resolution reported errors",
      });
    }
    if ((this.state.plan?.plans ?? []).some((p) => p.action === "conflict")) {
      blocks.push({
        id: "conflict",
        reason: "the plan has a conflict",
      });
    }
    return blocks;
  }

  get canApply(): boolean {
    return (
      this.state.status === "ready" &&
      this.state.plan !== undefined &&
      this.blocks.length === 0
    );
  }

  /** The segment that separates Studio's output tree from the CLI's. */
  static readonly OUT_SEGMENT = "studio";

  /**
   * Where Studio writes: `.gearbox/studio/<product>/<profile>/`.
   *
   * The engine's own default is `.gearbox/<product>/<profile>/`, and the honest
   * thing would be to send no `out` at all and use it. Studio does not, for one
   * specific reason that is worth stating rather than leaving as a preference.
   *
   * **`product.lock` is not client-independent yet.** `SourceRoot::to_resolved`
   * records `digest` as `path:<declared location>` -- deliberately provisional,
   * and its own comment says so -- and the declared location is whatever the
   * caller spelled. The CLI is run from the repository and declares
   * `../gears-rust`; Studio's backend declares an absolute path. That string
   * feeds `lock_hash`, so the *same* product and profile serialise to two
   * different locks. Sharing one output tree would therefore mean each client
   * rewriting the other's `product.lock` on every apply, forever, and the tree
   * §12 step 2 builds is the CLI's.
   *
   * Applying is otherwise safe to repeat -- `apply_generate` skips any file whose
   * action does not write, so it never touches `target/` and never rewrites an
   * unchanged byte. Separation is *only* about the lock.
   *
   * **When the digest becomes content-based, delete this method** and let the
   * engine default stand: one tree, generated by either client, byte-identical.
   * That is the condition, and it is the reason this is a method with a comment
   * rather than a setting somebody has to discover.
   *
   * The tree is Studio's own and disposable, which is also what makes it safe for
   * the conformance suite to clear between runs. `.gearbox/` is gitignored and
   * excluded from the file watcher, so neither client dirties the repository.
   */
  async outRoot(): Promise<string | undefined> {
    const product = this.product.current.resolution?.product?.product;
    if (product === undefined) return undefined;
    const roots = await this.service.workspaceRoots();
    const workspace = roots[0];
    if (workspace === undefined) return undefined;
    return `${workspace}/.gearbox/${GenerateService.OUT_SEGMENT}/${product.id}/${product.profile}`;
  }

  /** Fetch the plan for whatever is on screen, once per resolution. */
  async ensurePlan(): Promise<void> {
    const open = this.product.current.open;
    const profile = this.product.current.profile;
    if (open === undefined || profile === undefined) {
      return;
    }
    const key = `${open.path}::${profile}`;
    if (
      this.inFlight ||
      this.product.current.status !== "ready" ||
      (this.forKey === key && this.state.plan !== undefined)
    ) {
      return;
    }
    this.inFlight = true;
    const epoch = ++this.epoch;
    this.forKey = key;
    this.update({ status: "planning", plan: undefined, written: undefined, error: undefined });
    try {
      const out = await this.outRoot();
      const plan = await this.service.planGenerate(open.path, profile, out);
      if (epoch !== this.epoch) return;
      this.update({ status: "ready", plan, error: undefined });
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.update({ status: "error", error: messageOf(error) });
    } finally {
      this.inFlight = false;
    }
  }

  /** Write the planned tree. No-op when a gate is closed. */
  async apply(): Promise<GenerateApplyResult | undefined> {
    if (!this.canApply) {
      this.messages.warn(this.blocks.map((b) => b.reason).join("; "));
      return undefined;
    }
    const open = this.product.current.open;
    const profile = this.product.current.profile;
    if (open === undefined || profile === undefined) return undefined;
    try {
      const out = await this.outRoot();
      const outcome = await this.service.applyGenerate(open.path, profile, out);
      this.update({
        plan: {
          plans: outcome.plans,
          diagnostics: outcome.diagnostics,
          out_root: this.state.plan?.out_root ?? out ?? "",
          skipped: this.state.plan?.skipped,
        },
        written: outcome.written,
      });
      return outcome;
    } catch (error) {
      this.messages.error(messageOf(error));
      return undefined;
    }
  }

  /** The two sides of one planned file. */
  async file(plan: FilePlan): Promise<GenerateFileResult> {
    const open = this.product.current.open;
    const profile = this.product.current.profile;
    if (open === undefined || profile === undefined) {
      throw new Error("open a product before asking for a generated file");
    }
    const out = await this.outRoot();
    return this.service.generateFile(open.path, plan.path, profile, out);
  }

  /**
   * Drop the plan when the resolution it describes is no longer on screen.
   *
   * Called from the widget on every store change. A plan for `dev` shown
   * against a `prod` resolution would be a lie.
   */
  forgetIfStale(): void {
    const open = this.product.current.open;
    const profile = this.product.current.profile;
    const key = open === undefined || profile === undefined ? undefined : `${open.path}::${profile}`;
    if (key !== this.forKey) {
      this.epoch += 1;
      this.forKey = undefined;
      this.inFlight = false;
      this.state = EMPTY;
      this.onChangedEmitter.fire();
    }
  }

  protected update(patch: Partial<GenerateState>): void {
    this.state = { ...this.state, ...patch };
    this.onChangedEmitter.fire();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
