/* Search semantics match ViewerStore. The Worker owns I/O, release and cache limits. */
export const NORMALIZER = "viewer_search_text_unicode61_v1";
export const RANKER = "sqlite_fts5_bm25_single_column_v1";

const gardenWords = value => String(value || "").toLowerCase().replaceAll("ё", "е")
  .match(/[а-яa-z0-9]+/gu)?.join(" ") || "";
const schoolSet = values => [...new Set(values.map(gardenWords).filter(Boolean))].sort();

/** Keep official garden claims searchable even when no map boundary exists. */
export function sourceOnlyGardenFeatures(followups, mapped) {
  const groups = new Map();
  for (const claim of followups || []) {
    if (claim?.status !== 'source_preserved_without_accepted_map_boundary'
        || !claim.district || !claim.name || !claim.school_number || !claim.source_raw_file
        || !/^[a-f0-9]{64}$/.test(claim.claim_id || '')
        || !/^[a-f0-9]{64}$/.test(claim.source_fragment_id || '')) continue;
    const sameMapped = (mapped || []).some(feature => feature?.properties?.district === claim.district
      && gardenWords(feature.properties.name) === gardenWords(claim.name));
    if (sameMapped) continue;
    const key = JSON.stringify([claim.district, gardenWords(claim.name), claim.source_raw_file]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(claim);
  }
  return [...groups.values()].map(claims => {
    claims.sort((a,b) => a.claim_id.localeCompare(b.claim_id));
    const first = claims[0];
    return {type:'Feature', geometry:null, properties:{territory_id:`source-only:${first.claim_id}`,
      address_unit:'garden_territory', district:first.district, name:first.name, municipality:'', point:null,
      status:'source_only_unlocated', boundary_note:'Точное положение и граница территории не определены',
      source_raw_file:first.source_raw_file,
      school_numbers:[...new Set(claims.map(item => item.school_number))].sort(),
      source_fragment_ids:[...new Set(claims.map(item => item.source_fragment_id))].sort(),
      source_claims:claims.map(item => ({school_number:item.school_number,source_fragment_id:item.source_fragment_id}))}};
  });
}

/** Hide only house suggestions already represented by one unambiguous garden. */
export function suppressGardenHouseDuplicates(rows, gardens, knownGardens = gardens) {
  const visible = new Set(gardens);
  const scopes = knownGardens.map(garden => {
    const props = garden?.properties || {};
    const quoted = String(props.name || "").match(/[«"]([^»"]+)[»"]/u)?.[1];
    const name = gardenWords(quoted || props.name).replace(/^(?:снт|сдт|ст|садоводство)\s+/u, "");
    return { garden, district: props.district, municipality: gardenWords(props.municipality), name,
      schools: schoolSet(Array.isArray(props.school_numbers) ? props.school_numbers : []) };
  }).filter(scope => scope.district && scope.name.length >= 3);
  return rows.filter(row => {
    const schools = schoolSet(String(row.current_school_numbers || "").split("|"));
    if (!schools.length) return true;
    const addresses = [row.canonical_address, ...String(row.address_aliases || "").split("|")];
    const names = new Set(addresses.flatMap(address => String(address || "").split(/[>,]/u).map(segment => {
      const tokens = gardenWords(segment).split(" ");
      if (!tokens.some(token => ["снт", "сдт", "садоводство"].includes(token))) return "";
      return tokens.filter(token => !["снт", "сдт", "садоводство", "тер", "территория"].includes(token)).join(" ");
    })).filter(Boolean));
    const localities = String(row.canonical_address || "").split(/[>,]/u).map(segment => {
      const match = gardenWords(segment).match(/^(.+) (?:п|пос|поселок|г|город|дер|деревня)$/u);
      return match?.[1] === "санкт петербург" ? "" : match?.[1] || "";
    }).filter(Boolean);
    let matches = scopes.filter(scope => row.district === scope.district && names.has(scope.name));
    if (localities.length) matches = matches.filter(scope => localities.includes(scope.municipality));
    if (matches.length !== 1 || !visible.has(matches[0].garden)) return true;
    return JSON.stringify(schools) !== JSON.stringify(matches[0].schools);
  });
}

export function searchText(value) {
  let text = String(value || "").toLowerCase().replaceAll("ё", "е")
    .replace(/([0-9])([а-яa-z])(?=[^а-яa-z0-9]|$)/g, "$1 $2")
    .replace(/([0-9а-яa-z])([кс])(?=[0-9])/g, "$1 $2 ");
  const substitutions = [
    ["улица|ул\\.?", "ул"], ["проезд|пр\\s*-?\\s*д\\.?", "прд"],
    ["проспект|просп\\.?|пр\\.?", "пр"], ["переулок|пер\\.?", "пер"],
    ["набережная|наб\\.?", "наб"], ["шоссе|ш\\.?", "ш"],
    ["бульвар|бул\\.?|б\\s*-\\s*р", "бл"], ["площадь|пл\\.?", "пл"],
    ["аллея|ал\\.?", "ал"], ["корпус|корп\\.?|к\\.?", "к"],
    ["строение|стр\\.?|сооружение|соор\\.?|с\\.?", "с"], ["литера|лит\\.?|л\\.?", "л"]
  ];
  for (const [pattern, replacement] of substitutions) {
    text = text.replace(new RegExp(`(?<![а-яa-z0-9])(?:${pattern})(?=[^а-яa-z0-9]|$)`, "g"), ` ${replacement} `);
  }
  return text.replace(/(?<![а-яa-z0-9])(?:дом|д\.?)[\s,;№]*(?=[0-9])/g, " ").match(/[а-яa-z0-9]+/g)?.join(" ") || "";
}

export function queryTokens(query) {
  if (typeof query !== "string" || [...query].length > 200) throw new Error("Поисковый запрос слишком длинный или некорректный");
  const tokens = searchText(query).split(" ").filter(Boolean);
  return tokens.length < 2 || !tokens.some(token => /[0-9]/.test(token)) ? [] : tokens.slice(0, 16);
}

// Typeahead is deliberately separate from the complete, SQLite-compatible search.
// Generic address words alone would fan out into the whole register.
export function suggestionTokens(query) {
  if (typeof query !== "string" || [...query].length > 200) throw new Error("Поисковый запрос слишком длинный или некорректный");
  const generic = new Set(["ул", "пр", "прд", "пер", "наб", "ш", "бл", "пл", "ал", "дом", "д", "к", "с", "л", "снт", "санкт", "петербург"]);
  const tokens = searchText(query).split(" ").filter(token => token && !generic.has(token));
  return tokens.some(token => /[а-яa-z]{3}/.test(token)) ? tokens.slice(0, 16) : [];
}

function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }

export function prefixPostings(prefix, parts) {
  if (!/^[а-яa-z0-9]+$/.test(prefix)) throw new Error("Некорректный поисковый префикс");
  const result = new Map(), terms = new Set();
  for (const part of parts) {
    if (part?.schema !== 1 || !part.terms || typeof part.terms !== "object" || Array.isArray(part.terms)) throw new Error("Некорректный поисковый пакет");
    for (const [term, rows] of Object.entries(part.terms)) {
      if (!term.startsWith(prefix)) continue;
      if (terms.has(term) || !Array.isArray(rows)) throw new Error("Поисковые пакеты пересекаются или повреждены");
      terms.add(term);
      const seen = new Set();
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 3) throw new Error("Некорректная поисковая запись");
        const [id, frequency, length] = row;
        if (!Number.isSafeInteger(id) || id < 0 || !positiveInteger(frequency) || !positiveInteger(length)
            || frequency > length || seen.has(id)) throw new Error("Некорректная частота поискового слова");
        seen.add(id);
        const previous = result.get(id);
        if (previous && previous.length !== length) throw new Error("Несовместимые версии поискового адреса");
        const combined = (previous?.frequency || 0) + frequency;
        if (combined > length) throw new Error("Частота поисковой фразы превышает длину адреса");
        result.set(id, { frequency: combined, length });
      }
    }
  }
  return result;
}

