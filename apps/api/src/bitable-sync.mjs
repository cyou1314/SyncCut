// Feishu returns record fields keyed by their current names, not field IDs.
// Resolve saved IDs against a fresh field listing on every sync so renames work.
export function resolveMapping(mapping, fields) {
  const byId = new Map(fields.map(f => [f.field_id, f]));
  const result = {};
  for (const [key, id] of Object.entries(mapping)) {
    const field = byId.get(id);
    if (!field) throw new Error(`Mapped field missing: ${key}`);
    result[key] = field.field_name;
  }
  for (const key of ['name', 'kind', 'attachment']) if (!result[key]) throw new Error(`Missing mapping: ${key}`);
  return result;
}
const kinds = { '音乐':'music', '音效':'sfx', '配音':'voice', '环境音':'ambience' };
function text(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v : (v.text ?? '')).join('');
  throw new Error('Invalid text field');
}
function number(value, key) {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}`);
  return value;
}
// Preserve only the documented permission parameter, never arbitrary URLs or credentials.
export function attachmentExtra(file) {
  if (typeof file.url !== 'string') return null;
  let url;
  try { url = new URL(file.url); } catch { throw new Error('Invalid attachment URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'open.feishu.cn' || url.pathname !== `/open-apis/drive/v1/medias/${encodeURIComponent(file.file_token)}/download`) throw new Error('Invalid attachment URL');
  const values = url.searchParams.getAll('extra');
  if (values.length > 1) throw new Error('Invalid attachment extra');
  return values[0] ?? null;
}
export function mapRecord(record, mapping) {
  const f = record.fields ?? {};
  const value = key => mapping[key] ? f[mapping[key]] : null;
  const name = text(value('name'))?.trim();
  const kind = kinds[text(value('kind'))];
  const files = value('attachment');
  if (!record.record_id || !name || !kind) throw new Error('Record requires ID, name and supported kind');
  if (!Array.isArray(files) || files.length !== 1 || !files[0]?.file_token) throw new Error('Record requires exactly one audio attachment');
  const file = files[0];
  const track = text(value('track'));
  if (track && !['A1','A2','A3','A4'].includes(track)) throw new Error('Invalid track');
  const timing = {};
  for (const key of ['start','inPoint','outPoint','volume','fadeIn','fadeOut']) timing[key] = number(value(key), key);
  if (timing.inPoint != null && timing.outPoint != null && timing.outPoint <= timing.inPoint) throw new Error('Invalid source range');
  const tags = value('tags');
  if (tags != null && (!Array.isArray(tags) || tags.some(t => typeof t !== 'string'))) throw new Error('Invalid tags');
  const modified = value('modified');
  if (modified != null && (typeof modified !== 'number' || !Number.isFinite(modified) || !Number.isFinite(new Date(modified).getTime()))) throw new Error('Invalid modified timestamp');
  return { recordId: record.record_id, name, kind, project: text(value('project')), episode: text(value('episode')), scene: text(value('scene')), shot: text(value('shot')), notes: text(value('notes')), tags: tags ?? [], timing: {...timing, track}, attachment: {fileToken: file.file_token, name: file.name ?? null, mimeType: file.type ?? null, size: number(file.size, 'attachment size'), extra: attachmentExtra(file)}, modified: modified == null ? null : new Date(modified).toISOString() };
}

export async function listAll(fetchPage) {
  let pageToken; const seen = new Set(), items = [];
  do {
    const page = await fetchPage(pageToken);
    if (!Array.isArray(page.items)) throw new Error('Invalid Feishu page');
    items.push(...page.items);
    if (!page.has_more) break;
    if (!page.page_token || seen.has(page.page_token)) throw new Error('Invalid or repeated page token');
    seen.add(page.page_token); pageToken = page.page_token;
  } while (true);
  return items;
}

export async function inspectConnection(client, appToken, tableId) {
  const base = await client.getBase({appToken});
  const tables = await listAll(pageToken => client.listTables({appToken, pageToken}));
  if (!tableId) return {base, tables, fields: []};
  if (!tables.some(t => t.table_id === tableId)) throw new Error('Target table is not accessible');
  const fields = await listAll(pageToken => client.listFields({appToken, tableId, pageToken}));
  return {base, tables, fields};
}

// Caller supplies an authenticated, tenant-scoped connection and persistence adapter.
// Never infer deletions from a scan: records may move during pagination.
export async function fullSync({client, connection, store}) {
  const {appToken, tableId, fieldMapping} = connection;
  const {fields} = await inspectConnection(client, appToken, tableId);
  const mapping = resolveMapping(fieldMapping, fields);
  const seen = new Set(); let pageToken; let imported = 0, duplicates = 0, failed = 0; const errors = [];
  const pages = new Set();
  do {
    const page = await client.listRecords({appToken, tableId, pageToken});
    if (!Array.isArray(page.items)) throw new Error('Invalid Feishu record page');
    for (const record of page.items) {
      if (record.record_id && seen.has(record.record_id)) { duplicates++; continue; }
      if (record.record_id) seen.add(record.record_id);
      try { await store.upsert(mapRecord(record, mapping)); imported++; }
      catch (error) { failed++; errors.push({recordId: record.record_id ?? null, reason: error.message.startsWith('Record ') || error.message.startsWith('Invalid ') ? error.message : 'Unable to persist record'}); }
    }
    if (!page.has_more) break;
    if (!page.page_token || pages.has(page.page_token)) throw new Error('Invalid or repeated page token');
    pages.add(page.page_token); pageToken = page.page_token;
  } while (true);
  return {imported, duplicates, failed, errors};
}
