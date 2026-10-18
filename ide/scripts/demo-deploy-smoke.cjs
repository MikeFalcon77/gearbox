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
  service.launch = () => {
    starts++;
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
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
