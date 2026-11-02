import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const run = promisify(execFile);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.aiff', '.aif', '.flac', '.ogg', '.opus']);
const MAX_ENTRIES = 20000;
const MAX_AUDIO = 512 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const MAX_XML = 32 * 1024 * 1024;

function safeEntryName(name) {
  const value = name.replaceAll('\\', '/');
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || /[\x00-\x1f]/.test(value)) throw new Error('Unsafe ZIP entry name: ' + name);
  const parts = value.split('/');
  if (parts.some(part => part === '..' || part === '.') || parts[0].startsWith('-')) throw new Error('Unsafe ZIP entry name: ' + name);
  return value;
}

async function listZipEntries(zipPath) {
  const result = await run('unzip', ['-Z1', path.resolve(zipPath)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const names = result.stdout.split(/\r?\n/).filter(Boolean);
  if (names.length > MAX_ENTRIES) throw new Error('ZIP archive contains too many entries.');
  const seen = new Set();
  return names.map(name => {
    const safeName = safeEntryName(name);
    const key = safeName.toLocaleLowerCase();
    if (seen.has(key)) throw new Error('Duplicate ZIP entry path: ' + safeName);
    seen.add(key);
    return safeName;
  });
}

async function readZipEntry(zipPath, entryName, maxBytes = MAX_XML) {
  const result = await run('unzip', ['-p', path.resolve(zipPath), entryName], { encoding: 'buffer', maxBuffer: maxBytes, windowsHide: true });
  if (result.stdout.length > maxBytes) throw new Error('ZIP entry exceeds read limit: ' + entryName);
  return result.stdout;
}

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const key = entity.toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === 'apos') return "'";
    const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
function attrs(source) {
  const result = {};
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  return result;
}
function textNodes(xml) { return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join(''); }
function columnIndex(reference) {
  const letters = /^([A-Z]+)/i.exec(reference)?.[1]?.toUpperCase();
  if (!letters) throw new Error('Invalid XLSX cell reference: ' + reference);
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

export async function readXlsxFile(filePath) {
  const names = await listZipEntries(filePath);
  const available = new Set(names);
  const required = ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels'];
  if (required.some(name => !available.has(name))) throw new Error('File is not a supported XLSX workbook.');
  const workbook = (await readZipEntry(filePath, 'xl/workbook.xml')).toString('utf8');
  const rels = (await readZipEntry(filePath, 'xl/_rels/workbook.xml.rels')).toString('utf8');
  const sheet = /<sheet\b([^>]*)\/?\s*>/.exec(workbook);
  if (!sheet) throw new Error('XLSX workbook has no worksheets.');
  const relId = attrs(sheet[1])['r:id'];
  const relation = [...rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map(match => attrs(match[1])).find(item => item.Id === relId);
  if (!relation?.Target) throw new Error('XLSX worksheet relationship is missing.');
  const sheetPath = path.posix.normalize(relation.Target.startsWith('/') ? relation.Target.slice(1) : path.posix.join('xl', relation.Target));
  if (sheetPath.startsWith('../') || !available.has(sheetPath)) throw new Error('XLSX worksheet file is missing or invalid.');
  let shared = [];
  if (available.has('xl/sharedStrings.xml')) {
    const xml = (await readZipEntry(filePath, 'xl/sharedStrings.xml')).toString('utf8');
    shared = [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(match => textNodes(match[1]));
  }
  const xml = (await readZipEntry(filePath, sheetPath)).toString('utf8');
  const rows = [];
  for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const values = [];
    for (const cell of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cell[1]);
      if (!a.r) continue;
      const body = cell[2] ?? '';
      const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      let value = raw;
      if (a.t === 's') {
        const index = Number(raw);
        if (!Number.isInteger(index) || index < 0 || index >= shared.length) throw new Error('XLSX shared string index is invalid.');
        value = shared[index];
      } else if (a.t === 'inlineStr') value = textNodes(body);
      else if (a.t === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else value = decodeXml(raw);
      values[columnIndex(a.r)] = value;
    }
    values.__row = Number(attrs(row[1]).r) || rows.length + 1;
    rows.push(values);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map(value => String(value ?? '').trim());
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('XLSX headers are empty or duplicated.');
  return rows.filter(row => row.some(value => String(value ?? '').trim())).map(row => ({
    ...Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])), __row: row.__row,
  }));
}

function unzipEntryToFile(zipPath, entryName, destination, maxBytes) {
  return new Promise(async (resolve, reject) => {
    const child = spawn('unzip', ['-p', path.resolve(zipPath), entryName], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const temporary = destination + '.' + randomUUID() + '.partial';
    let stderr = '', bytes = 0, spawnError = null;
    const exitPromise = new Promise(resolveExit => {
      child.once('error', error => { spawnError = error; resolveExit(-1); });
      child.once('close', code => resolveExit(code));
    });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length); });
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) return callback(new Error('Audio entry exceeds size limit: ' + entryName));
        callback(null, chunk);
      },
    });
    try {
      await mkdir(path.dirname(destination), { recursive: true });
      await pipeline(child.stdout, limiter, createWriteStream(temporary, { flags: 'wx' }));
      const code = await exitPromise;
      if (spawnError) throw spawnError;
      if (code !== 0) throw new Error('ZIP extraction failed for ' + entryName + ': ' + (stderr.trim() || 'exit ' + code));
      if (bytes === 0) throw new Error('Empty audio file in ZIP is not supported: ' + entryName);
      await rename(temporary, destination);
      resolve(bytes);
    } catch (error) {
      child.kill('SIGKILL');
      await exitPromise;
      await rm(temporary, { force: true });
      reject(error);
    }
  });
}

export async function extractAudioZip(zipPath, destinationDirectory, options = {}) {
  const names = await listZipEntries(zipPath);
  const maxEntryBytes = options.maxEntryBytes ?? MAX_AUDIO;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL;
  let totalBytes = 0, extracted = 0;
  const root = path.resolve(destinationDirectory);
  for (const name of names) {
    if (name.endsWith('/')) continue;
    if (!AUDIO.has(path.posix.extname(name).toLowerCase())) continue;
    if (/[?*\[\]]/.test(name)) throw new Error('ZIP audio entry uses unsupported wildcard characters: ' + name);
    const destination = path.resolve(root, ...name.split('/'));
    if (!destination.startsWith(root + path.sep)) throw new Error('Unsafe ZIP destination: ' + name);
    const bytes = await unzipEntryToFile(zipPath, name, destination, maxEntryBytes);
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) throw new Error('ZIP audio content exceeds the total extraction limit.');
    extracted += 1;
  }
  if (!extracted) throw new Error('ZIP archive contains no supported audio files.');
  return { extracted, totalBytes, directory: destinationDirectory };
}
