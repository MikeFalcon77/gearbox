#!/usr/bin/env node
'use strict';
// Loopback-only integration harness. Tokens live only for one request and are
// never written to files or returned in diagnostics. Cloud setup is unchanged.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {randomBytes, randomUUID} = require('node:crypto');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../../..');
const privateDir = path.join(repo, '.gearbox/settings-community-demo/private');
const handoffDir = path.join(repo, '.gearbox/firebase-preflight');
const secrets = JSON.parse(fs.readFileSync(path.join(privateDir, 'runtime-secrets.json'), 'utf8'));
const inputs = JSON.parse(fs.readFileSync(path.join(handoffDir, 'authn-demo-inputs.json'), 'utf8'));
const webConfig = JSON.parse(fs.readFileSync(path.join(handoffDir, 'firebase-web-config.json'), 'utf8'));
const apiBase = process.env.DEMO_API_URL || 'http://127.0.0.1:18087';
const apiUrl = new URL(apiBase);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname)
  && ['http:', 'https:'].includes(apiUrl.protocol) && !apiUrl.username && !apiUrl.password,
  'The identity harness requires a loopback Gateway URL.');
const origin = 'http://localhost:4174';
const nonce = randomBytes(32).toString('hex');
const tenants = {dasha: 'd0000000-0000-4000-8000-000000000002', ilya: 'a0000000-0000-4000-8000-000000000003'};
const topic = 'gts.cf.core.events.topic.v1~cf.demo.settings.changed.v1';
const eventType = 'gts.cf.core.events.event.v1~cf.demo.settings.changed.v1~';
const subjectType = 'gts.cf.demo.settings.setting.v1~';
const key = 'gts.cf.core.settings.setting_type.v1~cf.family_labs.lab.lab_message.v1~';
const setting = '/settings-service/v1/settings/' + encodeURIComponent(key);

