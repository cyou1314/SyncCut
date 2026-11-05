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
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';

const cliPath=fileURLToPath(new URL('../bin/import-media.mjs',import.meta.url));
async function runProcess(args,input){
 const child=spawn(process.execPath,[cliPath,...args],{stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);
 child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
 child.stdin.end(input);
 const [code]=await once(child,'close');
 return {code,stdout,stderr};
}
test('CLI cancellation leaves library untouched; explicit IMPORT creates a manifest',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'sc-cli-run-'));
 try{
  const table=path.join(root,'assets.csv'),audio=path.join(root,'audio'),library=path.join(root,'library');
  await mkdir(audio);await writeFile(path.join(audio,'rain.wav'),'audio-data');
  await writeFile(table,'素材名称,素材类型,音频附件,项目名称,集数\n雨声,音效,rain.wav,雁回关,EP015\n');
  const argv=['--table',table,'--audio-dir',audio,'--library',library];
  const cancelled=await runProcess(argv,'cancel\n');
  assert.equal(cancelled.code,0,cancelled.stdout+cancelled.stderr);
  await assert.rejects(access(path.join(library,'manifest.json')));
  const confirmed=await runProcess(argv,'IMPORT\n');
  assert.equal(confirmed.code,0,confirmed.stdout+confirmed.stderr);
  const manifest=JSON.parse(await readFile(path.join(library,'manifest.json'),'utf8'));
  assert.equal(manifest.assets.length,1);
  assert.equal(manifest.assets[0].metadata.name,'雨声');
  assert.match(confirmed.stdout,/导入完成/);
 }finally{await rm(root,{recursive:true,force:true})}
});
