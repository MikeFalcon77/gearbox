'use strict';
// Private, bounded maintenance for the single disposable Family Labs deployment.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const assert = require('node:assert/strict');
const writers = ['settings-community-demo-demo-settings-worker', 'settings-community-demo-demo-gateway'];
const databases = ['credstore', 'settings_service', 'types_registry', 'gearbox_demo_cluster'];
const privateFiles = [
  'private/runtime-secrets.json', 'private/values.private.json', 'private/kubernetes-secret.json',
  'private/postgres.env', 'private-assets/portraits/manifest.json',
  'private-assets/portraits/dasha.webp', 'private-assets/portraits/ilya.webp',
];
const optionalPrivateFiles = ['private/runtime-smoke.json', 'offline/private/runtime-secrets.json'];
const firebaseFiles = ['authn-demo-inputs.json', 'firebase-web-config.json', 'state.json'];
const optionalFirebaseFiles = ['signins.json', 'expected-users.json'];
const backupIdPattern = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const pvcName = 'gearbox-demo-gateway-data';
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
// Validate the deliberately small tar format we produce. No links, devices,
// extended names, traversal, duplicates or unrelated volume paths are accepted.
function checkSqliteTar(file) {
  const fd = fs.openSync(file, 'r');
  const names = new Set();
  try {
    const length = fs.fstatSync(fd).size;
    let at = 0, ended = false;
    while (at + 512 <= length) {
      const block = Buffer.alloc(512);
      assert.equal(fs.readSync(fd, block, 0, 512, at), 512);
      if (block.every(byte => byte === 0)) {ended = true; break;}
      const string = (start, size) => block.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
      const raw = string(0, 100), prefix = string(345, 155);
      const name = raw.replace(/^\.\//, '');
      assert(!prefix, 'Unsupported tar prefix');
      const type = string(156, 1);
      const directory = raw === '.' || raw === './' || name === 'event-broker/' || name === 'event-broker';
      assert(directory ? type === '5' : ['0', ''].includes(type), 'Unsupported tar entry type');
      assert(directory || /^event-broker\/(events|metadata)\.sqlite3(?:-(wal|shm|journal))?$/.test(name), 'Unexpected SQLite archive path');
      assert(!names.has(name), 'Duplicate SQLite archive entry');
      names.add(name);
      const octal = string(124, 12).trim();
      assert(/^[0-7]+$/.test(octal), 'Invalid tar size');
      const size = parseInt(octal, 8);
      assert(Number.isSafeInteger(size) && size >= 0 && (!directory || size === 0), 'Invalid tar entry length');
      const checksum = parseInt(string(148, 8).trim(), 8);
      const actual = block.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      assert.equal(checksum, actual, 'Tar checksum mismatch');
      at += 512 + Math.ceil(size / 512) * 512;
      assert(at <= length, 'Truncated SQLite archive');
    }
    assert(ended, 'SQLite archive has no terminator');
    assert(names.has('event-broker/events.sqlite3') && names.has('event-broker/metadata.sqlite3'), 'Both SQLite stores are required');
  } finally {fs.closeSync(fd);}
}
function backupFolder(work, id) {
  assert(backupIdPattern.test(id || ''), 'Use the exact backup ID reported by backup');
  const base = path.join(work, 'backups');
  const folder = path.join(base, id);
  if (fs.existsSync(base)) assert(!fs.lstatSync(base).isSymbolicLink(), 'Backup root cannot be a symlink');
  if (fs.existsSync(folder)) assert(fs.lstatSync(folder).isDirectory() && !fs.lstatSync(folder).isSymbolicLink(), 'Backup must be a local directory');
  return folder;
}
async function maintenance(command, ctx, backupId) {
  const {repo, work, env, run, k, stage, validate, smoke} = ctx;
  const bundle = await validate();
  const get = async (kind, name) => JSON.parse(await k(['get', kind, name, '-o', 'json'], 'maintenance-inspect', true));
  const owned = resource => assert.equal(resource.metadata.annotations?.['meta.helm.sh/release-name'], 'settings-community-demo', 'Refusing an unowned workload');
  const deployments = [];
  for (const name of writers) {
    const value = await get('deployment', name);
    owned(value);
    assert.equal(value.spec.template.metadata.annotations?.['demo.gearbox.dev/auth-mode'], bundle.mode, 'Deploy the requested mode before maintenance');
    const image = bundle.images.find(image => image.name === (name.endsWith('worker') ? 'settings' : 'gateway'));
    assert(value.spec.template.spec.containers.some(container => container.image === image.ref), 'The running writer differs from this prepared mode');
    assert((command === 'restore' ? [0, 1] : [1]).includes(value.spec.replicas), 'Maintenance expects one demo replica (or a stopped restore)');
    deployments.push({name, selector: Object.entries(value.spec.selector.matchLabels).map(([key, value]) => key + '=' + value).join(',')});
  }
  const echo = await get('deployment', 'demo-echo'); owned(echo);
  assert(echo.spec.template.spec.containers.some(container => container.image === bundle.images.find(image => image.name === 'echo').ref), 'Refusing an unexpected echo image');
  const pvc = await get('pvc', pvcName);
  assert.equal(pvc.status.phase, 'Bound');
  assert.equal(pvc.metadata.labels?.['app.kubernetes.io/part-of'], 'settings-community-demo', 'Refusing an unowned PVC');
  const pv = await get('pv', pvc.spec.volumeName);
  assert.equal(pv.spec.persistentVolumeReclaimPolicy, 'Retain');
  const container = JSON.parse(await run('docker', ['inspect', 'gearbox-demo-postgres'], 'maintenance-postgres', true))[0];
  assert.equal(container.Config.Labels?.['app.kubernetes.io/part-of'], 'settings-community-demo');
  assert(container.Mounts.some(m => m.Name === 'gearbox-demo-postgres-data' && m.Destination === '/var/lib/postgresql/data'), 'Unexpected Postgres storage');
  const volume = JSON.parse(await run('docker', ['volume', 'inspect', 'gearbox-demo-postgres-data'], 'maintenance-volume', true))[0];
  assert.equal(volume.Labels?.['app.kubernetes.io/part-of'], 'settings-community-demo');
  // Execute API calls inside the existing unprivileged echo workload. Credentials
  // enter stdin only; responses cannot include them or arbitrary error bodies.
  const api = async operations => {
    const secrets = JSON.parse(fs.readFileSync(path.join(work, 'private/runtime-secrets.json'), 'utf8'));
    const script = `let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',async()=>{try{const {token,operations}=JSON.parse(text);const base='http://demo-gateway:8087';const result=[];for(const op of operations){const headers={Authorization:'Bearer '+token,...(op.body?{'Content-Type':'application/json'}:{}),...(op.etag?{'If-Match':op.etag}:{})};const r=await fetch(base+op.path,{method:op.method||'GET',headers,body:op.body?JSON.stringify(op.body):undefined,signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Demo maintenance API returned '+r.status);const body=await r.text();result.push({body:body?JSON.parse(body):null,etag:r.headers.get('etag')});}console.log(JSON.stringify(result));}catch(e){console.error(e.message);process.exitCode=1}});`;
    return JSON.parse(await run('kubectl', ['--context', 'gearbox-demo', '--namespace', 'gearbox-demo', 'exec', '-i', 'deployment/demo-echo', '--', 'node', '-e', script], 'maintenance-api', true, JSON.stringify({token: secrets.DEMO_BOOTSTRAP_TOKEN, operations})));
  };
  const approval = '/settings-service/v1/settings/' + encodeURIComponent('gts.cf.core.settings.setting_type.v1~cf.family_labs.lab.ice_cream_approved.v1~');
  const scopes = ['d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003'];
  if (command === 'reset') {
    stage('reset', 'Resetting only Ice cream approved in both laboratories through Settings API');
    for (const tenant of scopes) {
      const route = approval + '?tenant=' + tenant;
      const [current] = await api([{path: route}]);
      if (current.body.value !== false) await api([{path: approval + '/value?tenant=' + tenant, method: 'PUT', body: {value: false}, etag: current.etag}]);
      const [verified] = await api([{path: route}]);
      assert.equal(verified.body.value, false);
    }
    fs.writeFileSync(path.join(work, 'last-reset.json'), JSON.stringify({passed: true, at: new Date().toISOString(), dasha: false, ilya: false}) + '\n', {mode: 0o600});
    stage('ready', 'Both laboratories are waiting for approval', 'ready');
    return;
  }
  if (command === 'cleanup') {
    const all = async route => {
      const items = [], seen = new Set();
      let cursor;
      for (let page = 0; page < 100; page++) {
        const [response] = await api([{path: route + '?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')}]);
        assert(Array.isArray(response.body?.items), 'Expected the broker pagination envelope');
        items.push(...response.body.items);
        cursor = response.body.page_info?.next_cursor;
        if (!cursor) return items;
        assert(!seen.has(cursor), 'Repeated pagination cursor'); seen.add(cursor);
      }
      throw Error('Too many broker groups for bounded demo cleanup');
    };
    const groups = await all('/event-broker/v1/consumer-groups');
    const candidates = groups.filter(group => group.kind === 'anonymous' && scopes.includes(group.tenant_id)
      && /^Browser [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(group.description || '')
      && Date.parse(group.created_at) < Date.now() - 10 * 60 * 1000);
    const removed = [];
    for (const group of candidates) {
      const active = await all('/event-broker/v1/subscriptions');
      if (active.some(subscription => subscription.consumer_group === group.id)) continue;
      await api([{path: '/event-broker/v1/consumer-groups/' + encodeURIComponent(group.id), method: 'DELETE'}]);
      removed.push(group.id);
    }
    fs.writeFileSync(path.join(work, 'last-cleanup.json'), JSON.stringify({passed: true, at: new Date().toISOString(), removed}, null, 2) + '\n', {mode: 0o600});
    stage('ready', 'Removed ' + removed.length + ' inactive old demo UI groups; active and business groups retained', 'ready');
    return;
  }
  const helperName = 'demo-snapshot-' + crypto.randomUUID().slice(0, 8);
  let helperCreated = false;
  const helperArgs = ['--context', 'gearbox-demo', '--namespace', 'gearbox-demo', 'exec', helperName, '--'];
  async function helper(readOnly) {
    const image = bundle.images.find(image => image.name === 'echo');
    assert(image, 'Prepared Node image is missing');
    const pod = {apiVersion: 'v1', kind: 'Pod', metadata: {name: helperName, namespace: 'gearbox-demo', labels: {'app.kubernetes.io/part-of': 'settings-community-demo', 'gearbox.dev/maintenance': 'snapshot'}}, spec: {
      automountServiceAccountToken: false, restartPolicy: 'Never', securityContext: {runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532},
      containers: [{name: 'snapshot', image: image.ref, imagePullPolicy: 'Never', command: ['node', '-e', 'setInterval(()=>{},60000)'], securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ['ALL']}}, resources: {requests: {cpu: '10m', memory: '32Mi'}, limits: {cpu: '250m', memory: '128Mi'}}, volumeMounts: [{name: 'data', mountPath: '/data', readOnly}]}],
      volumes: [{name: 'data', persistentVolumeClaim: {claimName: pvcName, readOnly}}],
    }};
    await run('kubectl', ['--context', 'gearbox-demo', '--namespace', 'gearbox-demo', 'create', '-f', '-'], 'snapshot-helper-create', false, JSON.stringify(pod));
    helperCreated = true;
    await k(['wait', '--for=condition=Ready', 'pod/' + helperName, '--timeout=90s'], 'snapshot-helper-ready');
  }
  async function transfer(executable, args, file, direction) {
    const errorFile = file + '.stderr';
    const errors = fs.openSync(errorFile, 'w', 0o600);
    const child = cp.spawn(executable, args, {cwd: repo, env: env(), stdio: [direction === 'in' ? 'pipe' : 'ignore', direction === 'out' ? 'pipe' : 'ignore', errors], windowsHide: true});
    fs.closeSync(errors);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 5 * 60 * 1000);
    const exit = new Promise((resolve, reject) => {child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('Snapshot transfer failed; inspect the private .stderr file')));});
    try {
      await Promise.all([exit, direction === 'out' ? pipeline(child.stdout, fs.createWriteStream(file, {flags: 'wx', mode: 0o600})) : pipeline(fs.createReadStream(file), child.stdin)]);
      fs.unlinkSync(errorFile);
    } catch (error) {child.kill('SIGTERM'); throw error;}
    finally {clearTimeout(timeout);}
  }
  const backupIdValue = command === 'backup' ? new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + crypto.randomUUID().slice(0, 8) : backupId;
  const folder = backupFolder(work, backupIdValue);
  let manifest;
  const files = [];
  if (command === 'restore') {
    manifest = JSON.parse(fs.readFileSync(path.join(folder, 'snapshot.json'), 'utf8'));
    assert.equal(manifest.version, 1); assert.equal(manifest.complete, true);
    assert.equal(manifest.id, backupIdValue);
    assert.equal(manifest.inputs.gears.digest, bundle.inputs.gears.digest, 'Restore requires the same backend source/migrations');
    assert.equal(manifest.inputs.privateHash, bundle.inputs.privateHash, 'Restore requires the original private credentials and portraits');
    const required = new Set(['sqlite.tar', ...databases.map(db => db + '.dump'), ...privateFiles.map(name => 'inputs/' + name), ...firebaseFiles.map(name => 'firebase/' + name)]);
    const allowed = new Set([...required, ...optionalPrivateFiles.map(name => 'inputs/' + name), ...optionalFirebaseFiles.map(name => 'firebase/' + name)]);
    const included = new Set();
    for (const item of manifest.files) {
      assert(allowed.has(item.name) && !included.has(item.name), 'Unexpected or duplicate snapshot file');
      included.add(item.name); required.delete(item.name);
      const file = path.join(folder, item.name);
      assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'Snapshot input must be a regular file');
      assert.equal(await hashFile(file), item.sha256, 'Backup file hash mismatch: ' + item.name);
    }
    assert.equal(required.size, 0, 'Snapshot is incomplete');
    checkSqliteTar(path.join(folder, 'sqlite.tar'));
    // Validate PostgreSQL archives before any writer is stopped or data changes.
    for (const database of databases) await transfer('docker', ['exec', '-i', 'gearbox-demo-postgres', 'pg_restore', '--list'], path.join(folder, database + '.dump'), 'in');
  } else {
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    manifest = {version: 1, complete: false, id: backupIdValue, at: new Date().toISOString(), inputs: bundle.inputs, images: bundle.images, pvcUid: pvc.metadata.uid, files};
    // Copy only known local product inputs. Never include Google CLI credentials
    // or browser user tokens. This directory itself is PRIVATE, not shareable.
    for (const [sourceBase, names, prefix] of [[work, [...privateFiles, ...optionalPrivateFiles.filter(name => fs.existsSync(path.join(work, name)))], 'inputs'], [path.join(repo, '.gearbox/firebase-preflight'), [...firebaseFiles, ...optionalFirebaseFiles.filter(name => fs.existsSync(path.join(repo, '.gearbox/firebase-preflight', name)))], 'firebase']]) {
      for (const name of names) {
        const source = path.join(sourceBase, name);
        assert(fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink(), 'Expected a regular private input');
        const relative = prefix + '/' + name, destination = path.join(folder, relative);
        fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); fs.chmodSync(destination, 0o600);
        files.push({name: relative, sha256: await hashFile(destination)});
      }
    }
    const values = await api(scopes.map(tenant => ({path: approval + '?tenant=' + tenant})));
    manifest.approvals = values.map(value => value.body.value);
  }
  let stopped = false, restored = false;
  try {
    stage('quiesce', 'Stopping Settings and Gateway writers for a consistent private snapshot');
    stopped = true;
    for (const deployment of deployments) {
      await k(['scale', 'deployment/' + deployment.name, '--replicas=0'], 'snapshot-stop-writer');
      await k(['wait', '--for=delete', 'pods', '-l', deployment.selector, '--timeout=120s'], 'snapshot-writer-stopped');
    }
    await helper(command === 'backup');
    if (command === 'backup') {
      stage('backup', 'Saving both SQLite stores, four Postgres databases and private product inputs');
      await transfer('kubectl', [...helperArgs, 'tar', '-C', '/data', '-cf', '-', 'event-broker'], path.join(folder, 'sqlite.tar'), 'out');
      checkSqliteTar(path.join(folder, 'sqlite.tar'));
      files.push({name: 'sqlite.tar', sha256: await hashFile(path.join(folder, 'sqlite.tar'))});
      for (const database of databases) {
        const file = path.join(folder, database + '.dump');
        await transfer('docker', ['exec', 'gearbox-demo-postgres', 'pg_dump', '-U', 'gearbox_demo', '-Fc', '--no-owner', '--no-acl', database], file, 'out');
        files.push({name: database + '.dump', sha256: await hashFile(file)});
      }
      manifest.complete = true;
      fs.writeFileSync(path.join(folder, 'snapshot.json.tmp'), JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
      fs.renameSync(path.join(folder, 'snapshot.json.tmp'), path.join(folder, 'snapshot.json'));
    } else {
      stage('restore', 'Restoring the selected private snapshot into the stopped demo only');
      for (const database of databases) await transfer('docker', ['exec', '-i', 'gearbox-demo-postgres', 'pg_restore', '-U', 'gearbox_demo', '--dbname=' + database, '--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction'], path.join(folder, database + '.dump'), 'in');
      // Fixed path in a verified owned PVC, after the complete archive was hashed
      // and validated. No computed host path or unrelated volume is deleted.
      await run('kubectl', [...helperArgs, 'node', '-e', "require('node:fs').rmSync('/data/event-broker',{recursive:true,force:true})"], 'snapshot-clear-owned-sqlite');
      await transfer('kubectl', ['--context', 'gearbox-demo', '--namespace', 'gearbox-demo', 'exec', '-i', helperName, '--', 'tar', '--no-same-owner', '-C', '/data', '-xf', '-'], path.join(folder, 'sqlite.tar'), 'in');
      restored = true;
    }
  } finally {
    let helperError;
    try {if (helperCreated) await k(['delete', 'pod', helperName, '--wait=true', '--timeout=90s'], 'snapshot-helper-remove');}
    catch (error) {helperError = error;}
    // A failed restore can span several stores; never start writers on a partial
    // restore. Re-run the same validated snapshot after fixing the reported cause.
    if (stopped && (command === 'backup' || restored)) {
      for (const deployment of [...deployments].reverse()) {
        await k(['scale', 'deployment/' + deployment.name, '--replicas=1'], 'snapshot-resume-writer');
        await k(['rollout', 'status', 'deployment/' + deployment.name, '--timeout=180s'], 'snapshot-writer-ready');
      }
      await smoke();
    } else if (stopped) stage('error', 'Restore failed. Writers remain stopped; repair the cause and restore the same backup before resuming.', 'error');
    if (helperError) throw helperError;
  }
  if (command === 'restore') {
    if (manifest.files.some(file => file.name === 'inputs/private/runtime-smoke.json')) fs.copyFileSync(path.join(folder, 'inputs/private/runtime-smoke.json'), path.join(work, 'private/runtime-smoke.json'));
    const values = await api(scopes.map(tenant => ({path: approval + '?tenant=' + tenant})));
    assert.deepEqual(values.map(value => value.body.value), manifest.approvals, 'Restored Settings values differ from snapshot');
  }
  const receipt = {passed: true, command, backupId: backupIdValue, at: new Date().toISOString(), privateDirectory: folder};
  fs.writeFileSync(path.join(work, 'last-' + command + '.json'), JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600});
  stage('ready', command + ' passed: ' + backupIdValue, 'ready');
}
module.exports = {maintenance, checkSqliteTar, backupFolder, hashFile};