// SQLite BINARY compares UTF-8. Valid Unicode has the same code-point order;
// localeCompare and UTF-16 ordering differ for some strings and must not substitute.
export function binaryTextCompare(a, b) {
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    if (i === a.length) return -1;
    if (j === b.length) return 1;
    const left = a.codePointAt(i), right = b.codePointAt(j);
    if (left !== right) return left < right ? -1 : 1;
    i += left > 0xffff ? 2 : 1;
    j += right > 0xffff ? 2 : 1;
  }
  return 0;
}

export function rankCandidates(groups, stats, cardFor, limit = 80) {
  if (!Array.isArray(groups) || groups.length > 16 || groups.some(group => !(group instanceof Map))) throw new Error("Некорректные поисковые фразы");
  if (!groups.length || groups.some(group => !group.size)) return [];
  if (!positiveInteger(stats.documents) || !Number.isFinite(stats.average_length) || stats.average_length <= 0
      || groups.some(group => group.size > stats.documents) || !Number.isInteger(limit)) throw new Error("Некорректная поисковая статистика");
  const frequencies = stats.phrase_document_frequencies || groups.map(group => group.size);
  if (!Array.isArray(frequencies) || frequencies.length !== groups.length
      || frequencies.some((value, i) => !positiveInteger(value) || value < groups[i].size || value > stats.documents)) throw new Error("Некорректная частота поисковой фразы");
  const count = Math.min(Math.max(limit, 1), 100), heap = [];
  const compare = (a, b) => a.rank - b.rank || binaryTextCompare(a.canonical_address, b.canonical_address) || a.ordinal - b.ordinal;
  const weights = frequencies.map(frequency => {
    const idf = Math.log((stats.documents - frequency + 0.5) / (frequency + 0.5));
    return idf <= 0 ? 1e-6 : idf;
  });
  const smallest = groups.reduce((best, group) => group.size < best.size ? group : best);
  for (const [id, first] of smallest) {
    if (!groups.every(group => group.has(id))) continue;
    const length = first.length;
    if (!Number.isSafeInteger(id) || id < 0 || !positiveInteger(length)) throw new Error("Некорректный поисковый адрес");
    let rank = 0;
    for (let i = 0; i < groups.length; i++) {
      const occurrence = groups[i].get(id);
      if (occurrence.length !== length || !positiveInteger(occurrence.frequency) || occurrence.frequency > length) throw new Error("Несовместимые версии поискового адреса");
      rank -= weights[i] * (occurrence.frequency * 2.2) / (occurrence.frequency + 1.2 * (0.25 + 0.75 * length / stats.average_length));
    }
    const card = cardFor(id);
    if (!card || !Number.isSafeInteger(card.ordinal) || card.ordinal < 0 || typeof card.canonical_address !== "string") throw new Error("Подпись поискового адреса отсутствует");
    const item = { id, rank, ordinal: card.ordinal, canonical_address: card.canonical_address };
    // A max heap retains only the best K; broad queries never allocate/sort N result objects.
    if (heap.length < count) {
      heap.push(item);
      for (let i = heap.length - 1; i > 0;) {
        const parent = (i - 1) >> 1;
        if (compare(heap[i], heap[parent]) <= 0) break;
        [heap[i], heap[parent]] = [heap[parent], heap[i]]; i = parent;
      }
    } else if (compare(item, heap[0]) < 0) {
      heap[0] = item;
      for (let i = 0;;) {
        const left = 2 * i + 1, right = left + 1;
        let worst = i;
        if (left < heap.length && compare(heap[left], heap[worst]) > 0) worst = left;
        if (right < heap.length && compare(heap[right], heap[worst]) > 0) worst = right;
        if (worst === i) break;
        [heap[i], heap[worst]] = [heap[worst], heap[i]]; i = worst;
      }
    }
  }
  return heap.sort(compare);
}
