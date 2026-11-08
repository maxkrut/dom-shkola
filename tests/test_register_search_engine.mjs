import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { StaticRegisterSearch } from "../app/static/register-search-engine.mjs";
import { NORMALIZER, RANKER } from "../app/static/register-search-core.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/sqlite-oracle-fixture.json", import.meta.url)));
const digest = value => createHash("sha256").update(value).digest("hex"), bucket = value => digest(String(value)).slice(0, 2);
const fields = ["id", "ordinal", "district", "address_key", "canonical_address", "address_aliases", "current_school_numbers", "tokens"];

function packet({ dropPosting = false, dropCard = false, badVersion = false, dropPrefixDf = false, dropShortDf = false, dropDistrictDf = false, dropShortDistrictDf = false, twoDistricts = false } = {}) {
  const files = new Map(), posts = new Map(), cards = new Map(), prefixes = new Map(), shards = new Map(), requests = [];
  const put = value => {
    const bytes = Buffer.from(JSON.stringify(value)), sha256 = digest(bytes), path = `objects/${sha256}.json`;
    files.set("register/" + path, bytes); return { path, sha256, bytes: bytes.length };
  };
  for (const [word, occurrences] of Object.entries(fixture.terms)) {
    const key = bucket(word); if (!posts.has(key)) posts.set(key, {});
    posts.get(key)[word] = dropPosting && word === "мира" ? occurrences.slice(1) : occurrences;
    for (let n = 1; n <= word.length; n++) {
      const prefix = word.slice(0, n); if (!prefixes.has(prefix)) prefixes.set(prefix, new Set());
      for (const [id] of occurrences) prefixes.get(prefix).add(id);
    }
    const prefix = word.slice(0, 2); if (!shards.has(prefix)) shards.set(prefix, { schema: 1, kind: "school_register_search_lexicon", terms: [], prefix_df: {} });
    shards.get(prefix).terms.push([word, [["test", key]]]);
  }
  for (const [prefix, ids] of prefixes) if (prefix.length >= 2) shards.get(prefix.slice(0, 2)).prefix_df[prefix] = [["test", ids.size]];
  if (dropPrefixDf) delete shards.get("ми").prefix_df["мира"];
  if (dropDistrictDf || dropShortDistrictDf || twoDistricts) {
    for (const shard of shards.values()) {
      for (const entry of shard.terms) entry[1].push(["other", entry[1][0][1]]);
      for (const [prefix, entries] of Object.entries(shard.prefix_df)) if (!(dropDistrictDf && prefix === "мира")) entries.push(["other", entries[0][1]]);
    }
  }
  for (const card of fixture.cards) {
    const key = bucket(card.id); if (!cards.has(key)) cards.set(key, []);
    if (dropCard && card.ordinal === 1) continue;
    const tokens = Object.entries(fixture.terms).flatMap(([word, records]) => records.filter(row => row[0] === card.id).map(row => [word, row[1]]));
    cards.get(key).push(fields.map(field => field === "tokens" ? tokens : card[field]));
  }
  const refs = map => Object.fromEntries([...map].map(([key, value]) => [key, put(value)]));
  const district = { schema: 1, kind: "school_register_search_district", reference_base: "root_manifest", district: "Тестовый", slug: "test",
    normalizer: NORMALIZER, ranker: RANKER, documents: fixture.documents, token_occurrences: fixture.token_occurrences,
    average_length: fixture.average_length, postings_bits: 8, cards_bits: 8,
    postings: refs(new Map([...posts].map(([key, terms]) => [key, { schema: 1, terms }]))),
    cards: refs(new Map([...cards].map(([key, rows]) => [key, { schema: 1, fields, rows }]))) };
  const router = { schema: 1, kind: "school_register_search_router", reference_base: "root_manifest", prefixes: refs(shards),
    short_prefix_df: Object.fromEntries([...prefixes].filter(([prefix]) => prefix.length === 1).map(([prefix, ids]) => [prefix, [["test", ids.size]]])) };
  if (dropShortDf) delete router.short_prefix_df["м"];
  let districts = { test: put(district) }, districtNames = [{ name: "Тестовый", slug: "test" }];
  if (dropDistrictDf || dropShortDistrictDf || twoDistricts) {
    districts.other = put({ ...district, slug: "other", district: "Другой",
      cards: refs(new Map([...cards].map(([key, rows]) => [key, { schema: 1, fields, rows: rows.map(row => row.map((v, i) => i === 2 ? "Другой" : v)) }]))) });
    districtNames.push({ name: "Другой", slug: "other" });
    for (const [prefix, entries] of Object.entries(router.short_prefix_df)) if (!(dropShortDistrictDf && prefix === "м")) entries.push(["other", entries[0][1]]);
  }
  const search = { schema: 1, kind: "school_register_search", reference_base: "root_manifest", normalizer: badVersion ? "unknown" : NORMALIZER,
    ranker: RANKER, postings_bits: 8, cards_bits: 8, district_order: Object.keys(districts), districts, router: put(router) };
  const manifest = { schema: 1, kind: "school_register_static", reference_base: "root_manifest", capabilities: ["search"], search: put(search) };
  const bytes = Buffer.from(JSON.stringify(manifest)); files.set("register/manifest.json", bytes);
  const options = { root: new URL("https://example.test/project/"), districts: districtNames,
    descriptor: { schema: 1, manifest: { path: "register/manifest.json", sha256: digest(bytes), bytes: bytes.length } },
    fetch: async (url, { signal } = {}) => {
      signal?.throwIfAborted(); const path = new URL(url).pathname.replace("/project/", ""); requests.push(path);
      return files.has(path) ? new Response(files.get(path)) : new Response("missing", { status: 404 });
    } };
  return { options, requests };
}

