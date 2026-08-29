// Opening a path the catalogue gave us.
//
// One place, because there were two copies and both were wrong in the same two
// ways -- which is what a second copy is for.
//
// Every path in the catalogue is relative to its source root: `gdl_path`, and
// every PRD/DESIGN/ADR link. The root is the one thing only the engine knows, so
// it is reported by `initialize` and joined here. Handing a relative path to
// `new URI(...)` yields a URI with no scheme, which no opener claims -- and the
// original code then swallowed the rejection in an empty `catch` whose comment
// assumed the file was outside the workspace. That assumption was never checked.
// The links looked live and did nothing.

import { OpenerService, open } from "@theia/core/lib/browser";
import type { EditorOpenerOptions } from "@theia/editor/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";
import { URI } from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";

import type { Location } from "../common/generated/Location";
import { CatalogueStore } from "./catalogue-store";

@injectable()
export class RevealService {
  @inject(OpenerService) protected readonly openerService!: OpenerService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(CatalogueStore) protected readonly store!: CatalogueStore;

  /**
   * Open `relative`, resolved against the root of `source`.
   *
   * Failures are reported rather than swallowed. A link that silently does
   * nothing is worse than one that says why: the first looks like the file is
   * uninteresting, the second looks like a bug -- and it is one.
   */
  /**
   * The `file://` URI for a catalogue path, when there is one.
   *
   * Exposed so a link can carry a real `href`. An `<a>` with only an `onClick`
   * is a div wearing a hat: no keyboard activation, no focus ring, nothing for
   * a screen reader to announce, and no target in the status bar.
   */
  uriFor(source: string, relative: string): string | undefined {
    const absolute = this.store.absolutePath(source, relative);
    return absolute === undefined ? undefined : URI.fromFilePath(absolute).toString();
  }

  /**
   * Open an engine-reported [`Location`] at its range.
   *
   * Simpler than [`reveal`] because a `Location` already carries a `file://`
   * URI -- the engine sends one precisely so it can be handed to an editor
   * unchanged. The range needs no conversion either: it is zero-based LSP
   * semantics, which is what Theia's editor selection takes.
   */
  async revealLocation(location: Location): Promise<void> {
    const options: EditorOpenerOptions = { selection: location.range };
    try {
      await open(this.openerService, new URI(location.uri), options);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.messages.error(`Cannot open ${location.uri}: ${reason}`);
    }
  }

  async reveal(source: string, relative: string): Promise<void> {
    const absolute = this.store.absolutePath(source, relative);
    if (absolute === undefined) {
      this.messages.error(
        `Cannot open ${relative}: the engine reported no path for source "${source}".`,
      );
      return;
    }
    try {
      await open(this.openerService, URI.fromFilePath(absolute));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.messages.error(`Cannot open ${absolute}: ${reason}`);
    }
  }
}
