import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {readXlsxFile,extractAudioZip} from '../src/archive-utils.mjs';
import {previewImport,applyImportPlan,readImportManifest} from '../src/local-importer.mjs';

function crc32(buffer){
 let crc=0xffffffff;
 for(const byte of buffer){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc&1)?(0xedb88320^(crc>>>1)):(crc>>>1)}
 return (crc^0xffffffff)>>>0;
}
function makeZip(entries){
 const local=[],central=[];let offset=0;
 for(const [name,value] of entries){
  const n=Buffer.from(name),data=Buffer.from(value),compressed=deflateRawSync(data),crc=crc32(data),lh=Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt16LE(0x0800,6);lh.writeUInt16LE(8,8);
  lh.writeUInt32LE(crc,14);lh.writeUInt32LE(compressed.length,18);lh.writeUInt32LE(data.length,22);lh.writeUInt16LE(n.length,26);
  local.push(lh,n,compressed);
  const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(0x0314,4);ch.writeUInt16LE(20,6);
  ch.writeUInt16LE(0x0800,8);ch.writeUInt16LE(8,10);ch.writeUInt32LE(crc,16);ch.writeUInt32LE(compressed.length,20);
  ch.writeUInt32LE(data.length,24);ch.writeUInt16LE(n.length,28);ch.writeUInt32LE(0x81a40000,38);ch.writeUInt32LE(offset,42);
  central.push(ch,n);offset+=lh.length+n.length+compressed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);
 end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
function makeXlsx(){
 const values=['素材名称','素材类型','音频附件','项目名称','集数','目标音轨','雨声','音效','rain.wav','雁回关','EP015','A3'];
 const shared='<sst>'+values.map(v=>'<si><t>'+v+'</t></si>').join('')+'</sst>';
 const cells=values.slice(0,6).map((v,i)=>'<c r="'+String.fromCharCode(65+i)+'1" t="s"><v>'+i+'</v></c>').join('');
 const data=values.slice(6).map((v,i)=>'<c r="'+String.fromCharCode(65+i)+'2" t="s"><v>'+(i+6)+'</v></c>').join('');
 const workbook='<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Assets" sheetId="1" r:id="rId1"/></sheets></workbook>';
 const rels='<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>';
 const sheet='<worksheet><sheetData><row r="1">'+cells+'</row><row r="2">'+data+'</row></sheetData></worksheet>';
 return makeZip([['[Content_Types].xml','<Types/>'],['xl/workbook.xml',workbook],['xl/_rels/workbook.xml.rels',rels],['xl/sharedStrings.xml',shared],['xl/worksheets/sheet1.xml',sheet]]);
}

test('reads XLSX shared strings and maps the first worksheet',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sc-xlsx-'));
 try{const file=path.join(dir,'assets.xlsx');await writeFile(file,makeXlsx());const rows=await readXlsxFile(file);assert.equal(rows.length,1);assert.equal(rows[0]['素材名称'],'雨声');assert.equal(rows[0]['音频附件'],'rain.wav');assert.equal(rows[0].__row,2)}
 finally{await rm(dir,{recursive:true,force:true})}
});

test('extracts audio from ZIP and rejects traversal entries',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sc-zip-'));
 try{
  const good=path.join(dir,'audio.zip');await writeFile(good,makeZip([['nested/rain.wav','wave-data'],['readme.txt','ignore']]));
  const out=path.join(dir,'out');const result=await extractAudioZip(good,out);assert.equal(result.extracted,1);assert.equal(await readFile(path.join(out,'nested/rain.wav'),'utf8'),'wave-data');
  const bad=path.join(dir,'bad.zip');await writeFile(bad,makeZip([['../escape.wav','bad']]));
  await assert.rejects(extractAudioZip(bad,path.join(dir,'bad-out')),/Unsafe ZIP entry/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('XLSX plus ZIP preview imports and cleans temporary extraction after confirmation',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sc-preview-'));
 try{
  const tablePath=path.join(dir,'assets.xlsx'),zipPath=path.join(dir,'audio.zip'),library=path.join(dir,'library'),manifestPath=path.join(library,'manifest.json');
  await writeFile(tablePath,makeXlsx());await writeFile(zipPath,makeZip([['rain.wav','rain-data']]));
  const plan=await previewImport({tablePath,audioZipPath:zipPath,manifestPath});
  assert.equal(plan.summary.ready,1);assert.equal(plan.summary.errors,0);
  const workspace=plan.workspaceDirectory;
  const result=await applyImportPlan({plan,libraryDirectory:library,manifestPath,confirm:true});
  assert.equal(result.changes[0].action,'added');await assert.rejects(access(workspace));
  const manifest=await readImportManifest(manifestPath);assert.equal(manifest.assets.length,1);assert.equal(manifest.assets[0].metadata.episode,'EP015');
 }finally{await rm(dir,{recursive:true,force:true})}
});
