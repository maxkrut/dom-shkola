/* No house inventory or document bytes are fetched before the user needs them. */
import { createOriginalSourceIndex } from './original-source-links.mjs';
const root = new URL("../../api/viewer/", import.meta.url);
const staticBootstrapMeta = globalThis.document?.querySelector?.('meta[name="school-viewer-bootstrap"]');
let bootstrapPromise;
let release = "";
let staticSearchPromise;
let staticDetailsPromise;
let staticPagesPromise;
let staticDetailsClient;
let staticPagesClient;
let originalSourceIndex;
const dataRoot = () => staticBootstrapMeta ? new URL('.', new URL(staticBootstrapMeta.getAttribute('content'), staticBootstrapMeta.baseURI || import.meta.url))
  : new URL('../../', import.meta.url);

async function request(endpoint, parameters = {}, options = {}) {
  if (staticBootstrapMeta) throw new Error("Подробности ещё не включены в эту статическую сборку.");
  const url = new URL(endpoint, root);
  for (const [key, value] of Object.entries(parameters)) if (value) url.searchParams.set(key, value);
  const response = await fetch(url, { cache: "no-cache", signal: options.signal });
  if (!response.ok) throw new Error(`Не удалось загрузить данные (${response.status})`);
  const revision = response.headers.get("X-Data-Revision");
  if (release && revision !== release) throw new Error("Данные обновились. Обновите страницу карты.");
  return response.json();
}

async function bootstrapPayload() {
  if (!staticBootstrapMeta) return request("bootstrap");
  const target = new URL(staticBootstrapMeta.getAttribute("content"), staticBootstrapMeta.baseURI || import.meta.url);
  if (target.search || target.hash) throw new Error("Некорректная ссылка начальных данных");
  const record = { path: target.pathname.split("/").at(-1), sha256: staticBootstrapMeta.getAttribute("data-sha256"),
    bytes: Number(staticBootstrapMeta.getAttribute("data-bytes")) };
  const { StaticJsonReader } = await import("./static-json-reader.mjs?v=20261108-state-fixes");
  const reader = new StaticJsonReader({ root: new URL(".", target), maxObjectBytes: 4 * 1024 * 1024, maxActiveBytes: 4 * 1024 * 1024 });
  try { return await reader.read(record); } finally { reader.clear(); }
}

function bootstrap() {
  if (!bootstrapPromise) bootstrapPromise = bootstrapPayload().then((value) => {
    const scopedPreview = value?.acceptance_scope === "district_preview_not_city_release"
      && value.city_release_accepted === false && /^local-preview:[a-f0-9]{64}$/.test(value.release_revision || "")
      && Array.isArray(value.requested_districts) && value.requested_districts.length > 0
      && value.requested_districts.length <= 18 && new Set(value.requested_districts).size === value.requested_districts.length
      && value.requested_districts.every(name => typeof name === "string" && name.trim())
      && Array.isArray(value.districts) && value.districts.length === value.requested_districts.length
      && new Set(value.districts.map(d => d?.name)).size === value.districts.length
      && value.districts.every(d => value.requested_districts.includes(d?.name));
    if (value?.schema !== 1 || (value.acceptance_scope === "district_preview_not_city_release" && !scopedPreview)
        || (!scopedPreview && value.districts?.length !== 18) || !Array.isArray(value.schools)
        || !/^(?:local-preview:)?[a-f0-9]{64}$/.test(value.release_revision || "")) throw new Error("Некорректные данные карты");
    if (Object.hasOwn(value, "register_data") && (value.register_data?.schema !== 1
        || !/^[a-f0-9]{64}$/.test(value.register_data.manifest?.sha256 || "")
        || !Number.isSafeInteger(value.register_data.manifest?.bytes) || value.register_data.manifest.bytes < 1
        || typeof value.register_data.manifest?.path !== "string")) throw new Error("Некорректные данные поиска");
    if (Object.hasOwn(value, 'source_pages') && (value.source_pages?.schema !== 1
        || !/^[a-f0-9]{64}$/.test(value.source_pages.manifest?.sha256 || '')
        || !Number.isSafeInteger(value.source_pages.manifest?.bytes) || value.source_pages.manifest.bytes < 1
        || typeof value.source_pages.manifest?.path !== 'string')) throw new Error('Некорректные данные документов');
    originalSourceIndex = Object.hasOwn(value, 'original_sources') ? createOriginalSourceIndex(value.original_sources) : null;
    release = value.release_revision;
    return value;
  }).catch((error) => { bootstrapPromise = null; throw error; });
  return bootstrapPromise;
}

