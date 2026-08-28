// Teaching Monaco that `.gdl` is a language.
//
// Until this existed, `gear.gdl` opened as plaintext -- not because the grammar
// was wrong but because there was none, and nothing had ever registered the
// language id. The TextMate machinery was already in the build (`@theia/monaco`
// carries `vscode-textmate` and the oniguruma wasm); it just had no
// contribution to iterate.
//
// This ships as a native Theia contribution rather than as the bundled VS Code
// extension the prototype plan sketched. That path needs `@theia/plugin-ext`
// and a populated `ide/plugins/`, neither of which this app has -- the
// `--plugins=local-dir:../plugins` flag in browser-app is inert today. Adding a
// plugin host to run one grammar is a large dependency for a small feature, and
// it would give up the thing that makes this version trustworthy: the
// vocabulary is generated from the engine's own globals.

import { injectable } from "@theia/core/shared/inversify";
import * as monaco from "@theia/monaco-editor-core";
// Imported by their narrow paths rather than through the `textmate` barrel:
// the barrel re-exports `monaco-textmate-frontend-bindings`, whose module body
// pulls in `vscode-oniguruma`.
import { LanguageGrammarDefinitionContribution } from "@theia/monaco/lib/browser/textmate/textmate-contribution";
import { TextmateRegistry } from "@theia/monaco/lib/browser/textmate/textmate-registry";

import { GDL_GRAMMAR, GDL_SCOPE_NAME } from "./gdl-grammar";
import { GDL_LANGUAGE_CONFIGURATION } from "./gdl-language-configuration";

export const GDL_LANGUAGE_ID = "gdl";

@injectable()
export class GdlLanguageContribution implements LanguageGrammarDefinitionContribution {
  /**
   * Registering the language belongs here, in the grammar hook, and not in a
   * `FrontendApplicationContribution` of its own.
   *
   * `MonacoTextmateService.initialize` runs every grammar provider first and
   * only then walks the registry calling `activateLanguage`, which waits on
   * `monaco.languages.onLanguage` -- an event that never fires for a language
   * Monaco has not been told about. Registering any later would arm nothing,
   * and the failure would be silent: a plaintext editor and no error.
   */
  registerTextmateLanguage(registry: TextmateRegistry): void {
    monaco.languages.register({
      id: GDL_LANGUAGE_ID,
      extensions: [".gdl"],
      // Both by extension and by name. The two files the engine looks for are
      // fixed (`catalogue.rs` and `product.rs` name them), while a `load()`
      // fragment can be called anything and is covered by the extension.
      filenames: ["gear.gdl", "product.gdl"],
      aliases: ["GDL", "Gears Description Language", "gdl"],
      mimetypes: ["text/x-gdl"],
    });
    monaco.languages.setLanguageConfiguration(GDL_LANGUAGE_ID, GDL_LANGUAGE_CONFIGURATION);

    registry.registerTextmateGrammarScope(GDL_SCOPE_NAME, {
      getGrammarDefinition: async () => ({ format: "json", content: GDL_GRAMMAR }),
    });
    registry.mapLanguageIdToTextmateGrammar(GDL_LANGUAGE_ID, GDL_SCOPE_NAME);
  }
}
