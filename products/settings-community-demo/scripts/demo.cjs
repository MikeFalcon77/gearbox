#!/usr/bin/env node
"use strict";
// Bounded local demo runner. No arbitrary scripts, profiles, namespaces or URLs.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  cp = require("node:child_process"),
  crypto = require("node:crypto");
const state = require("./bundle-state.cjs");
const offline = /^(prepare|deploy|validate|forward|smoke|reset|backup|restore|cleanup)-offline$/.test(process.argv[2] || "");
const repo = path.resolve(__dirname, "../../.."),
  baseWork = path.join(repo, ".gearbox/settings-community-demo"),
  work = offline ? path.join(baseWork, "offline") : baseWork,
  profile = "gearbox-demo",
  namespace = "gearbox-demo";
const machineFile = path.join(work, "machine.json"),
  manifestFile = path.join(work, "bundle.json");
let machine,
  logSerial = 0,
  operationId,
  pinnedPostgres;
const invocation = crypto.randomUUID();
// A disconnected observer may close its output pipe. Keep writing the private
// receipt; this does not guarantee survival of a host/process-tree shutdown.
process.stdout.on("error", error => { if (error.code !== "EPIPE") throw error; });
function stage(name, message, status = "running", extra = {}) {
  const event = { stage: name, status, message, ...extra };
  console.log("@@demo " + JSON.stringify(event));
  if (operationId) {
    const directory = path.join(work, "operations");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, operationId + ".json");
    fs.writeFileSync(
      file + ".tmp",
      JSON.stringify({
        operationId,
        pid: process.pid,
        ...event,
        at: new Date().toISOString(),
      }) + "\n",
      { mode: 0o600 },
    );
    fs.renameSync(file + ".tmp", file);
  }
}
function loadMachine() {
  const file = fs.existsSync(machineFile) ? machineFile : offline ? path.join(baseWork, "machine.json") : machineFile;
  const config = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  if (
    config.dockerHost &&
    !/^(unix:\/\/\/|npipe:\/\/\/|tcp:\/\/(127\.0\.0\.1|localhost):)/.test(
      config.dockerHost,
    )
  )
    throw Error("Only a local Docker daemon is supported");
  return config;
}
function env() {
  const result = {
    ...process.env,
    KUBECONFIG: machine.kubeconfig,
    DEMO_MINIKUBE_PROFILE: profile,
    DEMO_KUBE_CONTEXT: profile,
    DEMO_WORK_DIR: work,
    DEMO_OFFLINE: offline ? "1" : "0",
    DEMO_FIREBASE_HANDOFF: path.join(repo, ".gearbox/firebase-preflight"),
    ...(pinnedPostgres ? { DEMO_POSTGRES_IMAGE: pinnedPostgres } : {}),
  };
  if (machine.dockerHost) {
    result.DOCKER_HOST = machine.dockerHost;
    delete result.DOCKER_CONTEXT;
  }
  return result;
}
async function run(command, args, label, capture = false, input) {
  fs.mkdirSync(path.join(work, "logs", invocation), {
    recursive: true,
    mode: 0o700,
  });
  const log = path.join(
    work,
    "logs",
    invocation,
    String(++logSerial) + "-" + label.replace(/[^a-z0-9-]/gi, "_") + ".log",
  );
  const output = fs.createWriteStream(log, { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: repo,
      env: env(),
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin.end(input);
    let text = "",
      size = 0,
      settled = false;
    const timer = setTimeout(
      () => {
        child.kill("SIGTERM");
        finish(Error(label + " timed out; see " + log));
      },
      45 * 60 * 1000,
    );
    timer.unref();
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.end();
      error ? reject(error) : resolve(text);
    }
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes) => {
        output.write(bytes);
        if (capture && stream === child.stdout) {
          size += bytes.length;
          if (size > 64 * 1024 * 1024) {
            child.kill();
            finish(Error("Command output exceeded its bound"));
            return;
          }
          text += bytes.toString();
        }
        if (label === "build")
          for (const line of bytes.toString().split("\n"))
            if (
              /Compiling |Finished |exporting layers|transferring context:/.test(
                line,
              )
            )
              stage("build", line.trim().slice(0, 200));
      });
    child.on("error", () =>
      finish(Error("Cannot start " + command + "; see " + log)),
    );
    child.on("close", (code) =>
      finish(
        code === 0
          ? null
          : Error(label + " failed (exit " + code + "); see " + log),
      ),
    );
  });
}
const sh = (script, label) => run("sh", [path.join(__dirname, script)], label);
const k = (args, label = "cluster", capture = false) =>
  run(
    "kubectl",
    ["--context", profile, "--namespace", namespace, ...args],
    label,
    capture,
  );
