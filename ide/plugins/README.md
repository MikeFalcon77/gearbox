# Bundled VS Code plugins

`browser-app`'s start script passes `--plugins=local-dir:../plugins`, so anything
here is loaded by the plugin host at startup.

The directory is deliberately near-empty. Theia 1.75 no longer ships
`@theia/git` -- its last release was `1.61.0-next.8` -- so Git support comes from
the VS Code `vscode.git` extension running in this host. That extension is a
third-party artefact fetched from Open VSX rather than a package.json
dependency, which is a different kind of decision from adding a `@theia/*`
package, so it is not done implicitly.

To add it, declare it under `theiaPlugins` in `browser-app/package.json` and run
`theia download:plugins`.
