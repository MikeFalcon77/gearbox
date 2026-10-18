"use strict";
require("reflect-metadata");
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { EventEmitter } = require("node:events"),
  { PassThrough } = require("node:stream");
const {
  DemoDeployServiceImpl,
} = require("../gearbox-studio/lib/node/demo-deploy-service");
const product = path.resolve(
  __dirname,
  "../../products/settings-community-demo/product.gdl",
);
function fake(service) {
  let starts = 0,
    child;
  service.launch = (_args, progress) => {
    starts++;
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.progress = progress;
    return child;
  };
  return {
    get starts() {
      return starts;
    },
    get child() {
      return child;
    },
  };
}
test("a lost start acknowledgement and a repeated operation ID do not create a second deployment", async () => {
  const service = new DemoDeployServiceImpl(),
    process = fake(service),
    id = crypto.randomUUID();
  const remove = service.addClient({ onChanged() {} });
  await service.start(product, "minikube", id);
  remove();
  assert.equal((await service.getState(id)).status, "running");
  await service.start(product, "minikube", id);
  assert.equal(process.starts, 1);
  assert.equal((await service.getState(id)).operationId, id);
  process.child.emit("close", 1);
});
test("other products/profiles cannot reach the runner", async () => {
  const service = new DemoDeployServiceImpl(),
    process = fake(service);
  await assert.rejects(
    () => service.start(product, "production", crypto.randomUUID()),
    /limited/,
  );
  await assert.rejects(
    () =>
      service.start(
        path.resolve(__dirname, "../../Cargo.toml"),
        "minikube",
        crypto.randomUUID(),
      ),
    /limited/,
  );
  assert.equal(process.starts, 0);
});
test("successful process exit alone is not a readiness receipt", async () => {
  const service = new DemoDeployServiceImpl(),
    process = fake(service);
  await service.start(product, "minikube", crypto.randomUUID());
  process.child.emit("close", 0);
  assert.equal((await service.getState()).status, "error");
  assert.equal(process.starts, 1);
});

test("looking up a historical receipt cannot replace the active operation", async () => {
  const fs = require("node:fs");
  const service = new DemoDeployServiceImpl(),
    process = fake(service);
  const active = crypto.randomUUID(),
    historical = crypto.randomUUID();
  const receipts = path.resolve(
    __dirname,
    "../../.gearbox/settings-community-demo/operations",
  );
  fs.mkdirSync(receipts, { recursive: true });
  const file = path.join(receipts, historical + ".json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      stage: "ready",
      status: "ready",
      message: "Earlier deployment",
    }),
    { flag: "wx" },
  );
  try {
    await service.start(product, "minikube", active);
    assert.equal((await service.getState(historical)).operationId, historical);
    assert.equal((await service.getState()).operationId, active);
    assert.equal((await service.getState()).status, "running");
    process.child.emit("close", 1);
    assert.equal((await service.getState()).operationId, active);
  } finally {
    fs.unlinkSync(file);
  }
});

test("a restored UI forward clears its lost message while retaining deployment readiness", async () => {
  const service = new DemoDeployServiceImpl(),
    process = fake(service),
    id = crypto.randomUUID();
  await service.start(product, "minikube", id);
  process.child.progress({
    stage: "ready",
    status: "ready",
    message: "Family Labs is ready",
  });
  process.child.emit("close", 0);
  process.child.progress({
    stage: "open-ui",
    status: "ready",
    message: "UI ready",
  });
  process.child.emit("close", 1);
  assert.equal((await service.getState()).ui.status, "lost");
  assert.match((await service.getState()).message, /connection lost/);
  await service.connectUi();
  assert.equal((await service.getState()).message, "Connecting UI…");
  process.child.progress({
    stage: "open-ui",
    status: "ready",
    message: "UI ready",
  });
  const state = await service.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.operationId, id);
  assert.equal(state.ui.status, "ready");
  assert.equal(state.message, "Deployment is ready.");
});
