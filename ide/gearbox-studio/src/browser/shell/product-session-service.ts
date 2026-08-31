// Opening a product, and everything that has to be true for it to be editable.
//
// A product is a directory and the unit of work, so opening one is not "point a
// panel at a file": it decides **where the engine looks and where it may write**.
// Until this existed the backend fixed both -- `../gears-rust` as the only source
// root, the repository as the write boundary -- which meant a product anywhere
// else could be read and then silently refused on every edit and every generate,
// because `writable_path` and `writable_out_root` both measure from the declared
// workspace.
//
// **The order is forced, and one step of it is not obvious.** Source roots come
// from the product's own `sources`, and reading those means evaluating the
// description, which needs a running engine. So the engine starts twice:
//
//   1. initialize with the product's directory as the workspace and no roots --
//      enough to evaluate a description, which `load_product` does without any
//      catalogue;
//   2. read `sources`, resolve each `path(at = ...)` against the description's
//      own directory, as the IR documents it;
//   3. initialize again with those roots, which respawns the engine;
//   4. load the catalogue, then load and resolve the product.
//
// Two spawns per open is the price of deriving roots from the thing being opened
// rather than from a constant. It is the same cost `Reload Catalogue` already
// pays, and the alternative -- a client that guesses the roots -- is what this
// replaces.
//
// `git(...)` sources are refused rather than skipped. Materialising a repository
// is not built, and a catalogue quietly missing a source is indistinguishable
// from a product whose gears do not exist.

import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { SourceDecl } from "../../common/generated/SourceDecl";
import { GearboxService, type ProductRef, type StudioSession } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";
import { ProductStore } from "../product-store";

@injectable()
export class ProductSessionService {
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(MessageService) protected readonly messages!: MessageService;

  /**
   * Make sure something is open, if there is an obvious something.
   *
   * One product is a question with one answer, so it opens. Several is a choice,
   * and the picker asks it. This used to live in `ProductStore.discover()`, where
   * it opened a product *without* re-initializing the engine -- so the catalogue
   * kept whatever roots the previous session had left.
   */
  async ensureOpen(): Promise<void> {
    if (this.products.current.open !== undefined) return;
    await this.products.ensureDiscovered();
    const products = this.products.current.products;
    const [only] = products;
    if (products.length === 1 && only !== undefined) {
      await this.open(only);
    }
  }

  /**
   * Open `ref` as the session's product.
   *
   * Returns whether it opened. A refusal is reported to the person rather than
   * thrown: every reason is something they can act on -- a description that does
   * not evaluate, a `git(...)` source, no local sources at all.
   */
  async open(ref: ProductRef): Promise<boolean> {
    const directory = parentOf(ref.path);

    // Step 1: an engine that can evaluate a description and nothing more. The
    // workspace is already the product's, so a later edit is inside the boundary.
    await this.catalogue.load({ roots: [], workspace: directory });

    // Step 2: read what the description declares. `loadProduct` is evaluation
    // only -- nothing is joined against the catalogue -- which is exactly why it
    // works with no roots declared yet.
    let intent;
    try {
      intent = (await this.service.loadProduct(ref.path)).intent;
    } catch (error) {
      this.messages.error(
        `${ref.label} could not be evaluated, so it cannot be opened: ${messageOf(error)}`,
      );
      return false;
    }

    const roots: string[] = [];
    const refused: string[] = [];
    // Typed explicitly: `sources` is a mapped type keyed by `SourceId`, and
    // `Object.entries` widens its values to `unknown`.
    const declared = Object.entries(intent.sources ?? {}) as [string, SourceDecl][];
    for (const [id, source] of declared) {
      if (source.kind === "path") {
        roots.push(resolveFrom(directory, source.at));
      } else {
        refused.push(id);
      }
    }

    if (refused.length > 0) {
      // Named, not counted: which source cannot be reached is the actionable part.
      this.messages.error(
        `${ref.label} declares ${refused.join(", ")} as a git source, and fetching one is not ` +
          `built yet. Point it at a local path, or open a product that does.`,
      );
      return false;
    }
    if (roots.length === 0) {
      this.messages.error(`${ref.label} declares no source roots, so there are no gears to compose.`);
      return false;
    }

    // Step 3 and 4: the real session, then the catalogue and the product.
    const session: StudioSession = { roots, workspace: directory };
    await this.catalogue.load(session);
    await this.products.open(ref);
    return this.products.current.open !== undefined;
  }
}

/** The directory a `product.gdl` sits in. */
function parentOf(file: string): string {
  const at = file.lastIndexOf("/");
  return at <= 0 ? "/" : file.slice(0, at);
}

/**
 * `at` resolved against the description's directory.
 *
 * Hand-rolled because the browser has no `path`: the inputs are a POSIX absolute
 * directory and a relative path out of a `.gdl`, which is the only case this has
 * to be right for. `..` is honoured because that is how every real product points
 * at a sibling checkout -- `path("../../../gears-rust")` in the demo.
 */
function resolveFrom(directory: string, at: string): string {
  if (at.startsWith("/")) return at;
  const parts = directory.split("/").filter((p) => p.length > 0);
  for (const segment of at.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
