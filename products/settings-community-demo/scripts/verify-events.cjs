#!/usr/bin/env node
'use strict';
// Real integration check. The write URL may target the worker while Gateway/EB
// is deliberately stopped. Credentials stay in memory; receipts contain no token.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const privateDir = path.resolve(__dirname, '../../../.gearbox/settings-community-demo/private');
const secrets = JSON.parse(fs.readFileSync(path.join(privateDir, 'runtime-secrets.json'), 'utf8'));
const gateway = process.env.DEMO_API_URL || 'http://127.0.0.1:18087';
const worker = process.env.DEMO_WRITE_URL || gateway;
for (const base of [gateway, worker]) {
  const url = new URL(base);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Verification URLs must use loopback.');
}
const token = secrets.DEMO_BOOTSTRAP_TOKEN;
const tenant = 'd0000000-0000-4000-8000-000000000002';
const sibling = 'a0000000-0000-4000-8000-000000000003';
const key = 'gts.cf.core.settings.setting_type.v1~cf.family_labs.lab.lab_message.v1~';
const setting = '/settings-service/v1/settings/' + encodeURIComponent(key);
const topic = 'gts.cf.core.events.topic.v1~cf.demo.settings.changed.v1';
const eventType = 'gts.cf.core.events.event.v1~cf.demo.settings.changed.v1~';
const receiptPath = path.join(privateDir, 'event-check.json');
async function api(base, route, method = 'GET', body, headers = {}, statuses = [200]) {
  const response = await fetch(base + route, {
    method, signal: AbortSignal.timeout(30000),
    headers: {Authorization: `Bearer ${token}`, ...headers, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert(statuses.includes(response.status), `${method} ${route}: ${response.status} ${text.slice(0, 1000)}`);
  return {headers: response.headers, body: text ? JSON.parse(text) : undefined};
}
async function write() {
  const previous = await api(worker, setting + '?tenant=' + tenant);
  const other = await api(worker, setting + '?tenant=' + sibling);
  const receipt = {requestId: randomUUID(), value: 'Event delivery check ' + randomUUID(), previous: previous.body, sibling: other.body.value};
  // Save restoration coordinates before mutating, even if the request times out.
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  await api(worker, setting + '/value?tenant=' + tenant, 'PUT', {value: receipt.value},
    {'If-Match': previous.headers.get('etag'), 'X-Request-Id': receipt.requestId});
  console.log('Committed Settings change:', receipt.requestId);
}
async function replay() {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const group = (await api(gateway, '/event-broker/v1/consumer-groups', 'POST', {client_agent: 'settings-outbox-check', description: 'Disposable transactional delivery check'}, {}, [201])).body;
  let subscription;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    subscription = (await api(gateway, '/event-broker/v1/subscriptions', 'POST', {
      consumer_group: group.id, client_agent: 'settings-outbox-check',
      interests: [{topic, tenant_id: tenant, max_depth: 0, types: [eventType]}],
    }, {}, [201])).body;
    await api(gateway, `/event-broker/v1/subscriptions/${subscription.id}:seek`, 'POST', {
      topology_version: 1, positions: {[topic]: [{partition: 0, value: 'earliest'}]},
    });
    const response = await fetch(gateway + '/event-broker/v1/events:sse?subscription_id=' + encodeURIComponent(subscription.id), {
      headers: {Authorization: `Bearer ${token}`}, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, {stream: true});
      assert(buffer.length < 1024 * 1024, 'Stream exceeds frame bound');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const message = JSON.parse(data);
        const event = message.payload;
        if (message.kind !== 'event' || event?.data?.request_id !== receipt.requestId) continue;
        assert.equal(event.source, 'settings-service');
        assert.equal(event.tenant_id, tenant);
        assert.equal(event.data.key, key);
        assert(event.data.change_set_id && event.id && event.sequence > 0);
        assert.equal(event.data.value, undefined, 'Invalidation events must not contain setting values');
        if (receipt.eventId) assert.equal(event.id, receipt.eventId, 'Restart replay must preserve event identity');
        receipt.eventId = event.id;
        receipt.sequence = event.sequence;
        receipt.replayedAt = new Date().toISOString();
        const effective = (await api(gateway, '/family-labs/v1/effective:read', 'POST', {key, scope: '/tenants/' + tenant})).body;
        assert.equal(effective.value, receipt.value, 'Generated remote contract must read the committed value');
        const other = (await api(gateway, '/family-labs/v1/effective:read', 'POST', {key, scope: '/tenants/' + sibling})).body;
        assert.deepEqual(other.value, receipt.sibling, 'Sibling data must stay unchanged');
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
        console.log('Real remote outbox delivery, replay identity and remote Settings reread passed:', event.id);
        return;
      }
    }
    throw Error('Stream ended before the committed Settings event arrived');
  } finally {
    clearTimeout(timer); controller.abort();
    if (subscription) await api(gateway, '/event-broker/v1/subscriptions/' + subscription.id, 'DELETE', undefined, {}, [200, 204, 404]);
    await api(gateway, '/event-broker/v1/consumer-groups/' + encodeURIComponent(group.id), 'DELETE', undefined, {}, [200, 204, 404]);
  }
}
async function restore() {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const current = await api(worker, setting + '?tenant=' + tenant);
  assert.deepEqual(current.body.value, receipt.value, 'Another writer changed this value; leave it intact instead of restoring the QA snapshot');
  if (receipt.previous.source === 'schema_default' || receipt.previous.source === 'inherited') {
    await api(worker, setting + '/value/revert?tenant=' + tenant, 'POST', {}, {'If-Match': current.headers.get('etag')});
  } else {
    await api(worker, setting + '/value?tenant=' + tenant, 'PUT', {value: receipt.previous.value}, {'If-Match': current.headers.get('etag')});
  }
  console.log('Previous laboratory value restored through the API.');
}
const mode = process.argv[2] || 'roundtrip';
(async () => {
  if (mode === 'roundtrip') {await write(); try {await replay();} finally {await restore();}}
  else if (mode === 'write') await write();
  else if (mode === 'replay') await replay();
  else if (mode === 'restore') await restore();
  else throw Error('Expected roundtrip, write, replay or restore');
})().catch(error => {console.error(error.message); process.exitCode = 1;});
