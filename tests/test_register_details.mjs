import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StaticRegisterDetails } from '../app/static/register-details.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fields = ['district', 'school_number', 'address_key', 'assignment_id', 'is_current', 'record_kind', 'is_current_source_evidence',
  'source_raw_file', 'source_registry_raw_sha256', 'source_fragment_id', 'assignment_scope_type', 'assignment_scope_value', 'lat', 'lon', 'note'];
const common = { district: 'Тестовый', address_key: 'дом1', assignment_id: 'same-assignment-id', is_current: 'yes', record_kind: 'scan_literal',
  is_current_source_evidence: 'yes', source_raw_file: 'raw/test.pdf', source_registry_raw_sha256: 'a'.repeat(64),
  source_fragment_id: 'fragment1', assignment_scope_type: '', assignment_scope_value: '', lat: '59.00000', lon: '30.00000', note: '' };
const a = { ...common, school_number: '1' }, history = { ...a, is_current: 'no', note: 'История: 01.00' };
const b = { ...common, school_number: '2' }, rule = { ...b, address_key: 'rule', record_kind: 'scan_rule', is_current: 'no' };
const uid = n => String(n).repeat(32), key1 = 'Тестовый::1', key2 = 'Тестовый::2', emptyKey = 'all_school_empty';
const root = 'https://example.test/project/';
const regionId = 'c'.repeat(32);

// Hand-authored wire graph; the real 193-response integration uses a separate native SQL witness.
function packet(damage = '') {
  const files = new Map(), calls = [], blocks = [];
  const put = value => {
    const bytes = Buffer.from(JSON.stringify(value)), hash = sha(bytes), ref = { path: `objects/${hash}.json`, sha256: hash, bytes: bytes.length };
    files.set('register/' + ref.path, bytes); return ref;
  };
  const block = (key, ids, rows) => {
    const order = ids.map((_, i) => i);
    if (damage === 'missing-row' && key === key1) { ids = ids.slice(0, 1); rows = rows.slice(0, 1); }
    if (damage === 'duplicate-order' && key === key1) order[1] = 0;
    if (damage === 'foreign-school' && key === key1) rows = rows.map(row => ({ ...row, school_number: '99' }));
    const table = { schema: 1, kind: 'school_register_assignment_columns', fields, row_count: rows.length,
      columns: fields.map(name => ({ values: rows.map(row => row[name] ?? '') })) };
    const ref = put({ schema: 1, kind: 'school_register_assignment_block', school_key: key, row_ids: ids, school_order: order.slice(0, rows.length), table });
    blocks.push(ref); return ref;
  };
  const school1 = put({ schema: 1, kind: 'school_register_school', reference_base: 'root_manifest', district: 'Тестовый', school_key: key1, rows: 2,
    blocks: { '': block(key1, [uid(1), uid(2)], [a, history]) } });
  const school2 = put({ schema: 1, kind: 'school_register_school', reference_base: 'root_manifest', district: 'Тестовый', school_key: key2, rows: 2,
    blocks: { '': block(key2, [uid(3), uid(4)], [b, rule]) } });
  const empty = put({ schema: 1, kind: 'school_register_school', reference_base: 'root_manifest', district: 'Тестовый', school_key: emptyKey, rows: 0,
    blocks: {}, ...(damage === 'unproven-empty' ? {} : { accepted_empty_school: true }) });
  const addressHash = sha('дом1'), addressRefs = [[key2, uid(3)], [key1, uid(1)], [key1, uid(2)]];
  if (damage === 'wrong-address') addressRefs[0] = [key2, uid(4)];
  const addressIndex = put({ schema: 1, kind: 'school_register_address_index', district: 'Тестовый', entries: { 'дом1': addressRefs, rule: [[key2, uid(4)]] } });
  const addressLeaves = { [addressHash.slice(0, 2)]: addressIndex, [sha('rule').slice(0, 2)]: addressIndex };
  if (damage === 'overlapping-prefix') addressLeaves[addressHash.slice(0, 3)] = addressIndex;
  const district = put({ schema: 1, kind: 'school_register_details_district', reference_base: 'root_manifest', district: 'Тестовый', slug: 'test',
    rows: 4, fields, school_index: { [key1]: school1, [key2]: school2, [emptyKey]: empty }, addresses: addressLeaves });
  const territory = put({ schema: 1, kind: 'school_register_territory', territory_id: 'garden', district: 'Тестовый', source_raw_file: 'raw/test.pdf',
    source_sha256: damage === 'wrong-territory-sha' ? 'b'.repeat(64) : 'a'.repeat(64), rows: [[key2, uid(4)]] });
  const region = { id: damage === 'wrong-region' ? 'd'.repeat(32) : regionId, available: false, source_raw_file: 'raw/test.pdf' };
  const regionIndex = put({ schema: 1, kind: 'school_register_region_index', regions: { [regionId]: region } });
  const details = put({ schema: 1, kind: 'school_register_details', reference_base: 'root_manifest', district_names: { 'Тестовый': 'test' },
    districts: { test: district }, schools: { [key1]: 'test', [key2]: 'test', [emptyKey]: 'test' },
    territories: { garden: territory }, region_prefixes: { cc: regionIndex } });
  const manifest = Buffer.from(JSON.stringify({ schema: 1, kind: 'school_register_static', reference_base: 'root_manifest',
    capabilities: ['search', 'address', 'school', 'territory', 'region'], details }));
  files.set('register/manifest.json', manifest);
  const fetcher = async (url, options = {}) => {
    const relative = new URL(url).pathname.replace('/project/', ''); calls.push({ relative, signal: options.signal });
    return files.has(relative) ? new Response(files.get(relative)) : new Response('missing', { status: 404 });
  };
  const options = { root, descriptor: { schema: 1, manifest: { path: 'register/manifest.json', sha256: sha(manifest), bytes: manifest.length } },
    districts: [{ name: 'Тестовый', slug: 'test' }], fetch: fetcher };
  return { options, files, calls, blocks, region };
}

