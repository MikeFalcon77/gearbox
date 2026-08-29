// Preview and apply the artefact tree for the resolution on screen.
//
// The engine already knows how to generate; this panel is the missing place
// to look at the plan and to say yes. The tree is `FilePlan[]` -- one line
// per file, no bytes -- and a click asks `gearbox/generate/file` for the two
// sides of that one file. Putting every file on the plan would drag
// `Cargo.lock` (~100k) across for a preview nobody asked to read.

import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";
import * as monaco from "@theia/monaco-editor-core";

import type { FileAction } from "../../common/generated/FileAction";
import type { FileKind } from "../../common/generated/FileKind";
import type { FilePlan } from "../../common/generated/FilePlan";
import type { GenerateFileResult } from "../../common/generated/GenerateFileResult";
import { CatalogueStore } from "../catalogue-store";
import { ProductStore } from "../product-store";
import { GenerateService } from "./generate-service";

const ACTION_ICON: Record<FileAction, string> = {
  create: "new-file",
  update: "edit",
  unchanged: "pass",
  conflict: "warning",
  kept: "lock",
};

const KIND_LANGUAGE: Record<FileKind, string> = {
  rust: "rust",
  toml: "ini",
  yaml: "yaml",
  json: "json",
  dockerfile: "dockerfile",
  shell: "shell",
  text: "plaintext",
};

interface TreeNode {
  readonly name: string;
  readonly plan?: FilePlan;
  readonly children: TreeNode[];
}

function treeOf(plans: readonly FilePlan[]): TreeNode[] {
  const root: TreeNode = { name: "", children: [] };
  for (const plan of plans) {
    const parts = plan.path.split("/");
    let at = root;
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts[i] ?? "";
      const last = i === parts.length - 1;
      let next = at.children.find((child) => child.name === name);
      if (next === undefined) {
        next = { name, children: [], plan: last ? plan : undefined };
        at.children.push(next);
      }
      at = next;
    }
  }
  sortTree(root);
  return root.children;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    const aDir = a.plan === undefined;
    const bDir = b.plan === undefined;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}

function countByAction(plans: readonly FilePlan[]): Partial<Record<FileAction, number>> {
  const counts: Partial<Record<FileAction, number>> = {};
  for (const plan of plans) {
    counts[plan.action] = (counts[plan.action] ?? 0) + 1;
  }
  return counts;
}

@injectable()
export class GenerateWidget extends ReactWidget {
  static readonly ID = "gearbox.generate";
  static readonly LABEL = "Gearbox Generate";

  @inject(ProductStore) protected readonly product!: ProductStore;
  @inject(GenerateService) protected readonly generate!: GenerateService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;

  protected selected: string | undefined;
  protected preview: GenerateFileResult | undefined;
  protected previewError: string | undefined;
  protected previewing = false;

