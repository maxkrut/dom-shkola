import { NORMALIZER, RANKER, queryTokens, suggestionTokens, prefixPostings, rankCandidates } from "./register-search-core.mjs";
import { StaticJsonReader } from "./static-json-reader.mjs?v=20261108-state-fixes";

const CARD_FIELDS = ["id", "ordinal", "district", "address_key", "canonical_address", "address_aliases", "current_school_numbers", "tokens"];
const valid = (condition, message = "Некорректные поисковые данные") => { if (!condition) throw new Error(message); };
const integer = value => Number.isSafeInteger(value) && value > 0;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const checkKind = (value, kind) => valid(value?.schema === 1 && value.kind === kind);
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");

export class StaticRegisterSearch {
  constructor({ root, descriptor, districts, fetch: fetcher, maxQueryBytes = 4 * 1024 * 1024, maxQueryFiles = 192 } = {}) {
    valid(descriptor?.schema === 1 && descriptor.manifest && Array.isArray(districts) && districts.length);
    valid(integer(maxQueryBytes) && integer(maxQueryFiles));
    this.root = new URL(root); this.descriptor = descriptor;
    this.names = new Map(); this.slugs = new Map();
    for (const district of districts) {
      valid(typeof district.name === "string" && district.name && /^[a-z0-9_-]+$/.test(district.slug)
        && !this.names.has(district.name) && !this.slugs.has(district.slug));
      this.names.set(district.name, district.slug); this.slugs.set(district.slug, district.name);
    }
    this.reader = new StaticJsonReader({ root: this.root, ...(fetcher ? { fetch: fetcher } : {}) });
    this.maxQueryBytes = maxQueryBytes; this.maxQueryFiles = maxQueryFiles;
  }

  async initialize() {
    const manifest = await this.reader.read(this.descriptor.manifest);
    checkKind(manifest, "school_register_static");
    valid(manifest.reference_base === "root_manifest" && Array.isArray(manifest.capabilities) && manifest.capabilities.includes("search"));
    this.reader.root = new URL(".", new URL(this.descriptor.manifest.path, this.root));
    const search = await this.reader.read(manifest.search);
    checkKind(search, "school_register_search"); this.checkVersion(search);
    valid(search.reference_base === "root_manifest" && object(search.districts) && Array.isArray(search.district_order)
      && search.district_order.length === this.slugs.size && new Set(search.district_order).size === this.slugs.size
      && Object.keys(search.districts).length === this.slugs.size && search.district_order.every(slug => this.slugs.has(slug) && search.districts[slug]));
    const router = await this.reader.read(search.router);
    checkKind(router, "school_register_search_router");
    valid(router.reference_base === "root_manifest" && object(router.prefixes) && object(router.short_prefix_df));
    this.searchManifest = search; this.router = router;
  }

  checkVersion(value) {
    valid(value.normalizer === NORMALIZER && value.ranker === RANKER && value.postings_bits === 8 && value.cards_bits === 8,
      "Версия поисковых данных не поддерживается");
  }

  charge(ref, query) {
    query.signal?.throwIfAborted();
    valid(ref && /^[a-f0-9]{64}$/.test(ref.sha256 || "") && integer(ref.bytes));
    if (query.seen.has(ref.sha256)) { valid(query.seen.get(ref.sha256) === ref.bytes); return; }
    if (query.bytes + ref.bytes > this.maxQueryBytes || query.seen.size >= this.maxQueryFiles) {
      const error = new Error("Уточните район или адрес, чтобы сузить поиск.");
      error.code = "SEARCH_TOO_BROAD"; throw error;
    }
    query.seen.set(ref.sha256, ref.bytes); query.bytes += ref.bytes;
  }

  async readMany(refs, query) {
    for (const ref of refs) this.charge(ref, query);
    const result = [];
    for (let i = 0; i < refs.length; i += 6) {
      result.push(...await Promise.all(refs.slice(i, i + 6).map(ref => this.reader.read(ref, { signal: query.signal }))));
    }
    return result;
  }

  dfs(values) {
    valid(values === undefined || Array.isArray(values));
    const result = new Map();
    for (const entry of values || []) {
      valid(Array.isArray(entry) && entry.length === 2 && this.slugs.has(entry[0]) && integer(entry[1]) && !result.has(entry[0]));
      result.set(...entry);
    }
    return result;
  }

  lexiconRefs(token) {
    const keys = token.length >= 2 ? [token.slice(0, 2)] : Object.keys(this.router.prefixes).filter(key => key.startsWith(token));
    return keys.map(key => this.router.prefixes[key]).filter(Boolean);
  }

