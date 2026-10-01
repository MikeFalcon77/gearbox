// Everything about `.gdl` that is not colour: what a comment looks like, which
// brackets pair, where the caret lands on Enter.
//
// A TypeScript module rather than the `language-configuration.json` a VS Code
// extension would ship, because `wordPattern` and the indentation rules are
// typed `RegExp` and JSON cannot express one. Monaco wants the object, not a
// URI to fetch it from.

import * as monaco from "@theia/monaco-editor-core";

export const GDL_LANGUAGE_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  // GDL is Starlark, so `#` and not `//`. `//` is a *path* prefix here --
  // `load("//shared.gdl", ...)` is source-root-relative -- which is exactly the
  // mistake this line prevents an editor from making.
  comments: { lineComment: "#" },

  brackets: [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ],

  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    // The triple forms come first: Monaco takes the first match, and `"` would
    // otherwise win against `"""` and leave the docstring unbalanced.
    { open: '"""', close: '"""', notIn: ["string", "comment"] },
    { open: "'''", close: "'''", notIn: ["string", "comment"] },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
  ],

  surroundingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],

  // Starlark identifiers are ASCII word characters. `/` and `$` are excluded so
  // that double-clicking inside `"//shared.gdl"` or `"${PG_HOST}"` selects a
  // path segment or the variable name rather than the whole string's insides.
  wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,

  indentationRules: {
    // A line whose last non-comment character opens a bracket indents the next.
    increaseIndentPattern: /^.*[([{]\s*(#.*)?$/,
    // A line that is nothing but closers goes back out.
    decreaseIndentPattern: /^\s*[)\]}][,)\]}]*\s*$/,
  },

  onEnterRules: [
    {
      // Every gear.gdl in the corpus is laid out as `gear(\n    name = ...`,
      // so Enter after the opening paren should land where the first argument
      // goes.
      beforeText: /[([{]\s*$/,
      action: { indentAction: monaco.languages.IndentAction.Indent },
    },
  ],
};
