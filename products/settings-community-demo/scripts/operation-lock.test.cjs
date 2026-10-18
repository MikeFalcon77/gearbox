'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {acquire} = require('./operation-lock.cjs');
test('only one operation holds a host mutex, and exit/release permits recovery', async () => {
  const first = await acquire(0), port = first.port;
  try {await assert.rejects(() => acquire(port), /already running/);}
  finally {await first.close();}
  const next = await acquire(port);
  await next.close();
});