  async lexicons(token, query) {
    const values = await this.readMany(this.lexiconRefs(token), query);
    for (const value of values) {
      checkKind(value, "school_register_search_lexicon"); valid(Array.isArray(value.terms) && object(value.prefix_df));
    }
    return values;
  }

  locations(token, lexicons) {
    const locations = new Map();
    for (const lexicon of lexicons) for (const entry of lexicon.terms) {
      valid(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && Array.isArray(entry[1]));
      if (!entry[0].startsWith(token)) continue;
      for (const location of entry[1]) {
        valid(Array.isArray(location) && location.length === 2 && this.slugs.has(location[0]) && /^[a-f0-9]{2}$/.test(location[1]));
        if (!locations.has(location[0])) locations.set(location[0], new Set());
        locations.get(location[0]).add(location[1]);
      }
    }
    return locations;
  }

  async routes(token, slug, district, query) {
    const buckets = this.locations(token, await this.lexicons(token, query)).get(slug);
    valid(buckets?.size > 0, "Индекс поискового префикса неполон");
    return [...buckets].sort().map(bucket => { valid(district.postings[bucket]); return district.postings[bucket]; });
  }

  async prefixFrequencies(token, query) {
    const lexicons = await this.lexicons(token, query), locations = this.locations(token, lexicons);
    const df = this.dfs(token.length === 1 ? this.router.short_prefix_df[token] : lexicons[0]?.prefix_df[token]);
    valid(df.size === locations.size && [...locations.keys()].every(slug => df.has(slug)), "Индекс поискового префикса неполон");
    return df;
  }

  cost(refs, query) {
    const unique = new Map(refs.filter(ref => !query.seen.has(ref.sha256)).map(ref => [ref.sha256, ref]));
    return [...unique.values()].reduce((total, ref) => total + ref.bytes + 32768, 0);
  }

