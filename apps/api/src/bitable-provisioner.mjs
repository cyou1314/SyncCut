import { listAll } from './bitable-sync.mjs';

const options = values => ({options:values.map(name=>({name}))});
export const TEMPLATE = Object.freeze([
  {key:'name',field_name:'素材名称',type:1,primary:true},
  {key:'kind',field_name:'素材类型',type:3,property:options(['音乐','音效','配音','环境音'])},
  {key:'attachment',field_name:'音频附件',type:17},
  {key:'project',field_name:'项目名称',type:1},{key:'episode',field_name:'集数',type:1},
  {key:'scene',field_name:'场景',type:1},{key:'shot',field_name:'镜头编号',type:1},
  {key:'tags',field_name:'标签',type:4},{key:'notes',field_name:'备注',type:1},
  {key:'start',field_name:'开始时间',type:2},{key:'inPoint',field_name:'素材入点',type:2},
  {key:'outPoint',field_name:'素材出点',type:2},
  {key:'track',field_name:'目标音轨',type:3,property:options(['A1','A2','A3','A4'])},
  {key:'volume',field_name:'音量',type:2},{key:'fadeIn',field_name:'淡入',type:2},{key:'fadeOut',field_name:'淡出',type:2},
  {key:'status',field_name:'SyncCut 同步状态',type:3,property:options(['待同步','已同步','导入成功','失败'])},
  {key:'version',field_name:'SyncCut 版本',type:2},{key:'modified',field_name:'修改时间',type:1002},
]);
function verifyField(actual, expected) {
  if (actual.type !== expected.type || (expected.primary && !actual.is_primary)) throw new Error(`Field conflict: ${expected.field_name}`);
  if (expected.property?.options) {
    const actualNames = (actual.property?.options ?? []).map(x=>x.name);
    if (expected.property.options.some(x=>!actualNames.includes(x.name))) throw new Error(`Field options conflict: ${expected.field_name}`);
  }
  if (!actual.field_id) throw new Error(`Missing field ID: ${expected.field_name}`);
}
// Journal.withLock must serialize across processes and save must commit durably before
// returning. A pending create is deliberately never retried automatically.
export async function provisionBitable({client,journal,workspaceId,creatorId,dryRun=false}) {
  if (!workspaceId || !creatorId) throw new Error('Workspace and creator required');
  if (dryRun) return {dryRun:true,base:'SyncCut 素材管理中心',table:'素材表',fields:TEMPLATE};
  return journal.withLock(workspaceId,async lockedJournal=>{
    const active = lockedJournal ?? journal;
    let state=await active.load(workspaceId);
    if (!state) { state={workspaceId,creatorId,status:'running',baseToken:null,tableId:null,fields:{},pending:null}; await active.save(state); }
    if (state.creatorId!==creatorId) throw new Error('Provisioning owner mismatch');
    if (state.pending || state.status==='needs_review') throw new Error('Creation outcome requires manual review');
    const write = async (kind, action) => {
      state.pending=kind; await active.save(state);
      try { const result=await action(); return result; }
      catch { state.status='needs_review'; await active.save(state); throw new Error(`Creation outcome requires manual review: ${kind}`); }
    };
    if (!state.baseToken) {
      const base=await write('base',()=>client.createBase({name:'SyncCut 素材管理中心'}));
      if (!base.app?.app_token) { state.status='needs_review';await active.save(state);throw new Error('Base result requires manual review'); }
      state.baseToken=base.app.app_token;state.baseUrl=base.app.url ?? null;state.pending=null;await active.save(state);
    }
    if (!state.tableId) {
      const tables=await listAll(pageToken=>client.listTables({appToken:state.baseToken,pageToken}));
      const matches=tables.filter(t=>t.name==='素材表');
      if (matches.length>1) throw new Error('Multiple matching tables');
      if (matches.length===1) state.tableId=matches[0].table_id;
      else {
        const table=await write('table',()=>client.createTable({appToken:state.baseToken,name:'素材表',primaryName:'素材名称'}));
        if (!table.table_id) {state.status='needs_review';await active.save(state);throw new Error('Table result requires manual review');}
        state.tableId=table.table_id;state.pending=null;
      }
      await active.save(state);
    }
    for (const spec of TEMPLATE) {
      const fields=await listAll(pageToken=>client.listFields({appToken:state.baseToken,tableId:state.tableId,pageToken}));
      const matches=fields.filter(f=>f.field_name===spec.field_name);
      if (matches.length>1) throw new Error(`Multiple matching fields: ${spec.field_name}`);
      let field=matches[0];
      if (!field) {
        if (spec.primary) throw new Error('Primary field requires manual review');
        const created=await write(`field:${spec.field_name}`,()=>client.createField({appToken:state.baseToken,tableId:state.tableId,spec}));
        field=created.field;
        if (!field?.field_id) {state.status='needs_review';await active.save(state);throw new Error('Field result requires manual review');}
        state.pending=null;
      }
      verifyField(field,spec);
      if (state.fields[spec.key] && state.fields[spec.key] !== field.field_id) throw new Error(`Field ID changed: ${spec.field_name}`);
      state.fields[spec.key]=field.field_id; await active.save(state);
    }
    state.status='complete';await active.save(state);return state;
  });
}
