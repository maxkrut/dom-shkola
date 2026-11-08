import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { searchText, queryTokens, suggestionTokens, prefixPostings, rankCandidates, binaryTextCompare,
  suppressGardenHouseDuplicates, sourceOnlyGardenFeatures } from "../app/static/register-search-core.mjs";

test('unlocated official garden claims remain searchable without inventing a map point', () => {
  const claim = {status:'source_preserved_without_accepted_map_boundary',district:'Московский',
    name:'Коллективное огородничество «Западный»',school_number:'353',source_raw_file:'raw/districts/moskovsky/source.pdf',
    claim_id:'a'.repeat(64),source_fragment_id:'b'.repeat(64)};
  const other = {...claim, school_number:'354',claim_id:'c'.repeat(64),source_fragment_id:'d'.repeat(64)};
  const result = sourceOnlyGardenFeatures([claim,other,{...claim,status:'unlocated_in_accepted_map_snapshot'}],[]);
  assert.equal(result.length,1);
  assert.deepEqual(result[0].properties.school_numbers,['353','354']);
  assert.equal(result[0].geometry,null);
  assert.equal(result[0].properties.point,null);
  assert.equal(result[0].properties.source_claims.length,2);
  const alreadyMapped = {properties:{district:'Московский',name:claim.name}};
  assert.deepEqual(sourceOnlyGardenFeatures([claim,other],[alreadyMapped]),[]);
  assert.deepEqual(sourceOnlyGardenFeatures([{...claim,source_fragment_id:'invalid'}],[]),[]);
});

test('garden suggestions suppress only matching houses with the same school set', () => {
  const garden = {properties:{name:'СНТ «Кикенка»', district:'Петродворцовый', municipality:'Стрельна',
    school_numbers:['413','421','Петергофская гимназия императора Александра II']}};
  const row = {district:'Петродворцовый',
    canonical_address:'Санкт-Петербург г. > Стрельна п. > Кикенка тер. СНТ > 5-й пр-д, д. 1, литера А',
    current_school_numbers:'№413 | №421 | №Петергофская гимназия императора Александра II'};
  assert.deepEqual(suppressGardenHouseDuplicates([row], [garden]), []);
  for (const exception of [
    {...row, current_school_numbers:'№413 | №421'},
    {...row, current_school_numbers:''},
    {...row, district:'Другой'},
    {...row, canonical_address:row.canonical_address.replace('Стрельна', 'Петергоф')},
    {...row, canonical_address:row.canonical_address.replace('Кикенка тер.', 'Кикенка Новая тер.')},
  ]) assert.deepEqual(suppressGardenHouseDuplicates([exception], [garden]), [exception]);
  assert.deepEqual(suppressGardenHouseDuplicates([row], []), [row], 'A direct house search remains available');
  assert.deepEqual(suppressGardenHouseDuplicates([row], [garden,garden]), [row], 'Ambiguous gardens are not merged');
  const withoutLocality = {...row, canonical_address:'Санкт-Петербург, Кикенка тер. СНТ, 2-й пр-д, дом 3 с 1'};
  assert.deepEqual(suppressGardenHouseDuplicates([withoutLocality], [garden]), []);
  const unknownHomonym = {properties:{name:'СНТ Кикенка',district:'Петродворцовый'}};
  assert.deepEqual(suppressGardenHouseDuplicates([withoutLocality], [garden], [garden,unknownHomonym]), [withoutLocality]);
});

test('typeahead accepts a street prefix without a house and rejects citywide generic input', () => {
  assert.deepEqual(suggestionTokens('Будап'), ['будап']);
  assert.deepEqual(suggestionTokens('ул. Ёлоч'), ['елоч']);
  assert.deepEqual(suggestionTokens('Будапештская 24'), ['будапештская', '24']);
  for (const input of ['', 'ул', 'улица', 'проспект', 'санкт-петербург', '12', 'ми']) assert.deepEqual(suggestionTokens(input), []);
  assert.throws(() => suggestionTokens('а'.repeat(201)), /длинный/);
});

test("house qualifiers, ё/е and abbreviation boundaries follow the current search normalizer", () => {
  const cases = [
    ["г. Санкт-Петербург, улица Мира, дом 10к2 лит. А", "г санкт петербург ул мира 10 к 2 л а"],
    ["Ёлочная ул. д.6А", "елочная ул 6 а"], ["10к2с3", "10 к 2 с 3"],
    ["пр-д Мира 2, строение 1", "прд мира 2 с 1"], ["б-р Ленина, 2/4", "бл ленина 2 4"],
    ["Литературная 4", "литературная 4"]
  ];
  for (const [input, expected] of cases) assert.equal(searchText(input), expected, input);
  for (const query of ["улица", "1", "* NEAR()", '" OR --']) assert.deepEqual(queryTokens(query), []);
  assert.deepEqual(queryTokens("Мира 10к2"), ["мира", "10", "к", "2"]);
  assert.equal(queryTokens("1 " + "слово ".repeat(20)).length, 16);
  assert.throws(() => queryTokens("1".repeat(201)), /длинный/);
});

