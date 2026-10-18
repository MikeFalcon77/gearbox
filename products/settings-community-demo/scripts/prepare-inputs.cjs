#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '../../..');
const work = path.resolve(process.env.DEMO_WORK_DIR || path.join(repo, '.gearbox/settings-community-demo'));
const privateDir = path.join(work, 'private');
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const credentialsFile = path.join(privateDir, 'runtime-secrets.json');
const existing = fs.existsSync(credentialsFile);
const credentials = existing
  ? JSON.parse(fs.readFileSync(credentialsFile, 'utf8'))
  : { schemaVersion: 1 };
if (credentials.schemaVersion !== 1) throw new Error('Unsupported private runtime credentials schema.');
const names = ['GEARS_PG_PASSWORD', 'DEMO_INTERNAL_TOKEN', 'DEMO_BOOTSTRAP_TOKEN'];
for (const name of names) {
  if (credentials[name] === undefined && !existing) credentials[name] = crypto.randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(credentials[name])) {
    throw new Error(`Invalid ${name} in the private handoff; refusing to rotate existing credentials.`);
  }
}
function writePrivate(name, value) {
  const destination = path.join(privateDir, name);
  fs.writeFileSync(destination, value, { mode: 0o600 });
  return destination;
}
const serialized = JSON.stringify(credentials, null, 2) + '\n';
writePrivate('runtime-secrets.json', serialized);
const postgresEnvFile = writePrivate('postgres.env', [
  'POSTGRES_USER=gearbox_demo', 'POSTGRES_DB=postgres',
  `POSTGRES_PASSWORD=${credentials.GEARS_PG_PASSWORD}`, '',
].join('\n'));
const secretFile = writePrivate('kubernetes-secret.json', JSON.stringify({
  apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
  metadata: { name: 'gearbox-demo-runtime', namespace: 'gearbox-demo', labels: { 'app.kubernetes.io/part-of': 'settings-community-demo' } },
  data: Object.fromEntries(names.map(name => [name, Buffer.from(credentials[name], 'utf8').toString('base64')])),
}, null, 2) + '\n');
const revision = crypto.createHash('sha256').update(serialized).digest('hex');
const privateValuesFile = writePrivate('values.private.json', JSON.stringify(Object.fromEntries(
  ['demo-gateway', 'demo-settings-worker'].map(name => [name, {
    podAnnotations: { 'demo.gearbox.dev/credential-revision': revision },
  }]),
), null, 2) + '\n');
console.log(JSON.stringify({ work, credentialsFile, postgresEnvFile, secretFile, privateValuesFile }, null, 2));