  @postConstruct()
  protected init(): void {
    this.id = GenerateWidget.ID;
    this.title.label = GenerateWidget.LABEL;
    this.title.iconClass = codicon("checklist");
    this.title.caption = GenerateWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-generate");
    this.toDispose.push(
      this.product.onChanged(() => {
        this.generate.forgetIfStale();
        this.update();
      }),
    );
    this.toDispose.push(this.generate.onChanged(() => this.update()));
    this.toDispose.push(this.catalogue.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const caps = this.catalogue.engineCapabilities;
    if (caps !== undefined && !caps.generate) {
      return undefined;
    }

    const state = this.product.current;
    if (state.open === undefined || state.status !== "ready") {
      return (
        <div className="gbx-generate gbx-empty">
          Generate draws a <em>resolution</em>, so it needs a product and a
          profile. Open the Product view and it fills in.
        </div>
      );
    }

    if (this.generate.current.plan === undefined && this.generate.current.status !== "error") {
      void this.generate.ensurePlan();
    }

    const gen = this.generate.current;
    if (gen.status === "error") {
      return (
        <div className="gbx-generate">
          <div className="gbx-error" role="alert">
            {gen.error}
          </div>
        </div>
      );
    }
    if (gen.plan === undefined) {
      return <div className="gbx-generate gbx-empty">Planning generation…</div>;
    }

    const plans = gen.plan.plans;
    const counts = countByAction(plans);
    const blocks = this.generate.blocks;
    const selectedPlan = plans.find((p) => p.path === this.selected);

    return (
      <div className="gbx-generate" data-out-root={gen.plan.out_root} data-written={gen.written ?? ""}>
        <div className="gbx-generate-head">
          <div className="gbx-generate-counts">
            {(["create", "update", "unchanged", "conflict", "kept"] as const).map((action) =>
              (counts[action] ?? 0) > 0 ? (
                <span key={action} className="gbx-badge" data-count={action}>
                  {counts[action]} {action}
                </span>
              ) : undefined,
            )}
            {gen.written !== undefined && (
              <span className="gbx-badge" data-written-count={gen.written}>
                {gen.written} written
              </span>
            )}
          </div>
          <button
            className="gbx-choice gbx-choice-on"
            type="button"
            disabled={!this.generate.canApply}
            data-apply="true"
            onClick={() => void this.generate.apply()}
          >
            Apply
          </button>
        </div>
        {blocks.length > 0 && (
          <ul className="gbx-generate-blocks">
            {blocks.map((block) => (
              <li key={block.id} data-apply-block={block.id}>
                {block.reason}
              </li>
            ))}
          </ul>
        )}
        {(gen.plan.skipped ?? []).length > 0 && (
          <div className="gbx-gap">
            {gen.plan.skipped!.length} worker process(es) not generated — worker
            entry points are M6: {gen.plan.skipped!.join(", ")}
          </div>
        )}
        <div className="gbx-generate-body">
          <div className="gbx-generate-tree" role="tree">
            {treeOf(plans).map((node) => this.renderNode(node, 0))}
          </div>
          <div className="gbx-generate-preview">
            {this.renderPreview(selectedPlan)}
          </div>
        </div>
      </div>
    );
  }

  protected renderNode(node: TreeNode, depth: number): React.ReactNode {
    const plan = node.plan;
    if (plan === undefined) {
      return (
        <div className="gbx-generate-dir" key={node.name} style={{ paddingLeft: depth * 14 }}>
          <div className="gbx-generate-dir-label">
            <span className="codicon codicon-folder" />
            {node.name}
          </div>
          {node.children.map((child) => this.renderNode(child, depth + 1))}
        </div>
      );
    }
    const on = this.selected === plan.path;
    return (
      <div
        className={`gbx-row ${on ? "gbx-selected" : ""}`}
        key={plan.path}
        role="treeitem"
        tabIndex={0}
        style={{ paddingLeft: 4 + depth * 14 }}
        data-plan-path={plan.path}
        data-action={plan.action}
        data-ownership={plan.ownership}
        aria-selected={on}
        onClick={() => void this.select(plan)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void this.select(plan);
          }
        }}
      >
        <span className={`gbx-leaf-icon codicon codicon-${ACTION_ICON[plan.action]}`} />
        <span className="gbx-row-name">{node.name}</span>
        <span className="gbx-badge" data-ownership={plan.ownership}>
          {plan.ownership}
        </span>
      </div>
    );
  }

  protected renderPreview(plan: FilePlan | undefined): React.ReactNode {
    if (plan === undefined) {
      return <div className="gbx-empty">Select a file to see the proposed content.</div>;
    }
    if (!plan.preview_available) {
      return (
        <div className="gbx-empty" data-preview-unavailable={plan.path}>
          `{plan.path}` is not text, so there is no preview to show. The plan
          still names it; applying will write the bytes.
        </div>
      );
    }
    if (this.previewing && this.selected === plan.path && this.preview === undefined) {
      return <div className="gbx-empty">Loading preview…</div>;
    }
    if (this.previewError !== undefined && this.selected === plan.path) {
      return (
        <div className="gbx-error" role="alert">
          {this.previewError}
        </div>
      );
    }
    if (this.preview === undefined || this.selected !== plan.path) {
      return <div className="gbx-empty">Select a file to see the proposed content.</div>;
    }
    return (
      <GenerateDiff
        original={this.preview.current ?? ""}
        modified={this.preview.proposed ?? ""}
        language={KIND_LANGUAGE[plan.kind]}
      />
    );
  }

  protected async select(plan: FilePlan): Promise<void> {
    this.selected = plan.path;
    this.preview = undefined;
    this.previewError = undefined;
    this.update();
    if (!plan.preview_available) {
      return;
    }
    this.previewing = true;
    try {
      this.preview = await this.generate.file(plan);
    } catch (error) {
      this.previewError = error instanceof Error ? error.message : String(error);
    } finally {
      this.previewing = false;
      this.update();
    }
  }
}

/**
 * A read-only Monaco diff of one planned file.
 *
 * Created here rather than opened as a Theia editor tab: the preview belongs
 * to this panel, and a tab would steal the Product view. Disposed on every
 * change of the two sides, because Monaco models are not cheap to leak.
 */
function GenerateDiff(props: { original: string; modified: string; language: string }): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = host.current;
    if (el === null) return undefined;
    const original = monaco.editor.createModel(props.original, props.language);
    const modified = monaco.editor.createModel(props.modified, props.language);
    const editor = monaco.editor.createDiffEditor(el, {
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
    });
    editor.setModel({ original, modified });
    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [props.original, props.modified, props.language]);
  return <div className="gbx-generate-diff" ref={host} />;
}
