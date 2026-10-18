"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  cp = require("node:child_process");
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
function git(root, args) {
  // WSL Git on a Windows checkout can spend minutes issuing 9P stat calls.
  // Use the explicitly configured local Windows Git for mounted-drive roots.
  const mounted = root.match(/^\/mnt\/([a-z])\/(.*)$/);
  const native = process.env.DEMO_NATIVE_WINDOWS_GIT && mounted;
  const executable = native ? process.env.DEMO_NATIVE_WINDOWS_GIT : "git";
  const directory = native
    ? mounted[1].toUpperCase() + ":/" + mounted[2]
    : root;
  const result = cp.spawnSync(executable, ["-C", directory, ...args], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw Error("Cannot read source Git state: " + root);
  return result.stdout;
}
function sourceState(root, paths) {
  const hash = crypto.createHash("sha256");
  hash.update(git(root, ["ls-tree", "-r", "-z", "HEAD", "--", ...paths]));
  hash.update(
    git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "HEAD",
      "--",
      ...paths,
    ]),
  );
  const untracked = git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...paths,
  ])
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const name of untracked) {
    const file = path.join(root, name),
      stat = fs.lstatSync(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    hash.update(JSON.stringify(name));
    hash.update(
      digest(
        stat.isSymbolicLink()
          ? Buffer.from(fs.readlinkSync(file))
          : fs.readFileSync(file),
      ),
    );
  }
  return {
    revision: git(root, ["rev-parse", "HEAD"]).toString().trim(),
    digest: hash.digest("hex"),
  };
}
function fileDigest(file) {
  if (!fs.statSync(file).isFile()) throw Error("Missing input file: " + file);
  return digest(fs.readFileSync(file));
}
function inputs(repo, source, engine, work) {
  const gearbox = sourceState(repo, [
    "Cargo.toml",
    "Cargo.lock",
    "crates",
    "products/settings-community-demo",
    "ide/gearbox-studio/src",
  ]);
  const gears = sourceState(source, [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    ".cargo",
    "gears",
    "libs",
    "ui",
    "proto",
    "config",
  ]);
  const privateFiles = [
    "private/runtime-secrets.json",
    "private/values.private.json",
    "private/kubernetes-secret.json",
    "private/postgres.env",
    "private-assets/portraits/manifest.json",
    "private-assets/portraits/dasha.webp",
    "private-assets/portraits/ilya.webp",
  ];
  const privateHash = digest(
    Buffer.from(
      privateFiles
        .map((file) => file + ":" + fileDigest(path.join(work, file)))
        .join("\n"),
    ),
  );
  return { gearbox, gears, engine: fileDigest(engine), privateHash };
}
function within(base, relative) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((p) => p === "..")
  )
    throw Error("Invalid bundle artifact path");
  const actual = path.resolve(base, relative);
  if (!actual.startsWith(path.resolve(base) + path.sep))
    throw Error("Artifact escapes bundle");
  return actual;
}
function artifacts(base) {
  const result = [];
  function visit(relative) {
    for (const entry of fs
      .readdirSync(path.join(base, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", "target", ".git"].includes(entry.name)) continue;
      const name = path.join(relative, entry.name),
        file = path.join(base, name);
      if (entry.isSymbolicLink())
        throw Error("Generated bundle contains a symbolic link: " + name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        result.push({
          path: name.split(path.sep).join("/"),
          sha256: fileDigest(file),
        });
    }
  }
  visit("");
  return result;
}
function verifyArtifacts(base, list, exact = false) {
  if (!Array.isArray(list) || !list.length)
    throw Error("Bundle has no artifact manifest");
  for (const item of list)
    if (fileDigest(within(base, item.path)) !== item.sha256)
      throw Error("Prepared artifact changed: " + item.path);
  if (exact) {
    const expected = new Set(list.map((item) => item.path));
    const current = artifacts(base);
    if (
      current.length !== list.length ||
      current.some((item) => !expected.has(item.path))
    )
      throw Error("Prepared artifact set changed; run prepare again");
  }
}
function checkInputs(expected, current) {
  for (const name of ["gearbox", "gears"])
    if (expected[name]?.digest !== current[name]?.digest)
      throw Error(name + " source inputs changed; run prepare again");
  for (const name of ["engine", "privateHash"])
    if (expected[name] !== current[name])
      throw Error(
        name === "engine"
          ? "Generator binary changed; run prepare again"
          : "Private configuration or portraits changed; run prepare again",
      );
}
module.exports = {
  digest,
  sourceState,
  fileDigest,
  inputs,
  within,
  artifacts,
  verifyArtifacts,
  checkInputs,
};