test('address order, all history, duplicate assignment IDs, exact coordinate strings and empty named schools survive', async () => {
  const p = packet(), client = new StaticRegisterDetails(p.options);
  assert.equal(p.calls.length, 0, 'detail transport is lazy');
  assert.deepEqual(await client.address('Тестовый', 'дом1'), [b, a, history]);
  assert.deepEqual(await client.school(key1), [a, history]);
  assert.deepEqual(await client.school(emptyKey), [], 'stable ID is resolved explicitly without a district-prefix guess');
  assert.deepEqual(await client.territory('garden'), [rule]);
  assert.deepEqual(await client.region(regionId), p.region);
  assert(p.calls.every(call => call.relative.startsWith('register/')));
  assert(client.diagnostics().cacheBytesEstimate <= 8 * 1024 * 1024);
  client.clear(); assert.equal(client.diagnostics().cacheBytesEstimate, 0);
});

test('address history batches preserve every school and source, share blocks, and reject partial or ambiguous requests', async () => {
  const p = packet(), client = new StaticRegisterDetails(p.options);
  assert.deepEqual(await client.addresses('Тестовый', ['дом1', 'rule']), [b, a, history, rule]);
  const reads = p.calls.map(call => call.relative);
  for (const block of p.blocks) assert.equal(reads.filter(path => path.endsWith(block.path)).length, 1);
  await assert.rejects(client.addresses('Тестовый', ['дом1', 'дом1']), /список/);
  await assert.rejects(client.addresses('Тестовый', []), /список/);
  await assert.rejects(client.addresses('Тестовый', Array.from({length:21}, (_, i) => String(i))), /список/);
  await assert.rejects(client.addresses('Тестовый', ['дом1', 'unknown']), /отсутствует|не найден/);
  await assert.rejects(new StaticRegisterDetails(packet('wrong-address').options).addresses('Тестовый', ['дом1', 'rule']), /ссылк|другого адреса/);
});

test('rehashed missing, duplicated and foreign rows fail instead of returning a partial successful response', async () => {
  for (const damage of ['missing-row', 'duplicate-order', 'foreign-school', 'overlapping-prefix']) {
    const client = new StaticRegisterDetails(packet(damage).options);
    await assert.rejects(client.address('Тестовый', 'дом1'), /отсутствует|пакет|границ|школ/i, damage);
  }
  await assert.rejects(new StaticRegisterDetails(packet('missing-row').options).school(key1), /потеряли/);
  await assert.rejects(new StaticRegisterDetails(packet('wrong-address').options).address('Тестовый', 'дом1'), /другого адреса/);
});

test('unknown scope, unproven empty school, wrong territory source and mismatched region remain errors', async () => {
  const client = new StaticRegisterDetails(packet().options);
  await assert.rejects(client.school('unknown'), /не найдена/);
  await assert.rejects(client.territory('unknown'), /не найдена/);
  await assert.rejects(client.region('f'.repeat(32)), /отсутствует/);
  await assert.rejects(new StaticRegisterDetails(packet('unproven-empty').options).school(emptyKey), /не подтверждён/);
  await assert.rejects(new StaticRegisterDetails(packet('wrong-territory-sha').options).territory('garden'), /источник территории/);
  await assert.rejects(new StaticRegisterDetails(packet('wrong-region').options).region(regionId), /изменился/);
});

