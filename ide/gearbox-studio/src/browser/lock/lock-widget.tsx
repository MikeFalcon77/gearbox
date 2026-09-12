// The canonical `product.lock` for the resolution on screen.
//
// The text comes from `gearbox_lock::write_canonical`, the one function that
// decides the lock's bytes. Nothing here renders TOML: byte identity across runs
// is the property the lock exists for, and a second serializer would be a second
// answer to the one question it settles.
//
// §9 asked for a read-only Monaco view. This is a `<pre>`, and the reason is not
// laziness: no TOML grammar is installed -- the application has no plugin host,
// which ADR 0011 decided deliberately -- so Monaco would render the same
// uncoloured text behind a much larger component. What Monaco would add here is
// a scrollbar. The *editor* half of the requirement is met where it actually
// matters, on a `product.lock` opened as a file: see
// `theia/monaco/read-only-lock-editor-provider.ts`.

import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { LockOnDisk } from "../../common/generated/LockOnDisk";
import type { ResolvedProduct } from "../../common/generated/ResolvedProduct";
import { ProductStore } from "../product-store";

/** `blake3:c4412b91f813…` -> `c4412b91f813`. */
function shortHash(hash: string): string {
  return hash.replace(/^[a-z0-9]+:/, "").slice(0, 12);
}

@injectable()
export class LockWidget extends ReactWidget {
  static readonly ID = "gearbox.lock";
  // **`Resolution Lock`, not `Gearbox Lock`.** Every other view in this shell is
  // `Gearbox <noun>` because it is a panel of this tool; this one shows a
  // specific artefact, and "Lock" alone reads as a padlock -- a UX pass said so.
  // What the panel holds is the lock the *resolution* produced, which is also the
  // sentence its stale-hash badge is about.
  static readonly LABEL = "Resolution Lock";

  @inject(ProductStore) protected readonly store!: ProductStore;

  /** Whether the text below shows the lock on disk instead of the resolved one. */
  protected showingDisk = false;

  /**
   * Which half of the view is on screen.
   *
   * **Summary first**, because the raw canonical text is several hundred lines
   * and answers a question a person asks second: a UX pass called the panel "a
   * useful header and then a wall of TOML". The summary is not a second source of
   * truth -- it is rendered from `ResolvedProduct`, which this widget already
   * reaches into for `lock_hash` -- and the wall is one click away, unchanged,
   * because comparing it against a terminal is a real thing people do.
   */
  protected showing: "summary" | "raw" = "summary";

