// The editor's status bar, cut down to the one indicator that says something.
//
// A general editor tells you `Ln 12, Col 4`, `Spaces: 4`, `UTF-8` and `LF`,
// because a general editor is where you fix a file's encoding and its line
// endings. Studio's editor is there to *read* what the resolution points at -- a
// `gear.gdl`, a generated crate -- and none of those four is a thing anyone comes
// here to change. Four controls that will never be used are four controls that
// make the application look like something it is not.
//
// The language indicator stays. It is the one that carries information a reader
// wants: whether `.gdl` was recognised as GDL rather than falling back to
// plaintext, which is a real failure mode -- a TextMate grammar that fails to
// load is a `logger.warn` and nothing else.
//
// Done by rebinding rather than by removing elements after the fact, because both
// contributions re-set their elements on every cursor move, option change and
// editor switch. Anything that removed them afterwards would be racing the thing
// that puts them back.

import { StatusBar } from "@theia/core/lib/browser";
import { EditorContribution } from "@theia/editor/lib/browser/editor-contribution";
import { MonacoStatusBarContribution } from "@theia/monaco/lib/browser/monaco-status-bar-contribution";
import { injectable } from "@theia/core/shared/inversify";

/**
 * `Ln 12, Col 4` and `UTF-8`, suppressed.
 *
 * The overrides remove rather than skip: `deactivate` and the "no editor" paths
 * in the originals both call `removeElement`, so an element left over from before
 * a rebind -- or from another contribution -- goes as well. Skipping would leave
 * whatever was last set on screen for the rest of the session.
 */
@injectable()
export class QuietEditorContribution extends EditorContribution {
  protected override updateEncodingStatus(statusBar: StatusBar): void {
    statusBar.removeElement("editor-status-encoding");
  }

  protected override setCursorPositionStatus(statusBar: StatusBar): void {
    statusBar.removeElement("editor-status-cursor-position");
  }
}

/**
 * `Spaces: 4` and `LF`, suppressed.
 *
 * The base class already has the two removals as methods, so this is the
 * set-becomes-remove substitution and nothing more.
 */
@injectable()
export class QuietMonacoStatusBarContribution extends MonacoStatusBarContribution {
  protected override setConfigTabSizeWidget(statusBar: StatusBar): void {
    this.removeConfigTabSizeWidget(statusBar);
  }

  protected override setLineEndingWidget(statusBar: StatusBar): void {
    this.removeLineEndingWidget(statusBar);
  }
}
