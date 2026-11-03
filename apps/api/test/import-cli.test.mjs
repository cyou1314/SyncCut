import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs} from '../bin/import-media.mjs';

test('CLI requires a table, library and exactly one audio source',()=>{
 assert.throws(()=>parseArgs([]),/必须提供/);
 assert.throws(()=>parseArgs(['--table','a.csv','--library','lib']),/必须且只能/);
 assert.throws(()=>parseArgs(['--table','a.csv','--library','lib','--audio-dir','audio','--audio-zip','a.zip']),/必须且只能/);
});
test('CLI resolves paths and accepts ZIP input',()=>{
 const args=parseArgs(['--table','assets.xlsx','--audio-zip','audio.zip','--library','Media']);
 assert.equal(args.audioZipPath.endsWith('/audio.zip'),true);
 assert.equal(args.audioDirectory,undefined);
});
test('CLI rejects unknown and duplicate arguments',()=>{
 assert.throws(()=>parseArgs(['--wat','x']),/未知参数/);
 assert.throws(()=>parseArgs(['--table','a.csv','--table','b.csv','--library','lib','--audio-dir','audio']),/重复/);
});

import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {Readable,Writable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {runImportCli} from '../bin/import-media.mjs';

function outputCapture(){let value='';const stream=new Writable({write(chunk,encoding,callback){value+=chunk.toString();callback()}});return {stream,get value(){return value}}}
test('CLI cancellation leaves library untouched; explicit IMPORT creates a manifest',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'sc-cli-run-'));
 try{
  const table=path.join(root,'assets.csv'),audio=path.join(root,'audio'),library=path.join(root,'library');
  await mkdir(audio);await writeFile(path.join(audio,'rain.wav'),'audio-data');
  await writeFile(table,'素材名称,素材类型,音频附件,项目名称,集数\\n雨声,音效,rain.wav,雁回关,EP015\\n');
  const argv=['--table',table,'--audio-dir',audio,'--library',library];
  const cancelled=outputCapture();
  assert.equal(await runImportCli({argv,input:Readable.from(['cancel\\n']),output:cancelled.stream}),0);
  await assert.rejects(access(path.join(library,'manifest.json')));
  const confirmed=outputCapture();
  assert.equal(await runImportCli({argv,input:Readable.from(['IMPORT\\n']),output:confirmed.stream}),0);
  const manifest=JSON.parse(await readFile(path.join(library,'manifest.json'),'utf8'));
  assert.equal(manifest.assets.length,1);
  assert.equal(manifest.assets[0].metadata.name,'雨声');
  assert.match(confirmed.value,/导入完成/);
 }finally{await rm(root,{recursive:true,force:true})}
});
