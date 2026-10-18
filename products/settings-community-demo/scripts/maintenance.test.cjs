'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {checkSqliteTar,backupFolder}=require('./maintenance.cjs');
function entry(name,type='0') {
 const b=Buffer.alloc(512);b.write(name,0);b.write('0000644\0',100);b.write('0000000\0',108);b.write('0000000\0',116);b.write('00000000000\0',124);b.write('00000000000\0',136);b.fill(32,148,156);b.write(type,156);b.write('ustar\0',257);
 const sum=b.reduce((a,v)=>a+v,0);b.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return b;
}
function archive(t,entries) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gbx-snapshot-test-'));const file=path.join(dir,'sqlite.tar');
 t.after(()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('gbx-snapshot-test-'));fs.unlinkSync(file);fs.rmdirSync(dir);});
 fs.writeFileSync(file,Buffer.concat([...entries,Buffer.alloc(1024)]));return file;
}
const stores=()=>[entry('./','5'),entry('./event-broker/','5'),entry('./event-broker/events.sqlite3'),entry('./event-broker/metadata.sqlite3')];
test('restore requires both stores and accepts their stopped WAL companions',t=>{
 checkSqliteTar(archive(t,[...stores(),entry('./event-broker/events.sqlite3-wal')]));
 assert.throws(()=>checkSqliteTar(archive(t,[entry('./event-broker/events.sqlite3')])) ,/Both SQLite/);
});
test('restore rejects traversal, links, devices and duplicate entries before touching data',t=>{
 for(const bad of [entry('../other'),entry('/etc/passwd'),entry('./event-broker/link','2'),entry('./event-broker/events.sqlite3','1'),entry('./event-broker/dev','3'),entry('./event-broker/events.sqlite3')]) {
  assert.throws(()=>checkSqliteTar(archive(t,[...stores(),bad])));
 }
});
test('restore refuses a corrupted tar header',t=>{
 const chunks=stores();chunks[2][120]=65;assert.throws(()=>checkSqliteTar(archive(t,chunks)),/checksum/);
});
test('backup IDs cannot select arbitrary paths or a symlink',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gbx-backup-path-'));t.after(()=>fs.rmdirSync(dir));
 for(const id of ['../private','/tmp/x','latest','20261018T123456Z-ffffffff/..']) assert.throws(()=>backupFolder(dir,id));
 assert.equal(backupFolder(dir,'20261018T123456Z-ffffffff'),path.join(dir,'backups','20261018T123456Z-ffffffff'));
});
