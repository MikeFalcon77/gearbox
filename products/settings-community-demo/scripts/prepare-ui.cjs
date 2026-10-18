#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const work = path.resolve(process.env.DEMO_WORK_DIR || path.join(repo, '.gearbox/settings-community-demo'));
const ui = path.join(work, 'minikube/ui');
if (!fs.existsSync(path.join(ui, 'package.json'))) throw new Error('Generate the product UI first.');
const firebase = JSON.parse(fs.readFileSync(path.join(repo, '.gearbox/firebase-preflight/firebase-web-config.json'), 'utf8'));
const web = {};
for (const key of ['apiKey', 'appId', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId']) {
  if (typeof firebase[key] !== 'string' || !firebase[key]) throw new Error(`Missing public Firebase field: ${key}`);
  web[key] = firebase[key];
}
// Firebase Web SDK configuration is public. Private identities and credentials
// are never copied from the separate agent handoff.
fs.writeFileSync(path.join(ui, 'public/runtime-config.json'), JSON.stringify({apiBase: '/api', productName: 'Family Labs', firebase: web}, null, 2) + '\n');
console.log('Prepared product UI with the existing public Firebase Web SDK configuration.');
