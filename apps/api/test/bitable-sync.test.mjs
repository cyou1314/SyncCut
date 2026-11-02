import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMapping, mapRecord, listAll, fullSync } from '../src/bitable-sync.mjs';
const fields = [{field_id:'f1',field_name:'名称'},{field_id:'f2',field_name:'类型'},{field_id:'f3',field_name:'附件'},{field_id:'f4',field_name:'集数'},{field_id:'f5',field_name:'开始'}];
const ids = {name:'f1',kind:'f2',attachment:'f3',episode:'f4',start:'f5'};
const record = {record_id:'rec1',fields:{名称:[{text:'雨声'}],类型:'音效',附件:[{file_token:'file1',name:'rain.wav',type:'audio/wav',size:42}],集数:'EP015',开始:1.5}};
test('field IDs resolve renamed fields and parse attachment and timeline', () => {
  const m = resolveMapping(ids, fields); const a = mapRecord(record,m);
  assert.equal(a.name,'雨声'); assert.equal(a.kind,'sfx'); assert.equal(a.episode,'EP015'); assert.equal(a.timing.start,1.5); assert.equal(a.attachment.fileToken,'file1');
  assert.throws(() => resolveMapping({...ids,name:'deleted'},fields), /missing/);
  assert.throws(() => mapRecord({...record,fields:{...record.fields,附件:[]}},m), /exactly one/);
});
test('pagination handles pages and rejects cycles', async () => {
  assert.deepEqual(await listAll(async p => p ? {items:[2],has_more:false} : {items:[1],has_more:true,page_token:'next'}), [1,2]);
  await assert.rejects(listAll(async () => ({items:[],has_more:true,page_token:'same'})), /repeated/);
});
test('sync consumes pages, deduplicates records and reports invalid records', async () => {
  const saved=[]; const client={getBase:async()=>({app:{name:'Base'}}),listTables:async()=>({items:[{table_id:'tbl'}]}),listFields:async()=>({items:fields}),listRecords:async({pageToken})=>pageToken ? {items:[record,{record_id:'bad',fields:{}}],has_more:false} : {items:[record],has_more:true,page_token:'2'}};
  const result=await fullSync({client,connection:{appToken:'base',tableId:'tbl',fieldMapping:ids},store:{upsert:async a=>saved.push(a)}});
  assert.equal(saved.length,1); assert.equal(result.duplicates,1); assert.equal(result.failed,1); assert.equal(result.errors[0].recordId,'bad');
});

test('preserves Feishu attachment permission extra without trusting arbitrary URLs', () => {
  const extra='{"bitablePerm":{"tableId":"tbl","rev":32}}';
  const r={...record,fields:{...record.fields,附件:[{...record.fields.附件[0],url:'https://open.feishu.cn/open-apis/drive/v1/medias/file1/download?extra='+encodeURIComponent(extra)}]}};
  assert.equal(mapRecord(r,resolveMapping(ids,fields)).attachment.extra,extra);
  r.fields.附件[0].url='https://evil.example/steal?extra=bad';
  assert.throws(()=>mapRecord(r,resolveMapping(ids,fields)), /Invalid attachment URL/);
});
