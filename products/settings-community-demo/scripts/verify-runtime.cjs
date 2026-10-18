#!/usr/bin/env node
'use strict';
// Real authenticated HTTP smoke test. Run through a loopback-only port-forward.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const repo = path.resolve(__dirname, '../../..');
const work = path.resolve(process.env.DEMO_WORK_DIR || path.join(repo, '.gearbox/settings-community-demo'));
const privateDir = path.join(work, 'private');
const secrets = JSON.parse(fs.readFileSync(path.join(privateDir, 'runtime-secrets.json'), 'utf8'));
const base = process.env.DEMO_API_URL || 'http://127.0.0.1:18087';
const topic = 'gts.cf.core.events.topic.v1~cf.demo.settings.changed.v1';
const eventType = 'gts.cf.core.events.event.v1~cf.demo.settings.changed.v1~';
const subjectType = 'gts.cf.demo.settings.setting.v1~';
const tenant = 'f0000000-0000-4000-8000-000000000001';
const statePath = path.join(privateDir, 'runtime-smoke.json');
const mode = process.argv[2] || 'seed';
async function api(route, method = 'GET', body, expected = [200], authorized = true) {
  const response = await fetch(base + route, {
    method, signal: AbortSignal.timeout(30000),
    headers: {...(authorized ? {Authorization: `Bearer ${secrets.DEMO_BOOTSTRAP_TOKEN}`} : {}),
      ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert(expected.includes(response.status), `${method} ${route}: ${response.status} ${text.slice(0, 1500)}`);
  return text ? JSON.parse(text) : undefined;
}
async function registerDeclarations() {
  const registered = await api('/types-registry/v1/entities', 'POST', {entities: [
    {id: topic, description: 'Settings changes in Family Labs'},
    {$id: `gts://${eventType}`, $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
      'x-gts-traits': {topic, allowed_subject_types: [subjectType], partition_key: '/tenant_id'},
      allOf: [{$ref: 'gts://gts.cf.core.events.event.v1~'},
        {type: 'object', properties: {data: {type: ['object', 'null']}}}]},
  ]});
  assert.equal(registered.summary.failed, 0, JSON.stringify(registered));
  // The production specification refresh interval is 60 seconds by default.
  for (let attempt = 0; attempt < 90; attempt++) {
    const topics = await api('/event-broker/v1/topics');
    if (JSON.stringify(topics).includes(topic)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Registered topic was not loaded by the real broker');
}
async function main() {
  await api('/event-broker/v1/topics', 'GET', undefined, [401], false);
  // Directory is process-local; after a Gateway restart the worker re-registers
  // on its next heartbeat. Pod readiness alone does not prove that happened.
  let worker;
  for (let attempt = 0; attempt < 60; attempt++) {
    const gears = await api('/service-discovery/v1/gears');
    worker = gears.find(gear => gear.name === 'settings-service');
    if (worker?.instances.some(instance => ['ready', 'healthy'].includes(instance.state))) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(worker, 'Settings worker missing from Directory');
  assert.equal(worker.deployment_mode, 'out_of_process');
  assert(worker.instances.some(instance => ['ready', 'healthy'].includes(instance.state)), JSON.stringify(worker));
  console.log('Authenticated Directory sees a live out-of-process Settings worker.');
  await api('/settings-service/v1/declarations', 'GET', undefined, [401], false);
  await api('/settings-service/v1/declarations');
  console.log('Authorized Gateway-to-worker proxy call succeeds; anonymous call is rejected.');
  // Replay must prove startup registrations; it must never repair them.
  if (mode === 'seed') await registerDeclarations();
  else assert(JSON.stringify(await api('/event-broker/v1/topics')).includes(topic), 'Startup topic registration missing');
  if (mode === 'seed') {
    const producer = await api('/event-broker/v1/producers', 'POST', {mode: 'monotonic', client_agent: 'gearbox-runtime-smoke'}, [201]);
    const group = await api('/event-broker/v1/consumer-groups', 'POST', {client_agent: 'gearbox-runtime-smoke', description: 'Persistence verification'}, [201]);
    const eventId = randomUUID();
    // The current REST implementation acknowledges its durable ingest outbox
    // with 202. Backend persistence is verified by reading the original event.
    await api('/event-broker/v1/events', 'POST', {
      id: eventId, type: eventType, tenant_id: tenant, source: 'gearbox-runtime-smoke',
      subject: 'phase1-persistence', subject_type: subjectType, occurred_at: new Date().toISOString(),
      data: {check: 'retained-volume'}, meta: {version: 1, producer_id: producer.producer_id || producer.id, sequence: 1},
    }, [202]);
    fs.writeFileSync(statePath, JSON.stringify({eventId, groupId: group.id, producerId: producer.producer_id || producer.id}, null, 2) + '\n');
    console.log('Event durably enqueued; producer and consumer group created.');
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const group = await api(`/event-broker/v1/consumer-groups/${encodeURIComponent(state.groupId)}`);
  assert.equal(group.id, state.groupId);
  const cursors = await api(`/event-broker/v1/producers/${state.producerId}/cursors`);
  assert(JSON.stringify(cursors).includes(topic), JSON.stringify(cursors));
  const subscription = await api('/event-broker/v1/subscriptions', 'POST', {
    consumer_group: state.groupId, client_agent: 'gearbox-runtime-smoke', interests: [{topic, tenant_id: tenant, max_depth: 0, types: [eventType]}],
  }, [201]);
  await api(`/event-broker/v1/subscriptions/${subscription.id}:seek`, 'POST', {
    topology_version: subscription.topology_version, positions: {[topic]: [{partition: 0, value: 'earliest'}]},
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(base + '/event-broker/v1/events:sse?subscription_id=' + subscription.id, {
      headers: {Authorization: `Bearer ${secrets.DEMO_BOOTSTRAP_TOKEN}`}, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, {stream: true});
      assert(text.length < 1024 * 1024, 'SSE frame exceeds verification bound');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(text))) {
        const frame = text.slice(0, boundary.index);
        text = text.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const message = JSON.parse(data);
        if (process.env.DEMO_TRACE_STREAM === '1') console.log('SSE frame:', JSON.stringify(message));
        if (message.kind === 'event' && message.payload?.id === state.eventId) {
          assert.equal(message.payload.topic, topic);
          assert.equal(message.payload.tenant_id, tenant);
          assert.equal(message.payload.data.check, 'retained-volume');
          assert(message.payload.sequence > 0);
          console.log('Durable metadata/cursors and the original event verified through real SSE.');
          return;
        }
      }
    }
    throw new Error('SSE ended before the persisted event arrived');
  } finally {
    clearTimeout(timer); controller.abort();
    await api(`/event-broker/v1/subscriptions/${subscription.id}`, 'DELETE', undefined, [200, 204, 404]);
  }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
