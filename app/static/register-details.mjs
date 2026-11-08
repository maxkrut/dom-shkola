/* Static detail transport. Assignment values remain exact CSV strings. */
import { StaticJsonReader } from './static-json-reader.mjs?v=20261108-state-fixes';
import { decodeAssignmentColumns } from './register-column-codec.mjs';

const valid = (condition, text = 'Некорректный пакет подробностей') => { if (!condition) throw new Error(text); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const kind = (value, name) => valid(value?.schema === 1 && value.kind === name);
const hex = buffer => [...new Uint8Array(buffer)].map(n => n.toString(16).padStart(2, '0')).join('');
const encoder = new TextEncoder();
const schoolKey = row => row.district + '::' + String(row.school_number || '').trim().replace(/^№\s*/, '');
const addressKey = row => row.address_key || row.address_id || row.assignment_id;

function prefixes(index, max, empty = false) {
  valid(object(index));
  const keys = Object.keys(index).sort();
  for (let i = 0; i < keys.length; i++) {
    valid(new RegExp(`^[a-f0-9]{${empty ? 0 : 2},${max}}$`).test(keys[i]) && object(index[keys[i]])
      && (i === 0 || !keys[i].startsWith(keys[i - 1])), 'Некорректные границы пакетов подробностей');
  }
  return keys;
}

function reference(index, hash, { empty = false, required = false } = {}) {
  const matches = prefixes(index, hash.length, empty).filter(prefix => hash.startsWith(prefix));
  valid(matches.length <= 1 && (!required || matches.length === 1), 'Часть подробностей отсутствует');
  return matches.length ? { prefix: matches[0], record: index[matches[0]] } : null;
}

export class StaticRegisterDetails {
  constructor({ root, descriptor, districts, fetch: fetcher, maxQueryBytes = 24 * 1024 * 1024,
    maxQueryFiles = 256, maxResponseRows = 32768, maxResponseCells = 1024 * 1024, maxResponseStringBytes = 64 * 1024 * 1024 } = {}) {
    valid(descriptor?.schema === 1 && descriptor.manifest && Array.isArray(districts) && districts.length);
    valid([maxQueryBytes, maxQueryFiles, maxResponseRows, maxResponseCells, maxResponseStringBytes].every(n => Number.isSafeInteger(n) && n > 0));
    this.root = new URL(root); this.descriptor = descriptor;
    this.names = new Map(); this.slugs = new Map();
    for (const district of districts) {
      valid(typeof district.name === 'string' && district.name && /^[a-z0-9_-]+$/.test(district.slug)
        && !this.names.has(district.name) && !this.slugs.has(district.slug));
      this.names.set(district.name, district.slug); this.slugs.set(district.slug, district.name);
    }
    this.reader = new StaticJsonReader({ root: this.root, maxCacheBytes: 8 * 1024 * 1024, ...(fetcher ? { fetch: fetcher } : {}) });
    Object.assign(this, { maxQueryBytes, maxQueryFiles, maxResponseRows, maxResponseCells, maxResponseStringBytes });
  }

  async initialize() {
    this.reader.root = this.root;
    const manifest = await this.reader.read(this.descriptor.manifest);
    kind(manifest, 'school_register_static');
    valid(manifest.reference_base === 'root_manifest' && Array.isArray(manifest.capabilities));
    if (!['address', 'school', 'territory', 'region'].every(cap => manifest.capabilities.includes(cap))) throw new Error('Подробности ещё не включены в эту статическую сборку.');
    this.reader.root = new URL('.', new URL(this.descriptor.manifest.path, this.root));
    const details = await this.reader.read(manifest.details);
    kind(details, 'school_register_details');
    valid(details.reference_base === 'root_manifest' && object(details.district_names) && object(details.districts)
      && Object.keys(details.district_names).length === this.names.size && Object.keys(details.districts).length === this.slugs.size
      && [...this.names].every(([name, slug]) => details.district_names[name] === slug && details.districts[slug])
      && object(details.schools) && Object.values(details.schools).every(slug => this.slugs.has(slug)) && object(details.territories));
    prefixes(details.region_prefixes, 32);
    this.details = details;
  }

  async context(signal) {
    signal?.throwIfAborted();
    if (!this.ready) this.ready = this.initialize().catch(error => { this.ready = null; throw error; });
    await this.ready; signal?.throwIfAborted();
    return { signal, seen: new Map(), bytes: 0, rows: 0, cells: 0, strings: 0, districts: new Map(), schools: new Map() };
  }

  async read(record, query) {
    query.signal?.throwIfAborted();
    valid(record && /^[a-f0-9]{64}$/.test(record.sha256 || '') && Number.isSafeInteger(record.bytes) && record.bytes > 0);
    if (!query.seen.has(record.sha256)) {
      valid(query.seen.size < this.maxQueryFiles && query.bytes + record.bytes <= this.maxQueryBytes, 'Подробности превышают допустимый объём загрузки');
      query.seen.set(record.sha256, record.bytes); query.bytes += record.bytes;
    } else valid(query.seen.get(record.sha256) === record.bytes);
    return this.reader.read(record, { signal: query.signal });
  }

  async district(slug, query) {
    if (!query.districts.has(slug)) {
      valid(this.slugs.has(slug) && this.details.districts[slug], 'Район подробностей не найден');
      const value = await this.read(this.details.districts[slug], query);
      kind(value, 'school_register_details_district');
      valid(value.reference_base === 'root_manifest' && value.slug === slug && value.district === this.slugs.get(slug)
        && integer(value.rows) && Array.isArray(value.fields) && value.fields.length > 0 && value.fields.length <= 256
        && value.fields.every(name => typeof name === 'string' && name) && new Set(value.fields).size === value.fields.length && object(value.school_index));
      prefixes(value.addresses, 64);
      query.districts.set(slug, value);
    }
    return query.districts.get(slug);
  }

  async schoolManifest(key, query) {
    if (!query.schools.has(key)) {
      const slug = this.details.schools[key]; valid(typeof slug === 'string', 'Школа не найдена');
      const district = await this.district(slug, query), value = await this.read(district.school_index[key], query);
      kind(value, 'school_register_school');
      valid(value.reference_base === 'root_manifest' && value.school_key === key && value.district === district.district
        && integer(value.rows) && value.rows <= district.rows);
      const keys = prefixes(value.blocks, 32, true);
      valid(value.rows ? keys.length > 0 && value.accepted_empty_school !== true : value.accepted_empty_school === true && !keys.length,
        'Пустой школьный пакет не подтверждён');
      query.schools.set(key, { value, district });
    }
    return query.schools.get(key);
  }

  async block(key, school, prefix, record, query, wanted) {
    const value = await this.read(record, query);
    kind(value, 'school_register_assignment_block');
    const ids = value.row_ids, order = value.school_order;
    valid(value.school_key === key && Array.isArray(ids) && Array.isArray(order) && ids.length === value.table?.row_count
      && ids.length === order.length && new Set(ids).size === ids.length && new Set(order).size === order.length
      && ids.every(id => /^[a-f0-9]{32}$/.test(id) && id.startsWith(prefix))
      && order.every(n => integer(n) && n < school.value.rows)
      && JSON.stringify(value.table.fields) === JSON.stringify(school.district.fields));
    const positions = wanted ? ids.flatMap((id, index) => wanted.has(id) ? [index] : []) : undefined;
    const selectedCount = positions ? positions.length : ids.length;
    valid(query.rows + selectedCount <= this.maxResponseRows && query.cells + selectedCount * school.district.fields.length <= this.maxResponseCells,
      'Подробности превышают допустимый объём памяти');
    // The SHA-checked complete block is an upper bound for its table. Reusing
    // that stricter bound avoids serializing and UTF-8 copying every table again.
    const rows = decodeAssignmentColumns(value.table, positions, { encodedBytes: record.bytes, onStats: stats => {
      valid(query.strings + stats.logicalUtf8Bytes <= this.maxResponseStringBytes, 'Подробности превышают допустимый объём памяти');
      query.strings += stats.logicalUtf8Bytes;
    } });
    const chosen = positions || ids.map((_, index) => index);
    query.rows += rows.length;
    query.cells += rows.length * school.district.fields.length;
    for (const row of rows) {
      valid(row.district === school.district.district && schoolKey(row) === key, 'Пакет содержит строки другой школы');
    }
    valid(query.rows <= this.maxResponseRows && query.strings <= this.maxResponseStringBytes, 'Подробности превышают допустимый объём памяти');
    return rows.map((row, i) => ({ row, id: ids[chosen[i]], order: order[chosen[i]] }));
  }

  async selected(refs, query) {
    valid(Array.isArray(refs) && refs.length > 0 && refs.length <= this.maxResponseRows, 'Нет строк подтверждения');
    const groups = new Map(), identities = new Set();
    for (const pair of refs) {
      valid(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && /^[a-f0-9]{32}$/.test(pair[1]));
      const identity = JSON.stringify(pair); valid(!identities.has(identity), 'Повторена ссылка на одну строку'); identities.add(identity);
      if (!groups.has(pair[0])) groups.set(pair[0], new Set()); groups.get(pair[0]).add(pair[1]);
    }
    const found = new Map();
    for (const [key, ids] of groups) {
      const school = await this.schoolManifest(key, query), leaves = new Map();
      for (const id of ids) {
        const leaf = reference(school.value.blocks, id, { empty: true, required: true });
        if (!leaves.has(leaf.prefix)) leaves.set(leaf.prefix, { ...leaf, ids: new Set() });
        leaves.get(leaf.prefix).ids.add(id);
      }
      for (const leaf of leaves.values()) for (const item of await this.block(key, school, leaf.prefix, leaf.record, query, leaf.ids)) {
        found.set(JSON.stringify([key, item.id]), item.row);
      }
    }
    valid(found.size === refs.length && refs.every(pair => found.has(JSON.stringify(pair))), 'Часть строк подробностей отсутствует');
    return refs.map(pair => found.get(JSON.stringify(pair)));
  }

  async address(district, key, { signal } = {}) {
    return this.addresses(district, [key], { signal });
  }

  // A history page shares one query budget and reads each index/block once.
  async addresses(district, keys, { signal } = {}) {
    valid(typeof district === 'string' && this.names.has(district) && Array.isArray(keys)
      && keys.length > 0 && keys.length <= 20 && keys.every(key => typeof key === 'string' && key)
      && new Set(keys).size === keys.length, 'Некорректный список адресов');
    const query = await this.context(signal), data = await this.district(this.names.get(district), query);
    const indexes = new Map(), refs = new Map(), expected = new Map();
    for (const key of keys) {
      const hash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
      signal?.throwIfAborted();
      const leaf = reference(data.addresses, hash, { required: true });
      if (!indexes.has(leaf.prefix)) indexes.set(leaf.prefix, await this.read(leaf.record, query));
      const index = indexes.get(leaf.prefix);
      kind(index, 'school_register_address_index');
      valid(index.district === district && object(index.entries) && Object.hasOwn(index.entries, key) && Array.isArray(index.entries[key])
        && index.entries[key].length > 0, 'Адрес не найден');
      const local = new Set();
      for (const pair of index.entries[key]) {
        const id = JSON.stringify(pair);
        valid(!local.has(id) && (!expected.has(id) || expected.get(id) === key), 'Повторена ссылка на одну строку');
        local.add(id); refs.set(id, pair); expected.set(id, key);
      }
    }
    const pairs = [...refs.values()], rows = await this.selected(pairs, query);
    valid(rows.every((row, i) => row.district === district && addressKey(row) === expected.get(JSON.stringify(pairs[i]))), 'Подробности другого адреса');
    return rows;
  }

  async school(key, { signal } = {}) {
    valid(typeof key === 'string' && key, 'Школа не найдена');
    const query = await this.context(signal), school = await this.schoolManifest(key, query), values = [];
    valid(school.value.rows <= this.maxResponseRows && school.value.rows * school.district.fields.length <= this.maxResponseCells,
      'Подробности превышают допустимый объём памяти');
    for (const [prefix, record] of Object.entries(school.value.blocks)) values.push(...await this.block(key, school, prefix, record, query));
    values.sort((a, b) => a.order - b.order);
    valid(values.length === school.value.rows && new Set(values.map(value => value.id)).size === values.length
      && values.every((value, index) => value.order === index), 'Школьные подробности потеряли строки или порядок');
    return values.map(value => value.row);
  }

  async territory(key, { signal } = {}) {
    valid(typeof key === 'string' && key, 'Территория не найдена');
    const query = await this.context(signal); valid(Object.hasOwn(this.details.territories, key), 'Территория не найдена');
    const data = await this.read(this.details.territories[key], query); kind(data, 'school_register_territory');
    valid(data.territory_id === key && this.names.has(data.district) && typeof data.source_raw_file === 'string' && /^[a-f0-9]{64}$/.test(data.source_sha256));
    const rows = await this.selected(data.rows, query);
    valid(rows.every(row => row.district === data.district && row.source_raw_file === data.source_raw_file
      && row.source_registry_raw_sha256 === data.source_sha256 && row.record_kind === 'scan_rule' && row.is_current_source_evidence === 'yes'
      && !row.assignment_scope_type && !row.assignment_scope_value), 'Строки не подтверждают источник территории');
    return rows;
  }

  async region(id, { signal } = {}) {
    valid(/^[a-f0-9]{32}$/.test(id), 'Фрагмент документа не найден');
    const query = await this.context(signal), leaf = reference(this.details.region_prefixes, id, { required: true });
    const data = await this.read(leaf.record, query); kind(data, 'school_register_region_index');
    valid(object(data.regions) && Object.hasOwn(data.regions, id), 'Фрагмент документа не найден');
    const region = data.regions[id]; valid(region?.id === id, 'Фрагмент документа изменился');
    return region;
  }

  clear() { this.reader.clear(); }
  diagnostics() { return this.reader.diagnostics(); }
}
