declare module "*.svg" {
  const url: string;
  export default url;
}

declare module "@theia/monaco/data/monaco-themes/vscode/dark_plus.json" {
  const theme: Record<string, unknown>;
  export = theme;
}

declare module "@theia/monaco/data/monaco-themes/vscode/dark_vs.json" {
  const theme: Record<string, unknown>;
  export = theme;
}