test('failed object can be retried without accepting earlier partial data', async () => {
  const p = packet(); let fail = true;
  const client = new StaticRegisterDetails({ ...p.options, fetch: async (url, options) => {
    if (url.includes(p.blocks[0].sha256) && fail) { fail = false; return new Response('temporary', { status: 503 }); }
    return p.options.fetch(url, options);
  } });
  await assert.rejects(client.address('Тестовый', 'дом1'), /503/);
  assert.equal(client.diagnostics().activeRequests, 0);
  assert.deepEqual(await client.address('Тестовый', 'дом1'), [b, a, history]);
});

test('late aborted response cannot complete a selection and later fresh selection still works', async () => {
  const p = packet(), controller = new AbortController(); let resolveBlocked, ready;
  const blocked = new Promise(resolve => { ready = resolve; }); let block = true;
  const client = new StaticRegisterDetails({ ...p.options, fetch: async (url, options) => {
    if (block && url.includes(p.blocks[0].sha256)) { ready(); return new Promise(resolve => { resolveBlocked = resolve; }); }
    return p.options.fetch(url, options);
  } });
  const pending = client.address('Тестовый', 'дом1', { signal: controller.signal });
  await blocked; controller.abort(); block = false;
  resolveBlocked(new Response(p.files.get('register/' + p.blocks[0].path)));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(client.diagnostics().activeRequests, 0);
  assert.deepEqual(await client.address('Тестовый', 'дом1'), [b, a, history]);
});

test('request and expanded response limits fail explicitly, never as empty or truncated rows', async () => {
  for (const limits of [{ maxQueryBytes: 1 }, { maxResponseRows: 1 }, { maxResponseCells: 1 }, { maxResponseStringBytes: 1 }]) {
    await assert.rejects(new StaticRegisterDetails({ ...packet().options, ...limits }).school(key1), /объём/);
  }
});

test('verified whole-block byte bound avoids reserializing its table and stays conservative', async () => {
  const p=packet(),client=new StaticRegisterDetails(p.options),record=p.blocks[0];
  const value=JSON.parse(p.files.get('register/'+record.path)),school={value:{rows:2},district:{district:'Тестовый',fields}};
  client.read=async()=>value;
  const query=()=>({rows:0,cells:0,strings:0}),stringify=JSON.stringify;
  JSON.stringify=(input,...args)=>{assert.notEqual(input,value.table,'The verified table must not be serialized again');return stringify(input,...args);};
  try{
    const rows=await client.block(key1,school,'',record,query());
    assert.equal(rows.length,2);assert.deepEqual(rows.map(item=>item.row),[a,history]);
    await assert.rejects(client.block(key1,school,'',{...record,bytes:512*1024+1},query()),/объём/);
  }finally{JSON.stringify=stringify;}
});

test('actual Python-produced projection subset preserves all 82 columns, source4, history and exact region metadata', async () => {
  const folder = new URL('./fixtures/details-fixture-v1/', import.meta.url);
  const bytes = readFileSync(new URL('fixture.json', folder));
  assert.equal(sha(bytes), '48e87b9605155e8f2eaa9fb597f609f1ba42b9e81c2b5cd7411f75ceb66bd0e0');
  const fixture = JSON.parse(bytes), files = new Map();
  assert.equal(fixture.kind, 'actual_detail_projection_subset_fixture_not_release');
  for (const record of fixture.files) {
    const data = readFileSync(new URL('register/' + record.path, folder));
    assert.equal(data.length, record.bytes); assert.equal(sha(data), record.sha256);
    files.set('register/' + record.path, data);
  }
  const client = new StaticRegisterDetails({ root, descriptor: fixture.descriptor, districts: fixture.districts,
    fetch: async url => { const name = new URL(url).pathname.replace('/project/', ''); assert(files.has(name)); return new Response(files.get(name)); } });
  const matrix = (rows, names) => { for (const row of rows) assert.deepEqual(Object.keys(row), names); return rows.map(row => names.map(name => row[name])); };
  for (const item of fixture.addresses) assert.deepEqual(matrix(await client.address(item.district, item.key), item.fields), item.matrix);
  for (const [key, item] of Object.entries(fixture.schools)) assert.deepEqual(matrix(await client.school(key), item.fields), item.matrix);
  for (const [id, region] of Object.entries(fixture.regions)) assert.deepEqual(await client.region(id), region);
  assert.deepEqual(await client.school(fixture.named_empty_school), []);
});
