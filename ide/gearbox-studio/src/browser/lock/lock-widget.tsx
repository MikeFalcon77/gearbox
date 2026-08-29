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

import { ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import { ProductStore } from "../product-store";

/** `blake3:c4412b91f813…` -> `c4412b91f813`. */
function shortHash(hash: string): string {
  return hash.replace(/^[a-z0-9]+:/, "").slice(0, 12);
}

@injectable()
export class LockWidget extends ReactWidget {
  static readonly ID = "gearbox.lock";
  static readonly LABEL = "Gearbox Lock";

  @inject(ProductStore) protected readonly store!: ProductStore;

  @postConstruct()
  protected init(): void {
    this.id = LockWidget.ID;
    this.title.label = LockWidget.LABEL;
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
    const stale = resolved !== undefined && resolved.lock_hash !== lock.lock_hash;

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
            {stale && (
              <span className="gbx-badge gbx-downgraded" data-lock-stale="true">
                does not match the resolution on screen
              </span>
            )}
          </span>
        </div>
        {/* `readOnly` on a textarea would be editable-looking; a `<pre>` is
            read-only by construction. Selectable and copyable, because comparing
            a lock against one in a terminal is a real thing people do. */}
        <pre className="gbx-lock-text" data-lock-canonical="true">
          {lock.canonical}
        </pre>
      </div>
    );
  }
}