test("prefix phrase frequency sums terms, while document frequency counts their union", () => {
  const parts = [{ schema: 1, terms: { ленинский: [[1, 2, 8], [2, 1, 6]], ленина: [[1, 1, 8], [3, 2, 5]], мира: [[4, 1, 5]] } }];
  const matches = prefixPostings("лен", parts);
  assert.equal(matches.size, 3);
  assert.deepEqual(matches.get(1), { frequency: 3, length: 8 });
  assert.equal(matches.has(4), false);
  assert.throws(() => prefixPostings("лен", [...parts, ...parts]), /пересекаются/);
  assert.throws(() => prefixPostings("лен", [{ schema: 1, terms: { лен: [[1, 2, 1]] } }]), /частота/);
  assert.throws(() => prefixPostings("лен", [{ schema: 1, terms: { лен: [[1, 1, 2], [1, 1, 2]] } }]), /частота/);
});

test("bounded ranking preserves binary and ordinal ties, repeated phrases and AND", () => {
  const terms = { schema: 1, terms: { мира: [[1, 1, 4], [2, 1, 4], [3, 1, 4], [4, 1, 4]], "1": [[1, 1, 4], [2, 1, 4], [3, 1, 4]] } };
  const cards = new Map([[1, { ordinal: 3, canonical_address: "Б" }], [2, { ordinal: 2, canonical_address: "А" }], [3, { ordinal: 1, canonical_address: "А" }]]);
  const groups = [prefixPostings("мира", [terms]), prefixPostings("1", [terms])], stats = { documents: 4, average_length: 4 };
  const result = rankCandidates(groups, stats, id => cards.get(id), 2);
  assert.deepEqual(result.map(row => row.id), [3, 2]);
  const repeated = rankCandidates([...groups, groups[1]], stats, id => cards.get(id));
  assert.deepEqual(repeated.map(row => row.id), [3, 2, 1]);
  assert(repeated[0].rank < result[0].rank);
  assert.throws(() => rankCandidates(groups, stats, () => null), /отсутствует/);
  assert(binaryTextCompare("\ue000", "😀") < 0, "UTF-8 BINARY ordering must not become UTF-16 or locale ordering");
});

test("top K matches exhaustive ordering on a broad deterministic corpus", () => {
  const size = 10000, phrases = [new Map(), new Map()], cards = new Map();
  for (let id = 1; id <= size; id++) {
    const length = 10 + id % 19;
    phrases[0].set(id, { frequency: 1 + id % 3, length });
    phrases[1].set(id, { frequency: 1 + id % 2, length });
    cards.set(id, { ordinal: id, canonical_address: `Адрес ${size - id}` });
  }
  const actual = rankCandidates(phrases, { documents: size, average_length: 19 }, id => cards.get(id), 80);
  const expected = [...cards].map(([id, card]) => {
    const length = phrases[0].get(id).length;
    const rank = phrases.reduce((score, phrase) => {
      const f = phrase.get(id).frequency;
      return score - 1e-6 * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * length / 19));
    }, 0);
    return { id, rank, ...card };
  }).sort((a, b) => a.rank - b.rank || binaryTextCompare(a.canonical_address, b.canonical_address) || a.ordinal - b.ordinal).slice(0, 80);
  assert.deepEqual(actual.map(row => row.id), expected.map(row => row.id));
});

test("rarest-anchor candidate plans keep the global prefix union DF for BM25", () => {
  const all = [new Map(), new Map()];
  for (let id = 1; id <= 50; id++) all[0].set(id, { frequency: 1, length: 5 });
  for (const id of [1, 61, 62, 63, 64, 65, 66, 67, 68, 69]) all[1].set(id, { frequency: 1, length: 5 });
  const card = () => ({ ordinal: 1, canonical_address: "Адрес" }), stats = { documents: 100, average_length: 5 };
  const expected = rankCandidates(all, stats, card);
  const candidates = all.map(group => new Map([[1, group.get(1)]]));
  assert.deepEqual(rankCandidates(candidates, { ...stats, phrase_document_frequencies: [50, 10] }, card), expected);
  assert.notEqual(rankCandidates(candidates, stats, card)[0].rank, expected[0].rank);
  assert.throws(() => rankCandidates(all, { ...stats, phrase_document_frequencies: [1, 10] }, card), /частота/);
});

test("result order and BM25 match an independently generated SQLite Unicode61 oracle", () => {
  const bytes = readFileSync(new URL("./fixtures/sqlite-oracle-fixture.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "7694298e9ed64bf190a3494291a4eef50aefd6f2aa452b8e0bd1155da48811eb");
  const fixture = JSON.parse(bytes), cards = new Map(fixture.cards.map(card => [card.id, card]));
  assert.equal(fixture.kind, "independent_sqlite_search_fixture");
  for (const { query, tokens, expected } of fixture.cases) {
    assert.deepEqual(queryTokens(query), tokens, query);
    const groups = tokens.map(token => prefixPostings(token, [{ schema: 1, terms: fixture.terms }]));
    const actual = rankCandidates(groups, fixture, id => cards.get(id));
    assert.deepEqual(actual.map(row => row.ordinal), expected.map(row => row.ordinal), query);
    for (let i = 0; i < actual.length; i++) {
      assert(Math.abs(actual[i].rank - expected[i].rank) <= 1e-12 * Math.max(1, Math.abs(expected[i].rank)), `${query}: SQLite rank ${i}`);
    }
  }
});