  @postConstruct()
  protected init(): void {
    this.id = LockWidget.ID;
    this.title.label = LockWidget.LABEL;
    this.title.iconClass = codicon("lock");
    this.title.caption = LockWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-lock");
    this.toDispose.push(this.store.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const state = this.store.current;

    if (state.open === undefined) {
      return <div className="gbx-lock gbx-empty">Open a product to see its lock.</div>;
    }
    if (state.status !== "ready") {
      return <div className="gbx-lock gbx-empty">Resolving {state.profile}…</div>;
    }

    if (state.lockError !== undefined) {
      // The resolution itself stood: `status` is `ready`, the graph and the
      // diagnostics are on screen, and only the lock text is missing. Said here
      // rather than as the product's error for that reason.
      return (
        <div className="gbx-lock">
          <div className="gbx-error" role="alert">
            the lock could not be written: {state.lockError}
          </div>
        </div>
      );
    }

    const lock = state.lock;
    if (lock === undefined) {
      // Asked for here rather than eagerly on every resolve: the lock costs a
      // serialization the other panels never need. The store guards against the
      // render-triggers-fetch-triggers-render loop this would otherwise be.
      void this.store.ensureLock();
      return <div className="gbx-lock gbx-empty">Writing the lock…</div>;
    }

    const resolved = state.resolution?.product?.product;
    // The hash the lock text carries against the hash the resolution reported.
    // They come from the same resolution, so a mismatch means the two answers on
    // screen are about different runs -- worth saying rather than assuming.
    const inconsistent = resolved !== undefined && resolved.lock_hash !== lock.lock_hash;

    // Against the lock on disk, which is the comparison §9 actually asked for.
    // Until the source digest became content-based this could not be honest: a
    // lock written by the CLI carried that client's spelling of the root and so a
    // different hash, and every CLI-written lock would have read as stale here
    // forever.
    const disk = lock.on_disk ?? undefined;
    const drifted = disk !== undefined && disk.unreadable == null && disk.changes.length > 0;

    return (
      <div className="gbx-lock" data-lock-profile={lock.profile}>
        <div className="gbx-kv">
          <span>profile</span>
          <span>{lock.profile}</span>
        </div>
        <div className="gbx-kv">
          <span>lock hash</span>
          <span>
            {/* Short and without the `blake3:` prefix. The algorithm is not
                something a reader chooses or checks, and sixty-four hex
                characters are unreadable at a glance; what a person does with
                this is compare it to another one, and twelve characters do that.
                The whole value is in the tooltip, and in the text below, which is
                what a machine comparison reads. */}
            <code data-lock-text-hash={lock.lock_hash} title={lock.lock_hash}>
              {shortHash(lock.lock_hash)}
            </code>
            {inconsistent && (
              <span className="gbx-badge gbx-downgraded" data-lock-inconsistent="true">
                does not match the resolution on screen
              </span>
            )}
          </span>
        </div>
        {this.renderDisk(lock.lock_path, disk, drifted)}

        <div className="gbx-lock-tabs" role="tablist" aria-label="Lock view">
          {(["summary", "raw"] as const).map((which) => (
            <button
              type="button"
              key={which}
              role="tab"
              className={`gbx-choice ${this.showing === which ? "gbx-choice-on" : ""}`}
              aria-selected={this.showing === which}
              data-lock-tab={which}
              onClick={() => {
                this.showing = which;
                this.update();
              }}
            >
              {which === "summary" ? "Summary" : "Raw lock file"}
            </button>
          ))}
        </div>

        {this.showing === "summary" ? (
          this.renderSummary(state.resolution?.product ?? undefined)
        ) : (
          /* `readOnly` on a textarea would be editable-looking; a `<pre>` is
             read-only by construction. Selectable and copyable, because comparing
             a lock against one in a terminal is a real thing people do. */
          <pre className="gbx-lock-text" data-lock-canonical="true">
            {this.showingDisk && disk !== undefined ? disk.canonical : lock.canonical}
          </pre>
        )}
      </div>
    );
  }

  /**
   * What the lock records, in the terms the lock uses.
   *
   * Counted from `ResolvedProduct` -- the same object the header's hash comes
   * from -- rather than parsed back out of the canonical text. Parsing it here
   * would be a second TOML reader in the client, which a claim in
   * `conformance/prd-lock.spec.ts` forbids by grepping this source, and it would
   * be a second opinion about a file the engine just wrote.
   */
  protected renderSummary(product: ResolvedProduct | undefined): React.ReactNode {
    if (product === undefined) {
      return (
        <div className="gbx-empty" data-lock-summary="unavailable">
          The resolution behind this lock is no longer on screen. Open the raw file, or resolve
          again.
        </div>
      );
    }
    const gears = Object.keys(product.gears ?? {}).length;
    const sources = Object.keys(product.sources ?? {}).length;
    const applications = (product.applications ?? []).length;
    const bindings = (product.bindings ?? []).length;
    const cluster = (product.cluster ?? []).length;
    const rows: { label: string; value: string }[] = [
      { label: "sources", value: String(sources) },
      { label: "gears", value: String(gears) },
      { label: "applications", value: String(applications) },
      { label: "bindings", value: String(bindings) },
      { label: "cluster bindings", value: String(cluster) },
    ];
    return (
      <div className="gbx-lock-summary" data-lock-summary="ready">
        {rows.map(({ label, value }) => (
          <div className="gbx-kv" key={label}>
            <span>{label}</span>
            <span data-lock-summary-count={label}>{value}</span>
          </div>
        ))}
        <div className="gbx-kv">
          <span>applications</span>
          <span>
            {(product.applications ?? []).map((process) => (
              <span
                className="gbx-badge"
                key={process.name}
                data-lock-summary-application={process.name}
                title={`${process.kind}, ${process.gears.length} gear${
                  process.gears.length === 1 ? "" : "s"
                }`}
              >
                {process.name}
              </span>
            ))}
            {applications === 0 && "—"}
          </span>
        </div>
      </div>
    );
  }

  /**
   * The lock on disk: whether there is one, and how it differs.
   *
   * Four states, and each is a different thing to do about it -- which is why
   * none of them collapses into "no badge". There is no lock yet (generate one);
   * there is one and it matches (nothing to do); there is one and it differs
   * (regenerate, or find out why); there is a file that does not verify (look at
   * it). The path is reported in every case, because "nothing on disk" and "I
   * looked somewhere else" are indistinguishable without it.
   *
   * The fourth state exists because a lock is self-verifying: `gearbox_lock::read`
   * recomputes the hash and refuses on a mismatch. Reporting an empty diff for a
   * tampered file -- which is what comparing text would do -- would say the
   * opposite of the truth.
   */
  protected renderDisk(
    path: string,
    disk: LockOnDisk | undefined,
    drifted: boolean,
  ): React.ReactNode {
    const state =
      disk === undefined
        ? "absent"
        : disk.unreadable != null
          ? "unreadable"
          : drifted
            ? "drifted"
            : "current";

    return (
      <div className="gbx-lock-disk" data-lock-disk={state}>
        <div className="gbx-lock-disk-head">
          {state === "absent" && <span>No lock on disk yet — the Generate view writes one.</span>}
          {state === "unreadable" && (
            <>
              <span className="gbx-badge gbx-downgraded" data-lock-unverified="true">
                does not verify
              </span>
              <span>{disk?.unreadable}</span>
            </>
          )}
          {state === "drifted" && (
            <span className="gbx-badge gbx-downgraded" data-lock-stale="true">
              {disk?.changes.length}{" "}
              {disk?.changes.length === 1 ? "difference" : "differences"} from the lock on disk
            </span>
          )}
          {state === "current" && (
            <span className="gbx-badge" data-lock-current="true">
              matches the lock on disk
            </span>
          )}

          <code title={path}>{path}</code>

          {/* In every state, not just the interesting ones: after running
              `gearbox generate` in a terminal, the state a reader wants to leave
              is "absent" or "drifted", and that is exactly when the control has to
              be there. Nothing watches `.gearbox/**` -- it is excluded from
              Theia's file watcher because generated output is rewritten wholesale
              and watching it reports churn nobody acts on -- so the comparison is
              taken when the lock is fetched. An apply from the Generate view
              refreshes it without being asked. */}
          <button
            type="button"
            className="gbx-lock-toggle"
            data-lock-refresh="true"
            title="read the lock on disk again"
            onClick={() => void this.store.refreshLock()}
          >
            re-read
          </button>

          {/* Only when the two differ. A toggle between two identical texts is a
              control that does nothing, which is worse than no control. */}
          {state === "drifted" && (
            <button
              type="button"
              className="gbx-lock-toggle"
              data-lock-showing={this.showingDisk ? "disk" : "resolved"}
              onClick={() => {
                this.showingDisk = !this.showingDisk;
                this.update();
              }}
            >
              show {this.showingDisk ? "resolved" : "on disk"}
            </button>
          )}
        </div>
        {state === "drifted" && (
          <ul className="gbx-lock-changes">
            {(disk?.changes ?? []).map((line) => (
              <li key={line} data-lock-change={line.slice(0, 1)}>
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
}