  async cardBuckets(ids, query) {
    const unique = new Set();
    const values = [...ids];
    for (let i = 0; i < values.length; i += 64) {
      query.signal?.throwIfAborted();
      await Promise.all(values.slice(i, i + 64).map(async id => {
        if (!query.buckets.has(id)) {
          valid(Number.isSafeInteger(id) && id >= 0 && id < 2 ** 52);
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(id)));
          query.signal?.throwIfAborted(); query.buckets.set(id, hex(digest).slice(0, 2));
        }
        unique.add(query.buckets.get(id));
      }));
    }
    return [...unique].sort();
  }

  async districtResults(slug, tokens, frequencies, query) {
    const [district] = await this.readMany([this.searchManifest.districts[slug]], query);
    checkKind(district, "school_register_search_district"); this.checkVersion(district);
    valid(district.reference_base === "root_manifest" && district.slug === slug && district.district === this.slugs.get(slug)
      && integer(district.documents) && integer(district.token_occurrences) && district.average_length === district.token_occurrences / district.documents
      && object(district.postings) && object(district.cards));
    for (const token of tokens) valid(frequencies.get(token).get(slug) <= district.documents);
    const ordered = [...new Set(tokens)].sort((a, b) => frequencies.get(a).get(slug) - frequencies.get(b).get(slug));
    const groups = new Map();
    const postings = async token => {
      if (!groups.has(token)) {
        const parts = await this.readMany(await this.routes(token, slug, district, query), query);
        const group = prefixPostings(token, parts);
        valid(group.size === frequencies.get(token).get(slug), "Поисковый индекс потерял часть адресов");
        groups.set(token, group);
      }
      return groups.get(token);
    };
    const anchor = await postings(ordered[0]), candidates = new Set(anchor.keys());
    const cardRefs = async () => (await this.cardBuckets(candidates, query)).map(bucket => { valid(district.cards[bucket]); return district.cards[bucket]; });
    for (const token of ordered.slice(1)) {
      if (!candidates.size) return [];
      if (query.suggest) {
        const match = await postings(token);
        for (const id of candidates) if (!match.has(id)) candidates.delete(id);
        continue;
      }
      const cardsCost = this.cost(await cardRefs(), query);
      if (this.cost(this.lexiconRefs(token), query) >= cardsCost) continue;
      const refs = await this.routes(token, slug, district, query);
      if (this.cost(refs, query) >= cardsCost) continue;
      const match = await postings(token);
      for (const id of candidates) if (!match.has(id)) candidates.delete(id);
    }
    if (!candidates.size) return [];
    if (query.suggest) {
      // Rank postings before reading labels: at most eight card buckets, rather
      // than all buckets containing a popular street. Stable IDs break ties;
      // complete search retains its original alphabetical/SQLite ordering.
      const best = rankCandidates(tokens.map(token => groups.get(token)), {
        ...district, phrase_document_frequencies: tokens.map(token => frequencies.get(token).get(slug))
      }, id => ({ ordinal: id, canonical_address: "" }), 8);
      candidates.clear();
      for (const { id } of best) candidates.add(id);
    }
    const cards = new Map();
    for (const part of await this.readMany(await cardRefs(), query)) {
      valid(part?.schema === 1 && JSON.stringify(part.fields) === JSON.stringify(CARD_FIELDS) && Array.isArray(part.rows));
      for (const row of part.rows) {
        valid(Array.isArray(row) && row.length === CARD_FIELDS.length);
        if (!candidates.has(row[0])) continue;
        const card = Object.fromEntries(CARD_FIELDS.map((field, i) => [field, row[i]]));
        valid(!cards.has(card.id) && Number.isSafeInteger(card.ordinal) && card.ordinal >= 0 && card.district === district.district
          && [card.address_key, card.canonical_address, card.address_aliases, card.current_school_numbers].every(value => typeof value === "string")
          && Array.isArray(card.tokens));
        cards.set(card.id, card);
      }
    }
    valid(cards.size === candidates.size, "Подписи части найденных адресов отсутствуют");
    const matches = new Map(ordered.map(token => [token, new Map()]));
    for (const [id, card] of cards) {
      let length = 0; const seen = new Set(), counts = new Map(ordered.map(token => [token, 0]));
      for (const entry of card.tokens) {
        valid(Array.isArray(entry) && entry.length === 2 && /^[а-яa-z0-9]+$/.test(entry[0]) && integer(entry[1]) && !seen.has(entry[0]));
        seen.add(entry[0]); length += entry[1];
        for (const token of ordered) if (entry[0].startsWith(token)) counts.set(token, counts.get(token) + entry[1]);
      }
      valid(length === anchor.get(id).length, "Поисковые пакеты относятся к разным версиям адреса");
      for (const token of ordered) if (groups.has(token)) valid((groups.get(token).get(id)?.frequency || 0) === counts.get(token), "Поисковые слова и подпись адреса расходятся");
      if (ordered.some(token => !counts.get(token))) continue;
      for (const token of ordered) matches.get(token).set(id, { frequency: counts.get(token), length });
    }
    const ranks = rankCandidates(tokens.map(token => matches.get(token)), {
      ...district, phrase_document_frequencies: tokens.map(token => frequencies.get(token).get(slug))
    }, id => cards.get(id));
    return ranks.map(({ id }) => {
      const { district, address_key, canonical_address, address_aliases, current_school_numbers } = cards.get(id);
      return { district, address_key, canonical_address, address_aliases, current_school_numbers };
    });
  }

  async search(text, district = "", { signal, suggest = false, preferDistrict = false } = {}) {
    signal?.throwIfAborted();
    valid(typeof district === "string");
    const tokens = suggest ? suggestionTokens(text) : queryTokens(text);
    if (!tokens.length || district && !this.names.has(district)) return { rows: [], measurement: { files: 0, bytes: 0 } };
    if (!this.ready) this.ready = this.initialize().catch(error => { this.ready = null; throw error; });
    await this.ready; signal?.throwIfAborted();
    const query = { signal, suggest, seen: new Map(), bytes: 0, buckets: new Map() }, frequencies = new Map();
    for (const token of new Set(tokens)) {
      const df = await this.prefixFrequencies(token, query); frequencies.set(token, df);
      if (!df.size) return { rows: [], measurement: { files: query.seen.size, bytes: query.bytes } };
    }
    const preferred = suggest && preferDistrict && district ? this.names.get(district) : '';
    const selected = preferred ? [preferred, ...this.searchManifest.district_order.filter(slug => slug !== preferred)]
      : district ? [this.names.get(district)] : this.searchManifest.district_order;
    const groups = [], preferredRows = [];
    const suggestionLimit = preferred ? 12 : 8;
    let found = 0;
    for (const slug of selected) {
      if (tokens.every(token => frequencies.get(token).has(slug))) {
        const group = await this.districtResults(slug, tokens, frequencies, query);
        if (slug === preferred) preferredRows.push(...group); else groups.push(group);
        found += group.length;
      }
      if (suggest && found >= suggestionLimit) break;
    }
    const rows = [...preferredRows];
    for (let i = 0; i < Math.max(0, ...groups.map(group => group.length)) && rows.length < 100; i++) {
      for (const group of groups) if (group[i] && rows.length < 100) rows.push(group[i]);
    }
    return { rows: suggest ? rows.slice(0, suggestionLimit) : rows, measurement: { files: query.seen.size, bytes: query.bytes, cache: this.reader.diagnostics() } };
  }
}
