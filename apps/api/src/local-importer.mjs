import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,copyFile,stat,rename,rm,readdir,writeFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readXlsxFile,extractAudioZip} from './archive-utils.mjs';

const columns={id:['SyncCut ID','sync_cut_id','record_id','记录ID'],name:['素材名称','name'],kind:['素材类型','kind'],attachment:['音频附件','附件','filename','文件名','audio_file'],project:['项目名称','project'],episode:['集数','episode'],scene:['场景','scene'],shot:['镜头编号','shot','shot_id'],tags:['标签','tags'],notes:['备注','notes'],start:['开始时间','start'],inPoint:['素材入点','inPoint','in_point'],outPoint:['素材出点','outPoint','out_point'],track:['目标音轨','track'],volume:['音量','volume'],fadeIn:['淡入','fadeIn','fade_in'],fadeOut:['淡出','fadeOut','fade_out']};
const kinds={'音乐':'music','music':'music','音效':'sfx','sfx':'sfx','配音':'voice','voice':'voice','环境音':'ambience','ambience':'ambience'};
const extensions=new Set(['.mp3','.wav','.m4a','.aac','.aiff','.aif','.flac','.ogg','.opus']);
const MAX_XLSX_BYTES=32*1024*1024;
const pick=(r,k)=>{for(const c of columns[k])if(r[c]!=null&&String(r[c]).trim())return String(r[c]).trim();return ''};
const num=(v,k)=>{if(v==='')return null;const n=Number(v);if(!Number.isFinite(n)||n<0)throw Error('Invalid '+k);return n};
function parseCsv(s){
 const rows=[];let row=[],cell='',q=false;
 for(let i=0;i<s.length;i++){const c=s[i];if(q){if(c==='"'&&s[i+1]==='"'){cell+='"';i++}else if(c==='"')q=false;else cell+=c;continue}
 if(c==='"'&&!cell){q=true;continue}if(c===','){row.push(cell);cell='';continue}if(c==='\n'||c==='\r'){if(c==='\r'&&s[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';continue}cell+=c}
 if(q)throw Error('CSV contains unterminated quoted field');if(cell||row.length){row.push(cell);if(row.some(x=>x.trim()))rows.push(row)}
 if(!rows.length)return [];const headers=rows.shift().map(x=>x.replace(/^\uFEFF/,'').trim());if(headers.some(x=>!x)||new Set(headers).size!==headers.length)throw Error('CSV headers are empty or duplicated');
 return rows.map((values,i)=>({...Object.fromEntries(headers.map((h,j)=>[h,values[j]??''])),__row:i+2}));
}
async function walk(dir,out){for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())await walk(p,out);else if(e.isFile()&&extensions.has(path.extname(e.name).toLowerCase()))out.push(p)}}
async function hashFile(p){const {createReadStream}=await import('node:fs');const h=createHash('sha256');for await(const c of createReadStream(p))h.update(c);return h.digest('hex')}
export async function readCsvFile(p){return parseCsv((await readFile(p)).toString('utf8'))}
export async function listAudioFiles(dir){const out=[];await walk(dir,out);return out.sort()}
export function buildImportPlan({rows,files,existing=[]}){
 const idx=new Map();for(const f of files){const n=path.basename(f);idx.set(n,[...(idx.get(n)??[]),f])}
 const old=new Map(existing.map(x=>[x.sourceId,x])),seen=new Set(),items=[],errors=[];
 for(const r of rows){try{
 const name=pick(r,'name'),kind=kinds[pick(r,'kind')],attachment=pick(r,'attachment');if(!name||!kind)throw Error('素材名称或素材类型缺失/不支持');if(!attachment)throw Error('未填写音频附件文件名');
 const matches=idx.get(path.basename(attachment))??[];if(matches.length!==1)throw Error(matches.length?'音频文件名重复，无法唯一匹配':'找不到对应音频文件');
 const values={name,kind,project:pick(r,'project'),episode:pick(r,'episode'),scene:pick(r,'scene'),shot:pick(r,'shot'),tags:pick(r,'tags').split(/[;,，；]/).map(x=>x.trim()).filter(Boolean),notes:pick(r,'notes'),start:num(pick(r,'start'),'start'),inPoint:num(pick(r,'inPoint'),'inPoint'),outPoint:num(pick(r,'outPoint'),'outPoint'),track:pick(r,'track')||null,volume:num(pick(r,'volume'),'volume'),fadeIn:num(pick(r,'fadeIn'),'fadeIn'),fadeOut:num(pick(r,'fadeOut'),'fadeOut')};
 if(values.inPoint!=null&&values.outPoint!=null&&values.outPoint<=values.inPoint)throw Error('素材出点必须大于素材入点');if(values.track&&!['A1','A2','A3','A4'].includes(values.track))throw Error('目标音轨必须为 A1-A4');
 const explicit=pick(r,'id'),identity=explicit||[values.project,values.episode,values.scene,values.shot,values.name].join('\u001f').toLowerCase(),id=explicit||'derived_'+createHash('sha256').update(identity).digest('hex').slice(0,24);if(seen.has(id))throw Error('表格中存在重复素材 ID');seen.add(id);
 items.push({sourceId:id,sourceIdIsDerived:!explicit,...values,filePath:matches[0],previous:old.get(id)??null});
 }catch(e){errors.push({row:r.__row??null,reason:e.message})}}
 return {items,errors,summary:{total:rows.length,ready:items.length,errors:errors.length,new:items.filter(x=>!x.previous).length,existing:items.filter(x=>x.previous).length}};
}
async function readTableFile(tablePath){
 const ext=path.extname(tablePath).toLowerCase();
 if(ext==='.csv')return readCsvFile(tablePath);
 if(ext==='.xlsx'){const info=await stat(tablePath);if(info.size>MAX_XLSX_BYTES)throw Error('XLSX file exceeds the 32 MiB limit');return readXlsxFile(tablePath)}
 throw Error('Supported table formats are CSV and XLSX');
}
export async function readImportManifest(manifestPath){
 let manifest;
 try{manifest=JSON.parse(await readFile(manifestPath,'utf8'))}
 catch(error){if(error.code==='ENOENT')return {version:1,assets:[]};throw Error('Existing manifest is invalid')}
 if(manifest.version!==1||!Array.isArray(manifest.assets))throw Error('Unsupported manifest format');
 return manifest;
}
export async function previewImport({tablePath,audioDirectory,audioZipPath,existing=[],manifestPath,workspaceRoot=os.tmpdir()}){
 if(Boolean(audioDirectory)===Boolean(audioZipPath))throw Error('Provide exactly one of audioDirectory or audioZipPath');
 const rows=await readTableFile(tablePath);
 const knownAssets=manifestPath?(await readImportManifest(manifestPath)).assets:existing;
 let sourceDirectory=audioDirectory,workspaceDirectory=null;
 if(audioZipPath){
  await mkdir(workspaceRoot,{recursive:true});
  workspaceDirectory=await mkdtemp(path.join(workspaceRoot,'synccut-import-'));
  sourceDirectory=path.join(workspaceDirectory,'audio');
  try{await extractAudioZip(audioZipPath,sourceDirectory)}
  catch(error){await rm(workspaceDirectory,{recursive:true,force:true});throw error}
 }
 try{
  const files=await listAudioFiles(sourceDirectory);
  const plan=buildImportPlan({rows,files,existing:knownAssets});
  for(const item of plan.items){const info=await stat(item.filePath);item.sizeBytes=info.size;item.sha256=await hashFile(item.filePath)}
  if(workspaceDirectory)plan.workspaceDirectory=workspaceDirectory;
  return plan;
 }catch(error){if(workspaceDirectory)await rm(workspaceDirectory,{recursive:true,force:true});throw error}
}
export async function previewCsvImport({csvPath,audioDirectory,existing=[]}){
 return previewImport({tablePath:csvPath,audioDirectory,existing});
}
export async function cleanupImportPreview(plan){
 if(plan?.workspaceDirectory)await rm(plan.workspaceDirectory,{recursive:true,force:true});
}
export async function applyImportPlan({plan,libraryDirectory,manifestPath,confirm=false}){
 if(!confirm)throw Error('Import requires explicit confirmation');
 if(plan.errors?.length)throw Error('Resolve all import errors before applying');
 await mkdir(libraryDirectory,{recursive:true});
 const manifest=await readImportManifest(manifestPath);
 const byId=new Map(manifest.assets.map(x=>[x.sourceId,x])),changes=[];
 for(const item of plan.items){
  const old=byId.get(item.sourceId);
  const metadata={name:item.name,kind:item.kind,project:item.project,episode:item.episode,scene:item.scene,shot:item.shot,tags:item.tags,notes:item.notes,timing:{start:item.start,inPoint:item.inPoint,outPoint:item.outPoint,track:item.track,volume:item.volume,fadeIn:item.fadeIn,fadeOut:item.fadeOut}};
  if(old?.versions?.at(-1)?.sha256===item.sha256){
   const metadataUpdated=JSON.stringify(old.metadata)!==JSON.stringify(metadata);
   byId.set(item.sourceId,{...old,sourceIdIsDerived:item.sourceIdIsDerived,metadata});
   changes.push({sourceId:item.sourceId,action:'unchanged',metadataUpdated});
   continue;
  }
  const version=(old?.versions?.length??0)+1;
  const dir=path.join(libraryDirectory,createHash('sha256').update(item.sourceId).digest('hex').slice(0,20));
  await mkdir(dir,{recursive:true});
  const filename='v'+String(version).padStart(4,'0')+path.extname(item.filePath).toLowerCase();
  const dest=path.join(dir,filename),tmp=dest+'.'+randomUUID()+'.partial';
  try{await copyFile(item.filePath,tmp);if(await hashFile(tmp)!==item.sha256)throw Error('Copied file hash mismatch');await rename(tmp,dest)}
  catch(error){await rm(tmp,{force:true});throw error}
  byId.set(item.sourceId,{sourceId:item.sourceId,sourceIdIsDerived:item.sourceIdIsDerived,metadata,versions:[...(old?.versions??[]),{version,filename,diskPath:dest,sizeBytes:item.sizeBytes,sha256:item.sha256,importedAt:new Date().toISOString()}]});
  changes.push({sourceId:item.sourceId,action:old?'updated':'added',version});
 }
 const next={version:1,assets:[...byId.values()],updatedAt:new Date().toISOString()};
 const tmp=manifestPath+'.'+randomUUID()+'.partial';
 await mkdir(path.dirname(manifestPath),{recursive:true});
 try{await writeFile(tmp,JSON.stringify(next,null,2),{flag:'wx'});await rename(tmp,manifestPath)}
 catch(error){await rm(tmp,{force:true});throw error}
 await cleanupImportPreview(plan);
 return {changes,assetCount:next.assets.length,manifestPath};
}
