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
  : { schemaVersion: 2 };
const oldSchema = credentials.schemaVersion;
if (![1, 2].includes(oldSchema)) throw new Error('Unsupported private runtime credentials schema.');
const names = ['GEARS_PG_PASSWORD', 'DEMO_INTERNAL_TOKEN', 'DEMO_BOOTSTRAP_TOKEN', 'DEMO_WORKER_TOKEN'];
if (process.env.DEMO_OFFLINE === '1') names.push('DEMO_OFFLINE_DASHA_TOKEN', 'DEMO_OFFLINE_ILYA_TOKEN');
for (const name of names) {
  const addedInV2 = name === 'DEMO_WORKER_TOKEN' && oldSchema === 1;
  if (credentials[name] === undefined && (!existing || addedInV2 || name.startsWith('DEMO_OFFLINE_'))) credentials[name] = crypto.randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(credentials[name])) {
    throw new Error(`Invalid ${name} in the private handoff; refusing to rotate existing credentials.`);
  }
}
credentials.schemaVersion = 2;
const handoff = path.resolve(process.env.DEMO_FIREBASE_HANDOFF || path.join(repo, '.gearbox/firebase-preflight'));
const firebase = JSON.parse(fs.readFileSync(path.join(handoff, 'authn-demo-inputs.json'), 'utf8'));
const firebaseState = JSON.parse(fs.readFileSync(path.join(handoff, 'state.json'), 'utf8'));
const firebaseWeb = JSON.parse(fs.readFileSync(path.join(handoff, 'firebase-web-config.json'), 'utf8'));
if (firebaseState.status !== 'firebase-ready' || firebaseState.projectId !== firebase.projectId || firebaseWeb.projectId !== firebase.projectId ||
    firebase.issuer !== `https://securetoken.google.com/${firebase.projectId}` || firebase.audience !== firebase.projectId || firebase.containsUserTokens !== false) {
  throw new Error('The existing Firebase handoff is incomplete or inconsistent.');
}
const firebaseVariables = { DEMO_FIREBASE_PROJECT_ID: firebase.projectId };
const seenUids = new Set();
for (const lab of ['dasha', 'ilya']) {
  const identity = firebase.tenantIdentityMappings?.[lab];
  if (!identity || typeof identity.firebaseUid !== 'string' || !identity.firebaseUid || seenUids.has(identity.firebaseUid) ||
      typeof identity.email !== 'string' || !identity.email.includes('@')) throw new Error(`Missing or duplicate verified Firebase mapping for ${lab}.`);
  seenUids.add(identity.firebaseUid);
  firebaseVariables[`DEMO_${lab.toUpperCase()}_FIREBASE_UID`] = identity.firebaseUid;
  firebaseVariables[`DEMO_${lab.toUpperCase()}_FIREBASE_EMAIL`] = identity.email;
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
  data: Object.fromEntries(Object.entries({ ...Object.fromEntries(names.map(name => [name, credentials[name]])), ...firebaseVariables })
    .map(([name, value]) => [name, Buffer.from(value, 'utf8').toString('base64')])),
}, null, 2) + '\n');
const revision = crypto.createHash('sha256').update(serialized).update(JSON.stringify(firebaseVariables)).digest('hex');
const privateValuesFile = writePrivate('values.private.json', JSON.stringify(Object.fromEntries(
  ['demo-gateway', 'demo-settings-worker'].map(name => [name, {
    podAnnotations: { 'demo.gearbox.dev/credential-revision': revision, 'demo.gearbox.dev/auth-mode': process.env.DEMO_OFFLINE === '1' ? 'static-demo' : 'firebase' },
  }]),
), null, 2) + '\n');
console.log(JSON.stringify({ work, credentialsFile, postgresEnvFile, secretFile, privateValuesFile }, null, 2));
