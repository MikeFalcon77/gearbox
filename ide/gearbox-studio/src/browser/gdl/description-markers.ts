// Description-file diagnostics as Problems markers, over the language server.
//
// The other half of `cpt-gearbox-fr-editor-diagnostics`: "Description-file
// diagnostics MUST be reported with source ranges over a language-server
// interface". `resolution-markers.ts` is the half about resolutions; this is the
// half about the file being typed, and the two are deliberately independent.
//
// **A different marker owner from `resolution-markers.ts`, and that is the
// design.** `ProblemManager.setMarkers` replaces every marker for one
// `(uri, owner)` pair, so a shared owner would make each of the two halves erase
// the other's findings about the same file -- and they are about different
// things, arriving at different times. Two owners is what lets each replace its
// own set atomically, which is what the requirement asks of both.
//
// Native rather than a VS Code language client: `monaco-languageclient` depends
// on `monaco-editor` instead of `@theia/monaco-editor-core`, and a second Monaco
// gives `monaco.languages.register` a different `ILanguageService` than the one
// the editor waits on. See `cpt-gearbox-adr-gdl-language-server`.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { DisposableCollection } from "@theia/core/lib/common/disposable";
import { URI } from "@theia/core/lib/common/uri";
import type { PublishDiagnosticsParams } from "@theia/core/shared/vscode-languageserver-protocol";
import { inject, injectable } from "@theia/core/shared/inversify";
import { ProblemManager } from "@theia/markers/lib/browser/problem/problem-manager";
import type { MonacoEditorModel } from "@theia/monaco/lib/browser/monaco-editor-model";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";

import { GearboxService } from "../../common/protocol";
import { EngineConnectionService } from "../shell/engine-connection-service";
import { GDL_LANGUAGE_ID } from "./gdl-language-contribution";

/**
 * The marker owner, and not `"gearbox"`.
 *
 * See the note at the top of the file: sharing an owner with the resolution
 * markers would make each publication delete the other's.
 */
export const DESCRIPTION_MARKER_OWNER = "gearbox-gdl";

/**
 * How long a burst of keystrokes is allowed to collapse into one round trip.
 *
 * Not about the evaluation, which is milliseconds -- the trip is the browser's
 * websocket, then the backend, then the engine's stdio, and back. The same 200ms
 * the create wizard's preview uses, for the same reason and to keep one number
 * in the product rather than two.
 */
const DEBOUNCE_MS = 200;

/** One watched buffer: the model to re-read, and what watching it owns. */
interface Tracked {
  model: MonacoEditorModel;
  disposables: DisposableCollection;
}

@injectable()
export class DescriptionMarkers implements FrontendApplicationContribution {
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(ProblemManager) protected readonly problems!: ProblemManager;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;

  protected readonly tracked = new Map<string, Tracked>();
  protected readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** This contribution's own subscriptions, as opposed to one document's. */
  protected readonly toDispose = new DisposableCollection();

  onStart(): void {
    // `onDidCreate` is what catches a reload's restored editors, and the loop is
    // the smaller case. `FrontendApplication.start` runs `startContributions`
    // before `initializeLayout`, so the layout -- and every model in it -- is
    // restored after this method returns; what the loop is for is a model some
    // other contribution's `onStart` opened before this one ran.
    for (const model of this.models.models) this.track(model);
    this.toDispose.push(this.models.onDidCreate((model) => this.track(model)));

    // **Tell every new engine about the buffers that are already open.** The
    // backend replays its own document mirror across an `initialize`, but that
    // mirror belongs to one `GearboxServiceImpl` and `frontendConnectionTimeout`
    // is `0`: a dropped socket disposes the service, and the frontend reconnects
    // in place -- same page, same models, same `tracked` -- onto a replacement
    // that has never heard of any document. Nothing calls `track` a second time,
    // because the models never went away, so without this the markers on an open
    // `.gdl` freeze at whatever the dead engine said until the next keystroke.
    //
    // This event rather than `ConnectionStatusService`, because it fires where
    // `CatalogueStore` has finished `initialize` -- the first moment an engine
    // exists to be told anything. Listening to the socket instead would race the
    // load that respawns it, which is the ordering `view-contributions.ts`
    // records for the same edge. It also covers an engine that died on its own:
    // `onEngineExit` marks it down, so the reload marks it up again here.
    this.toDispose.push(
      this.engine.onDidChange((connected) => {
        if (connected) this.reopen();
      }),
    );
  }