async function staticSearch(value) {
  if (!staticSearchPromise) staticSearchPromise = import("./register-search-client.mjs?v=20261108-state-fixes").then(({ createStaticSearchClient }) => {
    const client = createStaticSearchClient(value.register_data, { root: dataRoot(), districts: value.districts });
    globalThis.addEventListener?.("pagehide", () => client.dispose());
    return client;
  }).catch(error => { staticSearchPromise = null; throw error; });
  return staticSearchPromise;
}

function releaseSearchIdle() {
  staticSearchPromise?.then(client => client.releaseIdle()).catch(() => {});
}

async function staticDetails(value) {
  if (!staticDetailsPromise) staticDetailsPromise = import('./register-details.mjs?v=20261108-state-fixes').then(({ StaticRegisterDetails }) => {
    staticDetailsClient = new StaticRegisterDetails({ root: dataRoot(), descriptor: value.register_data, districts: value.districts });
    return staticDetailsClient;
  })
    .catch(error => { staticDetailsPromise = null; throw error; });
  return staticDetailsPromise;
}

async function staticPages(value) {
  if (!value.source_pages) throw new Error('Страницы документов ещё не включены в эту сборку.');
  if (!staticPagesPromise) staticPagesPromise = Promise.all([import('./document-pages.mjs?v=20261108-state-fixes'), import('./document-page-pool.mjs')])
    .then(([{ StaticDocumentPages }, { PageAssetPool }]) => {
    const client = new StaticDocumentPages({ root: dataRoot(), descriptor: value.source_pages,
      poolFactory: options => new PageAssetPool({ ...options, maxEntries: 1 }) });
    staticPagesClient = client;
    globalThis.addEventListener?.('pagehide', () => client.clear());
    return client;
  }).catch(error => { staticPagesPromise = null; throw error; });
  return staticPagesPromise;
}

async function detail(operation, parameters, options = {}) {
  const value = await bootstrap(); releaseSearchIdle();
  if (staticBootstrapMeta) {
    if (!value.register_data) throw new Error('Подробности ещё не включены в эту статическую сборку.');
    const client = await staticDetails(value);
    return operation === 'address' ? client.address(parameters.district, parameters.key, options) : client[operation](parameters.key, options);
  }
  return request(operation, parameters, options);
}

export const viewerApi = {
  bootstrap,
  isStaticDelivery: Boolean(staticBootstrapMeta),
  originalDocument(rawFile, sha256 = '', page = 0) { return originalSourceIndex?.(rawFile, sha256, page); },
  releaseIdleResources() {
    if (!staticBootstrapMeta) return;
    releaseSearchIdle();
    staticDetailsClient?.clear();
    // Called after card removal: no surviving SVG may keep the old URL alive.
    return staticPagesClient?.clear();
  },
  async search(query, district, signal) {
    const value = await bootstrap();
    if (Object.hasOwn(value, "register_data")) return (await staticSearch(value)).search(query, district, signal);
    return request("search", { q: query, district }, { signal });
  },
  async suggest(query, district, signal) {
    const value = await bootstrap();
    if (Object.hasOwn(value, "register_data")) return (await staticSearch(value)).search(query, district, signal, true, true);
    const groups = district ? await Promise.all([request("search", { q: query, district }, { signal }), request("search", { q: query }, { signal })])
      : [await request("search", { q: query }, { signal })];
    const seen = new Set();
    return groups.flat().filter(row => { const key = row.district+'|'+row.address_key; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 12);
  },
  address: (district, key, options) => detail('address', { district, key }, options),
  async addresses(district, keys, options = {}) {
    const value = await bootstrap(); releaseSearchIdle();
    if (staticBootstrapMeta) return (await staticDetails(value)).addresses(district, keys, options);
    const rows = [];
    for (const key of keys) rows.push(...await detail('address', { district, key }, options));
    return rows;
  },
  school: (key, options) => detail('school', { key }, options),
  territory: (key, options) => detail('territory', { key }, options),
  async documentRegion(id, options = {}) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Фрагмент документа не найден');
    const value = await bootstrap();
    if (staticBootstrapMeta) return (await staticDetails(value)).region(id, options);
    const response = await fetch(new URL(`../../api/document-regions/${id}`, import.meta.url), { signal: options.signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`Не удалось загрузить фрагмент (${response.status})`);
    return response.json();
  },
  async documentPage(region, options = {}) {
    const value = await bootstrap();
    if (!staticBootstrapMeta) throw new Error('Статическая страница документа недоступна.');
    return (await staticPages(value)).acquire(region, options);
  },
  async areas(district) { await bootstrap(); return request("areas", { district }); },
};
