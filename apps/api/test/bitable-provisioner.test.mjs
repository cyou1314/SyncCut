import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionBitable,TEMPLATE} from '../src/bitable-provisioner.mjs';
function fixture(){let state, fields=[],calls=0;const journal={withLock:async(_,fn)=>fn(),load:async()=>state?structuredClone(state):null,save:async v=>{state=structuredClone(v)}};const client={createBase:async()=>{calls++;return {app:{app_token:'base'}}},listTables:async()=>({items:[]}),createTable:async()=>{calls++;fields.push({field_name:'素材名称',field_id:'id_name',type:1,is_primary:true});return {table_id:'tbl'}},listFields:async()=>({items:structuredClone(fields)}),createField:async({spec})=>{calls++;const f={...spec,field_id:'id_'+spec.key};fields.push(f);return {field:f}}};return {journal,client,get calls(){return calls},get fields(){return fields}}}
test('dry-run does not write; creates and saves field IDs without duplication on replay',async()=>{const f=fixture(),args={...f,workspaceId:'w',creatorId:'u'};const plan=await provisionBitable({...args,dryRun:true});assert.equal(plan.fields.length,TEMPLATE.length);assert.equal(f.calls,0);const state=await provisionBitable(args);assert.equal(state.status,'complete');assert.equal(Object.keys(state.fields).length,TEMPLATE.length);const calls=f.calls;await provisionBitable(args);assert.equal(f.calls,calls)});
test('ambiguous create outcome never retries',async()=>{const f=fixture();f.client.createBase=async()=>{throw new Error('timeout')};const args={...f,workspaceId:'w',creatorId:'u'};await assert.rejects(provisionBitable(args),/manual review/);await assert.rejects(provisionBitable(args),/manual review/)});
test('existing incompatible field fails without overwriting',async()=>{const f=fixture(),args={...f,workspaceId:'w',creatorId:'u'};await provisionBitable(args);f.fields.find(x=>x.field_name==='素材类型').type=1;await assert.rejects(provisionBitable(args),/Field conflict/)});
test('saved field identity cannot silently switch to a replacement',async()=>{const f=fixture(),args={...f,workspaceId:'w',creatorId:'u'};await provisionBitable(args);f.fields.find(x=>x.field_name==='音频附件').field_id='replacement';await assert.rejects(provisionBitable(args),/Field ID changed/)});
test('failed write preserves earlier steps and does not retry ambiguous creation',async()=>{
 const f=fixture(), original=f.client.createField;let n=0;f.client.createField=async request=>{if(++n===3)throw new Error('timeout');return original(request)};
 const args={...f,workspaceId:'w',creatorId:'u'};
 await assert.rejects(provisionBitable(args),/manual review/);
 const saved=await f.journal.load('w');assert.equal(saved.baseToken,'base');assert.equal(saved.tableId,'tbl');assert.ok(saved.fields.name);assert.equal(saved.pending,'field:项目名称');
 await assert.rejects(provisionBitable(args),/manual review/);assert.equal(n,3);
});