  onStop(): void {
    // Hygiene, not a leak -- the page is going away either way. But a debounce
    // that fires into a proxy being torn down logs a failure about a document
    // nobody is looking at any more.
    this.toDispose.dispose();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const { disposables } of this.tracked.values()) disposables.dispose();
    this.tracked.clear();
  }

  /**
   * Diagnostics for one document, replacing that document's previous set.
   *
   * The payload is already LSP's, so nothing is converted here -- the engine
   * publishes `textDocument/publishDiagnostics` and `ProblemManager` stores LSP
   * diagnostics. The empty list matters as much as a full one: it is how the
   * engine says "clean now", and dropping it would leave the last error on
   * screen after it was fixed.
   *
   * **Two publications are refused, and both refusals are of a stale one.** The
   * reason this requirement exists at all is that "stale markers are worse than
   * none", so an answer about a buffer that has already moved on is not drawn at
   * a range it no longer describes:
   *
   * - a version older than the model's. The engine echoes the version it
   *   evaluated precisely so this comparison is possible (`lsp.rs`,
   *   `PublishDiagnosticsParams::version`), and a newer answer is already coming
   *   -- the keystroke that outdated this one is what sends it.
   * - a URI nothing tracks. `forget` clears that file's markers itself rather
   *   than waiting for the engine's empty list, so a publication still in flight
   *   would otherwise put them back on a buffer that is closed.
   *
   * The close notification carries no version at all, which is why the first
   * guard tests for one before comparing: that publication is the empty list,
   * and an absent version must never read as an old one.
   */
  onDocumentDiagnostics(params: PublishDiagnosticsParams): void {
    const tracked = this.tracked.get(params.uri);
    if (tracked === undefined) return;
    if (params.version !== undefined && params.version < tracked.model.version) return;
    this.problems.setMarkers(new URI(params.uri), DESCRIPTION_MARKER_OWNER, params.diagnostics);
  }

  protected track(model: MonacoEditorModel): void {
    // The language id decides, not the extension: a `load()` fragment can be
    // called anything, and the language registration is the one place that says
    // which files are GDL.
    if (model.languageId !== GDL_LANGUAGE_ID) return;
    const uri = model.uri;
    if (this.tracked.has(uri)) return;

    const disposables = new DisposableCollection();
    this.tracked.set(uri, { model, disposables });

    this.open(uri, model);

    disposables.push(
      model.onDidChangeContent(() => {
        const pending = this.timers.get(uri);
        if (pending !== undefined) clearTimeout(pending);
        this.timers.set(
          uri,
          setTimeout(() => {
            this.timers.delete(uri);
            // Re-read at send time rather than closing over the text from the
            // event: what the engine should evaluate is the buffer as it is when
            // the trip starts, not as it was when the burst began.
            this.send(this.service.didChangeDocument(uri, model.version, model.getText()));
          }, DEBOUNCE_MS),
        );
      }),
    );

    disposables.push(model.onDispose(() => this.forget(uri)));
  }

  /** Tell the engine about one buffer, as it is at this moment. */
  protected open(uri: string, model: MonacoEditorModel): void {
    this.send(this.service.didOpenDocument(uri, model.version, model.getText()));
  }

  /**
   * Every tracked buffer again, for an engine that has not been told about any.
   *
   * A second `didOpen` for a document the engine already holds is not a problem
   * it has to solve: the handler stores the text it is given and republishes, so
   * a redundant evaluation is the whole cost. That is the cheap side of the
   * trade against a marker frozen on a file somebody is editing.
   */
  protected reopen(): void {
    for (const [uri, { model }] of this.tracked) this.open(uri, model);
  }

  /**
   * Fire and forget, but not fire and crash.
   *
   * These three calls are notifications in everything but the RPC layer's
   * opinion: nothing waits on them and there is nothing useful to do when one
   * fails. But `void` on a rejecting promise is an unhandled rejection, which
   * Theia surfaces as a page error -- and a page error is a real failure of the
   * application, reported by `regression.spec.ts`'s console claim, for something
   * that is not one.
   *
   * **A backend that cannot answer is an ordinary state here.** The one that
   * found this was a Playwright server reused across a backend change
   * (`reuseExistingServer`), where every `didOpenDocument` hit a process that had
   * never heard of it. A reconnect, a restart and a disposed engine all look the
   * same from this side. What repairs them is `reopen`, on the edge where an
   * engine reports itself up again; this only has to not turn the gap into an
   * error about a file somebody is simply typing in.
   */
  protected send(call: Promise<void>): void {
    call.catch((error: unknown) => {
      console.warn(`gearbox: the engine did not take a document update: ${String(error)}`);
    });
  }

  protected forget(uri: string): void {
    // A pending debounce is dropped rather than flushed: it describes a buffer
    // that no longer exists, and the answer would arrive after the markers for
    // this file had already been cleared -- putting them back.
    const pending = this.timers.get(uri);
    if (pending !== undefined) clearTimeout(pending);
    this.timers.delete(uri);

    this.tracked.get(uri)?.disposables.dispose();
    this.tracked.delete(uri);
    this.send(this.service.didCloseDocument(uri));
    // Cleared here too, and not only by waiting for the engine's empty list. The
    // engine may be gone -- a `didClose` sent into a dead connection is dropped
    // on purpose -- and a marker that outlives its buffer points at text nobody
    // can see.
    this.problems.setMarkers(new URI(uri), DESCRIPTION_MARKER_OWNER, []);
  }
}
