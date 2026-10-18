"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { checkVolume, readOnlyRoot } = require("./wsl-host.cjs");
test("host exhaustion is rejected independently of space advertised by the VHD", () => {
  assert.throws(
    () => checkVolume({ drive: "D", free: 15 * 1024 ** 2 }, "prepare"),
    /host volume D/,
  );
  assert.throws(
    () => checkVolume({ drive: "D", free: 10 * 1024 ** 3 }, "prepare"),
    /20 GiB/,
  );
  checkVolume({ drive: "D", free: 30 * 1024 ** 3 }, "prepare");
  checkVolume({ drive: "D", free: 10 * 1024 ** 3 }, "deploy");
  assert.throws(
    () => checkVolume({ drive: "D", free: null }, "prepare"),
    /Cannot determine/,
  );
});
test("read-only WSL root is detected without confusing ordinary read-only mounts", () => {
  assert.equal(readOnlyRoot("/dev/sdc / ext4 ro,relatime 0 0\n"), true);
  assert.equal(
    readOnlyRoot(
      "/dev/sdc / ext4 rw,relatime 0 0\nrootfs /init rootfs ro 0 0\n",
    ),
    false,
  );
});