test("actual static-manifest graph preserves all independent SQLite fixture results", async () => {
  const p = packet(), engine = new StaticRegisterSearch(p.options), byOrdinal = new Map(fixture.cards.map(card => [card.ordinal, card]));
  for (const item of fixture.cases) {
    const { rows, measurement } = await engine.search(item.query, "Тестовый");
    const expected = item.expected.map(({ ordinal }) => {
      const { district, address_key, canonical_address, address_aliases, current_school_numbers } = byOrdinal.get(ordinal);
      return { district, address_key, canonical_address, address_aliases, current_school_numbers };
    });
    assert.deepEqual(rows, expected, item.query);
    assert(measurement.bytes <= 4 * 1024 * 1024);
  }
  assert(p.requests.every(path => path.startsWith("register/")), "no Python API, CSV or complete inventory fallback");
});

test('preferred district suggestions put its matches first and keep other districts without changing strict search', async () => {
  const engine = new StaticRegisterSearch(packet({twoDistricts:true}).options);
  const {rows,measurement} = await engine.search('Мир', 'Другой', {suggest:true,preferDistrict:true});
  const firstForeign = rows.findIndex(row=>row.district !== 'Другой');
  assert(firstForeign > 0);
  assert(rows.slice(firstForeign).every(row=>row.district === 'Тестовый'));
  assert(rows.length <= 12);
  assert.equal(new Set(rows.map(row=>row.district+'|'+row.address_key)).size, rows.length);
  assert(measurement.bytes <= 4 * 1024 * 1024);
  const strict = (await engine.search('Мира 10', 'Другой')).rows;
  assert(strict.length > 0); assert(strict.every(row=>row.district === 'Другой'));
  assert.deepEqual((await engine.search('Мир', 'Неизвестный', {suggest:true,preferDistrict:true})).rows, []);
});

test("a rehashed omitted posting or missing result card fails instead of returning fewer addresses", async () => {
  for (const options of [{ dropPosting: true }, { dropCard: true }]) {
    const engine = new StaticRegisterSearch(packet(options).options);
    await assert.rejects(engine.search("Мира 10", "Тестовый"), /потерял|отсутствуют/);
  }
});

test("a rehashed missing prefix statistic cannot become an empty successful search", async () => {
  await assert.rejects(new StaticRegisterSearch(packet({ dropPrefixDf: true }).options).search("Мира 10"), /префикса неполон/);
  await assert.rejects(new StaticRegisterSearch(packet({ dropShortDf: true }).options).search("М 10"), /префикса неполон/);
  await assert.rejects(new StaticRegisterSearch(packet({ dropDistrictDf: true }).options).search("Мира 10"), /префикса неполон/);
  await assert.rejects(new StaticRegisterSearch(packet({ dropShortDistrictDf: true }).options).search("М 10"), /префикса неполон/);
  const engine = new StaticRegisterSearch(packet().options);
  assert.deepEqual((await engine.search("Мираж 10")).rows, [], "an absent word remains a valid empty result within a present lexicon shard");
});

test("resource and version errors are explicit; invalid or unknown-scope queries fetch nothing", async () => {
  const p = packet(), engine = new StaticRegisterSearch({ ...p.options, maxQueryBytes: 1 });
  assert.deepEqual((await engine.search("улица")).rows, []);
  assert.deepEqual((await engine.search("Мира 10", "Неизвестный")).rows, []);
  assert.equal(p.requests.length, 0);
  await assert.rejects(engine.search("Мира 10"), error => error.code === "SEARCH_TOO_BROAD");
  await assert.rejects(new StaticRegisterSearch(packet({ badVersion: true }).options).search("Мира 10"), /не поддерживается/);
});

test('partial address suggestions are bounded, real, deterministic and keep strict search semantics', async () => {
  const p = packet(), engine = new StaticRegisterSearch(p.options);
  assert.deepEqual((await engine.search('Мира')).rows, []);
  const first = await engine.search('Мир', '', {suggest:true});
  assert(first.rows.length > 0 && first.rows.length <= 8);
  for (const row of first.rows) {
    const original = fixture.cards.find(card => card.address_key === row.address_key);
    assert(original && Object.entries(fixture.terms).some(([token, postings]) => token.startsWith('мир') && postings.some(([id]) => id === original.id)));
  }
  assert.deepEqual((await engine.search('Мир', '', {suggest:true})).rows, first.rows);
  const before = p.requests.length;
  assert.deepEqual((await engine.search('улица', '', {suggest:true})).rows, []);
  assert.equal(p.requests.length, before);
  for (const options of [{dropPosting:true}, {dropCard:true}]) {
    await assert.rejects(new StaticRegisterSearch(packet(options).options).search('Мира 10', '', {suggest:true}), /потерял|отсутствуют/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(engine.search('Мир', '', {suggest:true, signal:controller.signal}), {name:'AbortError'});
});
