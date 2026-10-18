#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const work = path.resolve(process.env.DEMO_WORK_DIR || path.join(repo, '.gearbox/settings-community-demo'));
const chart = path.join(work, 'minikube/helm/settings-community-demo');
if (!fs.existsSync(path.join(chart, 'Chart.yaml'))) throw new Error('Generate the demo product before preparing its chart.');
const source = path.resolve(__dirname, '../deploy/extra-templates');
const ownership = '# Product extension owned by settings-community-demo.';
for (const name of fs.readdirSync(source).sort()) {
  if (!/^demo-[a-z0-9-]+\.yaml$/.test(name)) throw new Error(`Unexpected product extension name: ${name}`);
  const destination = path.join(chart, 'templates', name);
  const content = fs.readFileSync(path.join(source, name), 'utf8');
  if (!content.startsWith(ownership)) throw new Error(`Missing product ownership marker: ${name}`);
  if (fs.existsSync(destination) && !fs.readFileSync(destination, 'utf8').startsWith(ownership)) {
    throw new Error(`Refusing to overwrite an unrelated chart template: ${name}`);
  }
  fs.writeFileSync(destination, content);
}
console.log('Prepared product-owned chart extensions.');