async function dockerInfo() {
  const host =
    machine.dockerHost ||
    process.env.DOCKER_HOST ||
    JSON.parse(
      await run(
        "docker",
        ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
        "docker-context",
        true,
      ),
    );
  if (
    !/^(unix:\/\/\/|npipe:\/\/\/|tcp:\/\/(127\.0\.0\.1|localhost):)/.test(host)
  )
    throw Error("Private UI images must stay on a local Docker daemon");
  const info = JSON.parse(
    await run("docker", ["info", "--format", "{{json .}}"], "docker", true),
  );
  if (
    info.OSType !== "linux" ||
    info.NCPU < 3 ||
    info.MemTotal < 6 * 1024 ** 3
  )
    throw Error(
      "Docker needs Linux containers, at least 3 CPUs and 6 GiB RAM",
    );
  return info;
}
async function cluster() {
  const status = JSON.parse(
    await run(
      "minikube",
      ["-p", profile, "status", "-o", "json"],
      "cluster-status",
      true,
    ),
  );
  if (
    status.Host !== "Running" ||
    status.Kubelet !== "Running" ||
    status.APIServer !== "Running"
  )
    throw Error("Demo cluster is not running; run prepare");
  const profiles = JSON.parse(
    await run(
      "minikube",
      ["profile", "list", "-o", "json"],
      "profile-resources",
      true,
    ),
  );
  const allocation = profiles.valid?.find(
    (item) => item.Name === profile,
  )?.Config;
  if (
    !allocation ||
    allocation.Driver !== "docker" ||
    allocation.CPUs < 3 ||
    allocation.Memory < 4500
  )
    throw Error(
      "The demo minikube profile needs the Docker driver, 3 CPUs and 4500 MiB RAM",
    );
  const nodes = JSON.parse(
    await k(["get", "nodes", "-o", "json"], "nodes", true),
  );
  if (
    nodes.items.length !== 1 ||
    nodes.items[0].metadata.labels["minikube.k8s.io/name"] !== profile
  )
    throw Error("The kube context is not the named one-node demo profile");
  const system = JSON.parse(
    await k(
      ["get", "namespace", "kube-system", "-o", "json"],
      "cluster-identity",
      true,
    ),
  );
  return {
    uid: system.metadata.uid,
    architecture: nodes.items[0].status.nodeInfo.architecture,
  };
}
function linkSource(source) {
  const directory = path.join(work, "source"),
    link = path.join(directory, "gears-rust");
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(link)) {
    if (fs.realpathSync(link) !== fs.realpathSync(source))
      throw Error(
        "Prepared source alias points at another checkout; reconfigure the private demo source alias",
      );
    return;
  }
  fs.symlinkSync(
    source,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
}
async function engine() {
  if (machine.engine) {
    if (!fs.existsSync(machine.engine))
      throw Error("Configured generator binary is missing");
    return pinEngine(machine.engine);
  }
  stage("generator", "Building the local Gearbox generator");
  await run(
    "cargo",
    [
      "build",
      "--manifest-path",
      path.join(repo, "Cargo.toml"),
      "-p",
      "gearbox-cli",
      "--locked",
    ],
    "generator-build",
  );
  return pinEngine(path.join(repo, "target/debug/gearbox" + (process.platform === "win32" ? ".exe" : "")));
}
function pinEngine(source) {
  const directory = path.join(work, "bin");
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, "gearbox-" + state.fileDigest(source) + (process.platform === "win32" ? ".exe" : ""));
  if (!fs.existsSync(file)) fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
  if (state.fileDigest(file) !== state.fileDigest(source)) throw Error("Pinned generator hash mismatch");
  fs.chmodSync(file, 0o700);
  return file;
}
async function idleHelm() {
  const helm = (await shCapture("ensure-helm.sh", "helm")).trim();
  const releases = JSON.parse(
    await run(
      helm,
      [
        "list",
        "--all",
        "--filter",
        "^settings-community-demo$",
        "--kubeconfig",
        machine.kubeconfig,
        "--kube-context",
        profile,
        "--namespace",
        namespace,
        "-o",
        "json",
      ],
      "helm-release-state",
      true,
    ),
  );
  const status = releases[0]?.status;
  if (typeof status === "string" && status.startsWith("pending-"))
    throw Error(
      "The previous demo Helm operation is unfinished (" +
        status +
        "). Recover the owned release before retrying; no new upgrade was started.",
    );
  return helm;
}
function prepareOfflinePrivateInputs() {
  for (const relative of ["private/runtime-secrets.json", "private-assets/portraits/manifest.json", "private-assets/portraits/dasha.webp", "private-assets/portraits/ilya.webp"]) {
    const source = path.join(baseWork, relative), destination = path.join(work, relative);
    if (!fs.existsSync(source)) throw Error("Prepare the normal product and private inputs before the reserve profile");
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
    }
    const unchanged = relative.endsWith('runtime-secrets.json')
      ? Object.entries(JSON.parse(fs.readFileSync(source, 'utf8'))).every(([key, value]) => JSON.parse(fs.readFileSync(destination, 'utf8'))[key] === value)
      : fs.readFileSync(source).equals(fs.readFileSync(destination));
    if (!unchanged) throw Error('Normal private input changed: review and refresh the reserve copy before preparing offline: ' + relative);
  }
}
async function reusePreparedBackends() {
  const normal = JSON.parse(fs.readFileSync(path.join(baseWork, "bundle.json"), "utf8"));
  if (normal.verified !== true || normal.mode !== "firebase") throw Error("Prepare the normal Firebase bundle before the offline reserve");
  state.checkInputs(normal.inputs, state.inputs(repo, machine.sourceRoot, machine.preparedEngine, baseWork));
  const normalRoot = path.join(baseWork, "minikube"), offlineRoot = path.join(work, "minikube");
  state.verifyArtifacts(normalRoot, normal.artifacts, true);
  const normalize = (file, root) => fs.readFileSync(file, "utf8").replace(/path\s*=\s*"([^"\n]+)"/g, (_match, relative) => {
    const absolute = fs.realpathSync(path.resolve(path.dirname(file), relative));
    const inside = path.relative(root, absolute);
    return 'path = "' + (inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? "<generated>/" + inside : absolute).replaceAll("\\", "/") + '"';
  });
  for (const item of normal.artifacts.filter(item => item.path.endsWith(".rs") || item.path.endsWith("Cargo.toml"))) {
    if (normalize(path.join(normalRoot, item.path), normalRoot) !== normalize(path.join(offlineRoot, item.path), offlineRoot))
      throw Error("Offline compiled composition differs from the prepared backend: " + item.path);
  }
  for (const name of ["gateway", "settings"]) {
    const image = normal.images.find(image => image.name === name);
    const actual = JSON.parse(await run("docker", ["image", "inspect", image.ref], "offline-backend-image", true))[0];
    if (actual.Id !== image.id) throw Error("Prepared backend image changed");
    await run("docker", ["tag", image.ref, "gbx-demo-" + name + ":0.1.0"], "reuse-backend-image");
  }
  stage("build", "Reusing the verified identical backend composition; building the offline UI configuration");
}
async function prepare() {
  if (offline) prepareOfflinePrivateInputs();
  stage(
    "preflight",
    "Checking the existing Firebase handoff, private portraits and local tools",
  );
  if (
    !machine.sourceRoot ||
    !fs.existsSync(path.join(machine.sourceRoot, "gears"))
  )
    throw Error(
      "Set sourceRoot in the private machine.json or pass --source-root",
    );
  machine.sourceRoot = fs.realpathSync(machine.sourceRoot);
  linkSource(machine.sourceRoot);
  await run(
    process.execPath,
    [path.join(__dirname, "prepare-inputs.cjs")],
    "private-inputs",
  );
  const info = await dockerInfo();
  const status = cp.spawnSync(
    "minikube",
    ["-p", profile, "status", "-o", "json"],
    { env: env(), encoding: "utf8", windowsHide: true },
  );
  if (
    status.status !== 0 ||
    JSON.parse(status.stdout || "{}").Host !== "Running"
  ) {
    stage("cluster", "Starting the dedicated minikube profile");
    await run(
      "minikube",
      [
        "start",
        "-p",
        profile,
        "--driver=docker",
        "--container-runtime=containerd",
        "--cpus=3",
        "--memory=4600",
        "--kubernetes-version=v1.32.0",
      ],
      "cluster-start",
    );
  }
  const target = await cluster();
  await idleHelm();
  const diskImage = cp.spawnSync(
    "docker",
    ["image", "inspect", "node:24.21.0-alpine"],
    { env: env(), stdio: "ignore", windowsHide: true },
  );
  if (diskImage.status !== 0)
    await run("docker", ["pull", "node:24.21.0-alpine"], "preflight-image");
  const disk = (
    await run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "sh",
        "node:24.21.0-alpine",
        "-c",
        "df -Pk / | tail -n 1",
      ],
      "disk",
      true,
    )
  )
    .trim()
    .split(/\s+/);
  if (!Number.isFinite(Number(disk[3])) || Number(disk[3]) < 8 * 1024 * 1024)
    throw Error("Docker needs at least 8 GiB available disk space");
  const clusterDisk = (
    await run(
      "minikube",
      ["-p", profile, "ssh", "--", "df -Pk /var | tail -n 1"],
      "cluster-disk",
      true,
    )
  )
    .trim()
    .split(/\s+/);
  if (
    !Number.isFinite(Number(clusterDisk[3])) ||
    Number(clusterDisk[3]) < 8 * 1024 * 1024
  )
    throw Error("Minikube needs at least 8 GiB available disk space");
  const generator = await engine();
  machine.preparedEngine = generator;
  fs.writeFileSync(machineFile, JSON.stringify(machine, null, 2) + "\n", {
    mode: 0o600,
  });
  const before = state.inputs(repo, machine.sourceRoot, generator, work);
  stage("generate", "Resolving and generating the prepared GDL product");
  await run(
    generator,
    [
      "generate",
      "--root",
      machine.sourceRoot,
      "--source-id",
      "gears-rust",
      "--product",
      path.join(repo, offline ? "products/settings-community-demo/product.offline.gdl" : "products/settings-community-demo/product.gdl"),
      "--profile",
      offline ? "minikube-offline" : "minikube",
      "--out",
      path.join(work, "minikube"),
    ],
    "generate",
  );
  await run(
    process.execPath,
    [path.join(__dirname, "prepare-ui.cjs")],
    "ui-inputs",
  );
  await run(
    process.execPath,
    [path.join(__dirname, "prepare-chart.cjs")],
    "chart-inputs",
  );
  stage("build", offline ? "Preparing the explicit offline UI and verified backend reuse" : "Building the two backend applications and the UI");
  if (offline) await reusePreparedBackends();
  else await run("sh", [path.join(work, "minikube/docker/build.sh")], "build");
  await run(
    "docker",
    [
      "build",
      "-f",
      path.join(work, "minikube/ui/Dockerfile"),
      "-t",
      "gbx-demo-ui:0.1.0",
      path.join(work, "minikube/ui"),
    ],
    "build",
  );
  const server = cp.spawnSync(
    "docker",
    ["container", "inspect", "--format", "{{.Image}}", "gearbox-demo-postgres"],
    { env: env(), encoding: "utf8", windowsHide: true },
  );
  const serverBase =
    server.status === 0 ? server.stdout.trim() : "postgres:17-bookworm";
  const images = [];
  for (const [name, base] of [
    ["gateway", "gbx-demo-gateway:0.1.0"],
    ["settings", "gbx-demo-settings-worker:0.1.0"],
    ["ui", "gbx-demo-ui:0.1.0"],
    ["echo", "node:24.21.0-alpine"],
    ["database-client", "postgres:17-bookworm"],
    ["postgres-server", serverBase],
  ]) {
    const exists = cp.spawnSync("docker", ["image", "inspect", base], {
      env: env(),
      stdio: "ignore",
      windowsHide: true,
    });
    if (exists.status !== 0) await run("docker", ["pull", base], "pull-image");
    const image = JSON.parse(
      await run("docker", ["image", "inspect", base], "image-metadata", true),
    )[0];
    if (
      !/^sha256:[0-9a-f]{64}$/.test(image.Id) ||
      image.Architecture !== target.architecture
    )
      throw Error("Image architecture does not match minikube: " + base);
    const ref = "gbx-demo-" + name + ":prepared-" + image.Id.slice(7);
    await run("docker", ["tag", base, ref], "pin-image");
    images.push({ name, ref, id: image.Id, architecture: image.Architecture });
  }
  const image = (name) => images.find((i) => i.name === name);
  const values = {
    demoUiImage: image("ui").ref,
    demoEchoImage: image("echo").ref,
  };
  const aggregate = state.digest(
    Buffer.from(images.map((i) => i.id).join("\n")),
  );
  for (const [app, name] of [
    ["demo-gateway", "gateway"],
    ["demo-settings-worker", "settings"],
  ]) {
    const item = image(name),
      colon = item.ref.lastIndexOf(":");
    values[app] = {
      image: {
        repository: item.ref.slice(0, colon),
        tag: item.ref.slice(colon + 1),
        pullPolicy: "Never",
      },
      podAnnotations: {
        "demo.gearbox.dev/image-id": item.id,
        "demo.gearbox.dev/bundle-images": aggregate,
      },
    };
  }
  fs.writeFileSync(
    path.join(work, "images.values.json"),
    JSON.stringify(values, null, 2) + "\n",
  );
  const baseline = fs.readFileSync(
    path.join(__dirname, "../deploy/values.yaml"),
    "utf8",
  );
  if ((baseline.match(/image: postgres:17-bookworm/g) || []).length !== 1)
    throw Error("Unrecognized database-client readiness template");
  fs.writeFileSync(
    path.join(work, "deploy.values.yaml"),
    baseline.replace(
      "image: postgres:17-bookworm",
      "image: " + image("database-client").ref,
    ),
  );
  pinnedPostgres = image("postgres-server").ref;
  stage(
    "infrastructure",
    "Preparing external Postgres and retained cluster storage",
  );
  await sh("provision-postgres.sh", "postgres");
  await sh("provision-cluster-storage.sh", "persistent-storage");
  await sh("verify-chart.sh", "chart-check");
  // Publish only after the source snapshot still matches the one built above.
  state.checkInputs(
    before,
    state.inputs(repo, machine.sourceRoot, generator, work),
  );
  const bundle = {
    version: 1,
    mode: offline ? "static-demo" : "firebase",
    profile,
    namespace,
    preparedAt: new Date().toISOString(),
    dockerId: info.ID,
    versions: {
      node: process.version,
      docker: info.ServerVersion,
      generator: (
        await run(generator, ["--version"], "generator-version", true)
      ).trim(),
      minikube: (
        await run("minikube", ["version", "--short"], "minikube-version", true)
      ).trim(),
    },
    cluster: target,
    images,
    inputs: before,
    artifacts: state.artifacts(path.join(work, "minikube")),
    sidecars: [
      {
        path: "images.values.json",
        sha256: state.fileDigest(path.join(work, "images.values.json")),
      },
      {
        path: "deploy.values.yaml",
        sha256: state.fileDigest(path.join(work, "deploy.values.yaml")),
      },
    ],
  };
  fs.writeFileSync(
    manifestFile + ".tmp",
    JSON.stringify(bundle, null, 2) + "\n",
    { mode: 0o600 },
  );
  fs.renameSync(manifestFile + ".tmp", manifestFile);
  await deploy(true);
  bundle.verified = true;
  bundle.smoke = JSON.parse(
    fs.readFileSync(path.join(work, "last-readiness.json"), "utf8"),
  );
  fs.writeFileSync(
    manifestFile + ".tmp",
    JSON.stringify(bundle, null, 2) + "\n",
    { mode: 0o600 },
  );
  fs.renameSync(manifestFile + ".tmp", manifestFile);
  stage(
    "ready",
    "Prepared bundle, deployment and smoke checks passed",
    "ready",
  );
}
async function validate(allowUnverified = false) {
  if (!fs.existsSync(manifestFile))
    throw Error("No prepared bundle. Run demo.cjs prepare first");
  const bundle = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (!allowUnverified && bundle.verified !== true)
    throw Error("Preparation did not pass its smoke checks; run prepare again");
  if (
    bundle.version !== 1 ||
    bundle.profile !== profile ||
    bundle.namespace !== namespace
  )
    throw Error("Unsupported demo bundle");
  if (bundle.mode !== (offline ? "static-demo" : "firebase")) throw Error("Prepared authentication mode changed; prepare the requested mode again");
  state.checkInputs(
    bundle.inputs,
    state.inputs(repo, machine.sourceRoot, machine.preparedEngine, work),
  );
  state.verifyArtifacts(path.join(work, "minikube"), bundle.artifacts, true);
  state.verifyArtifacts(work, bundle.sidecars);
  const info = await dockerInfo(),
    target = await cluster();
  if (
    info.ID !== bundle.dockerId ||
    target.uid !== bundle.cluster.uid ||
    target.architecture !== bundle.cluster.architecture
  )
    throw Error("Docker daemon or demo cluster changed; prepare again");
  for (const image of bundle.images) {
    const actual = JSON.parse(
      await run("docker", ["image", "inspect", image.ref], "image-check", true),
    )[0];
    if (actual.Id !== image.id || actual.Architecture !== target.architecture)
      throw Error("Prepared image missing or changed: " + image.ref);
  }
  if (!fs.readFileSync(path.join(work, "minikube/ui/package-lock.json")).equals(
    fs.readFileSync(path.join(repo, "products/settings-community-demo/ui-package-lock.json"))))
    throw Error("Generated npm lock bytes changed; prepare again");
  const helm = (await shCapture("ensure-helm.sh", "helm")).trim();
  const rendered = await run(helm, ["template", "settings-community-demo",
    path.join(work, "minikube/helm/settings-community-demo"), "--namespace", namespace,
    "-f", path.join(work, "deploy.values.yaml"), "-f", path.join(work, "private/values.private.json"),
    "-f", path.join(work, "images.values.json")], "verify-image-allowlist", true);
  const references = [...rendered.matchAll(/^\s*image:\s*["']?([^"'\s]+)/gm)].map(match => match[1]);
  if (!references.length || references.some(ref => !bundle.images.some(image => image.ref === ref)))
    throw Error("Rendered workload references an unprepared image; prepare again");
  stage(
    "validate",
    "Prepared source, configuration, artifacts, cluster and images match",
    "ready",
  );
  return bundle;
}
async function deploy(allowUnverified = false) {
  stage("validate", "Validating the prepared bundle");
  const bundle = await validate(allowUnverified);
  const helm = await idleHelm();
  pinnedPostgres = bundle.images.find(
    (image) => image.name === "postgres-server",
  ).ref;
  stage(
    "infrastructure",
    "Checking persistent storage and the external Postgres",
  );
  await sh("provision-postgres.sh", "postgres");
  await sh("provision-cluster-storage.sh", "persistent-storage");
  const available = new Set(
    (
      await run(
        "minikube",
        ["-p", profile, "image", "ls"],
        "cluster-images",
        true,
      )
    )
      .trim()
      .split(/\r?\n/),
  );
  for (const image of bundle.images)
    if (
      !available.has(image.ref) &&
      !available.has("docker.io/library/" + image.ref)
    ) {
      stage(
        "images",
        "Loading prepared " + image.name + " image into minikube",
      );
      await run(
        "minikube",
        ["-p", profile, "image", "load", "--daemon", image.ref],
        "load-image",
      );
    }
  stage(
    "deploy",
    "Applying Helm; startup runs migrations and idempotent bootstrap",
  );
  await run(
    helm,
    [
      "upgrade",
      "--install",
      "settings-community-demo",
      path.join(work, "minikube/helm/settings-community-demo"),
      "--kubeconfig",
      machine.kubeconfig,
      "--kube-context",
      profile,
      "--namespace",
      namespace,
      "-f",
      path.join(work, "deploy.values.yaml"),
      "-f",
      path.join(work, "private/values.private.json"),
      "-f",
      path.join(work, "images.values.json"),
      "--wait",
      "--timeout",
      "10m",
      "--history-max",
      "10",
    ],
    "helm-upgrade",
  );
  stage(
    "readiness",
    offline ? "Checking deployments, storage, remote APIs and offline static identities" : "Checking the running deployments, storage, worker API and Google connectivity",
  );
  await smoke();
  // A long deployment must not certify inputs changed while Helm was waiting.
  state.checkInputs(
    bundle.inputs,
    state.inputs(repo, machine.sourceRoot, machine.preparedEngine, work),
  );
  state.verifyArtifacts(path.join(work, "minikube"), bundle.artifacts, true);
  state.verifyArtifacts(work, bundle.sidecars);
  fs.writeFileSync(
    path.join(work, "last-readiness.json"),
    JSON.stringify({
      passed: true,
      at: new Date().toISOString(),
      images: bundle.images.map((i) => i.id),
    }) + "\n",
  );
  stage("ready", "Family Labs is ready", "ready");
}
const shCapture = (script, label) =>
  run("sh", [path.join(__dirname, script)], label, true);
async function smoke() {
  for (const name of [
    "settings-community-demo-demo-gateway",
    "settings-community-demo-demo-settings-worker",
    "demo-ui",
    "demo-echo",
  ])
    await k(
      ["rollout", "status", "deployment/" + name, "--timeout=120s"],
      "readiness",
    );
  const pvc = JSON.parse(
    await k(
      ["get", "pvc", "gearbox-demo-gateway-data", "-o", "json"],
      "pvc",
      true,
    ),
  );
  if (pvc.status.phase !== "Bound")
    throw Error("Persistent claim is not Bound");
  const pv = JSON.parse(
    await k(["get", "pv", pvc.spec.volumeName, "-o", "json"], "pv", true),
  );
  if (pv.spec.persistentVolumeReclaimPolicy !== "Retain")
    throw Error("Actual PV does not retain data");
  const expectedEcho = JSON.parse(fs.readFileSync(manifestFile, "utf8")).images.find(image => image.name === "echo");
  const echo = JSON.parse(await k(["get", "deployment", "demo-echo", "-o", "json"], "smoke-echo-owner", true));
  if (echo.metadata.annotations?.["meta.helm.sh/release-name"] !== "settings-community-demo" ||
      !echo.spec.template.spec.containers.some(container => container.image === expectedEcho.ref))
    throw Error("Refusing to send smoke credentials to an unowned or changed echo workload");
  const secrets = JSON.parse(
    fs.readFileSync(path.join(work, "private/runtime-secrets.json"), "utf8"),
  );
  const probe = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{try{const {token,offline,offlineUsers}=JSON.parse(input);const base='http://demo-gateway.gearbox-demo.svc.cluster.local:8087';const get=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('API readiness failed: '+r.status);return r.json()};let registered=false;for(let attempt=0;attempt<65;attempt++){const directory=await get('/service-discovery/v1/gears');if(directory.some(g=>g.name==='settings-service'&&g.instances.some(i=>['ready','healthy'].includes(i.state)))){registered=true;break;}await new Promise(resolve=>setTimeout(resolve,1000));}if(!registered)throw Error('Worker did not re-register with Directory within 65 seconds');const value=await get('/family-labs/v1/effective:read',{key:'gts.cf.core.settings.setting_type.v1~cf.family_labs.lab.ice_cream_approved.v1~',scope:'/tenants/d0000000-0000-4000-8000-000000000002'});if(typeof value.value!=='boolean')throw Error('Effective setting unavailable');const types=await get('/family-labs/v1/registry/settings');if(types.entities.filter(e=>e.gts_id.includes('cf.family_labs.')).length!==3)throw Error('Settings registrations missing');if(!offline){const keys=await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',{signal:AbortSignal.timeout(15000)});if(!keys.ok||!Object.keys(await keys.json()).length)throw Error('Google verifier keys unreachable');}else{for(const user of offlineUsers){const r=await fetch(base+'/family-labs/v1/me',{headers:{Authorization:'Bearer '+user.token},signal:AbortSignal.timeout(15000)});if(!r.ok||(await r.json()).tenant_id!==user.tenant)throw Error('Offline identity mapping failed');const other=user.tenant===offlineUsers[0].tenant?offlineUsers[1].tenant:offlineUsers[0].tenant;const denied=await fetch(base+'/settings-service/v1/settings/'+encodeURIComponent('gts.cf.core.settings.setting_type.v1~cf.family_labs.lab.ice_cream_approved.v1~')+'?tenant='+other,{headers:{Authorization:'Bearer '+user.token},signal:AbortSignal.timeout(15000)});if(denied.status!==403)throw Error('Offline sibling isolation failed');}}console.log(offline?'Remote APIs and both restricted offline identities passed.':'Remote Settings, Directory, V1 registrations and Google connectivity passed.');}catch(e){console.error(e.message);process.exitCode=1}});`;
  await run(
    "kubectl",
    [
      "--context",
      profile,
      "--namespace",
      namespace,
      "exec",
      "-i",
      "deployment/demo-echo",
      "--",
      "node",
      "-e",
      probe,
    ],
    "api-smoke",
    true,
    JSON.stringify({ token: secrets.DEMO_BOOTSTRAP_TOKEN, offline,
      offlineUsers: offline ? [
        {token: secrets.DEMO_OFFLINE_DASHA_TOKEN, tenant: "d0000000-0000-4000-8000-000000000002"},
        {token: secrets.DEMO_OFFLINE_ILYA_TOKEN, tenant: "a0000000-0000-4000-8000-000000000003"},
      ] : [] }),
  );
}
async function forward() {
  const target = await cluster();
  if (
    fs.existsSync(manifestFile) &&
    JSON.parse(fs.readFileSync(manifestFile, "utf8")).cluster.uid !== target.uid
  )
    throw Error("The prepared cluster changed; run prepare");
  const service = JSON.parse(
    await k(["get", "service", "demo-ui", "-o", "json"], "ui-service", true),
  );
  if (
    service.metadata.annotations?.["meta.helm.sh/release-name"] !==
    "settings-community-demo"
  )
    throw Error("Refusing an unowned UI service");
  stage("open-ui", "Connecting localhost:8080 to the prepared UI");
  await new Promise((resolve, reject) => {
    const child = cp.spawn(
      "kubectl",
      [
        "--context",
        profile,
        "--namespace",
        namespace,
        "port-forward",
        "--address",
        "127.0.0.1",
        "svc/demo-ui",
        "8080:8080",
      ],
      { env: env(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let ready = false;
    const stop = () => child.kill("SIGTERM");
    process.stdin.resume();
    process.stdin.once("end", stop);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    child.stdout.on("data", (bytes) => {
      if (
        !ready &&
        bytes.toString().includes("Forwarding from 127.0.0.1:8080")
      ) {
        ready = true;
        stage("open-ui", "UI connection is ready", "ready", {
          url: "http://localhost:8080/#settings",
        });
      }
    });
    child.stderr.on("data", () => {});
    child.once("error", () =>
      reject(Error("Cannot start the UI port-forward")),
    );
    child.once("close", (code) => {
      process.stdin.removeListener("end", stop);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      process.stdin.pause();
      ready && code === 0
        ? resolve()
        : reject(Error("UI connection lost; use Reconnect UI"));
    });
  });
}
async function main() {
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  machine = loadMachine();
  const args = process.argv.slice(2),
    commandName = args.shift() || "status",
    command = commandName.replace(/-offline$/, "");
  for (let i = 0; i < args.length; i += 2) {
    const names = {
      "--source-root": "sourceRoot",
      "--engine": "engine",
      "--kubeconfig": "kubeconfig",
      "--docker-host": "dockerHost",
    };
    if (names[args[i]]) machine[names[args[i]]] = args[i + 1];
    else if (!["--operation", "--backup"].includes(args[i]))
      throw Error("Unknown demo option: " + args[i]);
  }
  machine.kubeconfig ??= path.join(
    os.homedir(),
    ".config/gearbox-demo/kubeconfig",
  );
  const operationIndex = args.indexOf("--operation");
  if (operationIndex >= 0) {
    operationId = args[operationIndex + 1];
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(operationId || ""))
      throw Error("Invalid operation identifier");
  }

  require("./wsl-host.cjs").checkWslHost(machine, command);
  if (process.platform === "win32" && machine.host === "wsl") {
    const translate = (file) =>
      file
        .replace(
          /^([a-zA-Z]):[\\/]/,
          (_, drive) => "/mnt/" + drive.toLowerCase() + "/",
        )
        .replaceAll("\\", "/");
    const node = machine.node || "/usr/bin/node",
      child = cp.spawn(
        "wsl.exe",
        [
          "-d",
          machine.distribution || "Ubuntu",
          "--exec",
          "env",
          "PATH=" +
            path.posix.dirname(node) +
            ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          node,
          translate(__filename),
          commandName,
          ...args,
        ],
        { stdio: ["pipe", "inherit", "inherit"], windowsHide: true },
      );
    process.stdin.pipe(child.stdin);
    child.once("close", (code) => (process.exitCode = code ?? 1));
    return;
  }
  if (machine.nativeWindowsGit)
    process.env.DEMO_NATIVE_WINDOWS_GIT = machine.nativeWindowsGit;
  const locked = ["prepare", "deploy", "reset", "backup", "restore", "cleanup"].includes(command);
  // The OS releases this loopback mutex on exit/reboot. A leftover receipt file
  // or a reused PID can never prevent recovery or steal another active lock.
  const lock = locked ? await require("./operation-lock.cjs").acquire() : undefined;
  try {
    if (command === "prepare") {
      fs.writeFileSync(machineFile, JSON.stringify(machine, null, 2) + "\n", {
        mode: 0o600,
      });
      await prepare();
    } else if (command === "validate") await validate();
    else if (command === "deploy") await deploy();
    else if (command === "forward") await forward();
    else if (command === "smoke") await smoke();
    else if (["reset", "backup", "restore", "cleanup"].includes(command)) {
      const backupIndex = args.indexOf("--backup");
      await require("./maintenance.cjs").maintenance(command,
        {repo, work, env, run, k, stage, validate, smoke},
        backupIndex < 0 ? undefined : args[backupIndex + 1]);
    }
    else throw Error("Use prepare, validate, deploy, forward, smoke, reset, backup, restore or cleanup (append -offline for the explicit static profile)");
  } finally {
    if (lock) await lock.close();
  }
}
if (require.main === module)
  main().catch((error) => {
    stage("error", error.message, "error");
    process.exitCode = 1;
  });
module.exports = { prepare, validate, deploy, smoke };