async function api(token, route, {method = 'GET', body, headers = {}, statuses = [200]} = {}) {
  const response = await fetch(apiBase + route, {
    method, signal: AbortSignal.timeout(30000),
    headers: {Authorization: `Bearer ${token}`, ...headers, ...(body ? {'Content-Type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  // Never echo token-bearing request headers or entire authentication errors.
  assert(statuses.includes(response.status), `${method} ${route}: expected ${statuses.join('/')}, received ${response.status}; ${text.slice(0, 1000)}`);
  return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined};
}

async function verifyUser(lab, token) {
  assert(Object.hasOwn(tenants, lab));
  assert.equal(typeof token, 'string');
  assert(token.length <= 8192);
  const own = tenants[lab], other = tenants[lab === 'dasha' ? 'ilya' : 'dasha'];
  const checks = [];
  const read = await api(token, setting);
  assert.equal(read.body.tenant_id, own, 'Server mapped the Firebase UID to the wrong tenant');
  checks.push('Real Firebase signature accepted; backend assigned the expected tenant.');
  await api(token, setting + '?tenant=' + other, {statuses: [403]});
  await api(token, setting + '/value?tenant=' + other, {
    method: 'PUT', body: {value: 'Cross-tenant write must be rejected.'},
    headers: {'If-Match': 'absent'}, statuses: [403],
  });
  checks.push('Cross-tenant Settings read and write rejected.');
  await api(token, setting + '/value', {method: 'PUT', body: {value: read.body.value}, headers: {'If-Match': read.headers.get('etag')}});
  checks.push('Own-tenant Settings write accepted without changing the value.');
  await api(token, '/service-discovery/v1/gears');
  await api(token, '/types-registry/v1/entities', {statuses: [403]});
  await api(token, '/family-labs/v1/registry/gateway');
  await api(token, '/family-labs/v1/registry/settings');
  await api(token, '/types-registry/v1/entities', {method: 'POST', body: {entities: []}, statuses: [403]});
  await api(token, '/event-broker/v1/producers', {method: 'POST', body: {mode: 'monotonic'}, statuses: [403]});
  checks.push('Filtered read-only registry diagnostics accepted; raw registry, schema writes and producer management rejected.');
  const group = (await api(token, '/event-broker/v1/consumer-groups', {
    method: 'POST', body: {client_agent: 'gearbox-identity-check', description: 'Disposable identity check'}, statuses: [201],
  })).body;
  let subscription;
  try {
    subscription = (await api(token, '/event-broker/v1/subscriptions', {
      method: 'POST', body: {consumer_group: group.id, client_agent: 'gearbox-identity-check', interests: [{topic, tenant_id: own, max_depth: 0, types: [eventType]}]}, statuses: [201],
    })).body;
    await api(token, '/event-broker/v1/subscriptions', {
      method: 'POST', body: {consumer_group: group.id, client_agent: 'gearbox-identity-check', interests: [{topic, tenant_id: other, max_depth: 0, types: [eventType]}]}, statuses: [403],
    });
    checks.push('Own-tenant subscription accepted; sibling-tenant subscription rejected.');
  } finally {
    if (subscription) await api(token, '/event-broker/v1/subscriptions/' + subscription.id, {method: 'DELETE', statuses: [200, 204, 404]});
    await api(token, '/event-broker/v1/consumer-groups/' + group.id, {method: 'DELETE', statuses: [200, 204, 404]});
  }
  const result = {lab, tenant: own, passed: true, checks, verifiedAt: new Date().toISOString()};
  fs.writeFileSync(path.join(privateDir, `identity-check-${lab}.json`), JSON.stringify(result, null, 2) + '\n');
  return result;
}

async function verifyTechnical() {
  const worker = secrets.DEMO_WORKER_TOKEN;
  await api('unknown-technical-token', '/event-broker/v1/topics', {statuses: [401]});
  await api('invalid.jwt.credential', '/event-broker/v1/topics', {statuses: [401]});
  await api(worker, '/settings-service/v1/declarations', {statuses: [403]});
  for (const route of ['/service-discovery/v1/gears', '/types-registry/v1/entities', '/family-labs/v1/registry/gateway', '/family-labs/v1/registry/settings']) await api(worker, route, {statuses: [403]});
  await api(worker, '/types-registry/v1/entities', {method: 'POST', body: {entities: []}, statuses: [403]});
  const producer = (await api(worker, '/event-broker/v1/producers', {method: 'POST', body: {mode: 'monotonic', client_agent: 'gearbox-worker-check'}, statuses: [201]})).body;
  const event = tenant => ({id: randomUUID(), type: eventType, tenant_id: tenant, source: 'gearbox-worker-check', subject: 'credential-check', subject_type: subjectType,
    occurred_at: new Date().toISOString(), data: {kind: 'auth-check'}, meta: {version: 1, producer_id: producer.producer_id || producer.id, sequence: 1}});
  await api(worker, '/event-broker/v1/events', {method: 'POST', body: event('f0000000-0000-4000-8000-000000000001'), statuses: [403]});
  await api(worker, '/event-broker/v1/events', {method: 'POST', body: event('b0000000-0000-4000-8000-000000000004'), statuses: [403]});
  const otherType = 'gts.cf.core.events.event.v1~cf.demo.settings.denied.v1~';
  await api(secrets.DEMO_BOOTSTRAP_TOKEN, '/types-registry/v1/entities', {method: 'POST', body: {entities: [
    {$id: 'gts://' + otherType, $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
      'x-gts-traits': {topic, allowed_subject_types: [subjectType], partition_key: '/tenant_id'},
      allOf: [{$ref: 'gts://gts.cf.core.events.event.v1~'}]},
  ]}});
  // Specification refresh can be delayed. Authorization must reject a declared
  // foreign type; retry only the specific not-yet-loaded 404, never a denial.
  for (let attempt = 0; attempt < 90; attempt++) {
    const denied = {...event(tenants.dasha), type: otherType};
    const response = await api(worker, '/event-broker/v1/events', {method: 'POST', body: denied, statuses: [403, 404]});
    if (response.status === 403) break;
    assert(attempt < 89, 'Foreign event type never appeared in the specification cache');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await api(worker, '/event-broker/v1/events', {method: 'POST', body: event(tenants.dasha), statuses: [202]});
  const ilyaEvent = event(tenants.ilya); ilyaEvent.meta.sequence = 2;
  await api(worker, '/event-broker/v1/events', {method: 'POST', body: ilyaEvent, statuses: [202]});
  const result = {passed: true, checks: ['Unknown opaque and malformed JWT credentials rejected.', 'Worker cannot access Settings or mutate schemas.', 'Worker cannot publish for root, unknown tenant or foreign event type.', 'Worker can publish the demo event for both permitted tenants.'], verifiedAt: new Date().toISOString()};
  fs.writeFileSync(path.join(privateDir, 'identity-check-technical.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[2] === 'technical') {
  verifyTechnical().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {console.error(error.message); process.exitCode = 1;});
} else {
  http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, body) => {res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body));};
    try {
      if (req.headers.host !== 'localhost:4174') return send(403, {error: 'Use ' + origin});
      if (req.method === 'GET' && req.url === '/') {res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); return res.end(fs.readFileSync(path.join(__dirname, 'verify-identities.html')));}
      if (req.method === 'GET' && req.url === '/setup') return send(200, {nonce, webConfig, expected: Object.fromEntries(Object.entries(inputs.tenantIdentityMappings).map(([lab, mapping]) => [lab, mapping.email]))});
      if (req.method !== 'POST' || req.url !== '/verify') return send(404, {error: 'Not found'});
      if (req.headers.origin !== origin || req.headers['x-demo-nonce'] !== nonce) return send(403, {error: 'Origin rejected'});
      let text = '';
      for await (const chunk of req) {text += chunk; if (text.length > 10000) throw Error('Request too large');}
      const {lab, token} = JSON.parse(text);
      return send(200, await verifyUser(lab, token));
    } catch (error) {return send(400, {error: error.message});}
  }).listen(4174, '127.0.0.1', () => console.log('Identity integration check: ' + origin));
}
