#!/usr/bin/env node
'use strict';
// Temporary phase-3 browser proof, before the modular product UI is generated.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {randomBytes} = require('node:crypto');
const repo = path.resolve(__dirname, '../../..');
const handoff = path.join(repo, '.gearbox/firebase-preflight');
const inputs = JSON.parse(fs.readFileSync(path.join(handoff, 'authn-demo-inputs.json'), 'utf8'));
const webConfig = JSON.parse(fs.readFileSync(path.join(handoff, 'firebase-web-config.json'), 'utf8'));
const upstream = new URL(process.env.DEMO_API_URL || 'http://127.0.0.1:18087');
if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(upstream.hostname)) throw Error('Expected loopback Gateway HTTP URL');
const origin = 'http://localhost:4175';
const nonce = randomBytes(32).toString('hex');
const server = http.createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  if (request.headers.host !== 'localhost:4175' || (request.headers.origin && request.headers.origin !== origin)) {
    response.writeHead(403).end(); return;
  }
  const url = new URL(request.url, origin);
  if (request.method === 'GET' && url.pathname === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(fs.readFileSync(path.join(__dirname, 'verify-vertical.html'))); return;
  }
  if (request.method === 'GET' && url.pathname === '/setup') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({webConfig, nonce, expected: Object.fromEntries(Object.entries(inputs.tenantIdentityMappings).map(([lab, item]) => [lab, item.email]))})); return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (request.headers['x-demo-nonce'] !== nonce) {response.writeHead(403).end(); return;}
    const headers = {...request.headers, host: upstream.host};
    delete headers['x-demo-nonce']; delete headers.cookie; delete headers.origin;
    const proxy = http.request({hostname: upstream.hostname, port: upstream.port, method: request.method, path: request.url.slice(4), headers}, result => {
      const output = {...result.headers, 'cache-control': 'no-store', 'x-accel-buffering': 'no'};
      response.writeHead(result.statusCode, output); response.flushHeaders(); result.pipe(response);
    });
    proxy.on('error', () => {if (!response.headersSent) response.writeHead(502); response.end();});
    response.on('close', () => proxy.destroy()); request.pipe(proxy); return;
  }
  if (request.method === 'POST' && url.pathname === '/receipt' && request.headers['x-demo-nonce'] === nonce) {
    let body = '';
    for await (const chunk of request) {body += chunk; if (body.length > 8192) {response.writeHead(413).end(); return;}}
    try {
      const value = JSON.parse(body);
      if (!['dasha', 'ilya'].includes(value.lab) || !['editor', 'observer'].includes(value.role)
        || typeof value.tabId !== 'string' || typeof value.eventId !== 'string' || typeof value.value !== 'boolean') throw Error('Invalid result');
      const receipt = {lab: value.lab, role: value.role, tabId: value.tabId, eventId: value.eventId, value: value.value, verifiedAt: new Date().toISOString()};
      fs.writeFileSync(path.join(repo, '.gearbox/settings-community-demo/private', 'vertical-' + value.lab + '-' + value.role + '.json'), JSON.stringify(receipt, null, 2) + '\n');
      response.writeHead(204).end();
    } catch {response.writeHead(400).end();}
    return;
  }
  response.writeHead(404).end();
});
server.listen(4175, '127.0.0.1', () => console.log('Phase-3 vertical check: http://localhost:4175'));
