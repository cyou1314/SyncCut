import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {buildImportPlan,previewCsvImport,applyImportPlan,readCsvFile} from '../src/local-importer.mjs';
const csv='素材名称,素材类型,音频附件,项目名称,集数,目标音轨\n"雨声,远景",音效,rain.wav,雁回关,EP015,A3\n';
test('CSV handles quoted commas and maps Chinese fields',async()=>{const d=await mkdtemp(path.join(os.tmpdir(),'sc-csv-'));try{const p=path.join(d,'a.csv');await writeFile(p,csv);const r=await readCsvFile(p);assert.equal(r[0].素材名称,'雨声,远景');const plan=buildImportPlan({rows:r,files:[path.join(d,'rain.wav')]});assert.equal(plan.items[0].episode,'EP015')}finally{await rm(d,{recursive:true,force:true})}});
test('ambiguous filenames are rejected',()=>{const p=buildImportPlan({rows:[{素材名称:'雨声',素材类型:'音效',音频附件:'rain.wav'}],files:['/a/rain.wav','/b/rain.wav']});assert.equal(p.errors.length,1)});
test('copies immutable versions and skips unchanged content',async()=>{const d=await mkdtemp(path.join(os.tmpdir(),'sc-import-'));try{const audio=path.join(d,'rain.wav'),csvPath=path.join(d,'a.csv'),lib=path.join(d,'lib'),manifest=path.join(d,'lib','manifest.json');await writeFile(audio,'v1');await writeFile(csvPath,csv);let p=await previewCsvImport({csvPath,audioDirectory:d});let r=await applyImportPlan({plan:p,libraryDirectory:lib,manifestPath:manifest,confirm:true});assert.equal(r.changes[0].action,'added');p=await previewCsvImport({csvPath,audioDirectory:d,existing:JSON.parse(await readFile(manifest)).assets});r=await applyImportPlan({plan:p,libraryDirectory:lib,manifestPath:manifest,confirm:true});assert.equal(r.changes[0].action,'unchanged');await writeFile(audio,'v2');p=await previewCsvImport({csvPath,audioDirectory:d,existing:JSON.parse(await readFile(manifest)).assets});r=await applyImportPlan({plan:p,libraryDirectory:lib,manifestPath:manifest,confirm:true});assert.equal(r.changes[0].version,2);assert.equal(JSON.parse(await readFile(manifest)).assets[0].versions.length,2)}finally{await rm(d,{recursive:true,force:true})}});
test('requires confirmation and rejects unresolved errors',async()=>{const d=await mkdtemp(path.join(os.tmpdir(),'sc-guard-'));try{const plan={items:[],errors:[{}]};await assert.rejects(applyImportPlan({plan,libraryDirectory:d,manifestPath:path.join(d,'m')}),/confirmation/);await assert.rejects(applyImportPlan({plan,libraryDirectory:d,manifestPath:path.join(d,'m'),confirm:true}),/Resolve/)}finally{await rm(d,{recursive:true,force:true})}});

test('metadata changes update the manifest without creating an audio version',async()=>{
 const d=await mkdtemp(path.join(os.tmpdir(),'sc-metadata-'));
 try{
  const audio=path.join(d,'rain.wav'),csvPath=path.join(d,'assets.csv'),library=path.join(d,'library'),manifestPath=path.join(library,'manifest.json');
  const first='素材名称,素材类型,音频附件,项目名称,集数,备注\n雨声,音效,rain.wav,雁回关,EP015,旧备注\n';
  await writeFile(audio,'same-audio');await writeFile(csvPath,first);
  let plan=await previewCsvImport({csvPath,audioDirectory:d});
  await applyImportPlan({plan,libraryDirectory:library,manifestPath,confirm:true});
  const existing=JSON.parse(await readFile(manifestPath,'utf8')).assets;
  await writeFile(csvPath,first.replace('旧备注','新备注'));
  plan=await previewCsvImport({csvPath,audioDirectory:d,existing});
  const result=await applyImportPlan({plan,libraryDirectory:library,manifestPath,confirm:true});
  assert.equal(result.changes[0].action,'unchanged');
  assert.equal(result.changes[0].metadataUpdated,true);
  const saved=JSON.parse(await readFile(manifestPath,'utf8'));
  assert.equal(saved.assets[0].metadata.notes,'新备注');
  assert.equal(saved.assets[0].versions.length,1);
 }finally{await rm(d,{recursive:true,force:true})}
});
