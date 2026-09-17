// Completion and hover for `.gdl`, from the engine's own vocabulary.
//
// `cpt-gearbox-adr-gdl-completion-and-hover`. Registered natively against
// `@theia/monaco-editor-core` rather than through `monaco-languageclient`, for
// the reason `description-markers.ts` records: a second Monaco would hand
// `monaco.languages.register` a different `ILanguageService` than the one the
// editor waits on.
//
// **Why the engine answers and not this file.** The generated
// `generated/vocabulary.ts` beside this one carries *names*, which is all a
// TextMate grammar needs. Completion needs each construct's parameters, their
// types and defaults, and the prose written above them -- and those live in the
// interpreter's `Globals` at runtime. Asking the engine keeps one source of
// truth; regenerating them into TypeScript would make a second, larger artefact
// whose only consumer is this file.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { inject, injectable } from "@theia/core/shared/inversify";
import * as monaco from "@theia/monaco-editor-core";

import { GearboxService } from "../../common/protocol";
import { GDL_LANGUAGE_ID } from "./gdl-language-contribution";

@injectable()
export class GdlAssistContribution implements FrontendApplicationContribution {
  @inject(GearboxService) protected readonly service!: GearboxService;

  onStart(): void {
    monaco.languages.registerCompletionItemProvider(GDL_LANGUAGE_ID, {
      // No `triggerCharacters`. Monaco supports single characters only, and `(`
      // would reopen the list on every finished call in the file. Completion is
      // asked for explicitly or while typing a word, which is enough.
      provideCompletionItems: async (model, position) => {
        const items = await this.service.completion(
          model.uri.toString(),
          // Monaco counts from one on both axes; LSP counts from zero.
          position.lineNumber - 1,
          position.column - 1,
        );
        // The word under the caret, so Monaco replaces it rather than inserting
        // beside it. Without an explicit range, a half-typed `pack` completed to
        // `package` yields `packpackage`.
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        return {
          suggestions: items.map((item) => ({
            label: item.label,
            kind: item.kind as monaco.languages.CompletionItemKind,
            detail: item.detail,
            documentation: item.documentation,
            insertText: item.label,
            range,
          })),
        };
      },
    });

    monaco.languages.registerHoverProvider(GDL_LANGUAGE_ID, {
      provideHover: async (model, position) => {
        const hover = await this.service.hover(
          model.uri.toString(),
          position.lineNumber - 1,
          position.column - 1,
        );
        // `null` is most of a file: the caret is not inside a known construct.
        // Returning `undefined` is how a Monaco provider declines, and declining
        // lets another provider answer instead of showing an empty tooltip.
        if (hover === null) return undefined;
        // The engine sends the plain-string form of LSP's `MarkedString`. The
        // protocol's type admits three more shapes, so this narrows rather than
        // casts: a server that started sending the object form would otherwise
        // render as `[object Object]` with nothing to say why.
        const text = typeof hover.contents === "string" ? hover.contents : undefined;
        return text === undefined ? undefined : { contents: [{ value: text }] };
      },
    });
  }
}
