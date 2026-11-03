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
