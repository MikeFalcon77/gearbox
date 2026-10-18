#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
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
const sourceAssets = path.join(work, 'private-assets/portraits');
const manifest = JSON.parse(fs.readFileSync(path.join(sourceAssets, 'manifest.json'), 'utf8'));
if (manifest.version !== 1) throw new Error('Prepare the private portraits with prepare-portraits.py first.');
const portraits = {};
fs.mkdirSync(path.join(ui, 'public/portraits'), {recursive: true});
for (const lab of ['dasha', 'ilya']) {
  const item = manifest.portraits[lab];
  if (item?.file !== `${lab}.webp` || item.metadataRemoved !== true) throw new Error(`Unprepared private portrait: ${lab}`);
  const bytes = fs.readFileSync(path.join(sourceAssets, item.file));
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Private portrait changed after verification: ${lab}`);
  fs.writeFileSync(path.join(ui, 'public/portraits', item.file), bytes);
  portraits[lab] = '/portraits/' + item.file;
}
const prefix = 'gts.cf.core.settings.setting_type.v1~cf.family_labs.lab.';
const approvalKey = prefix + 'ice_cream_approved.v1~';
const config = {apiBase:'/api',productName:'Family Labs',firebase:web,identityPath:'/family-labs/v1/me',
  tenants:{
    'd0000000-0000-4000-8000-000000000002':{name:"Dasha’s Lab",character:'Dasha',role:'Chief Ice Cream Officer',portrait:portraits.dasha,portraitPosition:"82% 43%",portraitZoom:2},
    'a0000000-0000-4000-8000-000000000003':{name:"Ilya’s Lab",character:'Ilya',role:'Head of Quality Assurance',portrait:portraits.ilya,portraitPosition:"50% 40%",portraitZoom:1}
  },
  events:{topic:'gts.cf.core.events.topic.v1~cf.demo.settings.changed.v1',type:'gts.cf.core.events.event.v1~cf.demo.settings.changed.v1~',requiresProcessor:true},
  settings:{effectivePath:'/family-labs/v1/effective:read',echoPath:'/oagw/v1/proxy/demo-echo.gearbox-demo.svc.cluster.local:8080/echo',approvalKey,fields:[
    {key:approvalKey,label:'Ice cream approved',kind:'boolean'},
    {key:prefix+'lab_message.v1~',label:'Lab message',kind:'string'},
    {key:prefix+'scoops_per_person.v1~',label:'Scoops per person',kind:'number'}
  ]}
};
fs.writeFileSync(path.join(ui,'public/runtime-config.json'),JSON.stringify(config,null,2)+'\n');
console.log('Prepared product UI with the existing public Firebase Web SDK configuration.');
