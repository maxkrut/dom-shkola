const DATA_ROOT = "../../data/spb_school_catchments/";
const DISTRICT_CONFIG_URL = "../../config/districts.json";
const DEFAULT_DISTRICT = "";
const VIEWER_API = window.schoolViewerApi || null;
let VIEWER_BOOTSTRAP = null;
let SCHOOL_AREA_TILE_PACKAGE = null;
const loadedSchoolDetails = new Set();
const territorySourceDetails = new Map();
const territorySourceCacheLimit = 24;
const detailPackages = new Map();
const detailPackageWeights = new Map();
const detailCacheBudget = 24 * 1024 * 1024;
let sharedComparisonCache = null;
const areaScopeData = new Map();
const areaScopeErrors = new Map();
let comparisonSchoolKey = '';
let returnAreaContext = null;
let returnSchoolContext = '';
let returnGardenContext = '';
async function ensureAreaScopeData(district, options = {}) {
  if (!areaScopeData.has(district)) {
    areaScopeErrors.delete(district);
    let data;
    try { data=await window.schoolAreaTileModule.loadAreaScopes(VIEWER_BOOTSTRAP, district, options); }
    catch (error) { if (error.name!=='AbortError') areaScopeErrors.set(district,error.message); throw error; }
    areaScopeData.set(district,data);
    while (areaScopeData.size > 2) areaScopeData.delete(areaScopeData.keys().next().value);
  }
  options.signal?.throwIfAborted();
  return areaScopeData.get(district);
}
const sourceDataPayloads = new WeakMap();
let addressSearchRequest = null;
let addressSearchWork = null;
let addressSearchKey = "";
let detailRequestController = null;

function cancelDetailRequest() {
  detailRequestController?.abort();
  detailRequestController = null;
  if (state.schoolDetailNotice?.status === 'loading' && state.schoolDetailNotice.token === state.selectionRequestToken
      && state.selectedSchoolKey === state.schoolDetailNotice.key) state.selectedSchoolKey = '';
  state.schoolDetailNotice = null;
  state.addressDetailNotice = null;
  addressSearchRequest?.abort();
  addressSearchRequest = null;
  addressSearchWork = null;
  addressSearchKey = "";
}

function beginDetailRequest() {
  cancelDetailRequest();
  detailRequestController = new AbortController();
  return detailRequestController.signal;
}
let cancelPendingSuggestions = () => {};
const ALL_DISTRICTS_ADDRESS_MIN_ZOOM = 12;
let DISTRICT_SLUGS = {};
let DISTRICT_VIEWER_CATALOG = null;
const CATALOG_SHA_BY_URL = new Map();
const DISTRICT_VIEWER_CATALOG_URL = "../../data/districts/viewer_catalog.json";
const DISTRICT_REVIEW_DECISION_FILES = {
  "Фрунзенский": "../../data/districts/frunzensky/current_review_decisions.csv"
};
const DISTRICT_COORDINATE_REVIEW_FILES = {
  "Фрунзенский": "../../data/districts/frunzensky/current_coordinate_review_sources.csv"
};

// Vary both hue and lightness. Neighbouring district boundaries were used to
// place visually distant colours next to each other.
const districtColors = [
  "#29BBC2", "#4A429F", "#235EC4", "#2A8A38", "#A76416", "#C64025",
  "#9C75D6", "#45A6E3", "#007FA8", "#83B735", "#E0AC18", "#007F58",
  "#14B979", "#8D8D18", "#972D26", "#008980", "#7547BA", "#F27726"
];
// Stable identity: loading/filtering order must never change a district colour.
const districtColorNames = [
  "Адмиралтейский", "Василеостровский", "Выборгский", "Калининский", "Кировский", "Колпинский",
  "Красногвардейский", "Красносельский", "Кронштадтский", "Курортный", "Московский", "Невский",
  "Петроградский", "Петродворцовый", "Приморский", "Пушкинский", "Фрунзенский", "Центральный"
];

const schoolTypeStyles = {
  school: { label: "школа", color: "#2563eb", stroke: "#172554" },
  gymnasium: { label: "гимназия", color: "#7c3aed", stroke: "#3b0764" },
  lyceum: { label: "лицей", color: "#0f766e", stroke: "#042f2e" },
  education_center: { label: "центр образования", color: "#ea580c", stroke: "#7c2d12" },
  primary: { label: "начальная школа", color: "#16a34a", stroke: "#14532d" },
  basic: { label: "основная школа", color: "#0891b2", stroke: "#164e63" },
  cadet: { label: "кадетская школа", color: "#be123c", stroke: "#881337" },
  other: { label: "другое", color: "#475569", stroke: "#1f2937" }
};

const emptyFeatureCollection = { type: "FeatureCollection", features: [] };
const schoolAddressListLimit = 50;
const addressHistoryLimit = 8;
const addressSuggestionLimit = 24;
const searchResultLimit = 20;
const searchInputDelay = 170;
const schoolHistoryChangeStatuses = new Set([
  "transferred_in",
  "transferred_out",
  "removed_from_latest_school_document",
  "document_updated"
]);
const detailTabLabels = {
  summary: "Обзор",
  addresses: "Дома",
  history: "История",
  documents: "Документы",
  qa: "Качество"
};

const state = {
  allAddresses: [],
  addresses: [],
  schools: [],
  scanSchools: [],
  districtBoundaries: emptyFeatureCollection,
  schoolSections: emptyFeatureCollection,
  schoolAreaTiles: null,
  sharedSchoolSections: emptyFeatureCollection,
  schoolCampuses: [],
  schoolCampusMetadataByKey: new Map(),
  schoolCampusMetadataBySchoolKey: new Map(),
  schoolCampusLoadStatus: "idle",
  districtGeometryByName: new Map(),
  districtColor: new Map(),
  sourceByDistrict: new Map(),
  assignmentsByAddressId: new Map(),
  assignmentsByAddressKey: new Map(),
  assignmentsBySchoolKey: new Map(),
  currentAssignmentByAddressId: new Map(),
  reviewDecisions: [],
  reviewDecisionByAddressKey: new Map(),
  reviewDecisionsBySchoolKey: new Map(),
  reviewDecisionLoadFailures: new Set(),
  coordinateReviewSources: [],
  coordinateReviewByAddressKey: new Map(),
  coordinateReviewsBySchoolKey: new Map(),
  coordinateReviewLoadFailures: new Set(),
  schoolByKey: new Map(),
  schoolDetailNotice: null,
  addressDetailNotice: null,
  scanSchoolByKey: new Map(),
  schoolCampusesBySchoolKey: new Map(),
  schoolFallbackPointByKey: new Map(),
  currentGeocodedAddressesBySchoolKey: new Map(),
  loadedAssignmentDistricts: new Set(),
  assignmentLevelByDistrict: new Map(),
  assignmentLoadingPromises: new Map(),
  schoolSectionsLoaded: false,
  schoolSectionsLoadingPromise: null,
  schoolSectionsDistrict: "",
  schoolSectionsLoadError: null,
  schoolSectionsRequestToken: 0,
  schoolSectionsRevision: 0,
  renderedSchoolSectionKey: "",
  renderedSchoolSectionKeys: [],
  renderedSharedSectionKeys: [],
  schoolCampusesLoaded: false,
  schoolCampusesLoadingPromise: null,
  addressById: new Map(),
  addressOptionByLabel: new Map(),
  schoolOptionByLabel: new Map(),
  gardenOptionByLabel: new Map(),
  gardenTerritories: [],
  sourceOnlyGardenTerritories: [],
  gardenById: new Map(),
  gardenSearchResults: [],
  addressSearchEntries: [],
  schoolSearchEntries: [],
  addressSearchPostings: new Map(),
  addressSearchOverlays: new Map(),
  addressSearchNextOrdinal: 0,
  schoolSearchPostings: new Map(),
  addressCountByDistrict: new Map(),
  searchIndexGeneration: 0,
  addressStatsBySchool: new Map(),
  outsideDistrictAddressCount: 0,
  expandedAddressHistories: new Set(),
  schoolAddressPageOffsets: new Map(),
  selectionRequestToken: 0,
  searchMode: "address",
  searchSubmitted: false,
  addressSearchResults: [],
  schoolSearchResults: [],
  sharedAreaSelection: null,
  schoolHouseQuery: "",
  schoolAddressFilter: "all",
  schoolStreetFilter: "",
  returnAddressId: "",
  returnAddressLabel: "",
  selectedAddressId: "",
  selectedGardenId: "",
  selectedSchoolKey: "",
  focusedSchoolAddressId: "",
  activeDetailTab: "summary",
  hoverSchoolKey: "",
  hoverSharedSchoolKeys: new Set(),
  hoverAddressId: "",
  activeAreaFeatureKeys: new Set(),
  areaSelectionFocused: false,
  activeSharedAreaFeatureKeys: new Set(),
  map: null
};

// The compact shell and diagnostics read the live state, but must not mutate
// the selection outside the transition functions below.
const publicSchoolMapState = new Proxy(state, {
  get(target, key) {
    const value = target[key];
    if (key === 'sharedAreaSelection' && value) return Object.freeze({ ...value, schoolKeys:Object.freeze([...value.schoolKeys]) });
    if (['addressSearchResults', 'schoolSearchResults', 'gardenSearchResults'].includes(key)) return Object.freeze(value.slice());
    return value;
  },
  set: () => false,
  deleteProperty: () => false,
  defineProperty: () => false
});
Object.defineProperty(window, 'schoolMapState', {value:publicSchoolMapState, writable:false, configurable:false});

const layerIds = {
  districtFill: "district-fill",
  districtLine: "district-line",
  schoolSectionsHitbox: "school-sections-hitbox",
  schoolSectionsFill: "school-sections-fill",
  schoolSectionsLine: "school-sections-line",
  schoolSectionsLabels: "school-sections-labels",
  schoolSectionsLabelsActive: "school-sections-labels-active",
  sharedSchoolSectionsHitbox: "shared-school-sections-hitbox",
  sharedSchoolSectionsFill: "shared-school-sections-fill",
  sharedSchoolSectionsLine: "shared-school-sections-line",
  sharedSchoolBuildingsFill: "shared-school-buildings-fill",
  sharedSchoolBuildingsLine: "shared-school-buildings-line",
  gardenFill: "garden-territories-fill",
  gardenLine: "garden-territories-line",
  gardenPoints: "garden-territories-points",
  addresses: "addresses",
  schools: "schools",
  selectedAddresses: "selected-addresses",
  selectedAddressPin: "selected-address-pin",
  selectedSchoolHalo: "selected-school-halo",
  selectedSchools: "selected-schools"
};

function updateDebugDataset() {
  const metadata = state.schoolAreaTiles?.features;
  const features = metadata ? metadata.filter(feature => !feature.properties.shared_area_key) : state.schoolSections.features || [];
  const sharedFeatures = metadata ? metadata.filter(feature => feature.properties.shared_area_key) : state.sharedSchoolSections.features || [];
  document.documentElement.dataset.schoolAreaSource = state.schoolAreaTiles ? "vector" : "geojson";
  document.documentElement.dataset.schoolAreaFeatures = String(features.length);
  document.documentElement.dataset.schoolAreaMethods = [...new Set(features.map((feature) => feature.properties?.section_method || "").filter(Boolean))].join("|");
  document.documentElement.dataset.schoolAreaDistricts = [...new Set(features.map((feature) => feature.properties?.district || "").filter(Boolean))].join("|");
  document.documentElement.dataset.schoolAreasLoaded = state.schoolSectionsLoaded ? "yes" : "no";
  document.documentElement.dataset.sharedSchoolAreaFeatures = String(sharedFeatures.length);
  document.documentElement.dataset.schoolCampusFeatures = String(state.schoolCampuses.length);
  document.documentElement.dataset.schoolCampusesLoaded = state.schoolCampusesLoaded ? "yes" : "no";
}

function updateRenderedAreaDebugDataset(features) {
  document.documentElement.dataset.renderedSchoolAreaFeatures = String(features.length);
  document.documentElement.dataset.activeSchoolAreaFeatures = String(features.filter((feature) => feature.properties?.selection_state === "active").length);
}

function splitCsvLine(line, delimiter = ";") {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

function splitPipeValues(value) {
  return String(value || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function fetchCsvUrl(url, options = {}) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    if (options.optional && !CATALOG_SHA_BY_URL.has(url)) return [];
    throw new Error(`${url}: ${response.status}`);
  }
  return parseCsv(await districtResponseText(url, response));
}

async function districtResponseText(url, response) {
  const expected = CATALOG_SHA_BY_URL.get(url);
  if (!expected) return response.text();
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) throw new Error("Данные района обновились. Обновите страницу карты.");
  return new TextDecoder("utf-8").decode(bytes);
}

async function fetchCsv(path) {
  return fetchCsvUrl(DATA_ROOT + path);
}

async function fetchOptionalCsv(path) {
  return fetchCsvUrl(DATA_ROOT + path, { optional: true });
}

async function fetchOptionalCsvUrl(url) {
  if (!url) return [];
  return fetchCsvUrl(url, { optional: true });
}

async function fetchDistrictEvidenceCsvs(config, failures, label) {
  const groups = await Promise.all(Object.entries(config).map(async ([district, url]) => {
    try {
      return await fetchCsvUrl(url);
    } catch (error) {
      failures.add(district);
      console.error(`${label}: ${district} район:`, error);
      return [];
    }
  }));
  return groups.flat();
}

function compactTableRows(payload) {
  const fields = payload?.fields;
  const values = payload?.rows;
  if (!Array.isArray(fields) || !Array.isArray(values)) {
    throw new Error("Некорректная схема компактной таблицы");
  }
  return values.map((valuesRow) => {
    const row = {};
    fields.forEach((field, index) => {
      row[field] = valuesRow[index] ?? "";
    });
    return row;
  });
}

async function fetchCompactTableUrl(url, options = {}) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    if (options.optional && !CATALOG_SHA_BY_URL.has(url)) return [];
    throw new Error(`${url}: ${response.status}`);
  }
  return compactTableRows(JSON.parse(await districtResponseText(url, response)));
}

async function fetchOptionalCompactTable(path) {
  return fetchCompactTableUrl(DATA_ROOT + path, { optional: true });
}

async function fetchOptionalCompactTableUrl(url) {
  if (!url) return [];
  return fetchCompactTableUrl(url, { optional: true });
}

function districtFileUrl(district, fileName) {
  if (DISTRICT_VIEWER_CATALOG) {
    const record = DISTRICT_VIEWER_CATALOG.get(district)?.files[fileName];
    if (!record) throw new Error(`Районный файл недоступен: ${district}`);
    return `../../${record.path}?revision=${record.sha256}`;
  }
  const slug = DISTRICT_SLUGS[district];
  return slug ? `../../data/districts/${slug}/${fileName}` : "";
}

function districtAssignmentUrl(district) {
  return districtFileUrl(district, "assignments.csv");
}

function districtMapAssignmentUrl(district) {
  return districtFileUrl(district, "map_assignments.csv");
}

function districtMapAddressUrl(district) {
  return districtFileUrl(district, "map_addresses.csv");
}

function districtMapAddressJsonUrl(district) {
  return districtFileUrl(district, "map_addresses.json");
}

function districtAreaUrl(district) {
  return districtFileUrl(district, "school_attachment_areas.geojson");
}

async function fetchInitialAssignments() {
  if (VIEWER_API) return [];
  if (DEFAULT_DISTRICT) {
    const districtUrl = districtAssignmentUrl(DEFAULT_DISTRICT);
    const districtRows = await fetchOptionalCsvUrl(districtUrl);
    if (districtRows.length) return districtRows;
  }
  if (DISTRICT_VIEWER_CATALOG) {
    const groups = await Promise.all(Object.keys(DISTRICT_SLUGS).map((district) =>
      fetchCompactTableUrl(districtMapAddressJsonUrl(district))));
    return prepareOverviewAddressRows(groups.flat());
  }
  const compactOverviewRows = await fetchOptionalCompactTable("map_addresses.json");
  if (compactOverviewRows.length) return prepareOverviewAddressRows(compactOverviewRows);
  const overviewRows = await fetchOptionalCsv("map_addresses.csv");
  if (overviewRows.length) return prepareOverviewAddressRows(overviewRows);
  return fetchCsv("address_assignment_register.csv");
}

async function fetchJsonUrl(url, options = {}) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    if (options.optional && !CATALOG_SHA_BY_URL.has(url)) return null;
    throw new Error(`${url}: ${response.status}`);
  }
  return JSON.parse(await districtResponseText(url, response));
}

async function fetchJson(path) {
  return fetchJsonUrl(DATA_ROOT + path, { optional: true });
}

async function loadDistrictConfig() {
  if (VIEWER_API) VIEWER_BOOTSTRAP = await VIEWER_API.bootstrap();
  if (VIEWER_BOOTSTRAP?.map_display) {
    if (!window.schoolAreaTileModule) throw new Error("Модуль школьных участков недоступен");
    SCHOOL_AREA_TILE_PACKAGE = await window.schoolAreaTileModule.loadAreaTilePackage(VIEWER_BOOTSTRAP.map_display);
    SCHOOL_AREA_TILE_PACKAGE.unregister = window.schoolAreaTileModule.registerAreaTileProtocol(maplibregl, SCHOOL_AREA_TILE_PACKAGE);
  }
  const rows = VIEWER_BOOTSTRAP?.districts || await fetchJsonUrl(DISTRICT_CONFIG_URL);
  const mapping = {};
  const slugs = new Set();
  for (const row of rows || []) {
    const name = String(row?.name || "").trim();
    const slug = String(row?.slug || "").trim();
    if (!name || !slug || mapping[name] || slugs.has(slug)) {
      throw new Error("Некорректный реестр районов");
    }
    mapping[name] = slug;
    slugs.add(slug);
  }
  let expectedDistricts = 18;
  if (VIEWER_BOOTSTRAP?.acceptance_scope === "district_preview_not_city_release") {
    const requested = VIEWER_BOOTSTRAP.requested_districts;
    if (!VIEWER_API || VIEWER_BOOTSTRAP.city_release_accepted !== false
        || !/^local-preview:[a-f0-9]{64}$/.test(VIEWER_BOOTSTRAP.release_revision || "")
        || !Array.isArray(requested) || !requested.length || requested.length > 18
        || new Set(requested).size !== requested.length
        || requested.some(name => !Object.hasOwn(mapping, name))) {
      throw new Error("Некорректный состав районного предпросмотра");
    }
    expectedDistricts = requested.length;
  }
  if (Object.keys(mapping).length !== expectedDistricts) {
    throw new Error(`Ожидалось ${expectedDistricts} районов, загружено ${Object.keys(mapping).length}`);
  }
  DISTRICT_SLUGS = mapping;
  if (!VIEWER_API) await loadDistrictViewerCatalog();
}

async function loadDistrictViewerCatalog() {
  const response = await fetch(DISTRICT_VIEWER_CATALOG_URL, { cache: "no-cache" });
  if (response.status === 404) return; // Explicit legacy deployment, before migration.
  if (!response.ok) throw new Error("Не удалось загрузить каталог районов");
  const payload = await response.json();
  if (payload?.schema !== 1 || payload.status !== "accepted_district_viewer_composition"
      || !Array.isArray(payload.districts) || payload.districts.length !== 18) {
    throw new Error("Некорректный каталог районов");
  }
  const catalog = new Map();
  const hashes = new Map();
  const required = ["assignments.csv", "map_assignments.csv", "map_addresses.csv", "map_addresses.json",
    "schools.json", "school_attachment_areas.geojson", "district_boundary.geojson"];
  for (const item of payload.districts) {
    if (!item || DISTRICT_SLUGS[item.district] !== item.slug || catalog.has(item.district)
        || !/^[a-f0-9]{64}$/.test(item.revision || "")) throw new Error("Некорректная версия района");
    for (const name of required) {
      const record = item.files?.[name];
      if (!record || typeof record.path !== "string" || !record.path.startsWith(`data/districts/${item.slug}/`)
          || !/^[a-zA-Z0-9_./-]+$/.test(record.path) || record.path.split("/").some((part) => !part || part === "." || part === "..")
          || !/^[a-f0-9]{64}$/.test(record.sha256 || "")) throw new Error("Некорректный файл района");
      hashes.set(`../../${record.path}?revision=${record.sha256}`, record.sha256);
    }
    catalog.set(item.district, item);
  }
  DISTRICT_VIEWER_CATALOG = catalog;
  CATALOG_SHA_BY_URL.clear();
  for (const [url, sha] of hashes) CATALOG_SHA_BY_URL.set(url, sha);
}

async function fetchViewerSchools() {
  if (VIEWER_API) return VIEWER_BOOTSTRAP.schools;
  if (!DISTRICT_VIEWER_CATALOG) return fetchCsv("all_schools_master.csv");
  const groups = await Promise.all(Object.keys(DISTRICT_SLUGS).map((district) =>
    fetchCompactTableUrl(districtFileUrl(district, "schools.json"))));
  return groups.flat();
}

async function fetchViewerGeometry(fileName) {
  const groups = await Promise.all(Object.keys(DISTRICT_SLUGS).map((district) =>
    fetchJsonUrl(districtFileUrl(district, fileName))));
  const shared = new Map();
  for (const group of groups) {
    if (group?.type !== "FeatureCollection" || !Array.isArray(group.features)
        || (group.shared_features != null && !Array.isArray(group.shared_features))) {
      throw new Error("Некорректные географические данные района");
    }
    for (const feature of group.shared_features || []) {
      const key = feature.properties?.shared_area_key || JSON.stringify(feature);
      if (shared.has(key) && JSON.stringify(shared.get(key)) !== JSON.stringify(feature)) {
        throw new Error("Районные данные общей области несовместимы");
      }
      shared.set(key, feature);
    }
  }
  return { type: "FeatureCollection", features: groups.flatMap((group) => group.features), shared_features: [...shared.values()] };
}

async function fetchViewerBoundaries() {
  if (VIEWER_API) return VIEWER_BOOTSTRAP.boundaries;
  return DISTRICT_VIEWER_CATALOG ? fetchViewerGeometry("district_boundary.geojson") : fetchJson("district_boundaries.geojson");
}

function scheduleIdleTask(callback) {
  if (window.requestIdleCallback) {
    window.requestIdleCallback(callback, { timeout: 1600 });
    return;
  }
  window.setTimeout(callback, 0);
}

function loadSchoolSections(district = selectedDistrict()) {
  if (state.schoolAreaTiles) {
    state.schoolSectionsLoaded = true;
    renderSchoolSections();
    updateDebugDataset();
    return Promise.resolve(emptyFeatureCollection);
  }
  const sectionDistrict = district || "__all__";
  if (state.schoolSectionsLoaded && !state.schoolSectionsLoadError && state.schoolSectionsDistrict === sectionDistrict) return Promise.resolve(state.schoolSections);
  if (state.schoolSectionsLoadingPromise?.district === sectionDistrict) return state.schoolSectionsLoadingPromise.promise;
  state.schoolSectionsLoaded = false;
  state.schoolSectionsLoadError = null;
  state.schoolSectionsDistrict = sectionDistrict;
  const requestToken = ++state.schoolSectionsRequestToken;
  updateDebugDataset();
  const districtUrl = district && !VIEWER_API ? districtAreaUrl(district) : "";
  const areaUrl = districtUrl || `${DATA_ROOT}school_attachment_areas.geojson`;
  const request = VIEWER_API ? VIEWER_API.areas(district) : DISTRICT_VIEWER_CATALOG && !district ? fetchViewerGeometry("school_attachment_areas.geojson") : fetchJsonUrl(areaUrl);
  const loadPromise = request
    .then((schoolSections) => {
      if (!schoolSections || schoolSections.type !== "FeatureCollection" || !Array.isArray(schoolSections.features)) {
        throw new Error(`${areaUrl}: некорректный GeoJSON областей`);
      }
      if (schoolSections.shared_features != null && !Array.isArray(schoolSections.shared_features)) {
        throw new Error(`${areaUrl}: некорректный слой общих областей`);
      }
      if (requestToken !== state.schoolSectionsRequestToken) return state.schoolSections;
      state.schoolSections = featureCollection(schoolSections.features);
      state.sharedSchoolSections = featureCollection((schoolSections.shared_features || []).filter(
        (feature) => feature.properties?.shared_kind !== "building_surface"));
      if (window.schoolAreaTileModule?.colorizeAreaFeatures) {
        const ownCount = state.schoolSections.features.length;
        const colors = Object.fromEntries(districtColorNames.map(name => [name, colorForDistrict(name)]));
        const colored = window.schoolAreaTileModule.colorizeAreaFeatures(
          [...state.schoolSections.features, ...state.sharedSchoolSections.features], colors);
        state.schoolSections = featureCollection(colored.slice(0, ownCount));
        state.sharedSchoolSections = featureCollection(colored.slice(ownCount));
      }
      state.schoolSectionsLoaded = true;
      state.schoolSectionsDistrict = sectionDistrict;
      state.schoolSectionsRevision += 1;
      state.schoolSectionsLoadingPromise = null;
      updateDebugDataset();
      renderSchoolSections();
      renderSelectionHighlights();
      renderSelectionCardPreservingFocus();
      return state.schoolSections;
    })
    .catch((error) => {
      if (requestToken !== state.schoolSectionsRequestToken) {
        console.warn(`${areaUrl}: проигнорирован устаревший ответ`, error);
        return state.schoolSections;
      }
      state.schoolSections = emptyFeatureCollection;
      state.sharedSchoolSections = emptyFeatureCollection;
      state.schoolSectionsLoaded = true;
      state.schoolSectionsDistrict = sectionDistrict;
      state.schoolSectionsLoadError = error;
      state.schoolSectionsRevision += 1;
      state.schoolSectionsLoadingPromise = null;
      updateDebugDataset();
      renderSchoolSections();
      renderSelectionHighlights();
      renderSelectionCardPreservingFocus();
      console.error(`${areaUrl}:`, error);
      return state.schoolSections;
    });
  state.schoolSectionsLoadingPromise = { district: sectionDistrict, promise: loadPromise };
  return loadPromise;
}

function loadSchoolCampuses() {
  if (VIEWER_API) return Promise.resolve([]);
  if (state.schoolCampusesLoaded) return Promise.resolve(state.schoolCampuses);
  if (state.schoolCampusesLoadingPromise) return state.schoolCampusesLoadingPromise;
  state.schoolCampusLoadStatus = "loading";
  state.schoolCampusesLoadingPromise = Promise.all([
    fetchCsv("osm_schools.csv"),
    fetchCsv("school_campus_metadata.csv")
  ])
    .then(([osmSchools, campusMetadata]) => {
      buildSchoolCampusMetadataIndex(campusMetadata);
      clearSchoolFeatureCache();
      buildSchoolCampusIndex(osmSchools);
      state.schoolCampusesLoaded = true;
      state.schoolCampusesLoadingPromise = null;
      state.schoolCampusLoadStatus = "loaded";
      for (const school of state.schools) school._schoolSearchText = "";
      buildSchoolSearchIndex();
      refreshSchoolOptions();
      const recomputedSubmittedSearch = state.searchMode === "school" && state.searchSubmitted && !state.selectedSchoolKey;
      if (recomputedSubmittedSearch) {
        const query = document.getElementById("schoolSearch")?.value || "";
        state.schoolSearchResults = searchSchoolCandidates(query, searchResultLimit);
      }
      updateDebugDataset();
      renderSchools(state.schools, matchingSchoolKeysForAddressQuery());
      renderSelectionHighlights();
      renderSelectionCardPreservingFocus();
      if (recomputedSubmittedSearch) updateStats(0, 0);
      return state.schoolCampuses;
    })
    .catch((error) => {
      state.schoolCampusesLoaded = false;
      state.schoolCampusesLoadingPromise = null;
      state.schoolCampusLoadStatus = "error";
      updateDebugDataset();
      renderSchools(state.schools, matchingSchoolKeysForAddressQuery());
      renderSelectionHighlights();
      renderSelectionCardPreservingFocus();
      console.error("osm_schools.csv:", error);
      announce("Дополнительные точки школ не загрузились; основные данные доступны");
      return state.schoolCampuses;
    });
  return state.schoolCampusesLoadingPromise;
}

function rebuildAssignmentState(changedDistrict = "") {
  state.addresses = state.allAddresses.filter((row) => row.is_current === "yes" && row.record_kind !== "scan_rule");
  state.outsideDistrictAddressCount = markAddressCoordinateQuality(state.allAddresses);
  buildAddressIndexes(changedDistrict);
  buildAssignmentIndexes(state.allAddresses);
}

function installDistrictAssignments(district, rows, level = "full") {
  prepareAddressRows(rows);
  state.allAddresses = state.allAddresses.filter((row) => row.district !== district);
  state.allAddresses.push(...rows);
  state.loadedAssignmentDistricts.add(district);
  state.assignmentLevelByDistrict.set(district, level);
}

function prepareOverviewAddressRows(rows) {
  for (const row of rows) {
    row.address_id = `overview::${row.district || ""}::${row.address_key || row.canonical_address || ""}`;
    row.is_current = "yes";
    row.record_kind = "overview_address";
    row.assignment_status = "current";
    row._overview = true;
  }
  return rows;
}

function installRequestedDetails(rows, packageKey) {
  // Conservative weight before view-specific indexes are added; retain one
  // complete active response even if it alone exceeds the warm-cache target.
  const weight = rows.reduce((total, row) => total + 64 + Object.values(row)
    .reduce((size, value) => size + 16 + (typeof value === "string" ? 24 + value.length * 2 : 8), 0), 0);
  prepareAddressRows(rows);
  detailPackages.delete(packageKey);
  detailPackageWeights.delete(packageKey);
  detailPackages.set(packageKey, rows);
  detailPackageWeights.set(packageKey, weight);
  const cachedWeight = () => [...detailPackages.keys()].reduce((sum, key) => sum + (detailPackageWeights.get(key) || 0), 0);
  while (detailPackages.size > 3 || detailPackages.size > 1 && cachedWeight() > detailCacheBudget) {
    const oldest = detailPackages.keys().next().value;
    detailPackages.delete(oldest);
    detailPackageWeights.delete(oldest);
    if (oldest.startsWith("school:")) loadedSchoolDetails.delete(oldest.slice(7));
  }
  const details = uniqueBy([...detailPackages.values()].flat(), (row) => row.assignment_id);
  const identities = new Set(details.map((row) => `${row.district}|${row.address_key}`));
  state.allAddresses = state.allAddresses.filter((row) => row._overview && !identities.has(`${row.district}|${row.address_key}`));
  state.allAddresses.push(...details);
  rebuildAssignmentState();
}

async function loadAddressSearch(value, selectionToken = state.selectionRequestToken) {
  if (!VIEWER_API) return;
  const district = selectedDistrict();
  const key = `${district}|${value}|${selectionToken}`;
  if (addressSearchWork && addressSearchKey === key) return addressSearchWork;
  addressSearchRequest?.abort();
  const controller = new AbortController();
  addressSearchRequest = controller;
  addressSearchKey = key;
  // Submitting a street/name uses the same bounded lookup as typeahead.
  const lookup = !/\d/u.test(value) && VIEWER_API.suggest ? VIEWER_API.suggest : VIEWER_API.search;
  const work = lookup.call(VIEWER_API, value, district, controller.signal).then((rows) => {
    if (controller.signal.aborted || selectedDistrict() !== district || selectionToken !== state.selectionRequestToken) return;
    const detailed = new Set(state.allAddresses.filter((row) => !row._overview).map((row) => `${row.district}|${row.address_key}`));
    state.allAddresses = state.allAddresses.filter((row) => !row._overview);
    state.allAddresses.push(...prepareAddressRows(prepareOverviewAddressRows(rows.filter((row) => !detailed.has(`${row.district}|${row.address_key}`)))));
    rebuildAssignmentState();
  }).finally(() => {
    if (addressSearchWork === work) {
      addressSearchWork = null;
      addressSearchRequest = null;
      addressSearchKey = "";
    }
  });
  addressSearchWork = work;
  return work;
}

function loadedDistrictLabel(district) {
  return district ? `${district} район` : "все районы";
}

function showAssignmentLoadError(district, error) {
  const message = `Не удалось загрузить полный пакет: ${loadedDistrictLabel(district)}.`;
  document.getElementById("stats").textContent = message;
  const card = document.getElementById("selectionCard");
  if (card) {
    card.setAttribute("aria-busy", "false");
    card.innerHTML = `<div class="search-empty"><strong>Детальные данные временно недоступны</strong><span>${escapeHtml(message)} Обзорные точки не удалены; повторите попытку позже.</span></div>`;
  }
  console.error(message, error);
  announce(message);
}

async function ensureAssignmentsForDistrict(district) {
  if (VIEWER_API) return;
  if (!district) return ensureAssignmentsForAllDistricts();
  if (state.assignmentLevelByDistrict.get(district) === "full") return;
  if (state.assignmentLoadingPromises.has(district)) return state.assignmentLoadingPromises.get(district);
  const url = districtAssignmentUrl(district);
  if (!url) return;
  const promise = fetchCsvUrl(url)
    .then((rows) => {
      if (!rows.length) throw new Error(`${url}: пустой районный пакет`);
      installDistrictAssignments(district, rows, "full");
      rebuildAssignmentState(district);
      return rows;
    })
    .finally(() => state.assignmentLoadingPromises.delete(district));
  state.assignmentLoadingPromises.set(district, promise);
  return promise;
}

async function ensureAssignmentsForAllDistricts() {
  if (VIEWER_API) return;
  const districts = Object.keys(DISTRICT_SLUGS).filter((district) => !state.assignmentLevelByDistrict.has(district));
  if (!districts.length) return;
  const allKey = "__all__";
  if (state.assignmentLoadingPromises.has(allKey)) return state.assignmentLoadingPromises.get(allKey);
  const promise = (async () => {
    const needed = new Set(districts);
    let cityRows = DISTRICT_VIEWER_CATALOG ? [] : await fetchOptionalCompactTable("map_addresses.json");
    if (!DISTRICT_VIEWER_CATALOG && !cityRows.length) cityRows = await fetchOptionalCsv("map_addresses.csv");
    if (cityRows.length) {
      const byDistrict = new Map(districts.map((district) => [district, []]));
      for (const row of cityRows) {
        if (needed.has(row.district)) byDistrict.get(row.district).push(row);
      }
      return districts.map((district) => {
        const rows = prepareOverviewAddressRows(byDistrict.get(district) || []);
        prepareAddressRows(rows);
        return { district, rows, level: "overview" };
      });
    }
    return Promise.all(districts.map(async (district) => {
      const addressJsonUrl = districtMapAddressJsonUrl(district);
      let rows = addressJsonUrl ? await fetchOptionalCompactTableUrl(addressJsonUrl) : [];
      const addressUrl = districtMapAddressUrl(district);
      if (!rows.length) rows = addressUrl ? await fetchOptionalCsvUrl(addressUrl) : [];
      let level = "overview";
      if (rows.length) prepareOverviewAddressRows(rows);
      if (!rows.length) {
        const mapUrl = districtMapAssignmentUrl(district);
        rows = mapUrl ? await fetchOptionalCsvUrl(mapUrl) : [];
        level = "map";
      }
      if (!rows.length) {
        const fullUrl = districtAssignmentUrl(district);
        rows = fullUrl ? await fetchOptionalCsvUrl(fullUrl) : [];
        level = "full";
      }
      prepareAddressRows(rows);
      return { district, rows, level };
    }));
  })().then((groups) => {
    // A full district request may have finished while the city overview was
    // loading. Never replace an independently installed package with this older result.
    const installable = groups.filter((group) => !state.assignmentLevelByDistrict.has(group.district));
    if (!installable.length) return;
    const replacedDistricts = new Set(installable.map((group) => group.district));
    state.allAddresses = state.allAddresses.filter((row) => !replacedDistricts.has(row.district));
    for (const { district, rows, level } of installable) {
      state.allAddresses.push(...rows);
      state.loadedAssignmentDistricts.add(district);
      state.assignmentLevelByDistrict.set(district, level);
    }
    rebuildAssignmentState();
  }).finally(() => state.assignmentLoadingPromises.delete(allKey));
  state.assignmentLoadingPromises.set(allKey, promise);
  return promise;
}

function numberValue(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return null;
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function hasCoordinates(row) {
  if (row && typeof row._hasCoordinates === "boolean") return row._hasCoordinates;
  return numberValue(row?.lat) != null && numberValue(row?.lon) != null;
}

function hasMapCoordinates(row) {
  if (!hasCoordinates(row)) return false;
  if (!["exact_house", "verified_house"].includes(row?.coordinate_precision)) return false;
  if (row?.home_point_eligible === "no" || row?.home_point_eligible === false) return false;
  if (NONEXACT_HOME_SOURCES.has(row?.coordinate_source)) return false;
  if (row?._isAddressRow && row._outsideDistrictBoundary) return false;
  return true;
}

// Saved proxy points remain evidence, but never position a user's home.
const NONEXACT_HOME_SOURCES = new Set([
  "manual_proxy", "osm_base_house", "osm_nearest_house_proxy", "osm_street_proxy",
  "school_point_proxy", "district_point_proxy", "register_address_key_inherited",
  "terminal_external_candidate_proxy", "terminal_nearby_existing_address_proxy",
  "terminal_saved_point_proxy"
]);

function coordinateIssueLabel(row) {
  if (!hasCoordinates(row)) return "нет координат";
  if (row?._outsideDistrictBoundary) return "координата вне района";
  if (!hasMapCoordinates(row)) return "точное местоположение дома не определено";
  return "";
}

function boundaryDistrictName(feature) {
  const props = feature?.properties || {};
  return props.district || String(props.name || "").replace(/\s+район$/i, "").trim();
}

function ringBounds(ring) {
  return ring.reduce((bounds, coord) => ({
    minLon: Math.min(bounds.minLon, coord[0]),
    minLat: Math.min(bounds.minLat, coord[1]),
    maxLon: Math.max(bounds.maxLon, coord[0]),
    maxLat: Math.max(bounds.maxLat, coord[1])
  }), { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity });
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index];
    const prev = ring[previous];
    const xi = current[0], yi = current[1];
    const xj = prev[0], yj = prev[1];
    const intersects = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(lon, lat, polygon) {
  if (!polygon?.length || !pointInRing(lon, lat, polygon[0])) return false;
  for (const hole of polygon.slice(1)) {
    if (pointInRing(lon, lat, hole)) return false;
  }
  return true;
}

function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return true;
  const bounds = geometry._bounds;
  if (bounds && (lon < bounds.minLon || lon > bounds.maxLon || lat < bounds.minLat || lat > bounds.maxLat)) return false;
  if (geometry.type === "Polygon") return pointInPolygonCoords(lon, lat, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((polygon) => pointInPolygonCoords(lon, lat, polygon));
  return true;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((value) => value == null)) return Infinity;
  const meanLatRad = ((lat1 + lat2) / 2) * Math.PI / 180;
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLon = Math.cos(meanLatRad) * 111320;
  return Math.hypot((lat1 - lat2) * metersPerDegreeLat, (lon1 - lon2) * metersPerDegreeLon);
}

function geometryWithBounds(geometry) {
  if (!geometry?.coordinates) return geometry;
  const rings = [];
  if (geometry.type === "Polygon") {
    rings.push(...geometry.coordinates);
  } else if (geometry.type === "MultiPolygon") {
    geometry.coordinates.forEach((polygon) => rings.push(...polygon));
  }
  const bounds = rings.reduce((acc, ring) => {
    const next = ringBounds(ring);
    return {
      minLon: Math.min(acc.minLon, next.minLon),
      minLat: Math.min(acc.minLat, next.minLat),
      maxLon: Math.max(acc.maxLon, next.maxLon),
      maxLat: Math.max(acc.maxLat, next.maxLat)
    };
  }, { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity });
  return { ...geometry, _bounds: bounds };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function truncate(value, maxLength = 92) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function ruPlural(count, one, few, many) {
  const value = Math.abs(Number(count) || 0);
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function colorForDistrict(district) {
  if (!state.districtColor.has(district)) {
    const index = districtColorNames.indexOf(district);
    state.districtColor.set(district, districtColors[index < 0 ? 9 : index]);
  }
  return state.districtColor.get(district);
}

function selectedDistrict() {
  return document.getElementById("districtFilter").value;
}

function addressQuery() {
  return document.getElementById("addressSearch")?.value.trim().toLowerCase() || "";
}

function addressQueryTokens() {
  return normalizeSearchValue(addressQuery()).split(/\s+/).filter(Boolean);
}

function schoolQuery() {
  return document.getElementById("schoolSearch")?.value.trim() || "";
}

function announce(message) {
  const region = document.getElementById("viewAnnouncer");
  if (!region) return;
  region.textContent = "";
  window.setTimeout(() => {
    region.textContent = message;
  }, 10);
}

function motionDuration(value) {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? 0 : value;
}

function controlChecked(id) {
  // Schools and areas are always visible in the compact interface.
  return document.getElementById(id)?.checked ?? (id === "toggleSchools" || id === "toggleAreas");
}

function normalizeSchoolNumber(value) {
  return String(value ?? "").trim().replace(/^№\s*/i, "");
}

function schoolReference(value) {
  const identifier = normalizeSchoolNumber(value);
  return /^\d+(?:\s*\|\s*\d+)*$/.test(identifier) ? `№${identifier}` : identifier;
}

function assignmentSchoolLabel(value) {
  const identifier = normalizeSchoolNumber(value);
  if (!identifier) return "школа не указана";
  return /^\d+$/.test(identifier) ? `школа №${identifier}` : identifier;
}

function districtSchoolKey(district, schoolNumber) {
  const number = normalizeSchoolNumber(schoolNumber);
  return district && number ? `${district}::${number}` : "";
}

function schoolKey(row) {
  if (row?._schoolKey) return row._schoolKey;
  const districtKey = districtSchoolKey(row.district, row.school_number);
  if (districtKey) return districtKey;
  if (row.school_id) return row.school_id;
  if (row.all_school_id) return row.all_school_id;
  if (row.osm_id) return `osm::${row.osm_type || ""}::${row.osm_id}`;
  return "";
}

function addressSchoolNumbers(row) {
  if (row?._addressSchoolNumbers) return row._addressSchoolNumbers;
  const numbers = splitPipeValues(row?.current_school_numbers || row?.current_school_number)
    .map(normalizeSchoolNumber)
    .filter(Boolean);
  if (row?.school_number) numbers.push(normalizeSchoolNumber(row.school_number));
  return uniqueBy(numbers, (number) => number);
}

function addressSchoolKeys(row) {
  if (row?._addressSchoolKeys) return row._addressSchoolKeys;
  const keys = addressSchoolNumbers(row)
    .map((number) => districtSchoolKey(row?.district, number))
    .filter(Boolean);
  if (!keys.length && row?.school_id) keys.push(row.school_id);
  return uniqueBy(keys, (key) => key);
}

function addressSchoolKey(row) {
  if (row?._addressSchoolKey) return row._addressSchoolKey;
  return addressSchoolKeys(row)[0] || "";
}

function schoolName(row) {
  const identifier = normalizeSchoolNumber(row?.school_number);
  if (identifier && !/^\d+$/.test(identifier)) return identifier;
  return row.canonical_school_name || row.school_name || row.school_name_normalized || row.school_name_raw || row.display_name || "Школа без названия";
}

function compactSchoolTitle(row) {
  const type = schoolTypeStyles[schoolTypeGroup(row)]?.label || "школа";
  const title = type.charAt(0).toUpperCase() + type.slice(1);
  const number = normalizeSchoolNumber(row?.school_number);
  if (number && !/^\d+$/.test(number)) return number;
  return number ? `${title} №${number}` : title;
}

function schoolTypeGroup(row) {
  const explicit = String(row?.school_type_group || "").trim();
  if (explicit && schoolTypeStyles[explicit]) return explicit;
  const text = normalizeSearchValue([
    row?.school_type,
    row?.school_type_label,
    row?.official_kind,
    row?.school_name,
    row?.school_name_raw,
    row?.display_name
  ].join(" "));
  if (text.includes("кадет")) return "cadet";
  if (text.includes("центр образ") || /(^|\s)ц\s*о(\s|$)/.test(text)) return "education_center";
  if (text.includes("начальн") || text.includes("прогимназ")) return "primary";
  if (text.includes("гимназ")) return "gymnasium";
  if (text.includes("лицей")) return "lyceum";
  if (text.includes("основн")) return "basic";
  return "school";
}

function schoolTypeLabel(row) {
  const group = schoolTypeGroup(row);
  return row?.school_type_label || row?.school_type || schoolTypeStyles[group]?.label || schoolTypeStyles.other.label;
}

function schoolTypeStyle(row) {
  return schoolTypeStyles[schoolTypeGroup(row)] || schoolTypeStyles.other;
}

function schoolLabel(row) {
  const district = selectedDistrict() ? "" : `${row.district || "без района"} · `;
  return `${district}${compactSchoolTitle(row)}`;
}

function isStreetAddressPart(value) {
  return /(?:улица|ул\.?|проспект|просп\.?|пр\.?|переулок|пер\.?|набережная|наб\.?|шоссе|ш\.?|бульвар|бул\.?|проезд|пр\s*-?\s*д\.?|площадь|пл\.?|аллея|ал\.?|линия|дорога|тракт|тупик|павильон|садоводство|снт)(?:\s|\.|,|$)/i.test(String(value || ""));
}

function isAddressQualifierPart(value) {
  return /^(?:корпус|корп\.?|к\.?|литера|лит\.?|л\.?|строение|стр\.?|сооружение|соор\.?|с\.?)\s*[№0-9а-яa-z]/i.test(String(value || ""));
}

function rememberAddressTitle(row, value) {
  const title = String(value || "");
  if (row && typeof row === "object") {
    row._addressTitle = title;
    row._addressTitleSearch = normalizeSearchValue(title);
  }
  return title;
}

function addressTitle(row) {
  if (row?._addressTitle) return row._addressTitle;
  const addressCandidates = [
    row.canonical_address,
    ...splitPipeValues(row.address_aliases),
    row.address_query,
    row.raw_address_text
  ].filter(Boolean);
  const preparedDisplaySource = row?._addressDisplaySource;
  const fallback = (preparedDisplaySource !== undefined
    ? preparedDisplaySource || addressCandidates[0]
    : addressCandidates.find((value) => houseTokensFromAddressValue(value).length) || addressCandidates[0])
    || "Адрес без названия";
  const withoutCity = String(fallback)
    .replace(/^\s*\d{6}\s*,\s*/i, "")
    .replace(/^\s*(?:г\.?\s*)?Санкт-Петербург(?:\s*г\.?)?\s*,\s*/i, "");
  const previewParts = withoutCity.split(",").map((part) => part.trim()).filter(Boolean);
  if (/\s+\/\s+/.test(withoutCity) && previewParts.filter(isStreetAddressPart).length > 1) return rememberAddressTitle(row, withoutCity);
  if (row.parsed_street && row.parsed_house) {
    const litera = String(fallback).match(/литера\s+([А-ЯA-Z])/i)?.[1];
    const parsedHouse = String(row.parsed_house).trim();
    const literaAlreadyPresent = Boolean(litera) && (
      /лит(?:ера|\.)?/i.test(parsedHouse)
      || new RegExp(`${escapeRegExp(litera)}$`, "i").test(parsedHouse.replace(/\s+/g, ""))
    );
    return rememberAddressTitle(row, `${row.parsed_street}, ${parsedHouse}${litera && !literaAlreadyPresent ? `, лит. ${litera.toUpperCase()}` : ""}`);
  }
  const parts = previewParts;
  if (/^\d/.test(parts[0] || "") && /(улица|проспект|переулок|бульвар|аллея|набережная|проезд|шоссе|площадь)/i.test(parts[1] || "")) {
    return rememberAddressTitle(row, `${parts[1]}, ${parts[0]}`);
  }
  const kilometerIndex = parts.findIndex((part) => /^\d+(?:\s*-?\s*(?:й|я|е))?\s*км(?:\s|$)/i.test(part));
  if (kilometerIndex >= 1) return rememberAddressTitle(row, parts.slice(0, kilometerIndex + 1).join(", "));
  const houseIndex = parts.findIndex((part) => /^(?:дом|д\.?|владение)\s*№?\s*\d/i.test(part));
  if (houseIndex >= 1) {
    let end = houseIndex + 1;
    while (parts[end] && isAddressQualifierPart(parts[end])) end += 1;
    return rememberAddressTitle(row, parts.slice(0, end).join(", "));
  }
  const streetIndex = parts.findIndex(isStreetAddressPart);
  if (streetIndex >= 0 && /^№?\s*\d/.test(parts[streetIndex + 1] || "")) {
    let end = streetIndex + 2;
    while (parts[end] && isAddressQualifierPart(parts[end])) end += 1;
    return rememberAddressTitle(row, parts.slice(streetIndex, end).join(", "));
  }
  const genericHouseIndex = parts.findIndex((part, index) => (
    index >= 1
    && /^№?\s*\d/i.test(part)
    && !(/^\d{6}$/.test(part) && /^россия$/i.test(parts[index + 1] || ""))
  ));
  if (genericHouseIndex >= 1) {
    let end = genericHouseIndex + 1;
    while (parts[end] && isAddressQualifierPart(parts[end])) end += 1;
    return rememberAddressTitle(row, parts.slice(0, end).join(", "));
  }
  return rememberAddressTitle(row, parts.slice(0, 2).join(", ") || String(fallback));
}

function addressText(row) {
  return [
    row.canonical_address,
    row.address_aliases,
    row.address_query,
    row.raw_address_text,
    row.parsed_street,
    row.parsed_house,
    row.district,
    row.school_number
  ].join(" ").toLowerCase();
}

function normalizeSearchValue(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/([0-9])([а-яa-z])(?=[^а-яa-z0-9]|$)/g, "$1 $2")
    .replace(/([0-9а-яa-z])к(?=[0-9])/g, "$1 к ")
    .replace(/([0-9а-яa-z])с(?=[0-9])/g, "$1 с ")
    .replace(/(^|[^а-яa-z0-9])(?:улица|ул\.?)(?=[^а-яa-z0-9]|$)/g, "$1 ул ")
    .replace(/(^|[^а-яa-z0-9])(?:проезд|пр\s*-?\s*д\.?)(?=[^а-яa-z0-9]|$)/g, "$1 прд ")
    .replace(/(^|[^а-яa-z0-9])(?:проспект|просп\.?|пр\.?)(?=[^а-яa-z0-9]|$)/g, "$1 пр ")
    .replace(/(^|[^а-яa-z0-9])(?:переулок|пер\.?)(?=[^а-яa-z0-9]|$)/g, "$1 пер ")
    .replace(/(^|[^а-яa-z0-9])(?:набережная|наб\.?)(?=[^а-яa-z0-9]|$)/g, "$1 наб ")
    .replace(/(^|[^а-яa-z0-9])(?:шоссе|ш\.?)(?=[^а-яa-z0-9]|$)/g, "$1 ш ")
    .replace(/(^|[^а-яa-z0-9])(?:бульвар|бул\.?|б\s*-\s*р)(?=[^а-яa-z0-9]|$)/g, "$1 бл ")
    .replace(/(^|[^а-яa-z0-9])(?:площадь|пл\.?)(?=[^а-яa-z0-9]|$)/g, "$1 пл ")
    .replace(/(^|[^а-яa-z0-9])(?:аллея|ал\.?)(?=[^а-яa-z0-9]|$)/g, "$1 ал ")
    .replace(/(^|[^а-яa-z0-9])(?:корпус|корп\.?|к\.?)[\s,;№]*(?=[0-9])/g, "$1 к ")
    .replace(/(^|[^а-яa-z0-9])(?:строение|стр\.?|сооружение|соор\.?|с\.?)[\s,;№]*(?=[0-9])/g, "$1 с ")
    .replace(/(^|[^а-яa-z0-9])(?:литера|лит\.?|л\.?)\s*([а-яa-z])(?=[^а-яa-z0-9]|$)/g, "$1 л $2 ")
    .replace(/(^|[^а-яa-z0-9])(?:дом|д\.?)[\s,;№]*(?=[0-9])/g, "$1 ")
    .replace(/[^а-яa-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenMatchesSearchText(text, token) {
  if (!token) return true;
  if (/\d/.test(token) || ["к", "с", "л"].includes(token)) {
    return new RegExp(`(^|\\s)${escapeRegExp(token)}($|\\s)`).test(text);
  }
  return text.includes(token);
}

function normalizeHouseToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/^0+(\d)/, "$1");
}

function queryHouseToken(value) {
  const raw = String(value ?? "").toLowerCase().replaceAll("ё", "е");
  const beforeRawQualifier = raw.match(/(?:^|[\s,;])([0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)(?=\s*(?:(?:корпус|корп\.?|к\.?)|(?:строение|стр\.?|сооружение|соор\.?|с\.?))\s*\d)/i);
  if (beforeRawQualifier) return normalizeHouseToken(beforeRawQualifier[1]);
  const explicit = raw.match(/(?:^|[\s,;])(?:дом|д\.?)\s*([0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)(?![0-9а-яa-z])/i);
  if (explicit) return normalizeHouseToken(explicit[1]);
  const hyphenatedRange = raw.match(/(?:^|[\s,;])([0-9]+)-[0-9]+(?:\/[0-9]+)?[а-яa-z]?(?:\s|$)/i);
  if (hyphenatedRange) return normalizeHouseToken(hyphenatedRange[1]);
  const kilometer = raw.match(/(?:^|[\s,;/])([0-9]+)(?:\s*-?\s*(?:й|я|е))?\s*км(?:\s|$)/i);
  if (kilometer) return normalizeHouseToken(kilometer[1]);
  const lettered = raw.match(/(?:^|[\s,;])([0-9]+[а-яa-z](?:\/[0-9]+[а-яa-z]?)?)$/i);
  if (lettered) return normalizeHouseToken(lettered[1]);
  const normalized = normalizeSearchValue(raw);
  const beforeQualifiers = normalized.match(/(?:^|\s)([0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)(?:(?:\s+(?:к|с)\s+[0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)|(?:\s+л\s+[а-яa-z]))+$/i);
  if (beforeQualifiers) return normalizeHouseToken(beforeQualifiers[1]);
  const implicitCorpus = normalized.match(/(?:^|\s)([0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)\s+([0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)$/i);
  if (implicitCorpus) return normalizeHouseToken(implicitCorpus[1]);
  const trailing = normalized.match(/(?:^|\s)([0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)$/i);
  return trailing ? normalizeHouseToken(trailing[1]) : "";
}

function houseTokensFromAddressValue(value) {
  const raw = String(value || "").toLowerCase().replaceAll("ё", "е");
  if (!raw) return [];
  const tokens = [];
  for (const match of raw.matchAll(/(?:^|[\s,;])(?:дом|д\.?)\s*([0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)(?![0-9а-яa-z])/gi)) {
    tokens.push(normalizeHouseToken(match[1]));
  }
  if (tokens.length) return uniqueBy(tokens.filter(Boolean), (token) => token);
  const parts = raw.split(",");
  const isPostalCodeCandidate = (token, index) => (
    /^\d{6}$/.test(token)
    && /^россия$/i.test(String(parts[index + 1] || "").trim())
  );
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!isStreetAddressPart(parts[index])) continue;
    for (let candidateIndex = index + 1; candidateIndex < Math.min(parts.length, index + 4); candidateIndex += 1) {
      if (candidateIndex > index + 1 && isStreetAddressPart(parts[candidateIndex])) break;
      const match = parts[candidateIndex].match(/^\s*(?:дом|д\.?)?\s*№?\s*([0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)(?![0-9а-яa-z])/i);
      if (!match) continue;
      const token = normalizeHouseToken(match[1]);
      if (isPostalCodeCandidate(token, candidateIndex)) continue;
      tokens.push(token);
      break;
    }
  }
  if (!tokens.length) {
    for (let index = 1; index < parts.length; index += 1) {
      const part = parts[index];
      const match = part.match(/^\s*№?\s*([0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?)(?![0-9а-яa-z])/i);
      if (!match) continue;
      const token = normalizeHouseToken(match[1]);
      if (isPostalCodeCandidate(token, index)) continue;
      tokens.push(token);
    }
  }
  return uniqueBy(tokens.filter(Boolean), (token) => token);
}

function rowHouseTokens(row) {
  if (Array.isArray(row?._baseHouseTokens)) return row._baseHouseTokens;
  const tokens = [];
  for (const source of [row?.parsed_house, row?.source_house_rule]) {
    const match = String(source || "").toLowerCase().replaceAll("ё", "е").match(/[0-9]+[а-яa-z]?(?:\/[0-9]+[а-яa-z]?)?/i);
    if (match) tokens.push(normalizeHouseToken(match[0]));
  }
  const aliasValues = splitPipeValues(row?.address_aliases);
  for (const source of [row?.canonical_address, ...aliasValues, row?.address_query, row?.raw_address_text]) {
    if (!source) continue;
    const sourceTokens = [];
    const inferred = queryHouseToken(source);
    if (inferred) sourceTokens.push(inferred);
    sourceTokens.push(...houseTokensFromAddressValue(source));
    if (!row._addressDisplaySource && sourceTokens.length) row._addressDisplaySource = source;
    tokens.push(...sourceTokens);
  }
  if (!tokens.length) {
    const fallback = queryHouseToken(addressTitle(row));
    if (fallback) tokens.push(fallback);
  }
  row._baseHouseTokens = uniqueBy(tokens.filter(Boolean), (token) => token);
  return row._baseHouseTokens;
}

function rowBaseHouseToken(row) {
  if (row?._baseHouseToken !== undefined) return row._baseHouseToken;
  const token = rowHouseTokens(row)[0] || "";
  if (row && typeof row === "object") row._baseHouseToken = token;
  return token;
}

function rowMatchesHouseToken(row, houseToken) {
  if (!houseToken) return true;
  return rowHouseTokens(row).includes(houseToken);
}

function isGroupOverlapAssignment(item) {
  return item?.assignment_status === "current_group_overlap" || item?.change_status === "group_expansion_overlap_review";
}

function isUnrecognizedApproximateCoordinate(item) {
  return item?.coordinate_precision === "unrecognized_approximate";
}

function coordinatePrecisionLabel(item) {
  if (isUnrecognizedApproximateCoordinate(item)) {
    return "приблизительная точка: адрес не распознан";
  }
  const labels = {
    exact_house: "точная точка дома", verified_house: "проверенная точка дома",
    exact_school_address: "точный адрес школы", exact_school_object: "точка школы",
    verified_school_address: "проверенный адрес школы", no_coordinate: "точный адрес дома не определён",
    proxy: "приблизительная точка", approximate: "приблизительная точка",
    street: "точка улицы", base_house: "точка базового дома"
  };
  return labels[item?.coordinate_precision] || "точность координаты не уточнена";
}

function reviewReasonLabels(value) {
  const labels = {
    current_multiple_schools_review: "несколько текущих школ",
    group_expansion_overlap_review: "несколько групповых строк",
    osm_expanded_from_scan_rule_review: "дом раскрыт из групповой строки, нужна сверка",
    group_rule_expanded_via_osm_review: "групповая строка раскрыта в дома, нужна сверка",
    not_in_local_oas_reference_needed: "нет точного совпадения в адресном справочнике",
    oas_miss_after_parse: "адрес не найден в справочнике после распознавания",
    oas_multiple_matches: "в справочнике несколько вариантов адреса, нужна сверка",
    street_not_found_in_oas: "улица не найдена в адресном справочнике",
    external_reference_needed: "нужна внешняя сверка адреса",
    manual_ocr: "адрес требует проверки распознавания PDF",
    group_rule_not_expanded: "групповая строка еще не раскрыта в дома",
    fuzzy_review_candidate: "найдено возможное нестрогое совпадение, нужна сверка",
    osm_base_house: "координата взята по базовому дому",
    osm_nearest_house_proxy: "координата взята по ближайшему дому",
    osm_street_proxy: "координата приблизительно определена по улице",
    district_point_proxy: "координата приблизительно определена по району",
    school_point_proxy: "координата временно взята по точке школы",
    nominatim_approximate: "приблизительная точка",
    manual_proxy: "координата взята как proxy-точка",
    osm_fuzzy: "координата подобрана нестрогим совпадением",
    geocode_not_found: "координаты не найдены",
    geocode_network_error: "координаты временно недоступны",
    geocode_error: "ошибка определения координат",
    geocode_foreign_locality: "координата относится к другой локации",
    geocode_outside_district: "координата находится вне границ района",
    corp_litera_mismatch: "корпус или литера требуют сверки",
    numeric_litera_mismatch: "числовое обозначение литеры требует сверки",
    gar_base_house_reference_review: "справочник подтверждает базовый дом, корпус требует сверки",
    gar_current_coordinate_missing: "актуальный адрес пока не имеет точной координаты",
    gar_current_eas_ambiguous: "для адреса найдены разные координаты, нужна сверка",
    gar_current_coordinates_incomplete: "не все актуальные адреса получили точные координаты",
    coordinate_inherited_from_review_source: "координата унаследована из проверочной записи",
    current_coordinate_conflict: "для одного адреса найдены разные точные координаты, нужна сверка объекта",
    removed_from_latest_school_document_review: "адрес исключен из последней редакции"
  };
  return String(value || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => labels[part] || "")
    .filter(Boolean);
}

function assignmentCheckLabels(item) {
  const labels = [];
  if (!hasCoordinates(item)) labels.push("нет координат");
  if (isUnrecognizedApproximateCoordinate(item)) {
    labels.push("завершено приблизительно: адрес не распознан");
  }
  if (item?.assignment_status === "current_conflict") labels.push("несколько текущих школ");
  if (isGroupOverlapAssignment(item)) labels.push("несколько групповых строк");
  labels.push(...reviewReasonLabels(item?.review_reason || ""));
  if (item?.needs_review === "yes" && labels.length === 0) labels.push("нужна проверка");
  return uniqueBy(labels, (label) => label);
}

function assignmentHasOpenReview(item) {
  if (item?.needs_review === "yes") return true;
  if (item?.assignment_status === "current_conflict") return true;
  if (isGroupOverlapAssignment(item)) return true;
  return false;
}

function checkLabelsValue(labels, limit = 5) {
  const clean = uniqueBy(labels.filter(Boolean), (label) => label);
  if (!clean.length) return "";
  const shown = clean.slice(0, limit);
  const rest = clean.length - shown.length;
  return `${shown.map(escapeHtml).join("<br>")}${rest > 0 ? `<br>и еще ${rest}` : ""}`;
}

function assignmentCheckNoteHtml(item, limit = 2) {
  const labels = assignmentCheckLabels(item).filter((label) => label !== "нет координат");
  if (!labels.length) return "";
  const prefix = assignmentHasOpenReview(item) ? "нужна проверка" : "примечание качества";
  return `<em>${prefix}: ${escapeHtml(labels.slice(0, limit).join("; "))}${labels.length > limit ? "; ..." : ""}</em>`;
}

function assignmentStatusBadgeHtml(item) {
  const labels = assignmentCheckLabels(item);
  if (!labels.length) return "";
  const open = assignmentHasOpenReview(item);
  const prefix = open ? "Нужна проверка" : "Примечание качества";
  return `<span class="row-status${open ? "" : " note"}" title="${escapeAttr(`${prefix}: ${labels.join("; ")}`)}" aria-label="${escapeAttr(`${prefix}: ${labels.join("; ")}`)}">${open ? "!" : "≈"}</span>`;
}

function addressCheckLabels(row, current = currentAddressAssignments(row)) {
  const items = current.length ? current : [state.currentAssignmentByAddressId.get(row.address_id) || row];
  const labels = [];
  if (current.length > 1) labels.push("несколько школ");
  for (const item of items) labels.push(...assignmentCheckLabels(item));
  return uniqueBy(labels, (label) => label);
}

function addressWarningLabel(row) {
  const labels = addressCheckLabels(row).filter((label) => label !== "нет координат");
  return labels[0] || "";
}

function addressTextMatches(row, tokens = addressQueryTokens()) {
  if (!tokens.length) return true;
  const text = searchableAddressText(row);
  return tokens.every((token) => tokenMatchesSearchText(text, token))
    && rowMatchesHouseToken(row, queryHouseToken(addressQuery()));
}

function addressLabel(row) {
  const numbers = uniqueBy(
    currentAddressAssignments(row).map((item) => normalizeSchoolNumber(item.school_number)).filter(Boolean),
    (number) => number
  );
  const school = numbers.length
    ? `${numbers.length > 1 ? "школы" : "школа"} ${numbers.map(schoolReference).join(", ")}`
    : "школа не указана";
  const coordinates = hasCoordinates(row) ? "" : " · без координат";
  const warning = addressWarningLabel(row);
  return `${truncate(addressTitle(row), 96)} · ${row.district || "без района"} · ${school}${coordinates}${warning ? ` · ${warning}` : ""}`;
}

function selectedAddressInputValue(row) {
  return addressTitle(row);
}

function addressIdentity(row) {
  return [
    row.canonical_address || row.address_query || row.raw_address_text,
    row.district
  ].join("|");
}

function sameSchool(row, key) {
  if (!key) return true;
  if (addressSchoolKeys(row).includes(key)) return true;
  const school = state.schoolByKey.get(key) || state.scanSchoolByKey.get(key);
  if (!school) return addressSchoolKey(row) === key;
  const schoolDistrictKey = districtSchoolKey(school.district, school.school_number);
  if (schoolDistrictKey && addressSchoolKeys(row).includes(schoolDistrictKey)) return true;
  return Boolean(school.school_id && row.school_id && school.school_id === row.school_id);
}

function schoolMatchesAddressSchool(row, addressRow) {
  if (!addressRow) return true;
  const rowDistrictKey = districtSchoolKey(row.district, row.school_number);
  if (rowDistrictKey && addressSchoolKeys(addressRow).includes(rowDistrictKey)) return true;
  return Boolean(row.school_id && addressRow.school_id && row.school_id === addressRow.school_id);
}

function selectedAddressRow() {
  return state.selectedAddressId ? state.addressById.get(state.selectedAddressId) : null;
}

function focusedSchoolAddressRow() {
  return state.focusedSchoolAddressId ? state.addressById.get(state.focusedSchoolAddressId)
    || sharedComparisonModel()?.addressById.get(state.focusedSchoolAddressId) : null;
}

function hoverAddressRow() {
  return state.hoverAddressId ? state.addressById.get(state.hoverAddressId) : null;
}

function selectedSchoolRow() {
  return state.selectedSchoolKey ? state.schoolByKey.get(state.selectedSchoolKey) : null;
}

function addressMatchesBaseFilters(row) {
  if (!isAddressCurrent(row)) return false;
  const district = selectedDistrict();
  if (district && row.district !== district) return false;
  return true;
}

function addressMatchesFilters(row) {
  if (!controlChecked("toggleAddresses")) return false;
  return addressMatchesBaseFilters(row);
}

function visibleAddressRows() {
  return state.addresses.filter(addressMatchesFilters);
}

function addressDedupeKey(row) {
  if (row?._addressDedupeKey) return row._addressDedupeKey;
  return row.address_key || row.address_id || addressIdentity(row);
}

function dedupeAddressRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = addressDedupeKey(row);
    const current = byKey.get(key);
    const currentScore = current ? (hasMapCoordinates(current) ? 2 : hasCoordinates(current) ? 1 : 0) : -1;
    const rowScore = hasMapCoordinates(row) ? 2 : hasCoordinates(row) ? 1 : 0;
    if (!current || rowScore > currentScore) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function searchableAddressText(row) {
  if (row?._searchableAddressText) return row._searchableAddressText;
  return normalizeSearchValue([
    row.canonical_address,
    row.address_aliases,
    row.address_query,
    row.raw_address_text,
    row.parsed_street,
    row.parsed_house,
    row.district
  ].join(" "));
}

function prepareAddressRows(rows) {
  for (const row of rows) {
    row._addressTitle = "";
    row._addressTitleSearch = "";
    row._addressDisplaySource = undefined;
    row._baseHouseToken = undefined;
    row._baseHouseTokens = undefined;
    row._isAddressRow = true;
    row._lat = numberValue(row.lat);
    row._lon = numberValue(row.lon);
    row._hasCoordinates = row._lat != null && row._lon != null;
    row._addressSchoolNumbers = addressSchoolNumbers(row);
    row._addressSchoolKeys = row._addressSchoolNumbers
      .map((number) => districtSchoolKey(row.district, number))
      .filter(Boolean);
    if (!row._addressSchoolKeys.length && row.school_id) row._addressSchoolKeys.push(row.school_id);
    row._addressSchoolKey = row._addressSchoolKeys[0] || "";
    row._addressDedupeKey = row.address_key || row.address_id || addressIdentity(row);
    row._detailSearchableAddressText = "";
    row._searchableAddressText = normalizeSearchValue([
      row.canonical_address,
      row.address_aliases,
      row.address_query,
      row.raw_address_text,
      row.parsed_street,
      row.parsed_house,
      row.district
    ].join(" "));
  }
  return rows;
}

function buildDistrictGeometryIndex(boundaries) {
  state.districtGeometryByName.clear();
  for (const feature of boundaries?.features || []) {
    const district = boundaryDistrictName(feature);
    if (district && feature.geometry) state.districtGeometryByName.set(district, geometryWithBounds(feature.geometry));
  }
}

function markAddressCoordinateQuality(rows) {
  let outsideCount = 0;
  for (const row of rows) {
    row._outsideDistrictBoundary = false;
    if (!hasCoordinates(row) || !row.district) continue;
    const geometry = state.districtGeometryByName.get(row.district);
    if (!geometry) continue;
    const inside = pointInGeometry(row._lon ?? numberValue(row.lon), row._lat ?? numberValue(row.lat), geometry);
    row._outsideDistrictBoundary = !inside;
    if (!inside) outsideCount += 1;
  }
  return outsideCount;
}

function prepareSchoolRows(rows) {
  for (const row of rows) {
    row._lat = numberValue(row.lat);
    row._lon = numberValue(row.lon);
    row._hasCoordinates = row._lat != null && row._lon != null;
    row._schoolKey = schoolKey(row);
  }
  return rows;
}

function schoolRowsByNumber() {
  const rowsByNumber = new Map();
  for (const row of state.schools) {
    const number = normalizeSchoolNumber(row.school_number);
    if (!number) continue;
    if (!rowsByNumber.has(number)) rowsByNumber.set(number, []);
    rowsByNumber.get(number).push(row);
  }
  return rowsByNumber;
}

function schoolCampusDuplicate(lat, lon, school, campuses, thresholdMeters = 120) {
  if (distanceMeters(lat, lon, school._lat, school._lon) <= thresholdMeters) return true;
  return campuses.some((campus) => distanceMeters(lat, lon, campus._lat, campus._lon) <= thresholdMeters);
}

function schoolCampusMetadataKey(district, schoolNumber, osmType, osmId) {
  const number = normalizeSchoolNumber(schoolNumber);
  const type = String(osmType || "").trim();
  const id = String(osmId || "").trim();
  return district && number && type && id ? `${district}::${number}::${type}::${id}` : "";
}

function buildSchoolCampusMetadataIndex(rows) {
  state.schoolCampusMetadataByKey.clear();
  state.schoolCampusMetadataBySchoolKey.clear();
  for (const row of rows || []) {
    const key = schoolCampusMetadataKey(row.district, row.school_number, row.osm_type, row.osm_id);
    if (!key || !row.campus_label || !row.campus_address || state.schoolCampusMetadataByKey.has(key)) continue;
    state.schoolCampusMetadataByKey.set(key, row);
    const schoolKeyValue = districtSchoolKey(row.district, row.school_number);
    if (!state.schoolCampusMetadataBySchoolKey.has(schoolKeyValue)) state.schoolCampusMetadataBySchoolKey.set(schoolKeyValue, []);
    state.schoolCampusMetadataBySchoolKey.get(schoolKeyValue).push(row);
  }
}

function schoolCampusMetadataFor(row, school = row) {
  const key = schoolCampusMetadataKey(
    school?.district,
    school?.school_number,
    row?.osm_type,
    row?.osm_id
  );
  return key ? state.schoolCampusMetadataByKey.get(key) || null : null;
}

function clearSchoolFeatureCache() {
  for (const row of [...state.schools, ...state.scanSchools, ...state.schoolCampuses]) {
    if (row) row._schoolFeature = null;
  }
}

function buildSchoolCampusIndex(osmRows) {
  state.schoolCampuses = [];
  state.schoolCampusesBySchoolKey.clear();
  const rowsByNumber = schoolRowsByNumber();
  const seen = new Set();

  for (const osmRow of osmRows || []) {
    const number = normalizeSchoolNumber(osmRow.school_number_guess);
    const lat = numberValue(osmRow.lat);
    const lon = numberValue(osmRow.lon);
    if (!number || lat == null || lon == null) continue;

    for (const school of rowsByNumber.get(number) || []) {
      const key = schoolKey(school);
      if (!key) continue;
      const districtGeometry = state.districtGeometryByName.get(school.district);
      if (districtGeometry && !pointInGeometry(lon, lat, districtGeometry)) continue;

      const campusId = `${key}::osm::${osmRow.osm_type || ""}::${osmRow.osm_id || ""}`;
      if (seen.has(campusId)) continue;
      const existingCampuses = state.schoolCampusesBySchoolKey.get(key) || [];
      if (schoolCampusDuplicate(lat, lon, school, existingCampuses)) continue;
      const metadata = schoolCampusMetadataFor(osmRow, school);

      const campus = {
        ...school,
        _schoolFeature: null,
        _schoolKey: key,
        _isSchoolCampus: Boolean(metadata),
        _isOsmSchoolCandidate: !metadata,
        _pointKind: metadata ? "school_campus" : "osm_school_candidate",
        _campusId: campusId,
        _campusLabel: metadata?.campus_label || osmRow.name || osmRow.official_name || "возможный объект OSM",
        _campusAddress: metadata?.campus_address || "",
        _campusSourceUrl: metadata?.source_url || "",
        _lat: lat,
        _lon: lon,
        _hasCoordinates: true,
        lat: osmRow.lat,
        lon: osmRow.lon,
        display_name: osmRow.name || osmRow.official_name || school.display_name || "",
        geocoder_display_name: osmRow.name || osmRow.official_name || school.geocoder_display_name || "",
        coordinate_source: metadata ? "verified_school_campus" : "osm_school_candidate",
        osm_type: osmRow.osm_type || "",
        osm_id: osmRow.osm_id || ""
      };
      seen.add(campusId);
      existingCampuses.push(campus);
      state.schoolCampusesBySchoolKey.set(key, existingCampuses);
      state.schoolCampuses.push(campus);
    }
  }
  updateDebugDataset();
}

function meaningfulSearchTokens(value) {
  return meaningfulSearchTokensFromNormalized(normalizeSearchValue(value));
}

function meaningfulSearchTokensFromNormalized(value) {
  return uniqueBy(
    String(value || "")
      .split(/\s+/)
      .filter((token) => /\d/.test(token) || token.length >= 2)
      .filter((token) => !["ул", "пр", "пер", "наб", "прд", "ш", "бл", "пл", "ал"].includes(token)),
    (token) => token
  );
}

function addPosting(postings, key, index) {
  if (!key) return;
  if (!postings.has(key)) postings.set(key, []);
  const bucket = postings.get(key);
  if (bucket[bucket.length - 1] !== index) bucket.push(index);
}

function buildSearchPostings(entries, textKey) {
  const byToken = new Map();
  entries.forEach((entry, index) => {
    const tokens = meaningfulSearchTokensFromNormalized(entry[textKey]);
    for (const token of tokens) {
      addPosting(byToken, token, index);
    }
  });
  return {
    byToken,
    vocabulary: [...byToken.keys()].filter((token) => !/\d/.test(token)).sort()
  };
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function postingIndexesForToken(postings, token) {
  if (/\d/.test(token)) return postings.byToken.get(token) || [];
  const start = lowerBound(postings.vocabulary, token);
  const indexes = new Set();
  for (let position = start; position < postings.vocabulary.length; position += 1) {
    const vocabularyToken = postings.vocabulary[position];
    if (!vocabularyToken.startsWith(token)) break;
    for (const index of postings.byToken.get(vocabularyToken) || []) indexes.add(index);
  }
  return [...indexes];
}

function indexedSearchEntries(entries, postings, value) {
  const tokens = meaningfulSearchTokens(value);
  if (!tokens.length) return [];
  const buckets = tokens.map((token) => postingIndexesForToken(postings, token));
  if (buckets.some((bucket) => bucket.length === 0)) return [];
  const smallest = buckets.reduce((left, right) => left.length <= right.length ? left : right);
  return smallest.map((index) => entries[index]);
}

function boundedSorted(items, limit, compare) {
  if (limit <= 0) return [];
  const best = [];
  for (const item of items) {
    let low = 0;
    let high = best.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compare(item, best[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    if (low >= limit) continue;
    best.splice(low, 0, item);
    if (best.length > limit) best.pop();
  }
  return best;
}

function schoolSearchText(row) {
  if (row?._schoolSearchText) return row._schoolSearchText;
  const confirmedCampuses = state.schoolCampusMetadataBySchoolKey.get(schoolKey(row)) || [];
  row._schoolSearchText = normalizeSearchValue([
    normalizeSchoolNumber(row?.school_number),
    compactSchoolTitle(row),
    schoolName(row),
    row?.school_name_raw,
    row?.display_name,
    row?.official_address,
    row?.address,
    row?.official_kind,
    schoolTypeLabel(row),
    row?.district,
    ...confirmedCampuses.flatMap((campus) => [campus.campus_label, campus.campus_address])
  ].join(" "));
  return row._schoolSearchText;
}

function schoolBuildingAddresses(row) {
  const confirmedCampuses = state.schoolCampusMetadataBySchoolKey.get(schoolKey(row)) || [];
  const sources = confirmedCampuses.length
    ? confirmedCampuses.map((campus) => campus.campus_address)
    : [row?.official_address || row?.address || ""];
  return uniqueBy(
    sources
      .filter(Boolean)
      // A school building can have a locality-only address or several campuses.
      // The residential address formatter can drop parts after the first two
      // commas, so keep the actual building address intact here.
      .map((address) => String(address).trim().replace(/\s+/g, " ")),
    (address) => normalizeSearchValue(address)
  );
}

function buildAddressSearchIndex() {
  const addressEntries = dedupeAddressRows(state.addresses).map((row, sourceOrdinal) => ({
    row,
    sourceOrdinal,
    sortRow: row,
    searchText: searchableAddressText(row)
  }));
  state.addressSearchEntries = addressEntries;
  state.addressSearchPostings = buildSearchPostings(addressEntries, "searchText");
  state.addressSearchOverlays.clear();
  state.addressSearchNextOrdinal = addressEntries.length;
  state.addressCountByDistrict.clear();
  const cityKeys = new Set();
  const districtKeys = new Map();
  for (const { row } of addressEntries) {
    const identity = addressDedupeKey(row);
    cityKeys.add(`${row.district || ""}::${identity}`);
    if (!districtKeys.has(row.district || "")) districtKeys.set(row.district || "", new Set());
    districtKeys.get(row.district || "").add(identity);
  }
  state.addressCountByDistrict.set("", cityKeys.size);
  districtKeys.forEach((keys, district) => state.addressCountByDistrict.set(district, keys.size));
  state.searchIndexGeneration += 1;
}

function buildAddressSearchOverlay(district) {
  const baseByIdentity = new Map(
    state.addressSearchEntries
      .filter(({ row }) => row.district === district)
      .map((entry) => [addressDedupeKey(entry.row), entry])
  );
  const entries = dedupeAddressRows(state.addresses.filter((row) => row.district === district))
    .map((row) => {
      const base = baseByIdentity.get(addressDedupeKey(row));
      if (base) {
        const detailSearchText = row._detailSearchableAddressText || searchableAddressText(row);
        row._detailSearchableAddressText = detailSearchText;
        row._searchableAddressText = `${base.searchText} ${detailSearchText}`.replace(/\s+/g, " ").trim();
        row._baseHouseTokens = uniqueBy(
          [...rowHouseTokens(row), ...rowHouseTokens(base.row)],
          (token) => token
        );
        row._baseHouseToken = row._baseHouseTokens[0] || "";
      }
      return {
        row,
        sourceOrdinal: base?.sourceOrdinal ?? state.addressSearchNextOrdinal++,
        sortRow: base?.sortRow || base?.row || row,
        searchText: searchableAddressText(row)
      };
    });
  state.addressSearchOverlays.set(district, {
    entries,
    postings: buildSearchPostings(entries, "searchText")
  });
  const previousDistrictCount = state.addressCountByDistrict.get(district) || 0;
  const previousCityCount = state.addressCountByDistrict.get("") || 0;
  state.addressCountByDistrict.set(district, entries.length);
  state.addressCountByDistrict.set("", previousCityCount - previousDistrictCount + entries.length);
  state.searchIndexGeneration += 1;
}

function indexedAddressSearchEntries(value, district = "") {
  const matches = [];
  const overlayDistricts = state.addressSearchOverlays;
  if (!district || !overlayDistricts.has(district)) {
    matches.push(...indexedSearchEntries(
      state.addressSearchEntries,
      state.addressSearchPostings,
      value
    ).filter(({ row }) => (
      (!district || row.district === district)
      && !overlayDistricts.has(row.district)
    )));
  }
  const overlays = district
    ? [overlayDistricts.get(district)].filter(Boolean)
    : [...overlayDistricts.values()];
  for (const overlay of overlays) {
    matches.push(...indexedSearchEntries(overlay.entries, overlay.postings, value));
  }
  return matches;
}

function buildSchoolSearchIndex() {
  state.schoolSearchEntries = state.schools.map((row, sourceOrdinal) => ({
    row,
    sourceOrdinal,
    searchText: schoolSearchText(row)
  }));
  state.schoolSearchPostings = buildSearchPostings(state.schoolSearchEntries, "searchText");
  state.searchIndexGeneration += 1;
}

function searchAddressCandidates(value, limit = searchResultLimit) {
  const query = normalizeSearchValue(value);
  const tokens = query.split(/\s+/).filter(Boolean);
  const houseToken = queryHouseToken(value);
  if (tokens.length < 2 || !tokens.some((token) => /\d/.test(token))) return [];
  const district = selectedDistrict();
  const indexed = indexedAddressSearchEntries(value, district);
  const scored = indexed
    .map((entry) => ({ ...entry, score: addressSearchScore(entry.row, query, tokens, houseToken) }))
    .filter((entry) => entry.score >= 0);
  return boundedSorted(scored, limit, (left, right) => (
      right.score - left.score
      || addressTitle(left.sortRow || left.row).localeCompare(addressTitle(right.sortRow || right.row), "ru")
      || left.sourceOrdinal - right.sourceOrdinal
    ))
    .map((entry) => entry.row);
}

function isLocalityTerritory(feature) {
  return feature?.properties?.address_unit === "locality_territory";
}

function mergeTerritoryCatalogs(catalogs) {
  const features = [], ids = new Set();
  for (const catalog of catalogs) {
    if (catalog?.type !== "FeatureCollection" || !Array.isArray(catalog.features)) throw new Error("Каталог территорий недоступен");
    for (const feature of catalog.features) {
      const id = feature.properties?.territory_id;
      if (!id || ids.has(id)) throw new Error("Повтор или отсутствующий идентификатор территории");
      ids.add(id);
      features.push(feature);
    }
  }
  return featureCollection(features);
}

function schoolLocalityTerritories(row) {
  return state.gardenTerritories.filter(feature => isLocalityTerritory(feature)
    && feature.properties.district === row.district
    && feature.properties.school_numbers.includes(normalizeSchoolNumber(row.school_number)));
}

function gardenNameKey(value) {
  return normalizeSearchValue(String(value ?? "").split("·")[0])
    .replace(/^(?:снт|сдт|ст|садоводство)\s+/u, "")
    .replace(/[^а-яa-z0-9]+/gu, "");
}

function gardenSearchCandidates(value, limit = searchResultLimit, preferDistrict = false) {
  const query = gardenNameKey(value);
  if (query.length < 3) return [];
  const district = selectedDistrict();
  return [...state.gardenTerritories, ...state.sourceOnlyGardenTerritories]
    .filter((feature) => preferDistrict || !district || feature.properties.district === district)
    .map((feature) => ({
      feature,
      key: gardenNameKey(feature.properties.name),
      score: gardenNameKey(feature.properties.name) === query ? 2 : 1
    }))
    .filter(({ key }) => key.includes(query))
    .sort((left, right) => (preferDistrict && district ? Number(right.feature.properties.district === district) - Number(left.feature.properties.district === district) : 0) || right.score - left.score
      || left.feature.properties.name.localeCompare(right.feature.properties.name, "ru"))
    .slice(0, limit)
    .map(({ feature }) => feature);
}

function gardenSearchLabel(feature) {
  const props = feature.properties;
  const name = isLocalityTerritory(feature) || /^(?:снт|сдт|ст|садоводство|(?:коллективное\s+)?огородничество)(?=\s|$)/iu.test(props.name) ? props.name : `СНТ ${props.name}`;
  return props.municipality ? `${name} · ${props.municipality}` : name;
}

function schoolSearchScore(row, value) {
  const query = normalizeSearchValue(value);
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.length) return -1;
  const text = schoolSearchText(row);
  if (!tokens.every((token) => tokenMatchesSearchText(text, token))) return -1;
  const number = normalizeSchoolNumber(row.school_number);
  const queryNumber = value.match(/\d+/)?.[0] || "";
  let score = tokens.length * 10;
  if (queryNumber && number === queryNumber) score += 1800;
  if (normalizeSearchValue(compactSchoolTitle(row)) === query) score += 1100;
  if (normalizeSearchValue(schoolName(row)) === query) score += 1000;
  if (normalizeSearchValue(row.official_address || row.address || "") === query) score += 900;
  if (text.includes(query)) score += 350;
  return score;
}

function searchSchoolCandidates(value, limit = searchResultLimit, preferDistrict = false) {
  const district = selectedDistrict();
  const indexed = indexedSearchEntries(
    state.schoolSearchEntries,
    state.schoolSearchPostings,
    value
  );
  const scored = indexed
    .filter(({ row }) => preferDistrict || !district || row.district === district)
    .map((entry) => ({ ...entry, score: schoolSearchScore(entry.row, value) }))
    .filter((entry) => entry.score >= 0);
  return boundedSorted(scored, limit, (left, right) => {
      if (preferDistrict && district) {
        const priority = Number(right.row.district === district) - Number(left.row.district === district);
        if (priority) return priority;
      }
      if (right.score !== left.score) return right.score - left.score;
      const districtCompare = String(left.row.district || "").localeCompare(String(right.row.district || ""), "ru");
      if (districtCompare) return districtCompare;
      const leftNumber = Number(normalizeSchoolNumber(left.row.school_number));
      const rightNumber = Number(normalizeSchoolNumber(right.row.school_number));
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
      return left.sourceOrdinal - right.sourceOrdinal;
    })
    .map((entry) => entry.row);
}

function addressSearchScore(row, query, tokens, houseToken = "") {
  const title = row._addressTitleSearch || normalizeSearchValue(addressTitle(row));
  const text = searchableAddressText(row);
  if (!tokens.every((token) => tokenMatchesSearchText(text, token))) return -1;
  if (!rowMatchesHouseToken(row, houseToken)) return -1;
  let score = tokens.length * 10;
  if (houseToken && rowMatchesHouseToken(row, houseToken)) score += 1200;
  if (title === query) score += 1000;
  else if (text === query) score += 900;
  else if (title.includes(query)) score += 650;
  else if (text.includes(query)) score += 400;
  if (hasCoordinates(row)) score += 5;
  if (row.assignment_status === "current_conflict") score -= 2;
  return score;
}

function findAddressByFreeText(value) {
  const query = normalizeSearchValue(value);
  const tokens = query.split(/\s+/).filter(Boolean);
  const houseToken = queryHouseToken(value);
  if (tokens.length < 2 || !tokens.some((token) => /\d/.test(token))) return null;
  let rows = searchAddressCandidates(value, 4);
  if (!rows.length) {
    rows = dedupeAddressRows(state.addresses.filter(addressMatchesBaseFilters));
  }
  let best = null;
  let bestScore = -1;
  let secondScore = -1;
  for (const row of rows) {
    const score = addressSearchScore(row, query, tokens, houseToken);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = row;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (!best || bestScore < 400) return null;
  if (secondScore >= 0 && bestScore - secondScore < 25) return null;
  return best;
}

function matchingSchoolKeysForAddressQuery() {
  return null;
}

function schoolMatchesBaseFilters(row) {
  const district = selectedDistrict();
  if (district && row.district !== district) return false;
  return true;
}

function schoolMatchesFilters(row, matchingSchoolKeys = null) {
  if (!controlChecked("toggleSchools")) return false;
  return schoolMatchesBaseFilters(row);
}

function setSourceData(sourceId, data) {
  const source = state.map.getSource(sourceId);
  if (!source) return;
  const payload = data || emptyFeatureCollection;
  if (VIEWER_API?.isStaticDelivery) {
    // MapLibre serializes these GeoJSON overlays for its worker. Re-submitting
    // identical content rebuilds tile/mesh buffers during a card-only change.
    // Keep one serialized identity per live source, including the empty case.
    const identity = JSON.stringify(payload);
    if (sourceDataPayloads.get(source) === identity) return;
    source.setData(payload);
    sourceDataPayloads.set(source, identity);
  } else source.setData(payload);
}

function addressFeature(row) {
  if (!hasMapCoordinates(row)) return null;
  if (row?._addressFeature) return row._addressFeature;
  const lat = row?._lat ?? numberValue(row.lat);
  const lon = row?._lon ?? numberValue(row.lon);
  const schoolCount = row?._currentSchoolCount ?? addressSchoolKeys(row).length;
  const feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      address_id: row.address_id || "",
      address_key: row.address_key || "",
      district: row.district || "",
      district_color: colorForDistrict(row.district || ""),
      coordinate_precision: row.coordinate_precision || "",
      current_school_count: schoolCount,
      multi_school: schoolCount > 1 ? "yes" : "no"
    }
  };
  if (row) row._addressFeature = feature;
  return feature;
}

function schoolFallbackPoint(row) {
  const key = schoolKey(row);
  return key ? state.schoolFallbackPointByKey.get(key) : null;
}

function schoolFeature(row) {
  if (row?._schoolFeature) return row._schoolFeature;
  const fallbackPoint = schoolFallbackPoint(row);
  const campusMetadata = schoolCampusMetadataFor(row);
  const isVerifiedCampus = Boolean(row?._isSchoolCampus || campusMetadata);
  const campusLabel = row?._campusLabel || campusMetadata?.campus_label || "";
  const hasExactPoint = hasCoordinates(row);
  const lat = hasExactPoint ? (row?._lat ?? numberValue(row.lat)) : numberValue(fallbackPoint?.lat);
  const lon = hasExactPoint ? (row?._lon ?? numberValue(row.lon)) : numberValue(fallbackPoint?.lon);
  if (lat == null || lon == null) return null;
  const typeStyle = schoolTypeStyle(row);
  const feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      school_key: schoolKey(row),
      district: row.district || "",
      school_number: row.school_number || "",
      canonical_school_name: compactSchoolTitle(row),
      school_name_raw: row.school_name_raw || "",
      school_type_group: schoolTypeGroup(row),
      school_type_label: schoolTypeLabel(row),
      school_type_color: typeStyle.color,
      school_type_stroke: typeStyle.stroke,
      point_kind: row?._pointKind || (hasExactPoint ? "exact_school" : "address_centroid"),
      is_school_campus: isVerifiedCampus ? "yes" : "no",
      campus_evidence_status: row?._isOsmSchoolCandidate ? "osm_candidate" : (isVerifiedCampus ? "verified" : "official_school_point"),
      campus_id: row?._campusId || "",
      campus_label: row?._isOsmSchoolCandidate && campusLabel
        ? `Возможный объект OSM: ${campusLabel}`
        : campusLabel,
      campus_address: row?._campusAddress || campusMetadata?.campus_address || "",
      campus_source_url: row?._campusSourceUrl || campusMetadata?.source_url || "",
      address_point_count: fallbackPoint?.count || "",
      geocoder_display_name: row.geocoder_display_name || "",
      display_name: row.display_name || "",
      osm_type: row.osm_type || "",
      osm_id: row.osm_id || ""
    }
  };
  if (row) row._schoolFeature = feature;
  return feature;
}

function schoolMapFeatures(row) {
  const features = [];
  const mainFeature = schoolFeature(row);
  if (mainFeature) features.push(mainFeature);
  const key = schoolKey(row);
  for (const campus of key ? state.schoolCampusesBySchoolKey.get(key) || [] : []) {
    const campusFeature = schoolFeature(campus);
    if (campusFeature) features.push(campusFeature);
  }
  return features;
}

function featureCollection(features) {
  return { type: "FeatureCollection", features };
}

function addressRowsForMap(rows) {
  if (selectedDistrict() || !state.map) return rows;
  if (state.map.getZoom() < ALL_DISTRICTS_ADDRESS_MIN_ZOOM) return [];
  const bounds = state.map.getBounds();
  return rows.filter((row) => {
    if (!hasMapCoordinates(row)) return false;
    const lon = row._lon ?? numberValue(row.lon);
    const lat = row._lat ?? numberValue(row.lat);
    return lon >= bounds.getWest() && lon <= bounds.getEast() && lat >= bounds.getSouth() && lat <= bounds.getNorth();
  });
}

function renderAddresses(rows) {
  // Homes are lookup results, never an overview or a school's point cloud.
  setSourceData("addresses", emptyFeatureCollection);
  document.documentElement.dataset.overviewHomePins = "0";
  return 0;
}

function renderSchools(rows, matchingSchoolKeys = null) {
  const features = [];
  let shownSchools = 0;
  const activeKeys = activeSchoolKeysForSelection(false);
  const focused = hasMapSelection();
  for (const row of rows) {
    if (!schoolMatchesFilters(row, matchingSchoolKeys)) continue;
    shownSchools += 1;
    if (focused && !activeKeys.has(schoolKey(row))) continue;
    for (const feature of schoolMapFeatures(row)) {
      features.push(cloneFeatureWithProps(feature, { selection_state: selectionStateForSchool(row, activeKeys) }));
    }
  }
  setSourceData("schools", featureCollection(features));
  state.schoolBadges?.update(features, activeKeys);
  return shownSchools;
}

// Individual school capsules scale with zoom and use one colour per district.
class SchoolCapsules {
  constructor(map) {
    this.map = map;
    this.selectKey = key => selectSchoolFromMap(key);
    this.features = [];
    this.active = new Set();
    this.buttons = new Map();
    this.buttonPool = [];
    this.buttonPoolLimit = 768;
    this.root = document.createElement("div");
    this.root.className = "school-capsules";
    this.root.setAttribute("aria-label", "Школы на карте");
    map.getContainer().append(this.root);
    this.schedule = () => {
      if (!this.frame) this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
    };
    map.on("move", this.schedule);
    map.on("resize", this.schedule);
    map.on("remove", () => {
      cancelAnimationFrame(this.frame);
      this.root.remove();
      this.buttons.clear();
      this.buttonPool.length = 0;
    });
  }

  update(features, active) {
    this.features = features;
    this.active = active;
    this.schedule();
  }

  render() {
    const width = this.root.clientWidth, height = this.root.clientHeight;
    if (!width || !height) return;
    const seen = new Set();
    const focused = hasMapSelection();
    const zoom = this.map.getZoom();
    const sparseBadges = zoom < 10.4 && !focused;
    const scale = Math.min(1, Math.max(0.36, 0.36 + (zoom - 9) * 0.107));
    if (this.scale !== scale) {
      this.root.style.setProperty("--capsule-scale", String(scale));
      this.scale = scale;
    }
    for (const feature of this.features) {
      const key = feature.properties.school_key;
      if (seen.has(key) || (focused && !this.active.has(key)) || (sparseBadges && !this.active.has(key))) continue;
      const point = this.map.project(feature.geometry.coordinates);
      if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) continue;
      seen.add(key);
      const first = feature.properties;
      let button = this.buttons.get(key);
      if (!button) {
        button = this.buttonPool.pop();
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.className = "school-capsule";
          button.innerHTML = '<span class="school-capsule-face"></span>';
          button.addEventListener("click", event => {
            event.stopPropagation();
            this.selectKey(event.currentTarget.dataset.schoolKey);
          });
        }
        button.dataset.schoolKey = key;
        this.buttons.set(key, button);
        this.root.append(button);
      }
      const active = this.active.has(key);
      button.classList.toggle("is-active", active);
      button.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%) scale(var(--capsule-scale, 1))`;
      if (button.dataset.district !== first.district) button.dataset.district = first.district;
      const color = colorForDistrict(first.district);
      if (button._capsuleColor !== color) {
        button.style.setProperty("--district-color", color);
        button._capsuleColor = color;
      }
      const number = String(first.school_number || "Ш");
      if (button.firstElementChild.textContent !== number) button.firstElementChild.textContent = number;
      const label = `${first.canonical_school_name || number} · ${first.district}`;
      if (button.title !== label) {
        button.setAttribute("aria-label", label);
        button.title = label;
      }
      const pressed = String(active);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
    for (const [key, button] of this.buttons) if (!seen.has(key)) {
      button.remove();
      this.buttons.delete(key);
      if (this.buttonPool.length < this.buttonPoolLimit) this.buttonPool.push(button);
    }
    this.root.dataset.schools = String(seen.size);
    this.root.dataset.badges = String(this.buttons.size);
  }
}

class SharedAreaCounters extends SchoolCapsules {
  constructor(map) {
    super(map);
    this.root.className = 'school-capsules shared-area-counters';
    this.root.setAttribute('aria-label', 'Общие территории школ');
    this.selectKey = key => {
      const feature = state.schoolAreaTiles?.byFID.get(key)
        || state.sharedSchoolSections.features.find(item => item.properties.shared_area_key === key);
      if (feature) selectAreaFromMap(feature,this.features.find(item=>item.properties.school_key===key)?.geometry.coordinates);
    };
    map.on('idle', () => this.refresh());
  }

  refresh() {
    const layout = window.schoolAreaTileModule?.sharedAreaBadgeCandidates;
    if (!layout || !controlChecked('toggleAreas') || !this.map.getLayer(layerIds.sharedSchoolSectionsFill)) {
      this.update([], new Set());
      return;
    }
    const width = this.root.clientWidth, height = this.root.clientHeight;
    const schools = (state.schoolBadges?.features || []).map(feature => this.map.project(feature.geometry.coordinates))
      .filter(point => point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height);
    const candidates = layout(this.map.queryRenderedFeatures({ layers: [layerIds.sharedSchoolSectionsFill] }),
      mapFeatureProperties, point => this.map.project(point), width, height, 48, schools);
    this.update(candidates.map(item => {
      const point = this.map.unproject([item.x, item.y]);
      const count = item.members.length;
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [point.lng, point.lat] }, properties: {
        school_key: item.key, district: item.properties.district,
        school_number: `∩${count}`,
        canonical_school_name: `Пересечение расчётных областей ${count} ${ruPlural(count, 'школы', 'школ', 'школ')}: ${item.members.map(key => {
          const school = state.schoolByKey.get(key);
          return school ? compactSchoolTitle(school) : key.split('::').slice(1).join('::');
        }).join(', ')}. Закрепление каждого дома — в таблице`
      } };
    }), new Set(selectedSharedArea() ? [selectedSharedArea().key] : []));
  }

  render() {
    // In school comparison mode the school badge is sufficient.
    const hidden = Boolean(state.selectedSchoolKey || state.selectedAddressId || state.selectedGardenId || !controlChecked('toggleAreas'));
    this.root.hidden = hidden;
    if (!hidden) {
      this.active = new Set(selectedSharedArea() ? [selectedSharedArea().key] : []);
      super.render();
    }
  }
}

function schoolLikeForAssignment(item) {
  const key = assignmentSchoolKey(item);
  return state.schoolByKey.get(key) || state.scanSchoolByKey.get(key) || {
    school_id: item.school_id || "",
    district: item.district || "",
    school_number: item.school_number || ""
  };
}

function selectedSchoolsForAddress(row) {
  const current = currentAddressAssignments(row);
  const rows = current.length ? current.map(schoolLikeForAssignment) : [schoolForAddress(row)];
  return uniqueBy(
    rows.filter(Boolean),
    (school) => schoolKey(school) || districtSchoolKey(school.district, school.school_number)
  );
}

function selectedSchoolsForArea() {
  const area = selectedSharedArea();
  if (area) return [...activeSchoolKeysForSelection(false)].map(key => state.schoolByKey.get(key)).filter(Boolean);
  const school = selectedSchoolRow();
  if (school) return [school];
  const territory = state.gardenById.get(state.selectedGardenId);
  if (territory) return territory.properties.school_numbers.map(number => state.schoolByKey.get(districtSchoolKey(territory.properties.district, number))).filter(Boolean);
  const address = selectedAddressRow() || hoverAddressRow();
  if (address) return selectedSchoolsForAddress(address);
  if (state.hoverSchoolKey) return [state.schoolByKey.get(state.hoverSchoolKey)].filter(Boolean);
  if (state.hoverSharedSchoolKeys.size) {
    return [...state.hoverSharedSchoolKeys].map((key) => state.schoolByKey.get(key)).filter(Boolean);
  }
  return [];
}

function currentGeocodedAddressRowsForSchool(school) {
  const key = schoolKey(school) || districtSchoolKey(school?.district, school?.school_number);
  if (!key) return [];
  const indexed = state.currentGeocodedAddressesBySchoolKey.get(key);
  if (indexed) return indexed;
  return dedupeAddressRows(state.addresses.filter((row) => isAddressCurrent(row) && hasMapCoordinates(row) && sameSchool(row, key)));
}

function hasMapSelection() {
  return Boolean(state.selectedSchoolKey || state.selectedAddressId || state.selectedGardenId || selectedSharedArea());
}

function activeSchoolKeysForSelection(includeHover = true) {
  const shared = selectedSharedArea();
  if (shared) return new Set(comparisonSchoolKey ? [comparisonSchoolKey] : shared.schoolKeys);
  const keys = new Set();
  const territory = state.gardenById.get(state.selectedGardenId);
  if (territory) territory.properties.school_numbers.forEach(number => keys.add(districtSchoolKey(territory.properties.district, number)));
  if (state.selectedSchoolKey) keys.add(state.selectedSchoolKey);
  const allowHover = includeHover && !hasMapSelection();
  if (allowHover && state.hoverSchoolKey) keys.add(state.hoverSchoolKey);
  if (allowHover) {
    state.hoverSharedSchoolKeys.forEach((key) => keys.add(key));
  }
  const address = selectedAddressRow() || (allowHover ? hoverAddressRow() : null);
  if (address) {
    const assignments = currentAddressAssignments(address);
    if (assignments.length) assignments.map(assignmentSchoolKey).filter(Boolean).forEach((key) => keys.add(key));
    else addressSchoolKeys(address).forEach((key) => keys.add(key));
  }
  return keys;
}

function selectionStateForAddress(row, activeKeys = null) {
  if ((state.selectedAddressId && row.address_id === state.selectedAddressId)
    || (state.focusedSchoolAddressId && row.address_id === state.focusedSchoolAddressId)) return "active";
  const keys = activeKeys || activeSchoolKeysForSelection();
  if (!keys.size) return "normal";
  return addressSchoolKeys(row).some((key) => keys.has(key)) ? "related" : "dim";
}

function selectionStateForSchool(row, activeKeys = null) {
  const key = schoolKey(row);
  const keys = activeKeys || activeSchoolKeysForSelection();
  if (!keys.size) return "normal";
  return keys.has(key) ? "active" : "dim";
}

function cloneFeatureWithProps(feature, props) {
  return {
    ...feature,
    properties: {
      ...(feature.properties || {}),
      ...props
    }
  };
}

function sectionMatchesFilters(feature) {
  if (!controlChecked("toggleAreas")) return false;
  const district = selectedDistrict();
  return !district || feature.properties?.district === district;
}

function sharedSectionMemberKeys(feature) {
  const properties = mapFeatureProperties(feature);
  return uniqueBy(
    String(properties.shared_member_school_keys || "")
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean),
    (key) => key
  );
}

function mapFeatureProperties(feature) {
  return state.schoolAreaTiles?.propertiesForFeature(feature) || feature?.properties || {};
}

function sharedSectionMatchesFilters(feature) {
  if (!controlChecked("toggleAreas")) return false;
  const district = selectedDistrict();
  if (!district) return true;
  return feature.properties?.district === district
    || sharedSectionMemberKeys(feature).some((key) => key.split("::", 1)[0] === district);
}

function selectionStateForSection(feature, activeKeys = null) {
  const keys = activeKeys || activeSchoolKeysForSelection();
  if (!keys.size) return "normal";
  return keys.has(feature.properties?.school_key) ? "active" : "dim";
}

function selectedSectionFeatures() {
  const keys = activeSchoolKeysForSelection();
  if (!keys.size) return [];
  if (state.schoolAreaTiles) return controlChecked("toggleAreas")
    ? state.schoolAreaTiles.selectedFeatures(keys, selectedDistrict()) : [];
  const exclusive = (state.schoolSections.features || []).filter((feature) => (
    sectionMatchesFilters(feature) && keys.has(feature.properties?.school_key)
  ));
  const shared = (state.sharedSchoolSections.features || []).filter((feature) => (
    sharedSectionMatchesFilters(feature)
      && sharedSectionMemberKeys(feature).some((key) => keys.has(key))
  ));
  return [...exclusive, ...shared];
}

function renderDistrictBoundaries() {
  const district = selectedDistrict();
  const hasSchoolFocus = activeSchoolKeysForSelection(false).size > 0;
  const features = (state.districtBoundaries.features || []).map((feature) => cloneFeatureWithProps(feature, {
    selection_state: hasSchoolFocus || (district && feature.properties?.district !== district) ? "dim" : "normal",
    is_selected_district: district && feature.properties?.district === district ? "yes" : "no"
  }));
  setSourceData("districtBoundaries", featureCollection(features));
}

function renderSchoolSections() {
  if (state.schoolAreaTiles) {
    state.schoolAreaTiles.updateVisibility(selectedDistrict(), controlChecked("toggleAreas"));
    syncSchoolAreaFeatureStates();
    return;
  }
  const renderKey = [
    state.schoolSectionsRevision,
    selectedDistrict(),
    controlChecked("toggleAreas") ? "on" : "off"
  ].join("|");
  if (renderKey === state.renderedSchoolSectionKey) {
    syncSchoolAreaFeatureStates();
    return;
  }
  const features = [];
  const schoolFeatures = [];
  const sharedFeatures = [];
  const labelFeatures = [];
  for (const feature of state.schoolSections.features || []) {
    if (!sectionMatchesFilters(feature)) continue;
    const rendered = cloneFeatureWithProps(feature, {
      selection_state: "normal",
      area_label_icon: schoolAreaLabelImageId(feature.properties?.school_number)
    });
    schoolFeatures.push(rendered);
    features.push(rendered);
    const lon = Number(feature.properties?.area_label_lon);
    const lat = Number(feature.properties?.area_label_lat);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      labelFeatures.push({
        type: "Feature",
        properties: rendered.properties,
        geometry: { type: "Point", coordinates: [lon, lat] }
      });
    }
  }
  for (const feature of state.sharedSchoolSections.features || []) {
    if (!sharedSectionMatchesFilters(feature)) continue;
    sharedFeatures.push(cloneFeatureWithProps(feature, { selection_state: "normal" }));
  }
  registerSchoolAreaNumberIcons(schoolFeatures);
  state.renderedSchoolSectionKeys = uniqueBy(
    schoolFeatures.map((feature) => feature.properties?.school_key).filter(Boolean),
    (key) => key
  );
  state.renderedSharedSectionKeys = uniqueBy(
    sharedFeatures.map((feature) => feature.properties?.shared_area_key).filter(Boolean),
    (key) => key
  );
  updateRenderedAreaDebugDataset(schoolFeatures);
  document.documentElement.dataset.renderedSharedSchoolAreaFeatures = String(sharedFeatures.length);
  state.activeAreaFeatureKeys = new Set();
  state.areaSelectionFocused = false;
  state.activeSharedAreaFeatureKeys = new Set();
  setSourceData("schoolSections", featureCollection(features));
  setSourceData("sharedSchoolSections", featureCollection(sharedFeatures));
  setSourceData("schoolSectionLabels", featureCollection(labelFeatures));
  state.renderedSchoolSectionKey = renderKey;
  window.requestAnimationFrame(() => syncSchoolAreaFeatureStates());
}

function syncSchoolAreaFeatureStates(force = false) {
  if (state.schoolAreaTiles) {
    const scope = selectedSharedArea();
    const hideTiles = Boolean(state.selectedGardenId);
    state.schoolAreaTiles.select(hideTiles ? new Set() : activeSchoolKeysForSelection(), {
      focusOnly: hasMapSelection(),
      highlight: !(scope && VIEWER_BOOTSTRAP?.area_scope_index && supportsSharedComparison(scope))
    });
    state.schoolAreaTiles.selectComponent(scope?.geometry && controlChecked('toggleAreas')
      ? {type:'Feature',properties:{selected_component:true},geometry:scope.geometry} : null,
      scope?.geometry && controlChecked('toggleAreas') ? sharedComparisonIdentity(scope) : '');
    document.documentElement.dataset.activeSchoolAreaFeatures = String(state.schoolAreaTiles.active.size);
    return;
  }
  if (!state.map?.getSource?.("schoolSections")) return;
  const selectedArea = selectedSharedArea();
  const nextKeys = state.selectedGardenId ? new Set() : activeSchoolKeysForSelection();
  const nextHasFocus = Boolean(selectedArea || state.selectedGardenId) || (hasMapSelection() && nextKeys.size > 0);
  const unchanged = nextHasFocus === Boolean(state.areaSelectionFocused)
    && (state.activeSelectedSharedAreaKey || '') === (selectedArea?.key || '')
    && nextKeys.size === state.activeAreaFeatureKeys.size
    && [...nextKeys].every((key) => state.activeAreaFeatureKeys.has(key));
  if (!force && unchanged) return;
  const previousKeys = state.activeAreaFeatureKeys;
  const previousHasFocus = Boolean(state.areaSelectionFocused);
  const keysToUpdate = force || previousHasFocus !== nextHasFocus
    ? state.renderedSchoolSectionKeys
    : state.renderedSchoolSectionKeys.filter(
      (key) => previousKeys.has(key) !== nextKeys.has(key)
    );
  for (const key of keysToUpdate) {
    try {
      const highlighted = nextKeys.has(key);
      state.map.setFeatureState(
        { source: "schoolSections", id: key },
        { highlighted, dimmed: nextHasFocus && !highlighted }
      );
      state.map.setFeatureState(
        { source: "schoolSectionLabels", id: key },
        { highlighted, dimmed: nextHasFocus && !highlighted }
      );
    } catch (error) {
      // The source may be replaced while a district package is loading.
    }
  }
  const nextSharedKeys = new Set(
    (state.sharedSchoolSections.features || [])
      .filter((feature) => sharedSectionMatchesFilters(feature))
      .filter((feature) => sharedSectionMemberKeys(feature).some((key) => nextKeys.has(key)))
      .map((feature) => feature.properties?.shared_area_key)
      .filter(Boolean)
  );
  for (const key of state.renderedSharedSectionKeys) {
    try {
      const highlighted = nextSharedKeys.has(key);
      state.map.setFeatureState(
        { source: "sharedSchoolSections", id: key },
        { highlighted, dimmed: nextHasFocus && !highlighted }
      );
    } catch (error) {
      // The source may be replaced while a district package is loading.
    }
  }
  state.activeAreaFeatureKeys = new Set(nextKeys);
  state.areaSelectionFocused = nextHasFocus;
  state.activeSharedAreaFeatureKeys = nextSharedKeys;
  state.activeSelectedSharedAreaKey = selectedArea?.key || '';
  document.documentElement.dataset.activeSchoolAreaFeatures = String(
    state.renderedSchoolSectionKeys.filter((key) => nextKeys.has(key)).length
  );
}

function renderSelectionHighlights() {
  const address = selectedAddressRow() || focusedSchoolAddressRow();
  const baseSelectedAddressFeature = address ? addressFeature(address) : null;
  const selectedAddressFeature = baseSelectedAddressFeature
    ? cloneFeatureWithProps(baseSelectedAddressFeature, { selection_state: "active" })
    : null;
  const areaSchools = selectedSchoolsForArea();
  const selectedSchoolFeatures = areaSchools
    .flatMap(schoolMapFeatures)
    .map((feature) => cloneFeatureWithProps(feature, { selection_state: "active" }));
  const comparison=sharedComparisonModel();
  const scopedPoints=currentSharedAreaContext() && comparison ? [...comparison.addresses.values()]
    .filter(row=>hasMapCoordinates(row) && (!comparisonSchoolKey || row.members.has(comparisonSchoolKey)))
    .map(row=>cloneFeatureWithProps(addressFeature(row),{selection_state:'related'})) : [];
  setSourceData("selectedAddresses", featureCollection(scopedPoints));
  setSourceData("selectedAddressPin", featureCollection(selectedAddressFeature ? [selectedAddressFeature] : []));
  document.documentElement.dataset.selectedHomePins = selectedAddressFeature ? "1" : "0";
  document.documentElement.dataset.relatedHomePins = String(scopedPoints.length);
  setSourceData("selectedSchools", featureCollection(selectedSchoolFeatures));
  state.schoolBadges?.update(state.schoolBadges.features, activeSchoolKeysForSelection(false));
  state.sharedAreaBadges?.schedule();
}

function renderGardenTerritories() {
  const district = selectedDistrict();
  const schools = selectedSharedArea() ? selectedSchoolsForArea()
    : selectedAddressRow() ? [] : [selectedSchoolRow()].filter(Boolean);
  const localities = new Set(schools.flatMap(schoolLocalityTerritories));
  const active = feature => feature.properties.territory_id === state.selectedGardenId
    || localities.has(feature);
  const focused = hasMapSelection();
  const visible = state.gardenTerritories.filter(feature => (focused ? active(feature) : isLocalityTerritory(feature))
    && (!district || feature.properties.district === district));
  const boundaries = visible.map(feature => cloneFeatureWithProps(feature, {selection_state: active(feature) ? "active" : "default"}));
  const points = visible.filter(feature => feature.properties.territory_id === state.selectedGardenId).map((feature) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: feature.properties.point },
    properties: {
      territory_id: feature.properties.territory_id,
      name: feature.properties.name,
      selection_state: feature.properties.territory_id === state.selectedGardenId ? "active" : "default"
    }
  }));
  setSourceData("gardenBoundaries", featureCollection(boundaries));
  setSourceData("gardenPoints", featureCollection(points));
  document.documentElement.dataset.gardenTerritoryPoints = String(points.length);
}

function updateStats(addressCount, schoolCount, matchingSchoolKeys = null) {
  const notice = currentSchoolDetailNotice();
  if (notice) {
    document.getElementById('stats').textContent = notice.status === 'loading' ? 'Загружаем данные школы…' : 'Данные школы не загрузились';
    return;
  }
  const district = selectedDistrict();
  const selectedAddress = selectedAddressRow();
  const selectedSchool = selectedSchoolRow();
  if (selectedAddress) {
    const schools = currentAddressAssignments(selectedAddress).length;
    document.getElementById("stats").innerHTML = `<span><strong>${schools}</strong> ${ruPlural(schools, "официальная привязка", "официальные привязки", "официальных привязок")}</span><span>${hasMapCoordinates(selectedAddress) ? "дом показан на карте" : "точной точки дома нет"}</span>`;
    return;
  }
  const selectedGarden = state.gardenById.get(state.selectedGardenId);
  if (selectedGarden) {
    const schools = selectedGarden.properties.school_numbers.length;
    const location = selectedGarden.properties.status === 'source_only_unlocated' ? 'Местоположение не определено' : `<strong>1</strong> ${isLocalityTerritory(selectedGarden) ? "территория" : "СНТ"} на карте`;
    document.getElementById("stats").innerHTML = `<span>${location}</span><span><strong>${schools}</strong> ${ruPlural(schools, "школа по правилу", "школы по правилу", "школ по правилу")}</span>`;
    return;
  }
  if (selectedSchool) {
    const stats = state.addressStatsBySchool.get(schoolKey(selectedSchool)) || { total: 0, geocoded: 0 };
    document.getElementById("stats").innerHTML = `<span><strong>${stats.total}</strong> ${ruPlural(stats.total, "закреплённый дом", "закреплённых дома", "закреплённых домов")}</span><span><strong>${stats.geocoded}</strong> с точным местоположением</span>`;
    return;
  }
  if (state.searchSubmitted) {
    const count = state.searchMode === "school" ? state.schoolSearchResults.length : state.addressSearchResults.length + state.gardenSearchResults.length;
    document.getElementById("stats").innerHTML = `<span><strong>${count}</strong> ${ruPlural(count, "результат", "результата", "результатов")}</span><span>${district ? `${escapeHtml(district)} район` : "весь город"}</span>`;
    return;
  }
  const overviewHint = "Найдите адрес, чтобы увидеть дом и его школу";
  document.getElementById("stats").innerHTML = `
    <span><strong>${schoolCount}</strong> ${ruPlural(schoolCount, "школа", "школы", "школ")}</span>
    ${overviewHint ? `<em>${overviewHint}</em>` : ""}
  `;
}

function render() {
  syncDistrictFilterUI();
  const matchingSchoolKeys = matchingSchoolKeysForAddressQuery();
  renderDistrictBoundaries();
  renderSchoolSections();
  renderGardenTerritories();
  const addressCount = renderAddresses(state.addresses);
  const schoolCount = renderSchools(state.schools, matchingSchoolKeys);
  renderSelectionHighlights();
  renderSelectionCard();
  updateStats(addressCount, schoolCount, matchingSchoolKeys);
}

function setupDistricts() {
  const select = document.getElementById("districtFilter");
  const districts = [...new Set([...state.allAddresses, ...state.schools].map((row) => row.district).filter(Boolean))].sort();
  select.innerHTML = `<option value="">Все районы</option>${districts.map((district) => `<option value="${escapeAttr(district)}">${escapeHtml(district)}</option>`).join("")}`;
  districts.forEach(colorForDistrict);
  const legend = document.getElementById("districtColorLegend");
  if (legend) legend.innerHTML = districts.map(district => `<button type="button" data-legend-district="${escapeAttr(district)}"><i style="background:${colorForDistrict(district)}" aria-hidden="true"></i><span>${escapeHtml(district)}</span></button>`).join("");
  select.value = DEFAULT_DISTRICT && districts.includes(DEFAULT_DISTRICT) ? DEFAULT_DISTRICT : "";
}

function refreshSchoolOptions() {
  const datalist = document.getElementById("schoolOptions");
  if (!datalist) return;
  const query = schoolQuery();
  const rows = query ? searchSchoolCandidates(query, addressSuggestionLimit) : [];
  state.schoolOptionByLabel.clear();
  datalist.innerHTML = rows.map((row) => {
    let label = `${compactSchoolTitle(row)} · ${row.district || "без района"}`;
    const buildingAddress = addressTitle({ canonical_address: row.official_address || row.address || "" });
    if (buildingAddress) label += ` · ${buildingAddress}`;
    if (state.schoolOptionByLabel.has(label)) label += ` · ${schoolKey(row)}`;
    state.schoolOptionByLabel.set(label, row);
    return `<option value="${escapeAttr(label)}"></option>`;
  }).join("");
}

function refreshAddressOptions() {
  const datalist = document.getElementById("addressOptions");
  if (!datalist) return;
  const query = addressQuery();
  state.addressOptionByLabel.clear();
  state.gardenOptionByLabel.clear();
  let rows = query ? searchAddressCandidates(query, addressSuggestionLimit) : [];
  const gardens = query ? gardenSearchCandidates(query, addressSuggestionLimit) : [];
  const selected = selectedAddressRow();
  if (selected && !rows.some((row) => row.address_id === selected.address_id)) rows.unshift(selected);
  const addressOptions = rows.map((row) => {
    let label = addressLabel(row);
    if (state.addressOptionByLabel.has(label)) label = `${label} · ${row.address_id.slice(-6)}`;
    state.addressOptionByLabel.set(label, row);
    return `<option value="${escapeAttr(label)}"></option>`;
  }).join("");
  const gardenOptions = gardens.map((feature) => {
    const label = gardenSearchLabel(feature);
    state.gardenOptionByLabel.set(label, feature);
    return `<option value="${escapeAttr(label)}"></option>`;
  }).join("");
  datalist.innerHTML = gardenOptions + addressOptions;
}

function refreshFilterOptions() {
  refreshSchoolOptions();
  refreshAddressOptions();
}

function buildSourceIndex(districtSources, primarySources) {
  state.sourceByDistrict.clear();
  for (const row of primarySources) {
    if (row.district && row.source_url) state.sourceByDistrict.set(row.district, row);
  }
  for (const row of districtSources) {
    if (row.district && row.source_url) state.sourceByDistrict.set(row.district, row);
  }
}

function buildAddressIndexes(changedDistrict = "") {
  state.addressById.clear();
  for (const row of state.addresses) {
    if (row.address_id) state.addressById.set(row.address_id, row);
  }
  if (changedDistrict && state.addressSearchEntries.length) buildAddressSearchOverlay(changedDistrict);
  else buildAddressSearchIndex();
}

function buildSchoolIndexes() {
  state.schoolByKey.clear();
  state.scanSchoolByKey.clear();
  for (const row of state.schools) {
    const key = schoolKey(row);
    if (key) state.schoolByKey.set(key, row);
  }
  for (const row of state.scanSchools) {
    const key = schoolKey(row);
    if (key) state.scanSchoolByKey.set(key, row);
  }
  buildSchoolSearchIndex();
}

function buildIndexes() {
  buildSchoolIndexes();
  buildAddressIndexes();
}

function assignmentSchoolKey(row) {
  // A source assignment belongs to its own school, even when its address is
  // shared by several schools. Address membership is a different relation.
  const number = normalizeSchoolNumber(row?.school_number);
  return number ? districtSchoolKey(row.district, number) || row.school_id || '' : addressSchoolKeys(row)[0] || '';
}

function assignmentSchoolKeys(row) {
  return row?._overview ? addressSchoolKeys(row) : [assignmentSchoolKey(row)].filter(Boolean);
}

function buildAssignmentIndexes(rows) {
  document.documentElement.dataset.loadedAssignmentRows = String(rows.filter((row) => !row._overview).length);
  document.documentElement.dataset.loadedOverviewRows = String(rows.filter((row) => row._overview).length);
  state.assignmentsByAddressId.clear();
  state.assignmentsByAddressKey.clear();
  state.assignmentsBySchoolKey.clear();
  state.currentAssignmentByAddressId.clear();
  state.addressStatsBySchool.clear();
  state.schoolFallbackPointByKey.clear();
  state.currentGeocodedAddressesBySchoolKey.clear();
  const statsSets = new Map();
  const fallbackPointRows = new Map();
  const currentGeocodedBySchool = new Map();
  const currentSchoolKeysByAddress = new Map();
  for (const row of rows) {
    if (row.address_id) {
      if (!state.assignmentsByAddressId.has(row.address_id)) state.assignmentsByAddressId.set(row.address_id, []);
      state.assignmentsByAddressId.get(row.address_id).push(row);
      if (row.is_current === "yes") state.currentAssignmentByAddressId.set(row.address_id, row);
    }
    if (row.address_key) {
      if (!state.assignmentsByAddressKey.has(row.address_key)) state.assignmentsByAddressKey.set(row.address_key, []);
      state.assignmentsByAddressKey.get(row.address_key).push(row);
    }
    const addressIdentityValue = row.address_key || row.address_id;
    if (addressIdentityValue && row.is_current === "yes" && row.record_kind !== "scan_rule") {
      if (!currentSchoolKeysByAddress.has(addressIdentityValue)) {
        currentSchoolKeysByAddress.set(addressIdentityValue, new Set());
      }
      for (const key of assignmentSchoolKeys(row)) {
        if (key) currentSchoolKeysByAddress.get(addressIdentityValue).add(key);
      }
    }
    for (const schoolKeyValue of assignmentSchoolKeys(row)) {
      if (!state.assignmentsBySchoolKey.has(schoolKeyValue)) state.assignmentsBySchoolKey.set(schoolKeyValue, []);
      state.assignmentsBySchoolKey.get(schoolKeyValue).push(row);
      if (row.is_current === "yes" && row.record_kind !== "scan_rule") {
        if (!statsSets.has(schoolKeyValue)) statsSets.set(schoolKeyValue, { total: new Set(), geocoded: new Set() });
        const stats = statsSets.get(schoolKeyValue);
        const identity = row.address_key || row.address_id;
        stats.total.add(identity);
        if (hasMapCoordinates(row)) {
          stats.geocoded.add(identity);
          if (!currentGeocodedBySchool.has(schoolKeyValue)) currentGeocodedBySchool.set(schoolKeyValue, new Map());
          const currentRow = currentGeocodedBySchool.get(schoolKeyValue).get(identity);
          if (!currentRow || (!hasMapCoordinates(currentRow) && hasMapCoordinates(row))) {
            currentGeocodedBySchool.get(schoolKeyValue).set(identity, row);
          }
          if (row.record_kind !== "scan_rule" && identity) {
            if (!fallbackPointRows.has(schoolKeyValue)) fallbackPointRows.set(schoolKeyValue, new Map());
            fallbackPointRows.get(schoolKeyValue).set(identity, {
              lat: row._lat ?? numberValue(row.lat),
              lon: row._lon ?? numberValue(row.lon)
            });
          }
        }
      }
    }
  }
  for (const row of rows) {
    const addressIdentityValue = row.address_key || row.address_id;
    const currentKeys = currentSchoolKeysByAddress.get(addressIdentityValue);
    row._currentSchoolCount = currentKeys?.size || addressSchoolKeys(row).length;
    row._addressFeature = null;
  }
  const sorter = (left, right) => String(right.source_act_date || "").localeCompare(String(left.source_act_date || ""));
  state.assignmentsByAddressId.forEach((items) => items.sort(sorter));
  state.assignmentsByAddressKey.forEach((items) => items.sort(sorter));
  state.assignmentsBySchoolKey.forEach((items) => items.sort(sorter));
  for (const [key, stats] of statsSets.entries()) {
    state.addressStatsBySchool.set(key, {
      total: stats.total.size,
      geocoded: stats.geocoded.size
    });
  }
  for (const [key, pointsByAddress] of fallbackPointRows.entries()) {
    const points = [...pointsByAddress.values()].filter((point) => point.lat != null && point.lon != null);
    if (!points.length) continue;
    state.schoolFallbackPointByKey.set(key, {
      lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
      lon: points.reduce((sum, point) => sum + point.lon, 0) / points.length,
      count: points.length
    });
  }
  for (const [key, rowsByAddress] of currentGeocodedBySchool.entries()) {
    state.currentGeocodedAddressesBySchoolKey.set(key, [...rowsByAddress.values()]);
  }
}

function buildReviewDecisionIndexes(rows) {
  state.reviewDecisionByAddressKey.clear();
  state.reviewDecisionsBySchoolKey.clear();
  for (const row of rows || []) {
    const addressKey = row.address_key || "";
    if (addressKey) state.reviewDecisionByAddressKey.set(addressKey, row);
    const schoolNumbers = splitPipeValues(row.current_school_numbers);
    for (const number of schoolNumbers) {
      const key = districtSchoolKey(row.district, number);
      if (!key) continue;
      if (!state.reviewDecisionsBySchoolKey.has(key)) state.reviewDecisionsBySchoolKey.set(key, []);
      state.reviewDecisionsBySchoolKey.get(key).push(row);
    }
  }
}

function buildCoordinateReviewIndexes(rows) {
  state.coordinateReviewByAddressKey.clear();
  state.coordinateReviewsBySchoolKey.clear();
  for (const row of rows || []) {
    const addressKey = row.address_key || "";
    if (addressKey) state.coordinateReviewByAddressKey.set(addressKey, row);
    const schoolNumbers = splitPipeValues(row.current_school_numbers);
    for (const number of schoolNumbers) {
      const key = districtSchoolKey(row.district, number);
      if (!key) continue;
      if (!state.coordinateReviewsBySchoolKey.has(key)) state.coordinateReviewsBySchoolKey.set(key, []);
      state.coordinateReviewsBySchoolKey.get(key).push(row);
    }
  }
}

function isAddressCurrent(row) {
  if (!row?.address_id) return true;
  const assignment = state.currentAssignmentByAddressId.get(row.address_id);
  return assignment ? assignment.is_current === "yes" : true;
}

function sourceForDistrict(district) {
  return state.sourceByDistrict.get(district) || {};
}

function localSourceHref(rawFile) {
  if (VIEWER_API?.originalDocument?.(rawFile)) return "";
  const normalized = String(rawFile || "").trim().replaceAll("\\", "/");
  if (!normalized) return "";
  if (/^https?:\/\//i.test(normalized)) return normalized;
  if (!normalized.startsWith("raw/") || normalized.split("/").includes("..")) return "";
  return encodeURI(`../../${normalized}`);
}

function sourceLabel(source) {
  if (!source?.source_url) return "";
  const actDate = source.act_date || source.source_act_date || "";
  const actNumber = source.act_number || source.source_act_number || "";
  const act = [actDate, actNumber ? `№${actNumber}` : ""].filter(Boolean).join(" ");
  return act || source.source_title || source.source_kind || source.source_type || "официальный источник";
}

function externalMapHref(row) {
  const lat = numberValue(row.lat);
  const lon = numberValue(row.lon);
  if (lat == null || lon == null) return "";
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
}

function safeLinkHref(href, options = {}) {
  let value = String(href || "").trim();
  if (!value) return "";
  if (options.allowRelative && /^(\.\.\/)+raw\/[^?#]*$/i.test(value)) {
    const localPath = value.replace(/^(\.\.\/)+/, "");
    if (!localPath.split("/").slice(1).includes("..")) return value;
  }
  if (value.startsWith("//")) value = `https:${value}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function linkHtml(href, label, options = {}) {
  if (!href) return "";
  const safeHref = safeLinkHref(href, options);
  if (!safeHref) return escapeHtml(label);
  return `<a href="${escapeAttr(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const rows = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(item);
  }
  return rows;
}

function assignmentHistoryForAddress(row) {
  const direct = state.assignmentsByAddressId.get(row.address_id) || [];
  const addressKey = direct.find((item) => item.address_key)?.address_key;
  const history = addressKey ? (state.assignmentsByAddressKey.get(addressKey) || direct) : direct;
  return uniqueBy(history, (item) => [
    item.assignment_status,
    item.school_id,
    item.district,
    item.school_number,
    item.source_document_key || item.source_raw_file,
    item.source_act_date,
    item.source_act_number,
    item.record_kind
  ].join("|"));
}

function currentAddressAssignments(row) {
  if (row?._overview) {
    if (!row._overviewAssignments) {
      row._overviewAssignments = addressSchoolNumbers(row).map((number) => {
        const key = districtSchoolKey(row.district, number);
        return {
          ...row,
          school_number: number,
          current_school_numbers: "",
          _addressSchoolNumbers: [number],
          _addressSchoolKeys: key ? [key] : [],
          _addressSchoolKey: key
        };
      });
    }
    return row._overviewAssignments;
  }
  return uniqueBy(
    assignmentHistoryForAddress(row).filter((item) => item.is_current === "yes" && item.record_kind !== "scan_rule"),
    (item) => assignmentSchoolKey(item)
  ).sort((left, right) => {
    const leftNumber = Number(normalizeSchoolNumber(left.school_number));
    const rightNumber = Number(normalizeSchoolNumber(right.school_number));
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
    return String(left.school_number || "").localeCompare(String(right.school_number || ""), "ru");
  });
}

function currentAddressEvidenceRows(row) {
  if (row?._overview) return currentAddressAssignments(row);
  return assignmentHistoryForAddress(row)
    .filter((item) => item.is_current === "yes" && item.record_kind !== "scan_rule");
}

function addressCurrentSchoolSummary(row) {
  const current = currentAddressAssignments(row);
  if (current.length > 1) {
    return `${current.length} ${ruPlural(current.length, "школа", "школы", "школ")} (${current.map((item) => schoolReference(item.school_number)).join(", ")})`;
  }
  const school = schoolForAddress(row);
  return school ? schoolName(school) : row.school_name_raw || "";
}

function assignmentSchoolDisplay(item) {
  const fallback = assignmentSchoolLabel(item.school_number);
  const key = assignmentSchoolKey(item);
  const school = state.schoolByKey.get(key) || state.scanSchoolByKey.get(key);
  return school ? schoolName(school) : fallback;
}

function addressCurrentSchoolValue(row) {
  const current = currentAddressAssignments(row);
  if (!current.length) return escapeHtml(addressCurrentSchoolSummary(row));
  const items = current.map((item) => {
    const key = assignmentSchoolKey(item);
    const label = current.length > 1 ? schoolReference(item.school_number) : assignmentSchoolDisplay(item);
    if (!key || !state.schoolByKey.has(key)) return escapeHtml(label);
    return `<button class="inline-action" type="button" data-school-key="${escapeAttr(key)}">${escapeHtml(label)}</button>`;
  });
  if (current.length === 1) return items[0];
  return `${current.length} ${ruPlural(current.length, "школа", "школы", "школ")}: ${items.join(" ")}`;
}

function addressCurrentSchoolChip(row) {
  const current = currentAddressAssignments(row);
  if (current.length > 1) return `${current.length} текущие школы`;
  const item = current[0] || row;
  return assignmentSchoolLabel(item.school_number);
}

function addressCurrentDocumentValue(row) {
  const current = currentAddressAssignments(row);
  if (!current.length) return "";
  const docs = uniqueBy(current, (item) => [
    item.source_raw_file,
    item.source_document_url,
    item.source_page_url,
    item.source_act_date,
    item.source_act_number
  ].join("|"));
  if (docs.length === 1) return escapeHtml(sourceActLabel(docs[0]) || sourceTitle(docs[0]));
  const labels = docs
    .map((item) => sourceActLabel(item) || sourceTitle(item))
    .filter(Boolean)
    .slice(0, 4);
  const rest = docs.length - labels.length;
  return `${labels.map(escapeHtml).join("<br>")}${rest > 0 ? `<br>и еще ${rest}` : ""}`;
}

function addressCurrentSourceValue(row) {
  const fallback = state.currentAssignmentByAddressId.get(row.address_id) || row;
  const current = currentAddressAssignments(row);
  const rows = current.length ? current : [fallback].filter(Boolean);
  const docs = uniqueBy(rows, (item) => [
    item.source_raw_file,
    item.source_document_url,
    item.source_page_url,
    item.source_act_date,
    item.source_act_number,
    item.source_page
  ].join("|"));
  if (!docs.length) return "";
  const shown = docs.slice(0, 4);
  const rest = docs.length - shown.length;
  const lines = shown.map((item) => {
    const act = sourceActLabel(item);
    const title = sourceTitle(item);
    const links = sourceLinks(item);
    const page = item.source_page ? `страница ${item.source_page}` : "";
    return [
      `<strong>${escapeHtml(act || title)}</strong>`,
      act && title ? escapeHtml(title) : "",
      page ? escapeHtml(page) : "",
      links
    ].filter(Boolean).join("<br>");
  });
  if (rest > 0) lines.push(`и еще ${rest}`);
  return lines.join("<br><br>");
}

function sourceActLabel(item, prefix = "source") {
  const date = item[`${prefix}_act_date`] || "";
  const number = item[`${prefix}_act_number`] ? `№${item[`${prefix}_act_number`]}` : "";
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const readableDate = parts && months[Number(parts[2]) - 1]
    ? `${Number(parts[3])} ${months[Number(parts[2]) - 1]} ${parts[1]}` : date;
  return [readableDate, number].filter(Boolean).join(" ");
}

function sourceTitle(item) {
  return item.source_raw_file || item.source_document_url || item.source_page_url || item.source_url || item.source_title || "источник";
}

function assignmentStatusLabel(item) {
  if (item.assignment_status === "current_conflict") return "текущая";
  if (item.assignment_status === "current_multi_school") return "текущая";
  if (item.assignment_status === "current_group_overlap") return "текущая";
  if (item.assignment_status === "current") return "текущая";
  if (item.assignment_status === "superseded_same_school") return "предыдущая редакция";
  if (item.assignment_status === "superseded_removed") return "раньше, исключен из последней редакции";
  if (item.assignment_status === "superseded") return "раньше";
  if (item.assignment_status === "source_rule_expanded") return "групповая строка документа";
  if (item.assignment_status === "source_rule_unexpanded_review") return "групповая строка без списка домов";
  if (item.assignment_status === "source_rule_accepted_unexpanded") return "непоточечное правило документа";
  return item.assignment_status || "";
}

function changeStatusLabel(item) {
  if (item.change_status === "transferred_in") return "добавлен / перешел сюда";
  if (item.change_status === "transferred_out") return "перешел в другую школу";
  if (item.change_status === "document_updated") return "обновлен документ";
  if (item.change_status === "removed_from_latest_school_document") return "исключен из последней редакции";
  if (item.change_status === "current_multi_school") return "есть в нескольких текущих школах";
  if (item.change_status === "current_multiple_schools_review") return "есть в нескольких текущих документах";
  if (item.change_status === "group_expansion_overlap_review") return "есть в нескольких групповых строках";
  if (item.change_status === "rule_expanded_to_addresses") return "групповая строка раскрыта в дома";
  if (item.change_status === "rule_needs_expansion") return "групповая строка без списка домов";
  if (item.change_status === "current") return "текущая привязка";
  return item.change_status || "";
}

function addressHistoryChangeLabel(item) {
  const previous = schoolReference(item.previous_school_number);
  const next = schoolReference(item.next_school_number);
  if (item.change_status === "transferred_in") {
    return previous ? `перешел из ${previous}` : "добавлен текущим документом";
  }
  if (item.change_status === "transferred_out") {
    return next ? `потом перешел в ${next}` : "исключен из текущей привязки";
  }
  if (item.change_status === "document_updated") return "обновлен документ";
  if (item.change_status === "removed_from_latest_school_document") return "исключен из последней редакции";
  if (item.change_status === "current_multi_school") return "есть в нескольких текущих школах";
  if (item.change_status === "current_multiple_schools_review") return "есть в нескольких текущих документах";
  if (item.change_status === "group_expansion_overlap_review") return "есть в нескольких групповых строках";
  return "";
}

function sourceLinksForPrefix(item, prefix = "source") {
  const rawFile = item[`${prefix}_raw_file`] || "";
  const external = VIEWER_API?.originalDocument?.(rawFile);
  if (external) return external.url ? linkHtml(external.url, external.label) : escapeHtml(external.label);
  const documentUrl = item[`${prefix}_document_url`] || "";
  const pageUrl = item[`${prefix}_page_url`] || (!documentUrl ? item[`${prefix}_url`] : "");
  return [
    rawFile ? linkHtml(localSourceHref(rawFile), "локальный файл", { allowRelative: true }) : "",
    documentUrl ? linkHtml(documentUrl, "PDF в интернете") : "",
    pageUrl ? linkHtml(pageUrl, "официальная страница") : ""
  ].filter(Boolean).join(" · ");
}

function sourceLinks(item) {
  return sourceLinksForPrefix(item, "source");
}

function sourceGroupKey(item, prefix = "source") {
  return [
    item[`${prefix}_document_key`] || "",
    item[`${prefix}_raw_file`] || "",
    item[`${prefix}_document_url`] || "",
    item[`${prefix}_page_url`] || item[`${prefix}_url`] || "",
    item[`${prefix}_act_date`] || "",
    item[`${prefix}_act_number`] || ""
  ].join("|");
}

function sourceCompactTitle(item, prefix = "source") {
  const act = sourceActLabel(item, prefix);
  if (act) return act;
  return item[`${prefix}_title`] || item[`${prefix}_raw_file`] || item[`${prefix}_document_url`] || item[`${prefix}_page_url`] || "источник";
}

function schoolNumberList(items) {
  return uniqueBy(
    items
      .map((item) => normalizeSchoolNumber(item.school_number))
      .filter(Boolean)
      .map(schoolReference),
    (value) => value
  ).join(", ");
}

function addressExampleList(items, limit = 2) {
  return uniqueBy(
    items.map(assignmentAddressTitle).filter(Boolean),
    (value) => value
  ).slice(0, limit);
}

function compactSourceRows(items, limit = 3) {
  const rows = uniqueBy(
    items.map((item) => item.source_page || item.source_row || item.source_y || "").filter(Boolean),
    (value) => value
  ).slice(0, limit);
  return rows.join(", ");
}

function sourceFragmentPeriod(item) {
  return (item.record_kind === "scan_rule" ? item.is_current_source_evidence : item.is_current) === "yes"
    ? "current" : "historical";
}

function schoolSourceFragmentWitnesses(items) {
  const first = items[0];
  if (!first || !/^[a-f0-9]{32}$/.test(first.source_region_id || "")) return [];
  const rawFile = first.source_region_raw_file || first.source_raw_file || "";
  const digest = first.source_region_sha256 || first.source_registry_raw_sha256 || "";
  if (!/\.pdf$/i.test(rawFile) || !/^[a-f0-9]{64}$/.test(digest)) return [];
  const group = sourceGroupKey(first), school = assignmentSchoolKey(first), period = sourceFragmentPeriod(first);
  const unique = new Map();
  for (const item of items) {
    if (assignmentSchoolKey(item) !== school || sourceGroupKey(item) !== group
        || sourceFragmentPeriod(item) !== period
        || (item.source_region_raw_file || item.source_raw_file || "") !== rawFile
        || (item.source_region_sha256 || item.source_registry_raw_sha256 || "") !== digest
        || !/^[a-f0-9]{32}$/.test(item.source_region_id || "")) continue;
    if (!unique.has(item.source_region_id)) unique.set(item.source_region_id, item);
  }
  return [...unique.values()].sort((left, right) => (
    Number(left.source_region_page || left.source_page || 0) - Number(right.source_region_page || right.source_page || 0)
    || Number(left.source_y || 0) - Number(right.source_y || 0)
    || assignmentAddressTitle(left).localeCompare(assignmentAddressTitle(right), "ru")
  ));
}

function schoolDocumentEvidenceHtml(items) {
  const first = items[0];
  const preview = sourceEvidenceSnippetHtml(first, "school");
  const witnesses = schoolSourceFragmentWitnesses(items);
  if (witnesses.length < 2) return preview;
  const options = witnesses.map(item => {
    const page = item.source_region_page || item.source_page;
    const label = [page ? `Стр. ${page}` : "", assignmentAddressTitle(item)].filter(Boolean).join(" · ");
    return `<option value="${escapeAttr(item.source_region_id)}"${item.source_region_id === first.source_region_id ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  return `<div class="school-source-document" data-source-fragment-group="${escapeAttr(sourceGroupKey(first))}" data-source-fragment-school="${escapeAttr(assignmentSchoolKey(first))}" data-source-fragment-period="${sourceFragmentPeriod(first)}" data-source-fragment-selected="${escapeAttr(first.source_region_id)}">
    <label class="source-fragment-field"><span>Строка документа</span><select data-school-source-fragment>${options}</select></label>
    <div data-source-fragment-preview>${preview}</div>
  </div>`;
}

function schoolSourceFragmentControlRows(group) {
  const school = selectedSchoolRow();
  if (!school || schoolKey(school) !== group.dataset.sourceFragmentSchool) return [];
  return schoolSourceFragmentWitnesses(schoolAssignments(school).filter(item => (
    sourceGroupKey(item) === group.dataset.sourceFragmentGroup
    && sourceFragmentPeriod(item) === group.dataset.sourceFragmentPeriod
  )));
}

function changeSchoolSourceFragment(control) {
  const group = control.closest("[data-source-fragment-group]");
  const preview = group?.querySelector("[data-source-fragment-preview]");
  if (!preview) return false;
  const witness = schoolSourceFragmentControlRows(group).find(item => item.source_region_id === control.value);
  if (!witness) {
    control.value = group.dataset.sourceFragmentSelected;
    return false;
  }
  group.dataset.sourceFragmentSelected = witness.source_region_id;
  preview.innerHTML = sourceEvidenceSnippetHtml(witness, "school");
  preview.querySelector("[data-source-preview]")?.click();
  return true;
}

function compactDocumentGroupsHtml(rows, title, options = {}) {
  const sourceRows = rows.filter((item) => item && (options.includeRules || item.record_kind !== "scan_rule"));
  if (!sourceRows.length) return `<div class="empty-note">${escapeHtml(options.emptyText || "Документов в регистре нет.")}</div>`;
  const groups = new Map();
  for (const item of sourceRows) {
    const key = sourceGroupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const groupsList = [...groups.values()].sort((left, right) => (
    String(right[0]?.source_act_date || "").localeCompare(String(left[0]?.source_act_date || ""))
  ));
  return `
    ${title ? `<div class="list-title">${escapeHtml(title)}</div>` : ""}
    <div class="compact-list">
      ${groupsList.map((items) => {
        const first = items[0];
        const addresses = items.filter((item) => item.record_kind !== "scan_rule");
        const rules = items.filter((item) => item.record_kind === "scan_rule");
        const addressCount = uniqueBy(addresses, (item) => item.address_key || item.address_id || assignmentAddressTitle(item)).length;
        const ruleCount = uniqueBy(rules, (item) => [item.address_key, item.source_page, item.source_y].join("|")).length;
        const schools = schoolNumberList(items);
        const examples = addressExampleList(items, 2);
        const links = sourceLinks(first);
        return `
          <div class="compact-row">
            <div class="compact-main">
              <strong>${escapeHtml(sourceCompactTitle(first))}</strong>
              <span>${[
                options.showAddressCount !== false && addressCount ? `${addressCount} ${ruPlural(addressCount, "адрес", "адреса", "адресов")}` : "",
                ruleCount ? `${ruleCount} ${ruPlural(ruleCount, "правило", "правила", "правил")}` : "",
                options.showSchools !== false && schools ? `Школы: ${schools}` : ""
              ].filter(Boolean).map(escapeHtml).join(" · ")}</span>
              ${examples.length && options.showExamples !== false ? `<em>${escapeHtml(examples.join("; "))}</em>` : ""}
              ${options.showEvidence ? schoolDocumentEvidenceHtml(items) : ""}
            </div>
            ${links ? `<div class="compact-links">${links}</div>` : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function changedByLabel(item) {
  const act = sourceActLabel(item, "changed_by_source");
  const school = item.changed_by_school_number ? `, ${assignmentSchoolLabel(item.changed_by_school_number)}` : "";
  if (act) return `изменено документом ${act}${school}`;
  if (item.changed_by_source_title) return `изменено документом: ${item.changed_by_source_title}${school}`;
  if (item.changed_by_source_raw_file) return `изменено файлом: ${item.changed_by_source_raw_file}${school}`;
  return "";
}

function changedByHtml(item) {
  const label = changedByLabel(item);
  if (!label) return "";
  const links = sourceLinksForPrefix(item, "changed_by_source");
  return `<br><em>${escapeHtml(label)}</em>${links ? `<br>${links}` : ""}`;
}

function addressHistoryKey(row) {
  return row.address_key || row.address_id || "";
}

function addressHistoryToggleHtml(row, total, expanded) {
  const key = addressHistoryKey(row);
  if (!key || total <= addressHistoryLimit) return "";
  const hidden = total - addressHistoryLimit;
  const label = expanded
    ? `Свернуть до ${addressHistoryLimit}`
    : `Показать всю историю · еще ${hidden}`;
  return `<button class="list-action" type="button" data-address-history-key="${escapeAttr(key)}" aria-expanded="${expanded}">${escapeHtml(label)}</button>`;
}

function sourceHistoryHtml(row) {
  const registerHistory = assignmentHistoryForAddress(row);
  if (registerHistory.length) {
    const key = addressHistoryKey(row);
    const expanded = key ? state.expandedAddressHistories.has(key) : false;
    const shown = expanded ? registerHistory : registerHistory.slice(0, addressHistoryLimit);
    const rest = registerHistory.length - shown.length;
    return `<div class="list-title">История привязки</div><div class="source-stack">${shown.map((item) => {
      const date = sourceActLabel(item) || (item.is_current === "yes" ? "актуальная запись" : "");
      const school = assignmentSchoolLabel(item.school_number);
      const status = assignmentStatusLabel(item);
      const change = addressHistoryChangeLabel(item);
      const links = sourceLinks(item);
      return `<div class="source-line"><span class="source-dot"></span><div><strong>${escapeHtml(date || "источник")}</strong> · ${escapeHtml(school)}${status ? ` · ${escapeHtml(status)}` : ""}${change ? ` · ${escapeHtml(change)}` : ""}<br>${escapeHtml(sourceTitle(item))}${links ? `<br>${links}` : ""}${changedByHtml(item)}</div></div>`;
    }).join("")}${rest > 0 ? `<div class="address-item muted">Скрыто ${rest}</div>` : ""}${addressHistoryToggleHtml(row, registerHistory.length, expanded)}</div>`;
  }

  const source = sourceForDistrict(row.district);
  const localHref = localSourceHref(row.source_raw_file);
  const original = VIEWER_API?.originalDocument?.(row.source_raw_file);
  const officialHref = original ? original.url : row.source_document_url || row.source_page_url || row.source_url || source.source_page_url || source.source_url || "";
  const history = [];
  if (!history.length) {
    history.push({
      date: row.source_date || source.act_date || "",
      title: row.source_raw_file || source.source_title || "текущий источник",
      url: officialHref,
      local: localHref
    });
  }
  return `<div class="list-title">Источник</div><div class="source-stack">${history.map((item, index) => {
    const title = item.title || item.source_raw_file || item.url || "источник";
    const date = item.date || (index === 0 ? "актуальная запись" : "");
    const links = [
      item.local ? linkHtml(item.local, "локальный файл", { allowRelative: true }) : "",
      item.url ? linkHtml(item.url, original?.label || sourceLabel(source) || "источник в интернете") : original ? escapeHtml(original.label) : ""
    ].filter(Boolean).join(" · ");
    return `<div class="source-line"><span class="source-dot"></span><div><strong>${escapeHtml(date || "источник")}</strong><br>${escapeHtml(title)}${links ? `<br>${links}` : ""}</div></div>`;
  }).join("")}</div>`;
}

function addressCurrentAssignmentsHtml(row) {
  const current = currentAddressAssignments(row);
  if (current.length <= 1) return "";
  return `
    <div class="list-title">Текущие школы</div>
    <div class="address-list">
      ${current.map((item) => {
        const date = sourceActLabel(item);
        const school = assignmentSchoolLabel(item.school_number);
        const schoolNameText = assignmentSchoolDisplay(item);
        const links = sourceLinks(item);
        return `
          <div ${schoolItemAttributes(item)}>
            <span>${escapeHtml(school)} · ${escapeHtml(schoolNameText)}</span>
            ${assignmentCheckNoteHtml(item)}
            ${date ? `<em>документ: ${escapeHtml(date)}</em>` : ""}
            <em>${escapeHtml(sourceTitle(item))}</em>
            ${links ? `<em>${links}</em>` : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function schoolAssignments(row) {
  return state.assignmentsBySchoolKey.get(schoolKey(row)) || [];
}

function schoolHistoryStats(row) {
  const current = new Set();
  const historical = new Set();
  for (const item of schoolAssignments(row)) {
    const identity = item.address_key || item.address_id;
    if (!identity) continue;
    if (item.is_current === "yes") current.add(identity);
    else historical.add(identity);
  }
  return { current: current.size, historical: historical.size };
}

function schoolCheckStats(row) {
  const needsCheck = new Set();
  for (const item of schoolCurrentAssignments(row)) {
    if (!assignmentHasOpenReview(item)) continue;
    const identity = item.address_key || item.address_id;
    if (identity) needsCheck.add(identity);
  }
  return { needsCheck: needsCheck.size };
}

function schoolChangeStats(row) {
  const stats = {
    transferredIn: new Set(),
    transferredOut: new Set(),
    removed: new Set(),
    documentUpdated: new Set()
  };
  for (const item of schoolAssignmentChanges(row)) {
    const identity = item.address_key || item.address_id;
    if (!identity) continue;
    if (item.change_status === "transferred_in") stats.transferredIn.add(identity);
    if (item.change_status === "transferred_out") stats.transferredOut.add(identity);
    if (item.change_status === "removed_from_latest_school_document") stats.removed.add(identity);
    if (item.change_status === "document_updated") stats.documentUpdated.add(identity);
  }
  return {
    transferredIn: stats.transferredIn.size,
    transferredOut: stats.transferredOut.size,
    removed: stats.removed.size,
    documentUpdated: stats.documentUpdated.size
  };
}

function schoolSourceDocuments(row, currentOnly = true) {
  const rows = schoolAssignments(row).filter((item) => currentOnly ? item.is_current === "yes" : item.is_current !== "yes");
  return uniqueBy(rows, (item) => [
    item.source_raw_file,
    item.source_url,
    item.source_page_url,
    item.source_document_url,
    item.source_act_date,
    item.source_act_number
  ].join("|")).slice(0, 8);
}

function schoolSourceDocumentsHtml(row, currentOnly = true, title = "Документы текущего списка") {
  const docs = schoolSourceDocuments(row, currentOnly);
  if (!docs.length) return "";
  return `<div class="list-title">${escapeHtml(title)}</div><div class="source-stack">${docs.map((item) => {
    const date = sourceActLabel(item) || "источник";
    const links = sourceLinks(item);
    return `<div class="source-line"><span class="source-dot"></span><div><strong>${escapeHtml(date)}</strong><br>${escapeHtml(sourceTitle(item))}${links ? `<br>${links}` : ""}</div></div>`;
  }).join("")}</div>`;
}

function schoolAssignmentChanges(row) {
  return uniqueBy(
    schoolAssignments(row)
      .filter((item) => item.record_kind !== "scan_rule" && schoolHistoryChangeStatuses.has(item.change_status)),
    (item) => [
      item.change_status,
      item.address_key || item.address_id,
      item.source_raw_file,
      item.source_act_date,
      item.source_act_number,
      item.previous_school_number,
      item.next_school_number
    ].join("|")
  ).sort((left, right) => String(right.source_act_date || "").localeCompare(String(left.source_act_date || "")));
}

function schoolChangeCategoryLabel(item) {
  if (item.change_status === "transferred_in") return item.previous_school_number ? "перешли в эту школу" : "добавлены в список";
  if (item.change_status === "transferred_out") return "перешли в другую школу";
  if (item.change_status === "removed_from_latest_school_document") return "исключены из последней редакции";
  if (item.change_status === "document_updated") return "остались, обновлен документ";
  return changeStatusLabel(item);
}

function schoolAssignmentChangeGroups(row) {
  const groups = new Map();
  for (const item of schoolAssignmentChanges(row)) {
    const key = [
      item.change_status,
      item.source_document_key || item.source_raw_file,
      item.source_act_date,
      item.source_act_number,
      item.previous_school_number,
      item.next_school_number
    ].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        item,
        addressKeys: new Set(),
        examples: []
      });
    }
    const group = groups.get(key);
    const identity = item.address_key || item.address_id || assignmentAddressTitle(item);
    group.addressKeys.add(identity);
    if (group.examples.length < 2) group.examples.push(assignmentAddressTitle(item));
  }
  return [...groups.values()].sort((left, right) => {
    const dateCompare = String(right.item.source_act_date || "").localeCompare(String(left.item.source_act_date || ""));
    if (dateCompare) return dateCompare;
    return String(right.item.source_act_number || "").localeCompare(String(left.item.source_act_number || ""), "ru");
  });
}

function schoolAssignmentChangesHtml(row) {
  const groups = schoolAssignmentChangeGroups(row);
  if (!groups.length) return "";
  const shown = groups.slice(0, 24);
  const rest = groups.length - shown.length;
  return `
    <div class="list-title">История изменений адресов</div>
    <div class="address-list">
      ${shown.map((group) => {
        const item = group.item;
        const date = sourceActLabel(item);
        const direction = item.change_status === "transferred_out" && item.next_school_number
          ? ` → ${schoolReference(item.next_school_number)}`
          : item.change_status === "transferred_in" && item.previous_school_number
            ? ` ← ${schoolReference(item.previous_school_number)}`
            : "";
        const count = group.addressKeys.size;
        return `
          <div class="address-item">
            <span>${count} ${ruPlural(count, "адрес", "адреса", "адресов")} · ${escapeHtml(schoolChangeCategoryLabel(item))}${escapeHtml(direction)}</span>
            ${date ? `<em>${escapeHtml(date)}</em>` : ""}
            ${sourceEvidenceSnippetHtml(item)}
          </div>
        `;
      }).join("")}
      ${rest > 0 ? `<div class="address-item muted">Еще ${rest} ${ruPlural(rest, "группа", "группы", "групп")}</div>` : ""}
    </div>
  `;
}

function assignmentAddressTitle(row) {
  return row.canonical_address || row.address_query || row.raw_address_text || "адрес без названия";
}

function navigableAddressId(item) {
  if (item.address_id && state.addressById.has(item.address_id)) return item.address_id;
  const history = item.address_key ? (state.assignmentsByAddressKey.get(item.address_key) || []) : [];
  const current = history.find((row) => row.is_current === "yes" && row.address_id && state.addressById.has(row.address_id));
  return current?.address_id || "";
}

function addressItemAttributes(item, action = "select") {
  const id = navigableAddressId(item);
  if (!id) return `class="address-item"`;
  const attribute = action === "focus" ? "data-focus-address-id" : "data-address-id";
  const focused = action === "focus" && state.focusedSchoolAddressId === id ? " focused" : "";
  return `class="address-item action${focused}" role="button" tabindex="0" ${attribute}="${escapeAttr(id)}"`;
}

function addressActionRowHtml(item, innerHtml, action = "select") {
  const id = navigableAddressId(item);
  if (!id) return `<div class="address-item">${innerHtml}</div>`;
  const attribute = action === "focus" ? "data-focus-address-id" : "data-address-id";
  const focused = action === "focus" && state.focusedSchoolAddressId === id ? " focused" : "";
  return `<button class="address-item action${focused}" type="button" ${attribute}="${escapeAttr(id)}">${innerHtml}</button>`;
}

function schoolItemAttributes(item) {
  const key = assignmentSchoolKey(item);
  if (!key || !state.schoolByKey.has(key)) return `class="address-item"`;
  return `class="address-item action" role="button" tabindex="0" data-school-key="${escapeAttr(key)}"`;
}

function schoolAddressListKey(row, kind) {
  return `${schoolKey(row)}::${kind}`;
}

function schoolAddressPageOffset(row, kind) {
  return state.schoolAddressPageOffsets.get(schoolAddressListKey(row, kind)) || 0;
}

function moveSchoolAddressPage(row, key, action) {
  if (!row || !['previous', 'next'].includes(action)) return false;
  const kind = ['current', 'historical'].find(value => schoolAddressListKey(row, value) === key);
  if (!kind) return false;
  const total = kind === 'current' ? schoolFilteredCurrentAssignments(row).rows.length : schoolHistoricalAssignments(row).length;
  const last = Math.max(0, Math.floor((total - 1) / schoolAddressListLimit) * schoolAddressListLimit);
  const current = Math.min(last, Math.max(0, schoolAddressPageOffset(row, kind)));
  const next = Math.min(last, Math.max(0, current + (action === 'previous' ? -1 : 1) * schoolAddressListLimit));
  if (next === current) return false;
  state.schoolAddressPageOffsets.set(key, next);
  return true;
}

function schoolAddressListToggleHtml(row, kind, total, offset) {
  const key = schoolAddressListKey(row, kind);
  const controls = [];
  if (offset > 0) {
    controls.push(`<button class="list-action quiet" type="button" data-school-list-key="${escapeAttr(key)}" data-school-list-action="previous">← Предыдущие ${Math.min(schoolAddressListLimit, offset)}</button>`);
  }
  if (offset + schoolAddressListLimit < total) {
    const next = Math.min(schoolAddressListLimit, total - offset - schoolAddressListLimit);
    controls.push(`<button class="list-action" type="button" data-school-list-key="${escapeAttr(key)}" data-school-list-action="next">Следующие ${next} →</button>`);
  }
  return controls.join("");
}

function schoolCurrentAssignments(row) {
  return uniqueBy(
    schoolAssignments(row).filter((item) => item.is_current === "yes" && item.record_kind !== "scan_rule"),
    (item) => item.address_key || item.address_id
  ).sort((left, right) => assignmentAddressTitle(left).localeCompare(assignmentAddressTitle(right), "ru"));
}

function schoolCurrentSourceRules(row) {
  return uniqueBy(
    schoolAssignments(row).filter((item) => (
      item.record_kind === "scan_rule" && item.is_current_source_evidence === "yes"
    )),
    (item) => [item.address_key, item.source_document_key, item.source_page, item.source_y].join("|")
  ).sort((left, right) => assignmentAddressTitle(left).localeCompare(assignmentAddressTitle(right), "ru"));
}

function schoolCurrentEvidence(row) {
  return schoolAssignments(row).filter((item) => item.record_kind === "scan_rule"
    ? item.is_current_source_evidence === "yes"
    : item.is_current === "yes");
}

function sourceFromFifthGrade(item) {
  return /с\s+5\s*[-‑–]?\s*го\s+класса/iu.test(item.school_name_raw || "");
}

function schoolRuleScopeLabel(rules) {
  if (rules.length && rules.every(sourceFromFifthGrade)) {
    return "Адреса для приёма с 5-го класса";
  }
  if (rules.length && rules.every(item => item.assignment_status === "source_rule_territory_unit")) {
    return "Закрепление указано для территории целиком";
  }
  return rules.length ? "Закрепление по правилу из документа" : "Текущие адресные привязки не найдены";
}

function schoolRuleListHtml(rules) {
  const seen = new Set();
  const items = [];
  for (const item of rules) {
    const text = /^(вся территория|все жилые дома)(?:\s|$)/iu.test(item.source_house_rule || "")
      ? item.source_house_rule : item.raw_address_text || assignmentAddressTitle(item);
    const key = `${text}::${item.source_house_rule || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(`<li>${escapeHtml(text)}</li>`);
  }
  return `<ul class="school-rule-list" aria-label="Строки действующего документа">${items.join("")}</ul>`;
}

function schoolFilteredCurrentAssignments(row) {
  const allRows = schoolCurrentAssignments(row);
  const locatedRows = state.schoolAddressFilter === 'unlocated'
    ? allRows.filter(item => !hasMapCoordinates(state.addressById.get(navigableAddressId(item)) || item)) : allRows;
  const scopedRows = state.schoolStreetFilter
    ? locatedRows.filter(item => (item.parsed_street || item.street || 'Другие адреса') === state.schoolStreetFilter)
    : locatedRows;
  const query = normalizeSearchValue(state.schoolHouseQuery);
  const queryTokens = query.split(/\s+/).filter(Boolean);
  const houseToken = queryHouseToken(state.schoolHouseQuery);
  const rows = query
    ? scopedRows.filter((item) => (
        queryTokens.every((token) => tokenMatchesSearchText(searchableAddressText(item), token))
        && rowMatchesHouseToken(item, houseToken)
      ))
    : scopedRows;
  return { allRows, rows, query };
}

function schoolAddressListHtml(row) {
  const { allRows, rows, query } = schoolFilteredCurrentAssignments(row);
  if (!allRows.length) {
    const hasRules = schoolCurrentSourceRules(row).length > 0;
    const hasHistory = schoolHistoricalAssignments(row).length > 0;
    return `<div class="list-title">Текущие адреса</div><div class="empty-note">${hasRules ? "Отдельные дома не закреплены; ниже сохранены правила из текущего документа." : hasHistory ? "Текущих адресов в регистре нет; история доступна в разделе «Документы»." : "Адресов в регистре пока нет."}</div>`;
  }
  if (!rows.length) {
    return `<div class="list-title">Закрепленные адреса</div><div class="empty-note">В списке этой школы такого дома нет.</div>`;
  }
  const rawOffset = schoolAddressPageOffset(row, "current");
  const offset = rawOffset < rows.length ? rawOffset : 0;
  const shown = rows.slice(offset, offset + schoolAddressListLimit);
  const end = offset + shown.length;
  return `
    <div class="list-title">${query || state.schoolAddressFilter === 'unlocated' ? `${rows.length} из ${allRows.length} адресов` : "Закрепленные адреса"}</div>
    <div class="address-list">
      ${shown.map((item) => `
        <div class="address-table-row">
          ${addressActionRowHtml(item, `<span>${escapeHtml(addressTitle(item))}</span>${assignmentStatusBadgeHtml(item)}`, "focus")}
          ${sourceEvidenceSnippetHtml(item)}
        </div>
      `).join("")}
      ${rows.length > schoolAddressListLimit ? `<div class="address-item muted">Показаны ${offset + 1}-${end} из ${rows.length}</div>` : ""}
      ${schoolAddressListToggleHtml(row, "current", rows.length, offset)}
    </div>
  `;
}

function schoolHistoricalAssignments(row) {
  return uniqueBy(
    schoolAssignments(row).filter((item) => item.is_current !== "yes" && item.record_kind !== "scan_rule"),
    (item) => [
      item.address_key || item.address_id,
      item.school_id,
      item.source_raw_file,
      item.source_act_date,
      item.source_act_number,
      item.next_school_number
    ].join("|")
  ).sort((left, right) => String(right.source_act_date || "").localeCompare(String(left.source_act_date || "")));
}

function schoolHistoricalAddressListHtml(row) {
  const rows = schoolHistoricalAssignments(row);
  if (!rows.length) return "";
  const rawOffset = schoolAddressPageOffset(row, "historical");
  const offset = rawOffset < rows.length ? rawOffset : 0;
  const shown = rows.slice(offset, offset + schoolAddressListLimit);
  const end = offset + shown.length;
  return `
    <div class="list-title">Исторические адреса</div>
    <div id="schoolHistoryAddressResults" class="address-list">
      ${shown.map((item) => {
        const date = sourceActLabel(item);
        const sameSchool = item.change_status === "document_updated"
          || (item.next_school_number && normalizeSchoolNumber(item.next_school_number) === normalizeSchoolNumber(item.school_number));
        const next = sameSchool ? "Школа прежняя; обновился документ"
          : item.next_school_number ? `${assignmentSchoolLabel(item.school_number)} → ${assignmentSchoolLabel(item.next_school_number)}` : changeStatusLabel(item);
        const links = sourceLinks(item);
        const changedBy = changedByLabel(item);
        const addressId = navigableAddressId(item);
        return `
          <div class="address-item">
            <span>${escapeHtml(assignmentAddressTitle(item))}</span>
            <span class="row-actions">${addressId ? `<button class="inline-action" type="button" data-address-id="${escapeAttr(addressId)}">На карте</button>` : ""}${sourceEvidenceSnippetHtml(item)}</span>
            ${next ? `<em>${escapeHtml(next)}</em>` : ""}
            ${date ? `<em>${escapeHtml(date)}</em>` : ""}
            ${changedBy ? `<em>${escapeHtml(changedBy)}</em>` : ""}
            ${links ? `<em>${links}</em>` : ""}
          </div>
        `;
      }).join("")}
      ${rows.length > schoolAddressListLimit ? `<div class="address-item muted">Показаны ${offset + 1}-${end} из ${rows.length}</div>` : ""}
      ${schoolAddressListToggleHtml(row, "historical", rows.length, offset)}
    </div>
  `;
}

function metaRow(label, value) {
  if (!value) return "";
  return `<div class="meta-label">${escapeHtml(label)}</div><div class="meta-value">${value}</div>`;
}

function schoolAreaFeature(row) {
  const key = schoolKey(row);
  if (!key) return null;
  if (state.schoolAreaTiles) return state.schoolAreaTiles.exclusiveForSchool(key);
  return (state.schoolSections.features || []).find((feature) => feature.properties?.school_key === key) || null;
}

function schoolSharedAreaFeatures(row) {
  const key = schoolKey(row);
  if (!key) return [];
  if (state.schoolAreaTiles) return state.schoolAreaTiles.sharedForSchool(key);
  return (state.sharedSchoolSections.features || []).filter((feature) => (
    sharedSectionMemberKeys(feature).includes(key)
  ));
}

function formatAreaM2(value) {
  const area = Number(value);
  if (!Number.isFinite(area) || area <= 0) return "";
  if (area >= 10000) {
    return `${(area / 10000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} га`;
  }
  return `${Math.round(area).toLocaleString("ru-RU")} м²`;
}

function areaExclusionReasonLabels(value) {
  const labels = {
    needs_review: "нужна проверка",
    current_conflict: "несколько текущих школ",
    current_multi_school: "несколько текущих школ",
    current_group_overlap: "пересечение групповых строк",
    osm_base_house: "координата по базовому дому",
    osm_nearest_house_proxy: "координата ближайшего дома",
    osm_street_proxy: "приблизительная координата улицы",
    district_point_proxy: "приблизительная координата района",
    school_point_proxy: "координата школы вместо дома",
    nominatim_approximate: "приблизительная точка",
    street_level_proxy: "приблизительная координата",
    manual_proxy: "proxy-точка",
    osm_fuzzy: "нестрогое совпадение координаты"
  };
  return splitPipeValues(value)
    .map((reason) => labels[reason] || reason)
    .filter(Boolean);
}

function schoolAreaMethodLabel(props) {
  const labels = {
    road_blocks: "по объединённым дорожным кварталам OSM",
    address_voronoi: "по адресному Voronoi",
    assignment_hull: "по оболочке адресов"
  };
  return labels[props?.section_method] || props?.section_method || "";
}

function schoolAreaSummaryHtml(row) {
  if (state.schoolSectionsLoadError) return escapeHtml("файл области временно недоступен");
  const feature = schoolAreaFeature(row);
  const sharedFeatures = schoolSharedAreaFeatures(row);
  const props = feature?.properties || {};
  if (!feature && !sharedFeatures.length) return escapeHtml("область пока не построена");
  const sharedZones = sharedFeatures.filter((item) => item.properties?.shared_kind === "assignment_zone");
  const sharedBuildings = sharedFeatures.filter((item) => item.properties?.shared_kind === "building_surface");
  const sharedLine = sharedFeatures.length
    ? `<span class="muted">Отдельный общий слой: ${sharedZones.length} ${ruPlural(sharedZones.length, "территория", "территории", "территорий")}${sharedBuildings.length ? `, ${sharedBuildings.length} ${ruPlural(sharedBuildings.length, "здание", "здания", "зданий")}` : ""}</span>`
    : "";
  if (!feature) {
    return [
      escapeHtml("собственной области нет: все текущие адреса относятся к нескольким школам"),
      sharedLine
    ].filter(Boolean).join("<br>");
  }
  const area = formatAreaM2(props.area_m2);
  const method = schoolAreaMethodLabel(props);
  const seedCount = Number(props.area_seed_address_count || 0);
  const totalCount = Number(props.address_count || props.geocoded_address_count || 0);
  const excludedCount = Number(props.area_excluded_address_count || 0);
  const seedLine = seedCount
    ? `${seedCount} ${ruPlural(seedCount, "проверенный адрес", "проверенных адреса", "проверенных адресов")}`
    : "нет проверенных адресов для границы";
  const totalLine = totalCount && totalCount !== seedCount
    ? `из ${totalCount} ${totalCount === 1 ? "текущего адреса" : "текущих адресов"}`
    : "";
  const excludedReasons = areaExclusionReasonLabels(props.area_exclusion_reasons || "");
  const excludedLine = excludedCount
    ? `<br><span class="muted">${excludedCount} ${ruPlural(excludedCount, "адрес", "адреса", "адресов")} с отметками проверки не влияют на границу${excludedReasons.length ? `: ${escapeHtml(excludedReasons.join(", "))}` : ""}</span>`
    : "";
  return [
    area ? escapeHtml(area) : "",
    method ? `<span class="muted">${escapeHtml(method)}</span>` : "",
    escapeHtml([seedLine, totalLine].filter(Boolean).join(" ")),
    excludedLine,
    sharedLine
  ].filter(Boolean).join("<br>");
}

function schoolCoordinateValue(row) {
  if (hasCoordinates(row)) {
    const coords = `${Number(row.lat).toFixed(6)}, ${Number(row.lon).toFixed(6)}`;
    const mapLink = externalMapHref(row);
    return mapLink ? linkHtml(mapLink, coords) : escapeHtml(coords);
  }
  const fallback = schoolFallbackPoint(row);
  if (!fallback) return escapeHtml("нет координат школы");
  const coords = `${Number(fallback.lat).toFixed(6)}, ${Number(fallback.lon).toFixed(6)}`;
  const mapLink = externalMapHref(fallback);
  return `${mapLink ? linkHtml(mapLink, coords) : escapeHtml(coords)}<br><span class="muted">примерная точка по адресам</span>`;
}

function schoolMapPointCount(row) {
  return schoolMapFeatures(row).length;
}

function schoolCampusesValue(row) {
  const campuses = state.schoolCampusesBySchoolKey.get(schoolKey(row)) || [];
  const pointCount = schoolMapPointCount(row);
  if (state.schoolCampusLoadStatus === "error") return escapeHtml("дополнительные точки временно недоступны");
  if (state.schoolCampusLoadStatus !== "loaded") return escapeHtml("дополнительные точки загружаются");
  if (pointCount <= 1) return escapeHtml("1 основная точка по официальному адресу");
  const describe = (feature) => {
    const label = feature?.properties?.campus_label || "основной адрес";
    const address = feature?.properties?.campus_address || "";
    const sourceUrl = feature?.properties?.campus_source_url || "";
    const text = escapeHtml([label, address].filter(Boolean).join(": "));
    return `${text}${sourceUrl ? ` · ${linkHtml(sourceUrl, "подтверждение")}` : ""}`;
  };
  const features = [schoolFeature(row), ...campuses.map(schoolFeature)].filter(Boolean);
  const verified = features.filter((feature) => feature.properties?.campus_evidence_status !== "osm_candidate");
  const candidates = features.filter((feature) => feature.properties?.campus_evidence_status === "osm_candidate");
  const summary = [
    verified.length ? `${verified.length} ${ruPlural(verified.length, "подтверждённая точка", "подтверждённые точки", "подтверждённых точек")}` : "",
    candidates.length ? `${candidates.length} ${ruPlural(candidates.length, "возможный объект OSM", "возможных объекта OSM", "возможных объектов OSM")}` : ""
  ].filter(Boolean).join("; ");
  const details = [
    ...verified.map(describe),
    ...candidates.map((feature) => `${describe(feature)} (не подтверждён как площадка школы)`)
  ];
  return `${escapeHtml(summary)}${details.length ? `<br><span class="muted">${details.join(";<br>")}</span>` : ""}`;
}

function schoolForAddress(row) {
  return state.schoolByKey.get(addressSchoolKey(row)) || state.scanSchoolByKey.get(addressSchoolKey(row)) || null;
}

function reviewDecisionForAddress(row) {
  const key = row?.address_key || "";
  return key ? state.reviewDecisionByAddressKey.get(key) || null : null;
}

function reviewDecisionsForSchool(row) {
  const key = schoolKey(row);
  return key ? state.reviewDecisionsBySchoolKey.get(key) || [] : [];
}

function coordinateReviewForAddress(row) {
  const key = row?.address_key || "";
  return key ? state.coordinateReviewByAddressKey.get(key) || null : null;
}

function coordinateReviewsForSchool(row) {
  const key = schoolKey(row);
  return key ? state.coordinateReviewsBySchoolKey.get(key) || [] : [];
}

function reviewDecisionStatusLabel(status) {
  const labels = {
    pending: "ожидает решения",
    resolved: "решено",
    keep_review: "оставить на проверке",
    quarantined: "исключить до проверки"
  };
  return labels[status] || status || "";
}

function reviewBucketLabel(bucket) {
  const labels = {
    source_decision: "выбор школы по источнику",
    coordinate_precision: "проверка точности координаты",
    manual_coordinate: "ручная проверка координаты",
    manual_review: "ручная проверка"
  };
  return labels[bucket] || bucket || "";
}

function coordinateAuditStatusLabel(status) {
  const labels = {
    base_house_or_sibling_object_only: "OSM дает базовый/соседний корпус",
    base_house_without_exact_suffix: "OSM дает базовый дом без корпуса",
    base_house_no_osm_gap_diagnostic: "нет строки в OSM gap-диагностике",
    manual_proxy_unverified: "proxy-координата без точного подтверждения",
    osm_sample_has_expected_suffix_check_required: "похожий OSM-объект требует ручной сверки",
    coordinate_review_unclassified: "тип координатной проверки не классифицирован"
  };
  return labels[status] || status || "";
}

function coordinateSampleClassLabel(value) {
  const labels = {
    other_corpus_in_sample: "в примере другой корпус",
    base_house_only_or_no_corpus_in_sample: "только базовый дом",
    expected_corpus_in_sample: "найден ожидаемый корпус, нужна сверка",
    other_structure_in_sample: "в примере другое строение",
    no_corpus_expected: "корпус не указан"
  };
  return splitPipeValues(value).map((item) => labels[item] || item).filter(Boolean).join("; ");
}

function coordinateReviewValue(row) {
  if (!row) return "";
  const status = coordinateAuditStatusLabel(row.coordinate_audit_status || "");
  const precision = coordinatePrecisionLabel(row);
  return [status, precision].filter(Boolean).map(escapeHtml).join("<br>");
}

function reviewDecisionValue(decision) {
  if (!decision) return "";
  const status = reviewDecisionStatusLabel(decision.decision_status || "pending");
  const bucket = reviewBucketLabel(decision.review_bucket || "");
  const school = decision.selected_school_numbers ? `школа: ${decision.selected_school_numbers}` : "";
  const coord = decision.coordinate_decision ? `координата: ${decision.coordinate_decision}` : "";
  const replacement = decision.replacement_lat && decision.replacement_lon
    ? `замена: ${decision.replacement_lat}, ${decision.replacement_lon}`
    : "";
  const basis = decision.decision_basis ? `основание: ${decision.decision_basis}` : "";
  return [status, bucket, school, coord, replacement, basis].filter(Boolean).map(escapeHtml).join("<br>");
}

function reviewDecisionChip(decision) {
  if (!decision) return "";
  const status = decision.decision_status || "pending";
  const label = reviewDecisionStatusLabel(status);
  const cls = status === "resolved" ? "ok" : status === "pending" ? "warn" : "history";
  return `<span class="chip ${cls}">${escapeHtml(label)}</span>`;
}

function reviewDecisionListHtml(decisions, limit = 10) {
  const rows = decisions || [];
  if (!rows.length) return `<div class="empty-note">Решений review для этой школы пока нет.</div>`;
  const shown = rows.slice(0, limit);
  return `
    <div class="compact-list">
      ${shown.map((decision) => `
        <div class="compact-row">
          <div class="compact-main">
            <strong>${escapeHtml(reviewDecisionStatusLabel(decision.decision_status || "pending"))}</strong>
            <span>${escapeHtml(decision.canonical_address || "")}</span>
            <em>${escapeHtml([reviewBucketLabel(decision.review_bucket), decision.school_conflict_group || decision.coordinate_review_group].filter(Boolean).join(" · "))}</em>
          </div>
        </div>
      `).join("")}
      ${rows.length > shown.length ? `<div class="address-item muted">Скрыто ${rows.length - shown.length}</div>` : ""}
    </div>
  `;
}

function coordinateReviewListHtml(rows, limit = 8) {
  const items = rows || [];
  if (!items.length) return `<div class="empty-note">Координатных проверок для этой школы нет.</div>`;
  const shown = items.slice(0, limit);
  return `
    <div class="compact-list">
      ${shown.map((item) => `
        <div class="compact-row">
          <div class="compact-main">
            <strong>${escapeHtml(coordinateAuditStatusLabel(item.coordinate_audit_status || ""))}</strong>
            <span>${escapeHtml(item.canonical_address || "")}</span>
            <em>${escapeHtml([item.parsed_house, item.osm_sample_display_names].filter(Boolean).join(" · "))}</em>
          </div>
        </div>
      `).join("")}
      ${items.length > shown.length ? `<div class="address-item muted">Скрыто ${items.length - shown.length}</div>` : ""}
    </div>
  `;
}

function cardTabsHtml(tabs, activeTab) {
  const keyboardTab = tabs.some(tab => tab.id === activeTab) ? activeTab : tabs[0]?.id;
  return `
    <div class="card-tabs" role="tablist" aria-label="Разделы карточки">
      ${tabs.map((tab) => `
        <button
          id="school-card-tab-${escapeAttr(tab.id)}"
          class="card-tab${tab.id === activeTab ? " active" : ""}"
          type="button"
          role="tab"
          aria-selected="${tab.id === activeTab ? "true" : "false"}"
          aria-controls="school-card-panel"
          tabindex="${tab.id === keyboardTab ? "0" : "-1"}"
          data-card-tab="${escapeAttr(tab.id)}"
        >${escapeHtml(tab.label || detailTabLabels[tab.id] || tab.id)}</button>
      `).join("")}
    </div>
  `;
}

function activeCardTab(tabs) {
  const ids = tabs.map((tab) => tab.id);
  if (ids.includes(state.activeDetailTab)) return state.activeDetailTab;
  state.activeDetailTab = ids[0] || "summary";
  return state.activeDetailTab;
}

function renderTabbedCard({ kicker, title, subtitle = "", chips = "", tabs }) {
  const availableTabs = tabs.filter((tab) => tab && tab.id && tab.html !== null && tab.html !== undefined);
  const activeTab = activeCardTab(availableTabs);
  const active = availableTabs.find((tab) => tab.id === activeTab) || availableTabs[0];
  return `
    <div class="card-kicker">${escapeHtml(kicker)}</div>
    <h2 id="selectionHeading" class="card-title" tabindex="-1">${title}</h2>
    ${subtitle ? `<div class="card-subtitle">${subtitle}</div>` : ""}
    ${chips ? `<div class="chip-row">${chips}</div>` : ""}
    ${cardTabsHtml(availableTabs, active?.id || "summary")}
    <div id="school-card-panel" class="card-tab-panel" role="tabpanel" aria-labelledby="school-card-tab-${escapeAttr(active?.id || "summary")}" tabindex="0">
      ${active?.html || ""}
    </div>
  `;
}

function currentSchoolsCompactHtml(row) {
  const current = currentAddressAssignments(row);
  if (!current.length) return `<div class="empty-note">Текущая школа в регистре не найдена.</div>`;
  return `
    <div class="compact-list">
      <div class="compact-row primary">
        <div class="compact-main">
          <strong>${escapeHtml(current.length > 1 ? `${current.length} текущие школы` : assignmentSchoolDisplay(current[0]))}</strong>
          <span>${escapeHtml(current.length > 1 ? schoolNumberList(current) : (schoolReference(current[0].school_number) || "без номера"))}</span>
        </div>
        <div class="compact-actions">
          ${current.map((item) => {
            const key = assignmentSchoolKey(item);
            if (!key || !state.schoolByKey.has(key)) return "";
            const label = schoolReference(item.school_number) || "школа";
            return `<button class="mini-action" type="button" data-school-key="${escapeAttr(key)}">${escapeHtml(label)}</button>`;
          }).filter(Boolean).join("")}
        </div>
      </div>
    </div>
  `;
}

function addressSummaryHtml(row, currentAssignments, checkValue) {
  const coords = row.lat && row.lon ? `${Number(row.lat).toFixed(6)}, ${Number(row.lon).toFixed(6)}` : "";
  const mapLink = externalMapHref(row);
  return `
    ${currentSchoolsCompactHtml(row)}
    <div class="meta-grid compact-meta">
      ${metaRow("Координаты", mapLink ? linkHtml(mapLink, coords) : escapeHtml(coords || "нет координат"))}
      ${metaRow("Документ", addressCurrentDocumentValue(row))}
      ${metaRow("Район", escapeHtml(row.district || ""))}
      ${metaRow("Отметки", checkValue)}
    </div>
    ${currentAssignments.length > 1 ? `<div class="warning-note">Адрес имеет несколько текущих школ в источнике. Автоматически одну школу не выбираем.</div>` : ""}
  `;
}

function addressDocumentsCompactHtml(row) {
  const current = currentAddressAssignments(row);
  const history = assignmentHistoryForAddress(row);
  const historical = history.filter((item) => item.is_current !== "yes");
  const currentDocs = compactDocumentGroupsHtml(current, "Текущие документы", {
    showAddressCount: false,
    showExamples: false,
    emptyText: "Текущий документ не найден."
  });
  const historyDocs = compactDocumentGroupsHtml(historical, "Исторические документы", {
    showAddressCount: false,
    showExamples: false,
    emptyText: "Документов в истории адреса нет."
  });
  return `${currentDocs}${historical.length ? historyDocs : ""}`;
}

function addressAssignmentChange(row, history) {
  const previous = history.filter(item => item.record_kind !== "scan_rule" && item.is_current !== "yes" && item.source_act_date)
    .sort((a, b) => b.source_act_date.localeCompare(a.source_act_date));
  if (!previous.length) return '';
  const prior = previous.filter(item => item.source_act_date === previous[0].source_act_date);
  const current = currentAddressAssignments(row);
  const keys = rows => [...new Set(rows.map(assignmentSchoolKey).filter(Boolean))].sort();
  const before = keys(prior), after = keys(current);
  if (!before.length || !after.length || before.join("|") === after.join("|")) return '';
  const names = rows => uniqueBy(rows, assignmentSchoolKey).map(item => schoolReference(item.school_number)).join(", ");
  return `Раньше: ${names(prior)} → сейчас: ${names(current)}`;
}

function addressHistoryCompactHtml(row) {
  const registerHistory = assignmentHistoryForAddress(row).filter((item) => item.record_kind !== "scan_rule");
  if (!registerHistory.length) return `<div class="empty-note">Истории по адресу пока нет.</div>`;
  const groups = new Map();
  for (const item of registerHistory) {
    const key = [
      sourceGroupKey(item),
      item.is_current || "",
      item.assignment_status || "",
      item.change_status || "",
      item.changed_by_source_raw_file || "",
      item.changed_by_source_act_date || "",
      item.changed_by_source_act_number || ""
    ].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const grouped = [...groups.values()].sort((left, right) => (
    String(right[0]?.source_act_date || "").localeCompare(String(left[0]?.source_act_date || ""))
  ));
  const key = addressHistoryKey(row);
  const expanded = key ? state.expandedAddressHistories.has(key) : false;
  const shown = expanded ? grouped : grouped.slice(0, addressHistoryLimit);
  const rest = grouped.length - shown.length;
  return `
    <div class="compact-list">
      ${shown.map((items) => {
        const first = items[0];
        const schools = schoolNumberList(items) || "школа не указана";
        const status = assignmentStatusLabel(first);
        const change = addressHistoryChangeLabel(first) || changeStatusLabel(first);
        const changed = changedByLabel(first);
        return `
          <div class="compact-row">
            <div class="compact-main">
              <strong>${escapeHtml(sourceCompactTitle(first))}</strong>
              <span>${[schools, status, change].filter(Boolean).map(escapeHtml).join(" · ")}</span>
              ${changed ? `<em>${escapeHtml(changed)}</em>` : ""}
            </div>
          </div>
        `;
      }).join("")}
      ${rest > 0 ? `<div class="address-item muted">Скрыто ${rest}</div>` : ""}
      ${addressHistoryToggleHtml(row, grouped.length, expanded)}
    </div>
  `;
}

function addressEvidenceSpec(witness, mode = "address") {
  const rawFile = witness.source_region_raw_file || witness.source_raw_file || "";
  if (!/\.pdf$/i.test(rawFile)) return null;
  return {
    rawFile, page: witness.source_region_page || witness.source_page || "", y: witness.source_y ?? "",
    regionId: witness.source_region_id || "",
    parallel: Boolean(witness.source_region_raw_file && witness.source_region_raw_file !== witness.source_raw_file),
    sha256: witness.source_region_sha256 || witness.source_registry_raw_sha256 || "", school: normalizeSchoolNumber(witness.school_number),
    street: witness.parsed_street || "", house: witness.parsed_house || "",
    rule: witness.source_house_rule || "",
    ...(sourceFromFifthGrade(witness) ? {fromFifthGrade: true} : {}),
    literal: witness.record_kind === "scan_literal" && witness.source_point_status === "explicit_house",
    label: assignmentAddressTitle(witness), title: sourceCompactTitle(witness), mode
  };
}

function sourceEvidenceSnippetHtml(witness, mode = "address", label = "Фрагмент") {
  const spec = addressEvidenceSpec(witness, mode);
  if (!spec) return "";
  return `<button class="source-preview-link" type="button" data-source-preview="${escapeAttr(JSON.stringify(spec))}" aria-label="Фрагмент документа, ${escapeAttr(schoolReference(spec.school))}: ${escapeAttr(spec.label || spec.title)}">${escapeHtml(label)}</button>`;
}

function primaryDocumentLineHtml(rows, options = {}) {
  const evidenceRows = (rows || []).filter((item) => item && (options.includeRules || item.record_kind !== "scan_rule"));
  const multipleSchools = new Set(evidenceRows.map(row => normalizeSchoolNumber(row.school_number)).filter(Boolean)).size > 1;
  const groups = uniqueBy(
    evidenceRows,
    (item) => sourceGroupKey(item)
  );
  if (!groups.length) return "";
  return `
    <div class="primary-document inline-source-evidence">
      <h3 class="evidence-heading">${evidenceRows.every((item) => item.record_kind === "scan_rule") ? "Документ о территории" : "Откуда эта привязка"}</h3>
      ${groups.map((item) => {
        const links = sourceLinks(item);
        const groupKey = sourceGroupKey(item);
        const schoolNumbers = uniqueBy(
          evidenceRows
            .filter((row) => sourceGroupKey(row) === groupKey)
            .map((row) => normalizeSchoolNumber(row.school_number))
            .filter(Boolean),
          (number) => number
        );
        const schoolMapping = options.showSchools && multipleSchools && schoolNumbers.length
          ? `<small>Школы: ${escapeHtml(schoolNumbers.map(schoolReference).join(", "))}</small>`
          : "";
        const rawFile = item.source_region_raw_file || item.source_raw_file || "";
        const isPdf = /\.pdf$/i.test(rawFile);
        const witnesses = uniqueBy(evidenceRows.filter(row => sourceGroupKey(row) === groupKey), row => normalizeSchoolNumber(row.school_number));
        const previews = isPdf ? witnesses.map(witness => sourceEvidenceSnippetHtml(witness, options.mode || "address", multipleSchools ? `${schoolReference(witness.school_number)} · фрагмент` : "Фрагмент")).join("") : "";
        const pages = uniqueBy(witnesses.map(row => row.source_region_page || row.source_page).filter(value => /^\d+$/.test(value || "")), value => value);
        return `<section class="source-document"><div class="source-document-title"><strong>${escapeHtml(sourceCompactTitle(item))}</strong>${pages.length ? `<span>стр. ${escapeHtml(pages.join(", "))}</span>` : ""}${previews}</div>${schoolMapping}${links ? `<div class="compact-links">${links}</div>` : ""}</section>`;
      }).join("")}
    </div>
  `;
}

function approximateAreaExplanationHtml(schools) {
  const schoolRows = (schools || []).map((item) => schoolLikeForAssignment(item));
  const areaCount = schoolRows.filter((row) => (
    schoolAreaFeature(row) || schoolSharedAreaFeatures(row).length
  )).length;
  let title = "Область на карте загружается";
  let copy = "Официальными являются список домов и их связь со школой. Координаты и геометрия карты вычислены по этим данным.";
  if (state.schoolSectionsLoadError) {
    title = "Область временно недоступна";
    copy = "Файл вычисленной геометрии не загрузился. Официальные списки домов и их связь со школой остаются доступны.";
  } else if (state.schoolSectionsLoaded && areaCount === 0) {
    title = "Примерная область пока не построена";
    copy = "Точка дома появляется только при выборе адреса. Отсутствующая заливка не меняет официальную привязку к школе.";
  } else if (areaCount > 0) {
    title = areaCount < schoolRows.length ? `Показаны области ${areaCount} из ${schoolRows.length} школ` : "Заливка на карте: только ориентир";
    copy = "Официальными являются список домов и их связь со школой. Координаты и область вычислены по этим адресам и не являются официальной границей.";
  }
  return `
    <div class="area-explanation">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(copy)}</p>
      </div>
    </div>
  `;
}

function accuracyAnnotationHtml(content) {
  return `<section class="map-accuracy-info" aria-label="О карте и точности">
    <div class="annotation-heading"><h3>О карте и точности</h3><button type="button" class="annotation-trigger" data-annotation-trigger aria-label="Пояснение о карте и точности" aria-expanded="false" aria-controls="context-annotation"><span aria-hidden="true">!</span></button></div>
    <div class="annotation-source" hidden>${content}</div>
  </section>`;
}

function mapAccuracyInfoHtml(schools) {
  return accuracyAnnotationHtml(approximateAreaExplanationHtml(schools));
}

function renderAddressCard(row) {
  const currentAssignments = currentAddressAssignments(row);
  const homeLocated = hasMapCoordinates(row);
  const schools = currentAssignments.length ? currentAssignments : [row];
  return `
    <h2 id="selectionHeading" class="card-title prominent" tabindex="-1">${escapeHtml(addressTitle(row))}</h2>
    <div class="card-subtitle">${escapeHtml(row.district ? `${row.district} район` : "Санкт-Петербург")}</div>
    ${!homeLocated ? schoolStatusNoteHtml("Точное местоположение дома не определено.") : ""}
    ${schools.some(assignmentHasOpenReview) ? schoolStatusNoteHtml("Данные адреса требуют уточнения.") : ""}
    <div class="answer-block address-assignment">
      <strong>${schools.length > 1 ? "Закреплённые школы" : "Закреплённая школа"}</strong>
      <div class="answer-schools">
        ${schools.map((item) => {
          const key = assignmentSchoolKey(item);
          const label = compactSchoolTitle(schoolLikeForAssignment(item));
          const display = /^Школа №\d+$/u.test(label) ? label.slice("Школа ".length) : label;
          return key && state.schoolByKey.has(key)
            ? `<button class="school-answer" type="button" data-school-key="${escapeAttr(key)}" aria-label="${escapeAttr(label)}">${escapeHtml(display)}</button>`
            : `<strong>${escapeHtml(label)}</strong>`;
        }).join("")}
      </div>
    </div>
    <div data-inline-documents="address" aria-label="Документы адреса">
      <div class="address-action-bar">${homeLocated ? `<button type="button" data-center-address-id="${escapeAttr(row.address_id)}">${atlasIcon("pin")}Дом на карте</button>` : ""}</div>
    </div>
  `;
}

function schoolSummaryHtml(row, stats, historyStats, source) {
  const catchmentStatus = {
    current: "есть текущий официальный документ",
    history_only: "есть только исторический документ",
    none: "документ о территории не найден"
  }[row.scan_presence] || "статус документа не указан";
  return `
    <div class="meta-grid compact-meta">
      ${metaRow("Документ о территории", escapeHtml(catchmentStatus))}
      ${metaRow("Текущие адреса", escapeHtml(`${historyStats.current} ${ruPlural(historyStats.current, "адрес", "адреса", "адресов")}; ${stats.geocoded} на карте`))}
      ${metaRow("Примерная область", schoolAreaSummaryHtml(row))}
      ${metaRow("Точки школы на карте", schoolCampusesValue(row))}
      ${metaRow("Адрес организации в реестре", escapeHtml(row.official_address || row.address || ""))}
      ${metaRow("Сайт", row.official_website ? linkHtml(row.official_website, "сайт школы") : "")}
      ${metaRow("ОГРН", escapeHtml(row.official_ogrn || ""))}
      ${metaRow("Страница района", (source.source_page_url || source.source_url) ? linkHtml(source.source_page_url || source.source_url, "официальная страница") : "")}
    </div>
  `;
}


function schoolQaHtml(row, checkStats, areaExcluded) {
  const reviewRows = schoolCurrentAssignments(row).filter((item) => (
    assignmentCheckLabels(item).filter((label) => label !== "нет координат").length
  ));
  const decisions = reviewDecisionsForSchool(row);
  const coordinateReviews = coordinateReviewsForSchool(row);
  const decisionCounts = new Map();
  decisions.forEach((decision) => {
    const status = decision.decision_status || "pending";
    decisionCounts.set(status, (decisionCounts.get(status) || 0) + 1);
  });
  const coordinateCounts = new Map();
  coordinateReviews.forEach((item) => {
    const status = coordinateAuditStatusLabel(item.coordinate_audit_status || "");
    if (!status) return;
    coordinateCounts.set(status, (coordinateCounts.get(status) || 0) + 1);
  });
  const decisionSummary = [...decisionCounts.entries()]
    .map(([status, count]) => `${reviewDecisionStatusLabel(status)}: ${count}`)
    .join("; ");
  const coordinateSummary = [...coordinateCounts.entries()]
    .map(([status, count]) => `${status}: ${count}`)
    .join("; ");
  const decisionStatus = decisionSummary || (state.reviewDecisionLoadFailures.has(row.district) ? "источник недоступен" : "нет");
  const coordinateStatus = coordinateSummary || (state.coordinateReviewLoadFailures.has(row.district) ? "источник недоступен" : "нет");
  const reasonGroups = new Map();
  for (const item of reviewRows) {
    const reasons = assignmentCheckLabels(item).filter(label => label !== 'нет координат');
    for (const reason of reasons) {
      if (!reasonGroups.has(reason)) reasonGroups.set(reason, []);
      reasonGroups.get(reason).push(item);
    }
  }
  return `
    <div class="meta-grid compact-meta">
      ${metaRow("Координаты школы", schoolCoordinateValue(row))}
      ${checkStats.needsCheck ? metaRow("Адресов на проверке", escapeHtml(String(checkStats.needsCheck))) : ''}
      ${decisionStatus !== 'нет' ? metaRow("Результаты проверки", escapeHtml(decisionStatus)) : ''}
      ${coordinateStatus !== 'нет' ? metaRow("Проверка координат", escapeHtml(coordinateStatus)) : ''}
      ${areaExcluded ? metaRow("Не влияют на область", escapeHtml(String(areaExcluded))) : ''}
    </div>
    ${decisions.length ? `<div class="list-title">Решения по адресам</div>${reviewDecisionListHtml(decisions, 8)}` : ""}
    ${coordinateReviews.length ? `<div class="list-title">Координатные проверки</div>${coordinateReviewListHtml(coordinateReviews, 8)}` : ""}
    ${reasonGroups.size ? `
      <div class="list-title">Адреса с отметками</div>
      <div class="qa-reason-groups">
        ${[...reasonGroups].map(([reason, items]) => `<section class="qa-reason-group"><h3>${escapeHtml(reason)} · ${items.length}</h3><div>${items.map(item => addressActionRowHtml(item, `<span>${escapeHtml(atlasCampusAddress(assignmentAddressTitle(item)))}</span>`, 'focus')).join('')}</div></section>`).join('')}
      </div>
    ` : ''}
  `;
}

function atlasIcon(name) {
  const paths = {
    house: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    doc: '<path d="M5 3h9l5 5v13H5ZM14 3v6h5M8 13h8M8 17h6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
    map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2ZM9 3v16M15 5v16"/>',
    pin: '<path d="M19 10c0 4.5-7 10-7 10S5 14.5 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>'
  };
  return `<svg class="atlas-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function atlasStreetLabel(value) {
  return String(value || '').replace(/улица/giu, 'ул.').replace(/проспект/giu, 'пр.')
    .replace(/переулок/giu, 'пер.').replace(/набережная/giu, 'наб.');
}

function atlasStreetHeading(value) {
  const label = String(value || '').replace(/\s+/g,' ').trim();
  const types = [
    [['улица','ул.','ул'],'ул.'], [['проспект','пр-кт','просп.','просп','пр.','пр'],'пр.'],
    [['проезд','пр-д.','пр-д'],'пр-д'], [['переулок','пер.','пер'],'пер.'],
    [['шоссе','ш.','ш'],'ш.'], [['бульвар','б-р.','б-р','бул.','бул'],'б-р'],
    [['дорога','дор.','дор'],'дор.'], [['набережная','наб.','наб'],'наб.'],
    [['аллея','ал.','ал'],'ал.'], [['площадь','пл.','пл'],'пл.']
  ];
  const lower = label.toLocaleLowerCase('ru');
  for (const [aliases, short] of types) for (const alias of aliases) {
    if (lower.startsWith(alias+' ')) return label.slice(alias.length).trim()+' '+short;
    if (lower.endsWith(' '+alias)) return label.slice(0,-alias.length).trim()+' '+short;
  }
  return label;
}

function atlasCampusAddress(value) {
  const local = String(value || '').replace(/^\s*(?:\d{6}\s*,\s*)?(?:г\.?\s*)?Санкт-Петербург(?:\s*г\.?)?\s*,\s*/i, '')
    .replace(/,\s*\d{6}\s*$/, '');
  const parts = atlasStreetLabel(local).split(/\s*,\s*/);
  const house = parts.findIndex((part, index) => index > 0 && /^\d+[А-ЯA-Z]?(?:\/\d+[А-ЯA-Z]?)?$/iu.test(part));
  if (house >= 0) {
    parts[house] = `д.\u00a0${parts[house]}`;
  }
  return parts.join(', ').replace(/\sул(?=,|$)/giu, ' ул.')
    .replace(/(корп\.|стр\.|лит\.)\s+(\d+[А-ЯA-Z]?|[А-ЯA-Z])/giu, '$1\u00a0$2');
}

function schoolStreetGroups(row) {
  const groups = new Map();
  for (const item of schoolCurrentAssignments(row)) {
    const name = item.parsed_street || item.street || 'Другие адреса';
    if (!groups.has(name)) groups.set(name, {name, count: 0});
    groups.get(name).count += 1;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

// Cache only the selected school's directory. Expanded streets are rendered on
// demand; opening an address does not change the school or search selection.
let sidebarDirectoryCache = null, sidebarDirectorySerial = 0;
function reusableSchoolDirectory(school) {
  const cached = sidebarDirectoryCache, key = schoolKey(school);
  const complete = cached && (VIEWER_API ? loadedSchoolDetails.has(cached.key)
    : state.assignmentLevelByDistrict.get(cached.district) === 'full');
  const hasGarden = cached?.streets.some(street => street.kind === 'garden')
    || directoryGardensForSchool(school).some(garden => (garden.feature.properties.school_numbers || []).includes(school.school_number));
  return complete && !hasGarden && cached.eligibleSchoolKeys?.has(key)
    && cached.district === school.district && cached.total > 0
    && cached.rows === state.assignmentsBySchoolKey.get(cached.key)
    && cached.scopeData === areaScopeData.get(school.district)
    && Number(school.current_address_count) === cached.total ? cached : null;
}

function directoryGardensForSchool(school) {
  return [...state.gardenById.values()].filter(feature => feature.properties.district === school.district)
    .map(feature => {
      const p=feature.properties;
      const name=String(p.name || '').replace(/[«»"']/g,'').replace(/^(?:СНТ|СДТ|СТ|садоводство)\s+/iu,'').trim();
      const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      return {feature, fragments:new Set(p.source_fragment_ids || []),
        pattern:new RegExp('(?:^|[\\s,>])(?:снт|сдт|ст|садоводство|садоводческое товарищество)\\s+'+escaped+'(?=$|[\\s,>;])','iu')};
    });
}

function directoryGardenForAddress(row, gardens) {
  if (row._gardenTerritoryId) return gardens.find(garden=>garden.feature.properties.territory_id===row._gardenTerritoryId)?.feature || null;
  const text=String(row.canonical_address || '').replace(/[«»"']/g,'');
  const named=gardens.filter(garden=>garden.pattern.test(text));
  if(named.length===1) return named[0].feature;
  const bound=gardens.filter(garden=>garden.fragments.has(row.source_fragment_id));
  return bound.length===1 ? bound[0].feature : null;
}

function schoolAddressDirectory() {
  const school = selectedSchoolRow();
  if (!school || selectedAddressRow()) return null;
  const reusable = reusableSchoolDirectory(school);
  if (reusable) return {...reusable, key:schoolKey(school), title:compactSchoolTitle(school)};
  const rows = schoolAssignments(school);
  const scopeData=areaScopeData.get(school.district);
  if (sidebarDirectoryCache?.rows === rows && sidebarDirectoryCache.key === schoolKey(school) && sidebarDirectoryCache.scopeData===scopeData) return sidebarDirectoryCache;
  const groups = new Map(), addresses = new Map(), gardens = directoryGardensForSchool(school);
  for (const garden of gardens) {
    const p=garden.feature.properties;
    if (!(p.school_numbers || []).includes(school.school_number)) continue;
    const key='garden::'+p.territory_id;
    groups.set(key,{key,kind:'garden',territoryId:p.territory_id,
      name:`${p.name} (${VIEWER_BOOTSTRAP?.area_scope_index && !scopeData ? 'исключения не проверены' : scopeData?.gardens[p.territory_id]?.exceptions.length ? 'есть исключения' : 'все'})`,
      whole:true,schoolNumbers:p.school_numbers,items:[]});
  }
  let gardenMemberCount=0, ordinaryMissing=0;
  const currentRows=schoolCurrentAssignments(school), extraRows=[];
  const existingKeys=new Set(currentRows.map(row=>row.address_key || row.address_id));
  for (const [id,garden] of Object.entries(scopeData?.gardens || {})) {
    if (!garden.members.includes(schoolKey(school))) continue;
    for (const key of garden.exceptions) if (!existingKeys.has(key)) {
      extraRows.push({...scopeData.addresses[key],_gardenTerritoryId:id}); existingKeys.add(key);
    }
  }
  for (const item of [...currentRows,...extraRows]) {
    const street = item.parsed_street || item.street || 'Другие адреса';
    const name = atlasStreetHeading(street);
    const key = name.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const addressKey = item.address_key || item.address_id;
    const id = navigableAddressId(item);
    const row = state.addressById.get(id) || item;
    addresses.set(addressKey, row);
    const title = addressTitle(item);
    const label = title.startsWith(`${street},`) ? title.slice(street.length + 1).trim() : title;
    const addressItem={key:addressKey,id,label,title,located:hasMapCoordinates(row)};
    const garden=directoryGardenForAddress(item,gardens);
    if(garden) {
      gardenMemberCount++;
      const p=garden.properties, gardenKey='garden::'+p.territory_id;
      const expected=(p.school_numbers || []).map(number=>districtSchoolKey(p.district,number)).sort();
      const actual=[...new Set(splitPipeValues(item.current_school_numbers || item.current_school_number)
        .map(number=>districtSchoolKey(item.district,number)))].sort();
      const whole=expected.includes(schoolKey(school));
      const sameGardenHouse = scopeData?.gardens[p.territory_id]?.matching_aliases?.includes(addressKey);
      if(!groups.has(gardenKey)) groups.set(gardenKey,{key:gardenKey,kind:'garden',territoryId:p.territory_id,
        name:`${p.name} (${VIEWER_BOOTSTRAP?.area_scope_index && !scopeData ? 'исключения не проверены' : scopeData?.gardens[p.territory_id]?.exceptions.length ? 'есть исключения' : whole ? 'все' : 'часть адресов'})`,whole,schoolNumbers:p.school_numbers,items:[]});
      if(!whole || (!sameGardenHouse && JSON.stringify(actual)!==JSON.stringify(expected))) groups.get(gardenKey).items.push({...addressItem,label:title});
    } else {
      if(!groups.has(key)) groups.set(key,{key,name,items:[]});
      groups.get(key).items.push(addressItem);
      if(!addressItem.located) ordinaryMissing++;
    }
  }
  const streets = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru', {numeric: true}));
  for (const group of streets) group.items.sort((a, b) => a.label.localeCompare(b.label, 'ru', {numeric: true}));
  const signature = JSON.stringify([school.district, streets.map(street => [street.name,street.kind,street.whole,street.schoolNumbers, street.items.map(item => {
    const address = addresses.get(item.key);
    return [item.key,item.label,item.title,item.located,address?.lat,address?.lon,address?.coordinate_precision];
  })])]);
  let eligibleSchoolKeys = null;
  for (const address of addresses.values()) {
    // The accepted address membership is independent of the currently loaded
    // school package. Never infer identical lists from a shared polygon alone.
    const members = new Set(splitPipeValues(address.current_school_numbers || address.current_school_number)
      .map(number => districtSchoolKey(address.district, number)));
    eligibleSchoolKeys = eligibleSchoolKeys == null ? members
      : new Set([...eligibleSchoolKeys].filter(key => members.has(key)));
  }
  const contentKey = sidebarDirectoryCache?.signature === signature ? sidebarDirectoryCache.contentKey
    : `directory-${++sidebarDirectorySerial}`;
  sidebarDirectoryCache = {key: schoolKey(school), rows, scopeData, title: compactSchoolTitle(school), district: school.district,
    streets, addresses, total: addresses.size, signature, contentKey, eligibleSchoolKeys,
    houseCount:addresses.size-gardenMemberCount,gardenCount:streets.filter(street=>street.kind==='garden').length,
    streetCount:streets.filter(street=>street.kind!=='garden').length,missingCoordinates:ordinaryMissing};
  return sidebarDirectoryCache;
}

function sidebarAddressDocuments(row = selectedAddressRow()) {
  if (!row) return null;
  const history = assignmentHistoryForAddress(row);
  const evidence = uniqueBy((history.length ? history : [row]).filter(item => sourceFragmentPeriod(item) === 'current'), item => [sourceGroupKey(item), item.school_number,
    item.source_region_id, item.source_region_page || item.source_page, item.source_y, item.is_current].join('|'))
    .sort((a, b) => (b.is_current === 'yes') - (a.is_current === 'yes') || String(b.source_act_date).localeCompare(String(a.source_act_date)));
  const showSchool = new Set(evidence.map(item => item.school_number)).size > 1;
  const documents = evidence.map(item => {
    const period = sourceFragmentPeriod(item) === 'current' ? 'Текущий' : 'История';
    const school = schoolReference(item.school_number);
    const page = item.source_region_page || item.source_page;
    const link = VIEWER_API?.originalDocument?.(item.source_raw_file);
    const source = link?.url
      ? linkHtml(link.url, link.label)
      : sourceLinks(item);
    return {
      current: sourceFragmentPeriod(item) === 'current',
      label: `${period} · ${sourceCompactTitle(item)} · ${school}${page ? ` · стр. ${page}` : ''}`,
      compactLabel: `${period} · ${historyDocumentTitle(item)}${showSchool ? ` · ${school}` : ''}${page ? ` · с. ${page}` : ''}`,
      spec: addressEvidenceSpec(item),
      html: `<div class="address-source-meta">${source}${item.source_house_rule ? `<p>Правило: ${escapeHtml(item.source_house_rule)}</p>` : ''}</div>`
    };
  });
  return { documents, change: addressAssignmentChange(row, history) };
}

function focusSidebarAddress(key) {
  const row = sharedComparisonModel()?.addresses.get(key) || schoolAddressDirectory()?.addresses.get(key);
  if (!row || !hasMapCoordinates(row)) return;
  state.focusedSchoolAddressId = row.address_id;
  renderSelectionHighlights();
  centerHouse(row);
}

function centerHouse(row) {
  const feature = hasMapCoordinates(row) ? addressFeature(row) : null;
  if (feature) fitFeatures([feature],{maxZoom:16});
  else focusAddress(row);
}

function sharedComparisonIdentity(context) {
  return context ? [context.key,context.componentId || '',context.scopeMode || 'component', [...context.schoolKeys].sort().join('|')].join('|') : '';
}

function supportsSharedComparison(context) {
  return Boolean(context && (context.kind === 'exclusive' || (context.schoolKeys.length > 1
    && new Set(context.schoolKeys.map(key => key.split('::')[0])).size === 1)));
}

function sharedComparisonModel() {
  return sharedComparisonCache?.identity === sharedComparisonIdentity(currentSharedAreaContext())
    ? sharedComparisonCache.model : null;
}

function comparisonLocality(row) {
  const normalize = value => value.replace(/\s+/g, ' ').trim()
    .replace(/^(?:город|пос[её]лок|[гп]\.?)\s+/iu, '').replace(/\s+(?:город|пос[её]лок|[гп]\.?)$/iu, '')
    .toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const explicit = normalize(String(row.source_locality_hint || ''));
  if (explicit) return explicit;
  // Missing source locality is not a licence to merge a city homonym into a settlement.
  for (const segment of String(row.canonical_address || '').split(/[>,]/)) {
    const match = segment.trim().match(/^(?:пос[её]лок|город|[гп]\.?)\s+([А-ЯЁ][А-Яа-яЁё-]*)$/iu)
      || segment.trim().match(/^([А-ЯЁ][А-Яа-яЁё-]*)\s+[гп]\.?$/iu);
    const locality = match ? normalize(match[1]) : '';
    if (locality && locality !== 'санкт-петербург') return locality;
  }
  return '';
}

function buildSharedComparisonModel(rows, schoolKeys, identity = schoolKeys.join('|'), options = {}) {
  if (options.geographic) schoolKeys=[...new Set([...schoolKeys,...rows.flatMap(row=>addressSchoolKeys(row))])];
  const wanted = new Set(schoolKeys), addresses = new Map(), groups = new Map();
  const district = schoolKeys[0]?.split('::')[0];
  const schools = schoolKeys.map(key => ({key, number:key.split('::').slice(1).join('::'),
    title:state.schoolByKey.has(key) ? compactSchoolTitle(state.schoolByKey.get(key)) : key.split('::').slice(1).join('::')}));
  const gardens = directoryGardensForSchool({district});
  for (const item of rows) {
    if (item.is_current !== 'yes' || item.record_kind === 'scan_rule' || item.district !== district) continue;
    const key = item.address_key || item.address_id;
    const members = new Set(addressSchoolNumbers(item).map(number => districtSchoolKey(district, number)));
    if (!key || ![...members].some(member => wanted.has(member))) continue;
    if (addresses.has(key)) { members.forEach(member => addresses.get(key).members.add(member)); continue; }
    const row = Object.fromEntries(['address_id','address_key','district','canonical_address','parsed_street','parsed_house',
      'lat','lon','coordinate_precision','coordinate_source','geocode_status','source_locality_hint','source_fragment_id','current_school_number','school_number'].map(name => [name,item[name] ?? '']));
    row.home_point_eligible = hasMapCoordinates(item) ? 'yes' : 'no';
    addresses.set(key, {...row, members});
  }
  for (const [key,row] of addresses) {
    const garden = directoryGardenForAddress(row, gardens);
    if (garden) {
      const p = garden.properties, groupKey = 'garden::'+p.territory_id;
      if (!groups.has(groupKey)) groups.set(groupKey, {key:groupKey, name:p.name+(options.outsideArea ? '' : options.geographic ? ' (в выбранной области)' : ' (все)'), kind:'garden',
        territoryId:p.territory_id, members:new Set((p.school_numbers || []).map(number => districtSchoolKey(district,number))), items:[]});
      const expected = [...groups.get(groupKey).members].sort().join('|');
      if ([...row.members].sort().join('|') !== expected) groups.get(groupKey).items.push({key, row, members:row.members,
        label:atlasCampusAddress(row.canonical_address), located:hasMapCoordinates(row)});
      continue;
    }
    const street = atlasStreetHeading(row.parsed_street || 'Другие адреса'), locality = comparisonLocality(row);
    const groupKey = [locality.toLocaleLowerCase('ru'),street.toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/\./g,'')].join('|');
    if (!groups.has(groupKey)) groups.set(groupKey, {key:groupKey,name:street,locality,items:[]});
    const title = addressTitle(row), prefix = row.parsed_street+',';
    groups.get(groupKey).items.push({key,row,members:row.members,
      label:title.startsWith(prefix) ? title.slice(prefix.length).trim() : title,located:hasMapCoordinates(row)});
  }
  const streets = [...groups.values()].sort((a,b) => (a.locality || '').localeCompare(b.locality || '', 'ru') || a.name.localeCompare(b.name,'ru',{numeric:true}));
  for (const street of streets) {
    if (!street.locality && street.kind !== 'garden' && streets.some(other => other.name === street.name && other.locality)) street.locality = 'Населённый пункт не указан';
    else if (street.locality) street.locality = street.locality[0].toLocaleUpperCase('ru')+street.locality.slice(1);
    street.items.sort((a,b) => a.label.localeCompare(b.label,'ru',{numeric:true}));
    street.counts = schoolKeys.map(key => street.kind === 'garden' ? Number(street.members.has(key)) : street.items.filter(item => item.members.has(key)).length);
  }
  return {key:identity,contentKey:'comparison:'+identity,schools,streets,addresses,
    counts:schoolKeys.map(key => [...addresses.values()].filter(row => row.members.has(key)).length),
    addressById:new Map([...addresses.values()].map(row => [row.address_id,row]))};
}

async function loadSharedComparison(retry = false, {fitCoverage = false} = {}) {
  const context = currentSharedAreaContext();
  if (!supportsSharedComparison(context)) return;
  const identity = sharedComparisonIdentity(context);
  if (!retry && sharedComparisonCache?.identity === identity
      && (sharedComparisonCache.status==='ready' || sharedComparisonCache.context===context)) return;
  sharedComparisonCache?.controller.abort();
  const controller = new AbortController(), entry = {identity,context,controller,model:null,status:'loading'};
  sharedComparisonCache = entry;
  renderSelectionCard();
  try {
    if (VIEWER_BOOTSTRAP?.area_scope_index) {
      const district=context.district || context.schoolKeys[0].split('::')[0];
      const data=await ensureAreaScopeData(district,{signal:controller.signal});
      if (entry!==sharedComparisonCache || currentSharedAreaContext()!==context) return;
      const area=data.areas[context.key];
      if (!area) throw new Error('Участок отсутствует в индексе');
      context.kind=area.kind || 'assignment_zone';
      let component=area.components.find(part=>part.id===context.componentId);
      if (!component) component=area.components.find(part=>window.schoolAreaTileModule.componentContains(part,context.clickPoint))
        || (area.components.length===1 ? area.components[0] : null);
      if (!component && context.scopeMode === 'component') {
        entry.status = 'outside';
        renderSelectionCard();
        return;
      }
      context.componentId=component?.id || '';
      const parts=context.scopeMode==='all' ? area.components : component ? [component] : [];
      const keys=context.scopeMode==='unassigned' ? area.unassigned_keys : [...new Set(parts.flatMap(part=>part.keys))];
      context.geometry=context.scopeMode==='unassigned' ? null : parts.length===1 ? parts[0].geometry
        : {type:'MultiPolygon',coordinates:parts.map(part=>part.geometry.coordinates)};
      context.componentCount=area.components.length;
      context.unassignedCount=area.unassigned_keys.length;
      entry.identity=sharedComparisonIdentity(context);
      entry.model=buildSharedComparisonModel(keys.map(key=>data.addresses[key]),context.schoolKeys,entry.identity,{
        geographic:true, outsideArea:context.scopeMode==='unassigned'
      });
      prepareAddressRows([...entry.model.addresses.values()]);
      entry.status='ready';
      renderSchoolSections(); renderSelectionHighlights(); renderSelectionCard();
      if (fitCoverage) focusAreaSchoolCoverage(context);
      return;
    }
    if (VIEWER_API?.isStaticDelivery) throw new Error('Нет индекса адресов участка');
    const rows = [], covered = new Map();
    const ordered = [...context.schoolKeys].sort((a,b) => Number(state.schoolByKey.get(b)?.current_address_count || 0)-Number(state.schoolByKey.get(a)?.current_address_count || 0));
    for (const key of ordered) {
      const expected = Number(state.schoolByKey.get(key)?.current_address_count);
      if (Number.isFinite(expected) && expected >= 0 && covered.get(key)?.size === expected) continue;
      const data = loadedSchoolDetails.has(key) || !VIEWER_API ? state.assignmentsBySchoolKey.get(key) || [] : await VIEWER_API.school(key,{signal:controller.signal});
      controller.signal.throwIfAborted();
      if (entry !== sharedComparisonCache || identity !== sharedComparisonIdentity(currentSharedAreaContext())) { controller.abort(); return; }
      const currentData = data.filter(row => row.is_current === 'yes' && row.record_kind !== 'scan_rule');
      prepareAddressRows(currentData);
      for (const row of currentData) {
        rows.push(row);
        for (const number of addressSchoolNumbers(row)) {
          const member = districtSchoolKey(row.district,number);
          if (!covered.has(member)) covered.set(member,new Set());
          covered.get(member).add(row.address_key || row.address_id);
        }
      }
    }
    if (entry !== sharedComparisonCache || identity !== sharedComparisonIdentity(currentSharedAreaContext())) return;
    entry.model = buildSharedComparisonModel(rows,context.schoolKeys,identity); entry.status = 'ready';
  } catch (error) {
    if (controller.signal.aborted || entry !== sharedComparisonCache) return;
    entry.status = 'error';
  }
  if (entry === sharedComparisonCache) renderSelectionCard();
}

function renderSharedComparisonCard(context) {
  const model = sharedComparisonModel();
  const exclusive = context.kind === 'exclusive';
  const otherAddresses = context.scopeMode === 'unassigned';
  const label=otherAddresses ? 'Другие адреса этих школ'
    : exclusive ? 'Выбранный участок' : context.kind==='building_surface' ? 'Общий дом'
    : context.scopeMode==='all' ? 'Все общие участки этих школ' : 'Пересечение расчётных областей';
  const header = `<h2 id="selectionHeading" class="scope-title" tabindex="-1">${label}</h2>`;
  const schoolNames=context.schoolKeys.map(key=>state.schoolByKey.has(key)?compactSchoolTitle(state.schoolByKey.get(key)):key.split('::')[1]).join(', ');
  const title=`<p class="scope-schools">${escapeHtml(schoolNames)}</p>`;
  if (otherAddresses) {
    const previousMode = context.previousScopeMode === 'all' ? 'all' : 'component';
    const back = previousMode === 'all' ? 'К общим участкам' : 'К выбранному участку';
    const count = model ? `<p class="scope-count">${model.addresses.size} ${ruPlural(model.addresses.size,'адрес','адреса','адресов')}</p>` : '';
    return `${header}${title}<p class="scope-caption">Здесь дома за пределами этой зоны на карте и дома без точной точки. У каждого адреса указаны его школы.</p>
      ${count}<div class="scope-actions"><button type="button" data-scope-mode="${previousMode}">← ${back}</button></div>
      ${model ? '<div data-street-directory data-shared-comparison="list"></div>' : sharedComparisonStatusHtml()}`;
  }
  if (!model) return header+title+sharedComparisonStatusHtml();
  const controls=`<div class="scope-actions">${comparisonSchoolKey ? '<button type="button" data-comparison-column="">Все столбцы</button>' : ''}
    ${exclusive || comparisonSchoolKey ? `<button type="button" data-full-school="${escapeAttr(exclusive ? context.schoolKeys[0] : comparisonSchoolKey)}">Вся территория школы →</button>` : ''}
    ${!exclusive && context.componentCount>1 ? `<button type="button" data-scope-mode="${context.scopeMode==='all'?'component':'all'}">${context.scopeMode==='all'?'Выбранная часть':'Все общие участки ('+context.componentCount+')'}</button>` : ''}
    ${context.unassignedCount ? `<button type="button" data-scope-mode="unassigned">Другие адреса этих школ (${context.unassignedCount})</button>` : ''}</div>`;
  return `${header}${title}<p class="scope-caption">Это пересечение расчётных (не официальных) областей нескольких школ. Счётчик школ и строк в таблице описывает всю зону; галочка в строке дома показывает его фактическое закрепление.</p>
    <p class="scope-count">${model.addresses.size} ${ruPlural(model.addresses.size,'адрес','адреса','адресов')} в зоне${model.schools.length>context.schoolKeys.length ? ' · В таблице также есть другие школы этих домов' : ''}</p>${controls}<div data-street-directory data-shared-comparison></div>`;
}

function sharedComparisonStatusHtml() {
  const status = sharedComparisonCache?.status;
  const message = status === 'outside' ? 'Не удалось определить выбранную часть. Приблизьте карту и нажмите на участок ещё раз.'
    : status === 'error' ? 'Не удалось загрузить адреса. <button type="button" data-retry-shared-comparison>Повторить загрузку</button>'
    : 'Загружаем адреса…';
  return `<div class="shared-comparison-status" role="status">${message}</div>`;
}

function sidebarSchoolDocuments() {
  const row = selectedSchoolRow();
  if (!row) return null;
  const evidence = uniqueBy(schoolAssignments(row).filter(item => sourceFragmentPeriod(item) === 'current'), item => [sourceGroupKey(item), sourceFragmentPeriod(item),
    item.source_region_id, item.source_region_page || item.source_page, item.source_y].join('|'))
    .sort((a, b) => (sourceFragmentPeriod(b) === 'current') - (sourceFragmentPeriod(a) === 'current')
      || String(b.source_act_date).localeCompare(String(a.source_act_date)));
  return {documents: evidence.map(item => ({
    label: `${sourceFragmentPeriod(item) === 'current' ? 'Текущий' : 'История'} · ${sourceCompactTitle(item)}${item.source_region_page || item.source_page ? ` · стр. ${item.source_region_page || item.source_page}` : ''} · ${assignmentAddressTitle(item)}`,
    spec: addressEvidenceSpec(item, 'school'),
    html: `<div class="address-source-meta">${sourceLinks(item)}<p>${escapeHtml(assignmentAddressTitle(item))}</p>${item.source_house_rule ? `<p>Правило: ${escapeHtml(item.source_house_rule)}</p>` : ''}</div>`
  }))};
}

function historySchoolSet(schools) {
  return [...new Set(schools.map(normalizeSchoolNumber).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru', {numeric:true}));
}

function historyDocumentTitle(item) {
  return /^\d{4}-\d{2}-\d{2}$/.test(item.source_act_date || '') && item.source_act_number
    ? `№${item.source_act_number} · ${item.source_act_date.split('-').reverse().join('.')}` : sourceCompactTitle(item);
}

function schoolHistoryAddressRows(school) {
  const gardens = directoryGardensForSchool(school);
  const exceptions = new Set((schoolAddressDirectory()?.streets || []).filter(group => group.kind === 'garden').flatMap(group => group.items.map(item => item.key)));
  const current = schoolCurrentAssignments(school), currentKeys = new Set(current.map(item => item.address_key || item.address_id));
  return uniqueBy(schoolAssignments(school).filter(item => item.record_kind !== 'scan_rule'
    && (item.address_key || item.address_id) && (!directoryGardenForAddress(item, gardens) || exceptions.has(item.address_key || item.address_id))),
    item => item.address_key || item.address_id).map(item => ({key:item.address_key || item.address_id,
      title:atlasCampusAddress(assignmentAddressTitle(item)), current:currentKeys.has(item.address_key || item.address_id)}))
    .sort((a,b) => a.title.localeCompare(b.title, 'ru', {numeric:true}));
}

function schoolHistoryMatrix(addresses, evidence) {
  const docKey = item => item.source_act_date && item.source_act_number
    ? `${item.source_act_date}|${item.source_act_number}` : sourceGroupKey(item);
  const documents = new Map(), byAddress = new Map(addresses.map(address => [address.key, new Map()]));
  for (const item of evidence) {
    const address = byAddress.get(item.address_key || item.address_id);
    if (!address || item.record_kind === 'scan_rule') continue;
    const key = docKey(item);
    if (!documents.has(key)) documents.set(key, {key, date:item.source_act_date || '', number:item.source_act_number || '', title:historyDocumentTitle(item)});
    if (!address.has(key)) address.set(key, []);
    address.get(key).push(item);
  }
  const columns = [...documents.values()].sort((a,b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, 'ru', {numeric:true}));
  const rows = addresses.map(address => {
    const groups = [];
    columns.forEach((doc, col) => {
      const items = byAddress.get(address.key).get(doc.key) || [], schools = historySchoolSet(items.map(item => item.school_number));
      const signature = JSON.stringify(schools), previous = groups.at(-1);
      const witnesses = uniqueBy(items, item => [sourceGroupKey(item), item.school_number, item.source_region_id, item.source_page, item.source_y].join('|'));
      const documents = [{title:doc.title, witnesses}];
      if (schools.length && previous?.signature === signature) {
        previous.end = col; previous.documents.push(...documents);
      } else groups.push({start:col, end:col, signature, schools, documents,
        changed:Boolean(schools.length && previous?.schools.length && previous.signature !== signature)});
    });
    return {...address, groups};
  });
  return {columns, rows};
}

async function loadSidebarSchoolHistory(page = 0, {signal, pageSize = 8} = {}) {
  const school = selectedSchoolRow();
  if (!school) return null;
  const schoolIdentity = schoolKey(school), token = state.selectionRequestToken;
  if (VIEWER_API && !loadedSchoolDetails.has(schoolIdentity)) {
    const rows = await VIEWER_API.school(schoolIdentity, {signal});
    signal?.throwIfAborted();
    if (state.selectedSchoolKey !== schoolIdentity || token !== state.selectionRequestToken) return null;
    installRequestedDetails(rows, `school:${schoolIdentity}`);
    loadedSchoolDetails.add(schoolIdentity);
  }
  const all = schoolHistoryAddressRows(school);
  pageSize = Math.max(1, Math.min(8, Math.floor(Number(pageSize) || 8)));
  page = Math.max(0, Math.min(Math.floor(Number(page) || 0), Math.max(0, Math.ceil(all.length / pageSize) - 1)));
  const addresses = all.slice(page * pageSize, (page + 1) * pageSize);
  const evidence = !addresses.length ? [] : VIEWER_API
    ? await VIEWER_API.addresses(school.district, addresses.map(address => address.key), {signal})
    : addresses.flatMap(address => state.assignmentsByAddressKey.get(address.key) || state.assignmentsByAddressId.get(address.key) || []);
  signal?.throwIfAborted();
  if (state.selectedSchoolKey !== schoolIdentity || token !== state.selectionRequestToken) return null;
  const matrix = schoolHistoryMatrix(addresses, evidence);
  return {...matrix, page, pageSize, total:all.length,
    rows:matrix.rows.map(row => ({...row, groups:row.groups.map(group => ({...group,
      documents:group.documents.map(doc => ({title:doc.title, current:doc.witnesses.some(item => sourceFragmentPeriod(item) === 'current'), fragments:doc.witnesses.filter(item => sourceFragmentPeriod(item) === 'current').map(item => ({label:schoolReference(item.school_number),
        spec:addressEvidenceSpec(item), html:`<div class="address-source-meta">${sourceLinks(item)}</div>`}))}))}))}))};
}


function renderSchoolCard(row) {
  const key = schoolKey(row);
  const directory = VIEWER_API && !loadedSchoolDetails.has(key) ? reusableSchoolDirectory(row) : null;
  if (directory) return renderSharedDirectorySchoolCard(row, directory);
  const listing = schoolAddressDirectory();
  const stats = state.addressStatsBySchool.get(key) || { total: 0, geocoded: 0 };
  const current = schoolCurrentAssignments(row);
  const currentEvidence = schoolCurrentEvidence(row);
  const historyStats = schoolHistoryStats(row);
  const checkStats = schoolCheckStats(row);
  const areaProps = schoolAreaFeature(row)?.properties || {};
  const areaExcluded = Number(areaProps.area_excluded_address_count || 0);
  const commonAreaAddresses = areaExcluded > 0
    && String(areaProps.area_exclusion_reasons || "").trim() === "current_multi_school"
    && schoolSharedAreaFeatures(row).length > 0;
  const allMapped = stats.total > 0 && stats.total === stats.geocoded;
  const rules = current.length ? [] : schoolCurrentSourceRules(row);
  const rulesOnly = rules.length > 0;
  const hasGardenRows = listing?.streets.some(street => street.kind === "garden"
    && !isLocalityTerritory(state.gardenById.get(street.territoryId)));
  const evidenceUnavailable = state.reviewDecisionLoadFailures.has(row.district)
    || state.coordinateReviewLoadFailures.has(row.district)
    || Boolean(state.schoolSectionsLoadError);
  const missingCoordinates = listing?.missingCoordinates ?? Math.max(0, stats.total - stats.geocoded);
  const trustWarning = missingCoordinates > 0 || checkStats.needsCheck > 0 || areaExcluded > 0 || evidenceUnavailable;
  const trustTitle = evidenceUnavailable ? "Часть сведений временно недоступна"
    : checkStats.needsCheck > 0 ? `${checkStats.needsCheck} ${ruPlural(checkStats.needsCheck, "адрес требует", "адреса требуют", "адресов требуют")} уточнения`
    : missingCoordinates > 0 ? `Без точки дома на карте: ${missingCoordinates} ${ruPlural(missingCoordinates, "адрес", "адреса", "адресов")}`
    : commonAreaAddresses ? `${areaExcluded} ${ruPlural(areaExcluded, "адрес на общем участке", "адреса на общих участках", "адресов на общих участках")}`
    : areaExcluded > 0 ? `${areaExcluded} ${ruPlural(areaExcluded, "адрес не учтён", "адреса не учтены", "адресов не учтены")} в контуре`
    : allMapped ? "Для всех текущих адресов есть координаты" : "В текущем наборе нет адресов закрепления";
  const number = normalizeSchoolNumber(row.school_number);
  const buildingAddresses = schoolBuildingAddresses(row);
  const mapPointWithoutBuildingAddress = !buildingAddresses.length && schoolMapFeatures(row).length > 0;
  const buildingAddressLine = buildingAddresses.length
    ? buildingAddresses.map(address => `<span title="${escapeAttr(address)}">${escapeHtml(atlasCampusAddress(address))}</span>`).join('')
    : mapPointWithoutBuildingAddress
      ? 'Адрес здания в данных не указан; на карте показана известная точка школы'
      : 'Адрес школы не указан';
  return `
    ${state.returnAddressId ? `<button class="origin-back" type="button" data-return-address-id="${escapeAttr(state.returnAddressId)}">← Назад к дому: ${escapeHtml(state.returnAddressLabel || "выбранный адрес")}</button>` : ""}
    ${currentSharedAreaContext() ? `<section class="shared-school-comparison" aria-label="Сравнение школ общей территории"><div><span>Общая территория</span><button type="button" data-shared-area-key="${escapeAttr(currentSharedAreaContext().key)}">Вся область</button></div>${sharedAreaSchoolChoicesHtml(currentSharedAreaContext())}</section>` : ''}
    <div class="school-identity">
      ${/^\d+$/.test(number) ? `<span class="school-number" aria-hidden="true"><span>№</span>${escapeHtml(number)}</span>` : ''}
      <div>
        <div class="card-kicker">${escapeHtml(row.district ? `${row.district} район` : '')}</div>
        ${schoolHeadingHtml(row, number)}
        <p class="school-building-address">${buildingAddressLine}</p>
      </div>
    </div>
    ${schoolCardActionsHtml(row, currentEvidence[0], Boolean(current.length || historyStats.historical))}
    ${rulesOnly ? schoolStatusNoteHtml(schoolRuleScopeLabel(rules)) : `<div class="atlas-facts"><span>${listing?.houseCount ?? current.length} ${ruPlural(listing?.houseCount ?? current.length, 'дом', 'дома', 'домов')}${listing?.gardenCount ? ` · ${listing.gardenCount} СНТ` : ''}</span><span data-street-count></span></div>`}
    ${trustWarning ? schoolStatusNoteHtml(trustTitle) : ''}
    ${!currentEvidence.length ? schoolStatusNoteHtml(historyStats.historical ? 'Есть только исторический документ закрепления.' : 'Текущий документ закрепления не найден.') : ''}
    ${schoolLocalityTerritories(row).map(feature => {
      const label = feature.properties.status === 'source_only_unlocated' ? 'Территория целиком · граница не определена' : 'Территория целиком · показать границу';
      return `<div class="candidate-list"><button type="button" data-garden-id="${escapeAttr(feature.properties.territory_id)}"><strong>${escapeHtml(feature.properties.name)}</strong><span>${escapeHtml(label)}</span></button></div>`;
    }).join('')}
    ${rulesOnly ? schoolRuleListHtml(rules) : ''}
    ${!rulesOnly || hasGardenRows ? '<div data-street-directory></div>' : ''}
    ${!current.length ? '<div data-inline-documents="school" aria-label="Документы школы"></div>' : ''}
  `;
}

function schoolStatusNoteHtml(message) {
  return `<p class="school-status-note"><span class="school-status-icon" aria-hidden="true">!</span><span>${escapeHtml(message)}</span></p>`;
}

function schoolHeadingHtml(row, number) {
  const title = compactSchoolTitle(row);
  return `<div class="school-heading"><h2 id="selectionHeading" class="card-title prominent" tabindex="-1" aria-label="${escapeAttr(title)}">${escapeHtml(/^\d+$/.test(number) ? schoolTypeLabel(row) : title)}</h2></div>`;
}

function schoolCardActionsHtml(row, source, hasHistory) {
  const districtSource = state.sourceByDistrict.get(row.district);
  const original = source?.source_raw_file ? VIEWER_API?.originalDocument?.(source.source_raw_file) : null;
  const documentSource = original
    ? original.pageUrl || original.url || ""
    : source?.source_page_url || districtSource?.source_page_url || districtSource?.source_url || source?.source_url;
  const links = [
    linkHtml(row.official_website, "Сайт школы"),
    linkHtml(documentSource, "Источник документа")
  ].filter(Boolean);
  if (!hasHistory && !links.length) return "";
  return `<div class="school-card-actions">
    ${hasHistory ? `<button type="button" data-school-history-toggle="${escapeAttr(schoolKey(row))}" aria-controls="school-history-panel" aria-expanded="false">История адресов</button>` : ""}
    ${links.join("")}
  </div>${hasHistory ? '<section id="school-history-panel" aria-label="История адресов школы" hidden></section>' : ""}`;
}

function renderSharedDirectorySchoolCard(row, directory) {
  const number = normalizeSchoolNumber(row.school_number);
  return `<div class="school-identity">
      ${/^\d+$/.test(number) ? `<span class="school-number" aria-hidden="true"><span>№</span>${escapeHtml(number)}</span>` : ''}
      <div><div class="card-kicker">${escapeHtml(row.district)} район</div>
      ${schoolHeadingHtml(row, number)}
      <p class="school-building-address">${schoolBuildingAddresses(row).map(address => `<span title="${escapeAttr(address)}">${escapeHtml(atlasCampusAddress(address))}</span>`).join('') || 'Адрес школы не указан'}</p></div>
    </div>
    ${schoolCardActionsHtml(row, schoolCurrentEvidence(row)[0], Boolean(directory.houseCount || Number(row.historical_address_count)))}
    <div class="atlas-facts"><span>${directory.houseCount} ${ruPlural(directory.houseCount,'дом','дома','домов')}${directory.gardenCount ? ` · ${directory.gardenCount} СНТ` : ''}</span><span data-street-count></span></div>
    ${directory.missingCoordinates ? schoolStatusNoteHtml(`Без точки дома на карте: ${directory.missingCoordinates} ${ruPlural(directory.missingCoordinates,'адрес','адреса','адресов')}`) : ''}
    <div data-street-directory></div>`;
}

function renderAddressSearchState() {
  if (!state.searchSubmitted) {
    return '';
  }
  if (state.gardenSearchResults.length) {
    return `
      <div class="result-eyebrow">Территории СНТ</div>
      <h2 id="selectionHeading" class="card-title" tabindex="-1">Выберите СНТ</h2>
      <div class="candidate-list">
        ${state.gardenSearchResults.map((feature) => `
          <button type="button" data-garden-id="${escapeAttr(feature.properties.territory_id)}">
            <strong>${escapeHtml(gardenSearchLabel(feature))}</strong>
            <span>${escapeHtml(feature.properties.district)} район · граница по карте OpenStreetMap</span>
            <em>По правилу PDF: ${feature.properties.school_numbers.map((number) => escapeHtml(schoolReference(number))).join(", ")}</em>
            <b aria-hidden="true">→</b>
          </button>
        `).join("")}
      </div>
    `;
  }
  if (!state.addressSearchResults.length) {
    return `<div class="search-empty"><strong>Адрес или СНТ не найдены</strong><span>Проверьте номер дома либо название СНТ и выбранный район. Непроверенные территории пока не включены в поиск.</span></div>`;
  }
  return `
    <div class="result-eyebrow">Нужно уточнение</div>
    <h2 id="selectionHeading" class="card-title" tabindex="-1">Выберите адрес</h2>
    <div class="card-subtitle">Найдено ${state.addressSearchResults.length} ${ruPlural(state.addressSearchResults.length, "похожее совпадение", "похожих совпадения", "похожих совпадений")}.</div>
    <div class="candidate-list">
      ${state.addressSearchResults.map((row) => `
        <button type="button" data-address-id="${escapeAttr(row.address_id)}">
          <strong>${escapeHtml(addressTitle(row))}</strong>
          <span>${escapeHtml(row.district ? `${row.district} район` : "Санкт-Петербург")}</span>
          <em>${escapeHtml(currentAddressAssignments(row).map((item) => normalizeSchoolNumber(item.school_number)).filter(Boolean).map(schoolReference).join(", ") || "школа не указана")}</em>
          <b aria-hidden="true">→</b>
        </button>
      `).join("")}
    </div>
  `;
}

function gardenExceptionRow(key) {
  const garden=state.gardenById.get(state.selectedGardenId);
  return garden ? areaScopeData.get(garden.properties.district)?.addresses[key] : null;
}

function renderGardenCard(feature) {
  const props = feature.properties;
  const locality = isLocalityTerritory(feature);
  const sourceOnly = props.status === 'source_only_unlocated';
  const schoolButtons = props.school_numbers.map(number => {
    const key = districtSchoolKey(props.district, number);
    const school = state.schoolByKey.get(key);
    return `<button type="button" data-school-key="${escapeAttr(key)}"><strong>${escapeHtml(compactSchoolTitle(school || {school_number:number}))}</strong><b aria-hidden="true">→</b></button>`;
  }).join("");
  const fragments = new Set(props.source_fragment_ids || []);
  const sourceRows = territorySourceDetails.get(props.territory_id) || props.school_numbers.flatMap(number => {
    const school = state.schoolByKey.get(districtSchoolKey(props.district, number));
    return school ? schoolCurrentEvidence(school).filter(row => fragments.has(row.source_fragment_id)) : [];
  });
  const wholeRuleKeys = new Set(sourceRows.filter(row => row.record_kind === "scan_rule")
    .map(row => `${normalizeSchoolNumber(row.school_number)}::${row.source_fragment_id}`));
  const territorySources = sourceRows.filter(row => row.record_kind === "scan_rule"
    || !wholeRuleKeys.has(`${normalizeSchoolNumber(row.school_number)}::${row.source_fragment_id}`));
  const documents = primaryDocumentLineHtml(territorySources, {mode:"school", includeRules:true});
  const pdf = localSourceHref(props.source_raw_file);
  const original = VIEWER_API?.originalDocument?.(props.source_raw_file);
  const originalLink = original ? original.url ? linkHtml(original.url, original.label) : escapeHtml(original.label)
    : pdf ? linkHtml(pdf, "Официальный документ ↗", { allowRelative: true }) : "";
  const scopeData=areaScopeData.get(props.district), inventory=scopeData?.gardens[props.territory_id];
  const exceptions=inventory?.exceptions || [];
  const exceptionHtml=sourceOnly ? '' : inventory ? `<section class="garden-exceptions"><p>${exceptions.length ? `Известные исключения: ${exceptions.length}` : 'В текущем реестре исключений не найдено'}</p>${exceptions.map(key=>{
    const address = scopeData.addresses[key], located = hasMapCoordinates(address);
    const label = `Открыть документ по адресу: ${address.canonical_address}${located ? '' : '. Точное местоположение дома не определено'}`;
    return `<div><button type="button" data-directory-address="${escapeAttr(key)}">${escapeHtml(atlasCampusAddress(address.canonical_address))}</button><span> · ${escapeHtml(address.current_school_number)}</span><button type="button" class="address-info-trigger${located ? '' : ' is-unlocated'}" data-address-document="${escapeAttr(key)}" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${located ? 'i' : '!'}</button></div>`;
  }).join('')}</section>`
    : locality ? '' : areaScopeErrors.has(props.district) ? `<p class="scope-caption" role="status">Исключения СНТ не удалось проверить. <button type="button" data-retry-area-index="${escapeAttr(props.district)}">Повторить</button></p>`
      : '<p class="scope-caption">Исключения СНТ проверяются…</p>';
  return `<div class="result-eyebrow">${locality ? "Территория населённого пункта" : "Территория СНТ"}</div>
    <p class="card-kicker">${escapeHtml(props.district ? `${props.district} район` : "Район не указан")}</p>
    <h2 id="selectionHeading" class="card-title prominent" tabindex="-1">${escapeHtml(gardenSearchLabel(feature))}</h2>
    <p class="card-subtitle">По правилу официального документа эта территория относится к следующим школам:</p>
    <div class="candidate-list">${schoolButtons}</div>${exceptionHtml}
    ${sourceOnly ? '<p class="scope-caption" role="status">Точное положение и граница территории не определены.</p>' : accuracyAnnotationHtml(`<p class="card-subtitle">${escapeHtml(props.boundary_note)}. Точка обозначает территорию целиком, а не отдельный дом.</p>`)}
    ${documents || (originalLink ? `<p class="card-subtitle">${originalLink}</p>` : "")}`;
}

function renderSchoolSearchState() {
  if (!state.searchSubmitted) {
    return '';
  }
  if (!state.schoolSearchResults.length) {
    return `<div class="search-empty"><strong>Школа не найдена</strong><span>Поиск идёт по всему городу. Попробуйте номер без знака №, часть названия или адрес здания.</span></div>`;
  }
  const sharedArea = selectedSharedArea();
  if (sharedArea) {
    const count = sharedArea.schoolKeys.length;
    return `<div class="result-eyebrow">Общая территория</div>
      <h2 id="selectionHeading" class="card-title" tabindex="-1">${count} ${ruPlural(count, 'школа', 'школы', 'школ')}</h2>
      ${sharedAreaSchoolChoicesHtml(sharedArea)}
      <p class="shared-area-hint">Выберите школу, чтобы увидеть все её участки. Точную привязку дома проверяйте по адресу.</p>`;
  }
  return `
    <div class="result-eyebrow">${selectedSharedArea() ? "Школы общей территории" : state.schoolSearchResults.length === 1 ? "Точное или близкое совпадение" : "Результаты поиска"}</div>
    <h2 id="selectionHeading" class="card-title" tabindex="-1">${state.schoolSearchResults.length === 1 ? "Найдена школа" : "Выберите школу"}</h2>
    <div class="candidate-list">
      ${state.schoolSearchResults.map((row) => {
        const stats = state.addressStatsBySchool.get(schoolKey(row)) || { total: Number(row.current_address_count || 0), geocoded: 0 };
        const buildingAddresses = schoolBuildingAddresses(row);
        return `
          <button type="button" data-school-key="${escapeAttr(schoolKey(row))}">
            <strong>${escapeHtml(compactSchoolTitle(row))}</strong>
            <span>${escapeHtml(row.district ? `${row.district} район · ${schoolTypeLabel(row)}` : schoolTypeLabel(row))}</span>
            <em>${buildingAddresses.length > 1 ? "Адреса школы" : "Адрес школы"}: ${escapeHtml(buildingAddresses.join("; ") || "не указан")} · ${stats.total} ${ruPlural(stats.total, "дом", "дома", "домов")}</em>
            <b aria-hidden="true">→</b>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function currentSchoolDetailNotice() {
  const notice = state.schoolDetailNotice;
  return notice?.token === state.selectionRequestToken && notice.key === state.selectedSchoolKey ? notice : null;
}

function currentAddressDetailNotice() {
  const notice = state.addressDetailNotice;
  return notice?.token === state.selectionRequestToken ? notice : null;
}

function renderSelectionCard() {
  const card = document.getElementById("selectionCard");
  const existingDirectory = card.querySelector?.('.street-directory');
  const previousScroll = existingDirectory?.scrollTop || 0;
  const comparison = currentSharedAreaContext();
  if (!supportsSharedComparison(comparison) && sharedComparisonCache) { sharedComparisonCache.controller.abort(); sharedComparisonCache = null; }
  if (supportsSharedComparison(comparison)) {
    card.innerHTML = renderSharedComparisonCard(comparison);
    const slot = card.querySelector?.('[data-shared-comparison]');
    if (slot && existingDirectory?.dataset.contentKey === sharedComparisonModel()?.contentKey) { slot.append(existingDirectory); existingDirectory.scrollTop = previousScroll; }
    card.setAttribute('aria-busy',String(sharedComparisonCache?.status === 'loading'));
    return;
  }
  const addressNotice = currentAddressDetailNotice();
  if (addressNotice) {
    const loading = addressNotice.status === 'loading';
    const message = loading ? 'Загружаем закреплённые школы и документ…'
      : addressNotice.status === 'missing' ? 'Адрес не найден в актуальном районном пакете.'
      : 'Не удалось загрузить данные адреса. Проверьте соединение и повторите попытку.';
    card.innerHTML = `<div class="selection-notice search-empty"><h2 id="selectionHeading" tabindex="-1">${escapeHtml(addressTitle(addressNotice.row))}</h2><span>${message}</span>${addressNotice.status === 'error' ? '<button type="button" class="compact-detail-link" data-retry-address>Повторить загрузку</button>' : ''}</div>`;
    card.setAttribute('aria-busy', String(loading));
    return;
  }
  const notice = currentSchoolDetailNotice();
  if (notice) {
    const loading = notice.status === 'loading';
    const school = state.schoolByKey.get(notice.key);
    card.innerHTML = `<div class="selection-notice search-empty"><h2 id="selectionHeading" tabindex="-1">${escapeHtml(compactSchoolTitle(school))}</h2><span>${loading ? 'Загружаем закреплённые дома и документы…' : 'Не удалось загрузить данные школы. Проверьте соединение и повторите попытку.'}</span>${loading ? '' : `<button type="button" class="compact-detail-link" data-retry-school-key="${escapeAttr(notice.key)}">Повторить загрузку</button>`}</div>`;
    card.setAttribute('aria-busy', String(loading));
    return;
  }
  const address = selectedAddressRow();
  const school = selectedSchoolRow();
  const garden = state.gardenById.get(state.selectedGardenId);
  if (address) {
    card.innerHTML = renderAddressCard(address);
  } else if (garden) {
    card.innerHTML = renderGardenCard(garden);
  } else if (school) {
    card.innerHTML = renderSchoolCard(school);
  } else {
    card.innerHTML = state.searchMode === "school" ? renderSchoolSearchState() : renderAddressSearchState();
  }
  if (returnAreaContext && (address || school || garden)) card.insertAdjacentHTML?.('afterbegin',
    '<button type="button" class="scope-return" data-return-area>← Вернуться к выбранному участку</button>');
  else if (address && returnGardenContext) card.insertAdjacentHTML?.('afterbegin',
    '<button type="button" class="scope-return" data-return-garden>← К адресам СНТ</button>');
  else if (address && returnSchoolContext) card.insertAdjacentHTML?.('afterbegin',
    '<button type="button" class="scope-return" data-return-school>← К адресам школы</button>');
  if (school && areaScopeErrors.has(school.district) && directoryGardensForSchool(school).length) card.insertAdjacentHTML?.('afterbegin',
    `<p class="scope-caption" role="status">Исключения СНТ не удалось проверить. <button type="button" data-retry-area-index="${escapeAttr(school.district)}">Повторить</button></p>`);
  if (!VIEWER_API && state.schoolCampusLoadStatus === 'error') card.insertAdjacentHTML?.('beforeend',
    '<p class="scope-caption" role="status">Некоторые точки школ не загрузились. <button type="button" data-retry-school-campuses>Повторить</button></p>');
  const slot = card.querySelector?.('[data-street-directory]');
  if (slot && existingDirectory && schoolAddressDirectory()?.contentKey === existingDirectory.dataset.contentKey) {
    slot.append(existingDirectory);
    existingDirectory.scrollTop = previousScroll;
  }
  card.setAttribute("aria-busy", "false");
}

function selectionCardFocusSnapshot() {
  const card = document.getElementById("selectionCard");
  const active = document.activeElement;
  if (!card?.contains(active)) return null;
  if (active.id) return { id: active.id };
  const attributeNames = [
    "data-card-tab",
    "data-address-history-key",
    "data-school-list-key",
    "data-school-list-action",
    "data-focus-address-id",
    "data-address-id",
    "data-school-key",
    "data-shared-area-key",
    "data-return-address-id",
    "data-center-address-id"
  ];
  const attributes = attributeNames
    .filter((name) => active.hasAttribute?.(name))
    .map((name) => [name, active.getAttribute(name)]);
  return attributes.length ? { attributes } : null;
}

function restoreSelectionCardFocus(snapshot) {
  if (!snapshot) return;
  if (snapshot.id) {
    document.getElementById(snapshot.id)?.focus();
    return;
  }
  const [first] = snapshot.attributes || [];
  if (!first) return;
  const match = [...document.querySelectorAll(`#selectionCard [${first[0]}]`)]
    .find((item) => snapshot.attributes.every(([name, value]) => item.getAttribute(name) === value));
  match?.focus();
}

function renderSelectionCardPreservingFocus() {
  const card = document.getElementById("selectionCard");
  if (card?.getAttribute("aria-busy") === "true") return;
  const snapshot = selectionCardFocusSnapshot();
  renderSelectionCard();
  if (snapshot) window.requestAnimationFrame(() => restoreSelectionCardFocus(snapshot));
}

function collectCoordinates(geometry, out) {
  if (!geometry) return;
  const walk = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      out.push(coords);
      return;
    }
    coords.forEach(walk);
  };
  walk(geometry.coordinates);
}

function fitFeatures(features, options = {}) {
  // The directory is normally enhanced next frame. Measure the complete panel
  // before fitting, otherwise its later growth covers the selected territory.
  window.schoolCompactShell?.flush?.();
  const coords = [];
  features.forEach((feature) => {
    if (feature.bbox) coords.push([feature.bbox[0], feature.bbox[1]], [feature.bbox[2], feature.bbox[3]]);
    else collectCoordinates(feature.geometry, coords);
  });
  if (!coords.length) return;
  const bounds = coords.reduce((acc, coord) => acc.extend(coord), new maplibregl.LngLatBounds(coords[0], coords[0]));
  const panel = document.querySelector(".panel");
  const panelRect = panel?.getBoundingClientRect();
  const mobileLayout = window.matchMedia?.("(max-width: 760px)").matches;
  const panelCollapsed = panel?.dataset?.collapsed === 'true';
  const mobilePanelAtTop = (panelRect?.top || 0) < window.innerHeight - (panelRect?.bottom || 0);
  const padding = mobileLayout
    ? panelCollapsed ? {top:34,right:24,bottom:42,left:Math.min((panelRect?.right || 36)+16,window.innerWidth*0.25)}
      : {
          top: mobilePanelAtTop ? Math.min((panelRect?.bottom || 0)+16,window.innerHeight-122) : 34,
          right:24,
          bottom: mobilePanelAtTop ? 42 : Math.min(window.innerHeight-(panelRect?.top || 0)+16,window.innerHeight-122),
          left:24
        }
    : {
        top: 42,
        right: 42,
        bottom: 42,
        left: Math.min((panelRect?.right || 360) + 24, window.innerWidth - 122)
      };
  state.map.fitBounds(bounds, {
    padding,
    maxZoom: options.maxZoom ?? 16,
    duration: motionDuration(options.duration ?? 500)
  });
}

function districtBoundaryFeatures(district) {
  if (!district) return [];
  return (state.districtBoundaries.features || []).filter((feature) => (
    feature.properties?.district === district || boundaryDistrictName(feature) === district
  ));
}

function focusDistrict(district, duration = 450) {
  const features = districtBoundaryFeatures(district);
  if (features.length) fitFeatures(features, { maxZoom: 12, duration });
}

function focusAreaSchoolCoverage(context) {
  if (!context || !state.map?.fitBounds) return;
  const features = [...selectedSectionFeatures(), ...selectedSchoolsForArea().flatMap(schoolLocalityTerritories)];
  if (context.geometry) features.push({geometry: context.geometry});
  if (features.length) fitFeatures(features, { duration: 350, maxZoom: 13.5 });
}

function focusAddress(row) {
  const features = [];
  if (hasMapCoordinates(row)) features.push(addressFeature(row));
  for (const school of selectedSchoolsForAddress(row)) {
    features.push(...schoolMapFeatures(school));
    const section = schoolAreaFeature(school);
    if (section) features.push(section);
  }
  if (features.length) fitFeatures(features, { maxZoom: 16 });
}

function refitVisibleSelection() {
  if (!state.map) return;
  state.map.resize();
  window.requestAnimationFrame(() => {
    const shared = selectedSharedArea();
    if (shared) {
      focusAreaSchoolCoverage(shared);
      return;
    }
    const address = selectedAddressRow();
    if (address) {
      focusAddress(address);
      return;
    }
    const garden = state.gardenById.get(state.selectedGardenId);
    if (garden) {
      if (garden.properties.status === 'source_only_unlocated') focusDistrict(garden.properties.district, 300);
      else if (garden.geometry) fitFeatures([garden], { maxZoom: 16, duration: 300 });
      return;
    }
    const school = selectedSchoolRow();
    if (school) focusSchool(school);
  });
}

function focusSchool(row) {
  const features = [...selectedSectionFeatures(), ...schoolLocalityTerritories(row)];
  const schoolPoints = schoolMapFeatures(row);
  if (features.length) {
    fitFeatures([...schoolPoints, ...features].filter(Boolean));
  } else if (schoolPoints.length > 1) {
    fitFeatures(schoolPoints, { maxZoom: 14.6 });
  } else if (schoolPoints.length) {
    state.map.flyTo({ center: schoolPoints[0].geometry.coordinates, zoom: Math.max(state.map.getZoom(), 14), duration: motionDuration(450) });
  }
}

function applySearchModeUI() {
  document.body.dataset.searchMode = state.searchMode;
  document.querySelectorAll(".search-mode [data-search-mode]").forEach((button) => {
    const active = button.dataset.searchMode === state.searchMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const addressPanel = document.getElementById("addressSearchForm");
  const schoolPanel = document.getElementById("schoolSearchForm");
  if (addressPanel) addressPanel.hidden = unifiedSearchEnabled() ? false : state.searchMode !== "address";
  if (schoolPanel) schoolPanel.hidden = state.searchMode !== "school";
}

function unifiedSearchEnabled() {
  return document.body?.dataset?.unifiedSearch === 'true';
}

function unifiedQueryKind(value) {
  const query = String(value || '').trim();
  if (state.schoolOptionByLabel.has(query) || /^(?:№\s*)?\d{1,4}$/u.test(query)
      || /(?:^|[\s.,])(?:школ[аыу]|лице[йяю]|гимнази[яию]|гбоу|фмл)(?=$|[\s№.,\d])/iu.test(query)) return 'school';
  return 'address';
}

function syncUnifiedQuery() {
  const input = document.getElementById('addressSearch');
  const kind = unifiedQueryKind(input.value);
  document.getElementById('schoolSearch').value = input.value;
  return kind;
}

function submitUnifiedSearch() {
  returnAreaContext=null; returnSchoolContext='';
  if (!document.getElementById('addressSearch').value.trim()) return clearFilters();
  cancelPendingSuggestions();
  return syncUnifiedQuery() === 'school' ? submitSchoolSearch() : submitAddressSearch();
}

function focusSchoolAddressById(addressId) {
  const row = state.addressById.get(addressId);
  if (!row || !state.selectedSchoolKey) return;
  state.focusedSchoolAddressId = addressId;
  state.searchMode = "school";
  applySearchModeUI();
  renderSelectionHighlights();
  renderSelectionCard();
  window.requestAnimationFrame(() => {
    [...document.querySelectorAll("#selectionCard [data-focus-address-id]")]
      .find((item) => item.dataset.focusAddressId === addressId)
      ?.focus();
  });
  const feature = addressFeature(row);
  if (feature) {
    state.map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(state.map.getZoom(), 16), duration: motionDuration(420) });
  }
}

// Keep the current view only in this browser tab, without sending it to a server.
const VIEW_SESSION_KEY = "school-map-view-v1";
function saveSessionView() {
  try {
    const row = state.addressById.get(state.selectedAddressId);
    const center = state.map.getCenter();
    window.sessionStorage.setItem(VIEW_SESSION_KEY, JSON.stringify({
      district: selectedDistrict(), address: row ? { district: row.district, key: row.address_key } : null,
      school: state.selectedSchoolKey, garden: state.selectedGardenId,
      tab: state.activeDetailTab, center: [center.lng, center.lat], zoom: state.map.getZoom()
    }));
  } catch (_) { /* Storage may be disabled; the viewer remains usable. */ }
}

async function restoreSessionView() {
  let saved;
  try { saved = JSON.parse(window.sessionStorage.getItem(VIEW_SESSION_KEY) || "null"); }
  catch (_) { return; }
  if (!saved || typeof saved !== "object") return;
  const initialToken = state.selectionRequestToken;
  const districtControl = document.getElementById("districtFilter");
  if ([...districtControl.options].some(option => option.value === saved.district)) districtControl.value = saved.district;
  try {
    if (saved.address?.district && saved.address?.key) {
      if (VIEWER_API) {
        const restoreToken = state.selectionRequestToken;
        const rows = await VIEWER_API.address(saved.address.district, saved.address.key, { signal: beginDetailRequest() });
        if (restoreToken !== state.selectionRequestToken) return;
        installRequestedDetails(rows, `address:${saved.address.district}|${saved.address.key}`);
      } else {
        await ensureAssignmentsForDistrict(saved.address.district);
        if (state.selectionRequestToken !== initialToken) return;
      }
      const row = state.addresses.find(item => item.district === saved.address.district && item.address_key === saved.address.key);
      if (row) {
        await selectAddressById(row.address_id, false);
        if (state.selectionRequestToken !== initialToken+1) return;
        document.getElementById("addressSearch").value = selectedAddressInputValue(row);
      }
    } else if (saved.garden && state.gardenById.has(saved.garden)) {
      await selectGardenById(saved.garden, false);
      if (state.selectionRequestToken !== initialToken+1) return;
      document.getElementById("addressSearch").value = gardenSearchLabel(state.gardenById.get(saved.garden));
    } else if (saved.school && state.schoolByKey.has(saved.school)) {
      await selectSchoolByKey(saved.school, false);
      if (state.selectionRequestToken !== initialToken+1) return;
      document.getElementById("schoolSearch").value = compactSchoolTitle(state.schoolByKey.get(saved.school));
      if (["summary", "addresses", "documents", "qa"].includes(saved.tab)) state.activeDetailTab = saved.tab;
    }
    render();
    if (Array.isArray(saved.center) && saved.center.length === 2 && saved.center.every(Number.isFinite)
        && Math.abs(saved.center[0]) <= 180 && Math.abs(saved.center[1]) <= 85
        && Number.isFinite(saved.zoom) && saved.zoom >= 0 && saved.zoom <= 22) {
      state.map.jumpTo({center: saved.center, zoom: saved.zoom});
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    announce("Предыдущий выбор не удалось восстановить. Повторите поиск.");
  }
}

async function selectAddressById(addressId, focus = true, {directoryRow, openDocument = false} = {}) {
  let row = state.addressById.get(addressId) || directoryRow || sharedComparisonModel()?.addressById.get(addressId)
    || [...(schoolAddressDirectory()?.addresses.values() || [])].find(item=>item.address_id===addressId);
  if (!row) return;
  const gardenReturn = directoryRow ? state.selectedGardenId
    || (currentAddressDetailNotice()?.status === 'error' ? returnGardenContext : '') : '';
  if (currentSharedAreaContext()) returnAreaContext={...currentSharedAreaContext(),column:comparisonSchoolKey};
  resetDistrictForSearchResult(row.district);
  const selectionToken = ++state.selectionRequestToken;
  const signal = beginDetailRequest();
  const addressKey = row.address_key;
  const canonicalAddress = row.canonical_address;
  const district = row.district;
  if (VIEWER_API ? !detailPackages.has(`address:${district}|${addressKey}`) : state.assignmentLevelByDistrict.get(row.district) !== "full") {
    returnGardenContext = gardenReturn;
    state.addressDetailNotice = {token:selectionToken, status:'loading', row, addressId, directoryRow, focus, openDocument};
    state.searchMode = 'address';
    state.searchSubmitted = true;
    state.sharedAreaSelection = null;
    state.selectedAddressId = '';
    state.selectedSchoolKey = '';
    state.selectedGardenId = '';
    state.focusedSchoolAddressId = '';
    state.addressSearchResults = [];
    state.schoolSearchResults = [];
    state.gardenSearchResults = [];
    if (focus) document.getElementById('addressSearch').value = selectedAddressInputValue(row);
    applySearchModeUI();
    render();
    document.getElementById("stats").textContent = `Загрузка: ${loadedDistrictLabel(row.district)}...`;
    try {
      if (VIEWER_API) {
        const rows = await VIEWER_API.address(district, addressKey, { signal });
        if (selectionToken !== state.selectionRequestToken) return;
        installRequestedDetails(rows, `address:${district}|${addressKey}`);
      } else await ensureAssignmentsForDistrict(row.district);
    } catch (error) {
      if (selectionToken === state.selectionRequestToken && error.name !== 'AbortError') {
        state.addressDetailNotice.status = 'error';
        renderSelectionCard();
        announce('Не удалось загрузить данные адреса. Можно повторить загрузку.');
        console.error(`Не удалось загрузить данные адреса ${addressKey}:`, error);
      }
      return;
    }
    if (selectionToken !== state.selectionRequestToken) return;
    row = state.addresses.find((item) => item.address_key === addressKey)
      || state.addresses.find((item) => (
        item.district === district
        && item.canonical_address === canonicalAddress
      ))
      || null;
    if (!row) {
      state.addressDetailNotice.status = 'missing';
      renderSelectionCard();
      announce('Адрес не найден в актуальном районном пакете');
      return;
    }
    addressId = row.address_id;
  }
  state.addressDetailNotice = null;
  const currentAssignments = currentAddressAssignments(row);
  state.searchMode = "address";
  state.searchSubmitted = true;
  state.addressSearchResults = [];
  state.schoolSearchResults = [];
  state.selectedAddressId = addressId;
  returnGardenContext = gardenReturn;
  state.selectedGardenId = "";
  state.selectedSchoolKey = currentAssignments.length === 1 ? assignmentSchoolKey(currentAssignments[0]) : "";
  state.returnAddressId = "";
  state.returnAddressLabel = "";
  state.focusedSchoolAddressId = "";
  state.activeDetailTab = "summary";
  state.hoverAddressId = "";
  state.hoverSchoolKey = "";
  state.hoverSharedSchoolKeys = new Set();
  applySearchModeUI();
  if (focus) document.getElementById("addressSearch").value = selectedAddressInputValue(row);
  refreshFilterOptions();
  render();
  if (focus) {
    if (hasMapCoordinates(row)) centerHouse(row);
    else focusAddress(row);
    if (!openDocument) window.requestAnimationFrame(() => document.getElementById("selectionHeading")?.focus());
  }
  if (openDocument) window.schoolCompactShell?.openAddressDocument();
  announce(`${addressTitle(row)}: ${currentAssignments.length} ${ruPlural(currentAssignments.length, "школа", "школы", "школ")}`);
}

async function selectSchoolFromMap(key, focus = false) {
  if (!state.schoolByKey.has(key)) return;
  const selection = selectSchoolByKey(key, focus);
  window.schoolCompactShell?.revealSelection();
  const token = state.selectionRequestToken;
  try {
    await selection;
  } finally {
    if (token === state.selectionRequestToken) window.schoolCompactShell?.revealSelection();
  }
}

async function selectSchoolByKey(key, focus = true, origin = null) {
  let row = state.schoolByKey.get(key);
  if (!row) return;
  resetDistrictForSearchResult(row.district);
  const reusableDirectory = reusableSchoolDirectory(row);
  const selectionToken = ++state.selectionRequestToken;
  state.sharedAreaSelection = null;
  const signal = beginDetailRequest();
  const district = row.district;
  const needsDetails = VIEWER_API ? !loadedSchoolDetails.has(key) && !reusableDirectory
    : state.assignmentLevelByDistrict.get(district) !== 'full';
  state.schoolDetailNotice = needsDetails ? { key, token: selectionToken, status: 'loading', origin } : null;
  state.searchMode = "school";
  state.searchSubmitted = true;
  state.schoolSearchResults = [];
  state.addressSearchResults = [];
  state.selectedAddressId = "";
  state.selectedGardenId = "";
  state.selectedSchoolKey = key;
  state.focusedSchoolAddressId = "";
  state.activeDetailTab = "summary";
  state.schoolHouseQuery = "";
  state.schoolAddressFilter = "all";
  state.schoolStreetFilter = "";
  state.returnAddressId = origin?.address_id || "";
  state.returnAddressLabel = origin ? addressTitle(origin) : "";
  state.hoverAddressId = "";
  state.hoverSchoolKey = "";
  state.hoverSharedSchoolKeys = new Set();
  applySearchModeUI();
  if (focus || unifiedSearchEnabled()) {
    document.getElementById("schoolSearch").value = compactSchoolTitle(row);
    if (unifiedSearchEnabled()) document.getElementById('addressSearch').value = focus ? compactSchoolTitle(row) : '';
  }
  if (needsDetails) {
    render();
    announce(`${compactSchoolTitle(row)}: загружаем данные`);
    try {
      if (VIEWER_API) {
        const rows = await VIEWER_API.school(key, { signal });
        if (selectionToken !== state.selectionRequestToken) return;
        installRequestedDetails(rows, `school:${key}`);
        loadedSchoolDetails.add(key);
      } else await ensureAssignmentsForDistrict(row.district);
    } catch (error) {
      if (selectionToken === state.selectionRequestToken) {
        state.schoolDetailNotice.status = 'error';
        renderSelectionCard();
        updateStats(0, 0);
        announce(`${compactSchoolTitle(row)}: не удалось загрузить данные. Можно повторить загрузку.`);
        console.error(`Не удалось загрузить данные школы ${key}:`, error);
      }
      return;
    }
    if (selectionToken !== state.selectionRequestToken) return;
    row = state.schoolByKey.get(key);
    if (!row) {
      document.getElementById("selectionCard")?.setAttribute("aria-busy", "false");
      return;
    }
  }
  state.schoolDetailNotice = null;
  if (VIEWER_BOOTSTRAP?.area_scope_index && directoryGardensForSchool(row).length) {
    try { await ensureAreaScopeData(district,{signal}); }
    catch (error) { if (error.name==='AbortError') return; }
    if (selectionToken!==state.selectionRequestToken) return;
  }
  refreshFilterOptions();
  render();
  if (focus) {
    focusSchool(row);
    window.requestAnimationFrame(() => document.getElementById("selectionHeading")?.focus());
  }
  announce(`Открыто досье: ${compactSchoolTitle(row)}`);
}

function clearMapSelection() {
  const busy = document.getElementById("selectionCard")?.getAttribute("aria-busy") === "true";
  if (!state.selectedSchoolKey && !state.selectedAddressId && !state.selectedGardenId && !selectedSharedArea() && !currentAddressDetailNotice() && !busy) return;
  cancelDetailRequest();
  returnAreaContext=null; returnSchoolContext=''; comparisonSchoolKey=''; state.comparisonSchoolKey='';
  cancelPendingSuggestions();
  state.selectionRequestToken += 1;
  state.searchMode = "address";
  state.searchSubmitted = false;
  state.sharedAreaSelection = null;
  state.addressSearchResults = [];
  state.gardenSearchResults = [];
  state.schoolSearchResults = [];
  state.selectedSchoolKey = "";
  state.selectedAddressId = "";
  state.selectedGardenId = "";
  state.focusedSchoolAddressId = "";
  state.returnAddressId = "";
  state.returnAddressLabel = "";
  state.schoolHouseQuery = "";
  state.schoolStreetFilter = "";
  state.activeDetailTab = "summary";
  state.hoverAddressId = "";
  state.hoverSchoolKey = "";
  state.hoverSharedSchoolKeys = new Set();
  document.getElementById("addressSearch").value = "";
  document.getElementById("schoolSearch").value = "";
  applySearchModeUI();
  refreshFilterOptions();
  render();
  announce("Выделение на карте снято");
}

function clearFilters() {
  returnAreaContext=null; returnSchoolContext=''; comparisonSchoolKey=''; state.comparisonSchoolKey='';
  clearDistrictSearchNotice();
  cancelDetailRequest();
  state.selectionRequestToken += 1;
  state.searchMode = "address";
  state.searchSubmitted = false;
  state.sharedAreaSelection = null;
  state.addressSearchResults = [];
  state.schoolSearchResults = [];
  state.schoolHouseQuery = "";
  state.schoolStreetFilter = "";
  state.returnAddressId = "";
  state.returnAddressLabel = "";
  state.selectedAddressId = "";
  state.selectedGardenId = "";
  state.selectedSchoolKey = "";
  state.focusedSchoolAddressId = "";
  state.activeDetailTab = "summary";
  state.hoverAddressId = "";
  state.hoverSchoolKey = "";
  state.hoverSharedSchoolKeys = new Set();
  if (VIEWER_API?.isStaticDelivery) {
    detailPackages.clear();
    sidebarDirectoryCache = null;
    detailPackageWeights.clear();
    loadedSchoolDetails.clear();
    territorySourceDetails.clear();
    state.allAddresses = [];
    rebuildAssignmentState();
  }
  document.getElementById("districtFilter").value = "";
  document.getElementById("addressSearch").value = "";
  document.getElementById("schoolSearch").value = "";
  document.body.dataset.mobileView = "result";
  document.getElementById("mobileMapToggle")?.setAttribute("aria-pressed", "false");
  const mobileMapToggle = document.getElementById("mobileMapToggle");
  if (mobileMapToggle) {
    mobileMapToggle.textContent = "Карта";
    mobileMapToggle.setAttribute("aria-label", "Показывать карту");
  }
  applySearchModeUI();
  refreshFilterOptions();
  render();
  VIEWER_API?.releaseIdleResources?.();
  focusDistrict("");
  document.getElementById("addressSearch")?.focus();
  announce("Поиск сброшен");
}

function switchSearchMode(mode, moveFocus = true) {
  cancelDetailRequest();
  state.selectionRequestToken += 1;
  state.searchMode = mode === "school" ? "school" : "address";
  state.searchSubmitted = false;
  state.addressSearchResults = [];
  state.schoolSearchResults = [];
  state.selectedAddressId = "";
  state.selectedGardenId = "";
  state.selectedSchoolKey = "";
  state.focusedSchoolAddressId = "";
  state.returnAddressId = "";
  state.returnAddressLabel = "";
  state.schoolHouseQuery = "";
  state.schoolStreetFilter = "";
  state.activeDetailTab = "summary";
  applySearchModeUI();
  render();
  const target = document.getElementById(state.searchMode === "school" ? "schoolSearch" : "addressSearch");
  if (moveFocus) target?.focus();
  announce(state.searchMode === "school" ? "Режим поиска школы" : "Режим поиска школы по адресу дома");
}

function currentSharedAreaContext() {
  const selection = state.sharedAreaSelection;
  return selection?.token === state.selectionRequestToken && state.searchMode === 'school'
    && !state.selectedAddressId && !state.selectedGardenId
    && !state.selectedSchoolKey ? selection : null;
}

function selectedSharedArea() {
  return currentSharedAreaContext();
}

function sharedAreaSchoolChoicesHtml(area) {
  return `<div class="shared-school-choices" aria-label="Школы общей территории">${area.schoolKeys.map(key => {
    const school = state.schoolByKey.get(key);
    const title = school ? compactSchoolTitle(school) : key.split('::').slice(1).join('::');
    const number = school?.school_number;
    const label = /^\d+$/.test(String(number || '')) ? `№${number}` : title;
    return `<button type="button" data-school-key="${escapeAttr(key)}" aria-pressed="${key === state.selectedSchoolKey}" aria-label="${escapeAttr(title)}" title="${escapeAttr(title)}"${school ? '' : ' disabled'}>${escapeHtml(label)}${school ? '' : ' (сведения недоступны)'}</button>`;
  }).join('')}</div>`;
}

function selectAreaFromMap(feature, clickPoint = null) {
  const props = mapFeatureProperties(feature);
  const exclusive = !props.shared_area_key;
  const schoolKeys = exclusive ? [props.school_key] : sharedSectionMemberKeys(feature);
  const schools = schoolKeys.map(key => state.schoolByKey.get(key)).filter(Boolean);
  if (!schools.length) return false;
  cancelPendingSuggestions();
  state.hoverSchoolKey = '';
  state.hoverAddressId = '';
  state.hoverSharedSchoolKeys = new Set();
  document.getElementById('addressSearch').value = '';
  document.getElementById('schoolSearch').value = '';
  comparisonSchoolKey=''; state.comparisonSchoolKey='';
  returnAreaContext=null;
  if (exclusive) {
    void selectSchoolFromMap(props.school_key, true);
    return true;
  }
  showSubmittedSearchState('school', schools, { schoolKeys, key:props.shared_area_key || props.school_key, district:props.district,
    kind:exclusive ? 'exclusive' : props.shared_kind, clickPoint, scopeMode:clickPoint ? 'component' : 'all' });
  const context = currentSharedAreaContext();
  void loadSharedComparison(false, {fitCoverage: true});
  if (!(supportsSharedComparison(context) && VIEWER_BOOTSTRAP?.area_scope_index)) focusAreaSchoolCoverage(context);
  window.schoolCompactShell?.revealSelection();
  announce(`${exclusive ? 'Выбранный участок' : 'Общая территория'}: ${schools.map(compactSchoolTitle).join(', ')}.`);
  return true;
}

function showSubmittedSearchState(mode, rows, sharedArea = null) {
  cancelDetailRequest();
  state.selectionRequestToken += 1;
  state.sharedAreaSelection = sharedArea ? { ...sharedArea, token: state.selectionRequestToken } : null;
  state.searchMode = mode;
  state.searchSubmitted = true;
  state.selectedAddressId = "";
  state.selectedGardenId = "";
  state.selectedSchoolKey = "";
  state.focusedSchoolAddressId = "";
  state.returnAddressId = "";
  state.returnAddressLabel = "";
  state.addressSearchResults = mode === "address" ? rows : [];
  state.gardenSearchResults = [];
  state.schoolSearchResults = mode === "school" ? rows : [];
  state.activeDetailTab = "summary";
  applySearchModeUI();
  renderSchoolSections();
  renderSchools(state.schools);
  renderGardenTerritories();
  renderSelectionHighlights();
  renderSelectionCard();
  updateStats(0, 0);
  window.requestAnimationFrame(() => document.getElementById("selectionHeading")?.focus());
}

async function selectGardenById(territoryId, focus = true) {
  const feature = state.gardenById.get(territoryId);
  if (!feature) return;
  resetDistrictForSearchResult(feature.properties.district);
  const selectionToken = ++state.selectionRequestToken;
  const signal = beginDetailRequest();
  state.searchMode = "address";
  state.searchSubmitted = true;
  state.addressSearchResults = [];
  state.gardenSearchResults = [];
  state.schoolSearchResults = [];
  state.selectedAddressId = "";
  state.selectedSchoolKey = "";
  state.selectedGardenId = territoryId;
  state.focusedSchoolAddressId = "";
  applySearchModeUI();
  if (focus) document.getElementById("addressSearch").value = gardenSearchLabel(feature);
  refreshFilterOptions();
  render();
  if (feature.properties.status === 'source_only_unlocated') {
    focusDistrict(feature.properties.district, 420);
  } else if (feature.geometry) {
    fitFeatures([feature], { maxZoom: 16, duration: 420 });
  }
  if (focus) window.requestAnimationFrame(() => document.getElementById("selectionHeading")?.focus());
  announce(`${gardenSearchLabel(feature)}: ${feature.properties.school_numbers.length} ${ruPlural(feature.properties.school_numbers.length, "школа", "школы", "школ")}`);
  if (VIEWER_API) {
    try {
      if (VIEWER_BOOTSTRAP?.area_scope_index && !isLocalityTerritory(feature) && feature.geometry) {
        await ensureAreaScopeData(feature.properties.district,{signal});
        if (selectionToken!==state.selectionRequestToken) return;
        renderSelectionCard();
      }
      if (!isLocalityTerritory(feature) && feature.geometry && typeof VIEWER_API.territory === "function") {
        if (!territorySourceDetails.has(territoryId)) {
          const rows = await VIEWER_API.territory(territoryId, { signal });
          if (selectionToken !== state.selectionRequestToken) return;
          const props = feature.properties;
          const fragments = new Set(props.source_fragment_ids || []);
          const schools = new Set(props.school_numbers);
          const pairs = new Set((rows || []).map(row => `${row.source_fragment_id}::${row.school_number}`));
          if (!Array.isArray(rows) || !rows.length || pairs.size !== rows.length
              || rows.some(row => row.district !== props.district || row.record_kind !== "scan_rule"
                || row.is_current_source_evidence !== "yes" || row.assignment_scope_type || row.assignment_scope_value
                || !fragments.has(row.source_fragment_id) || !schools.has(row.school_number)
                || row.source_raw_file !== props.source_raw_file)
              || new Set(rows.map(row => row.source_fragment_id)).size !== fragments.size
              || new Set(rows.map(row => row.school_number)).size !== schools.size) {
            throw new Error("Источник территории не соответствует её школьным связям");
          }
          territorySourceDetails.set(territoryId, rows);
          while (territorySourceDetails.size > territorySourceCacheLimit) {
            territorySourceDetails.delete(territorySourceDetails.keys().next().value);
          }
        }
        render();
        return;
      }
      const keys = feature.properties.school_numbers.map(number => districtSchoolKey(feature.properties.district, number)).filter(key => !loadedSchoolDetails.has(key));
      const details = await Promise.all(keys.map(key => VIEWER_API.school(key, { signal })));
      if (selectionToken !== state.selectionRequestToken) return;
      keys.forEach((key,index) => {installRequestedDetails(details[index], `school:${key}`); loadedSchoolDetails.add(key);});
      if (keys.length) render();
    } catch (error) {
      if (selectionToken === state.selectionRequestToken) {
        announce("Не удалось загрузить фрагмент документа. Исходный файл доступен по ссылке.");
      }
    }
  }
}

function showGardenSearchResults(features) {
  cancelDetailRequest();
  state.selectionRequestToken += 1;
  state.searchMode = "address";
  state.searchSubmitted = true;
  state.selectedAddressId = "";
  state.selectedGardenId = "";
  state.selectedSchoolKey = "";
  state.addressSearchResults = [];
  state.schoolSearchResults = [];
  state.gardenSearchResults = features;
  applySearchModeUI();
  render();
  window.requestAnimationFrame(() => document.getElementById("selectionHeading")?.focus());
}

function searchFailureText(error, suggestions = false) {
  if (error?.code === "SEARCH_TOO_BROAD") return "Уточните район или адрес, чтобы сузить поиск.";
  return suggestions ? "Подсказки временно недоступны. Повторите запрос." : "Поиск временно недоступен. Повторите запрос.";
}

async function submitAddressSearch() {
  returnAreaContext=null; returnSchoolContext='';
  cancelDetailRequest();
  cancelPendingSuggestions();
  const input = document.getElementById("addressSearch");
  const value = input.value.trim();
  const token = ++state.selectionRequestToken;
  const listedGarden = state.gardenOptionByLabel.get(value);
  const gardens = gardenSearchCandidates(value, 8);
  const exactGardens = gardens.filter(garden => gardenNameKey(garden.properties.name) === gardenNameKey(value));
  if (listedGarden || exactGardens.length === 1) {
    selectGardenById((listedGarden || exactGardens[0]).properties.territory_id, true);
    return;
  }
  if (exactGardens.length > 1) {
    showGardenSearchResults(exactGardens);
    announce(`Найдено территорий: ${exactGardens.length}`);
    return;
  }
  try {
    await loadAddressSearch(value, token);
  } catch (error) {
    if (error.name !== "AbortError" && token === state.selectionRequestToken) {
      const message = searchFailureText(error);
      showSubmittedSearchState('address', []);
      document.getElementById('selectionCard').innerHTML = `<div class="search-empty"><strong>${escapeHtml(message)}</strong><span>Предыдущий результат сброшен. Попробуйте ещё раз.</span></div>`;
      document.getElementById("stats").textContent = message;
      announce(message);
    }
    return;
  }
  if (token !== state.selectionRequestToken || input.value.trim() !== value) return;
  const listed = state.addressOptionByLabel.get(value);
  const exact = listed || findAddressByFreeText(value);
  if (exact) {
    selectAddressById(exact.address_id, true);
    return;
  }
  if (gardens.length) {
    showGardenSearchResults(gardens);
    announce(`Найдено территорий: ${gardens.length}`);
    return;
  }
  const candidates = searchAddressCandidates(value, 8);
  showSubmittedSearchState("address", candidates);
  announce(candidates.length ? `Найдено ${candidates.length} похожих адресов; выберите нужный` : "Адрес не найден");
}

function syncDistrictFilterUI() {
  const filtered = Boolean(selectedDistrict());
  const reset = document.getElementById('clearDistrictFilter');
  const status = document.getElementById('districtFilterStatus');
  if (reset) reset.hidden = !filtered;
  if (status) status.hidden = !filtered;
}

function clearDistrictSearchNotice() {
  const notice = document.getElementById('districtFilterNotice');
  if (notice) { notice.textContent = ''; notice.hidden = true; }
}

function resetDistrictForSearchResult(district) {
  const control = document.getElementById('districtFilter');
  if (!control?.value || !district || control.value === district) return false;
  const previous = control.value;
  control.value = '';
  cancelPendingSuggestions();
  refreshFilterOptions();
  // The following selection renders the new result; avoid flashing the old card.
  loadSchoolSections('');
  const notice = document.getElementById('districtFilterNotice');
  if (notice) { notice.textContent = `Фильтр «${previous}» снят: выбран ${district} район.`; notice.hidden = false; }
  syncDistrictFilterUI();
  return true;
}

function prioritizeSearchSuggestions(items, district = selectedDistrict()) {
  return items.map((item, index) => ({item,index})).sort((a,b) =>
    Number((b.item.row.properties?.district || b.item.row.district) === district)
    - Number((a.item.row.properties?.district || a.item.row.district) === district) || a.index-b.index).map(({item})=>item);
}

function searchSuggestionWarning(item, district = selectedDistrict()) {
  const target = item.row.properties?.district || item.row.district;
  return district && target && target !== district ? `Сбросит фильтр «${district}»` : '';
}

function submitSchoolSearch() {
  returnAreaContext=null; returnSchoolContext='';
  const input = document.getElementById("schoolSearch");
  const value = input.value.trim();
  const listed = state.schoolOptionByLabel.get(value);
  if (listed) {
    selectSchoolByKey(schoolKey(listed), true);
    return;
  }
  const candidates = searchSchoolCandidates(value, searchResultLimit, true);
  showSubmittedSearchState("school", candidates);
  announce(candidates.length ? `Найдено школ: ${candidates.length}` : "Школа не найдена");
}

function activateCardTab(tabId, moveFocus = false) {
  if (tabId && !Object.hasOwn(detailTabLabels, tabId)) return;
  state.activeDetailTab = tabId || "summary";
  renderSelectionCard();
  const tab = document.getElementById(`school-card-tab-${state.activeDetailTab}`);
  if (moveFocus) window.requestAnimationFrame(() => tab?.focus());
  announce(detailTabLabels[state.activeDetailTab] || tab?.textContent?.trim() || "Раздел карточки");
}

function filterSchoolAddresses(filter) {
  state.schoolAddressFilter = filter === 'unlocated' ? 'unlocated' : 'all';
  state.schoolHouseQuery = '';
  state.schoolStreetFilter = '';
  const school = selectedSchoolRow();
  if (school) state.schoolAddressPageOffsets.set(schoolAddressListKey(school, 'current'), 0);
  activateCardTab('addresses');
}

function wireControls() {
  window.schoolCardActions = { activateTab: activateCardTab, filterAddresses: filterSchoolAddresses,
    directory: schoolAddressDirectory, addressDocuments: sidebarAddressDocuments,
    focusDirectoryAddress: focusSidebarAddress, schoolDocuments: sidebarSchoolDocuments,
    focusSchoolAddress: focusSchoolAddressById };
  window.schoolCardActions.schoolHistory = loadSidebarSchoolHistory;
  window.schoolCardActions.comparison = sharedComparisonModel;
  window.schoolCardActions.retryComparison = () => loadSharedComparison(true, {fitCoverage: true});
  window.schoolCardActions.selectGarden = id => selectGardenById(id,true);
  window.schoolCardActions.openDirectoryAddress = (key, openDocument = false) => {
    const row = sharedComparisonModel()?.addresses.get(key) || schoolAddressDirectory()?.addresses.get(key) || gardenExceptionRow(key);
    if (!row) return;
    if (currentSharedAreaContext()) returnAreaContext={...currentSharedAreaContext(),column:comparisonSchoolKey};
    else returnSchoolContext=state.selectedSchoolKey;
    return selectAddressById(row.address_id, true, {directoryRow: row, openDocument});
  };
  const selectionCard = document.getElementById("selectionCard");
  const addressInput = document.getElementById("addressSearch");
  const schoolInput = document.getElementById("schoolSearch");
  let suggestionTimer = null;
  let suggestionRequest = null, suggestionSequence = 0, suggestionItems = [], suggestionPage = 0, activeSuggestion = -1;
  const suggestionCache = new Map(); // <= 32 queries × 12 rows; bound to this page's release.
  const popup = document.getElementById('suggestionPopup');
  const options = document.getElementById('searchSuggestions');
  const status = document.getElementById('suggestionStatus');
  const pager = document.getElementById('suggestionPager');
  const closeSuggestions = () => {
    if (popup) popup.hidden = true;
    addressInput.setAttribute('aria-expanded', 'false');
    addressInput.removeAttribute('aria-activedescendant');
    activeSuggestion = -1;
  };
  cancelPendingSuggestions = () => {
    if (suggestionTimer) window.clearTimeout(suggestionTimer);
    suggestionTimer = null;
    suggestionRequest?.abort(); suggestionRequest = null;
    suggestionSequence++;
    closeSuggestions();
  };
  let districtChangeToken = 0;

  const suggestionPageSize = () => {
    const remaining = (window.visualViewport?.height || window.innerHeight) - addressInput.getBoundingClientRect().bottom - 65;
    const maximum = window.innerWidth <= 760 ? 3 : 5;
    return Math.max(1, Math.min(maximum, Math.floor(remaining / 65)));
  };
  const drawSuggestions = (message = '') => {
    if (!popup || document.activeElement !== addressInput || !addressInput.value.trim()) return closeSuggestions();
    const size = suggestionPageSize(), start = suggestionPage * size;
    if (start >= suggestionItems.length) suggestionPage = 0;
    options.innerHTML = suggestionItems.slice(suggestionPage * size, (suggestionPage + 1) * size).map((item, offset) => {
      const index = suggestionPage * size + offset;
      const warning = searchSuggestionWarning(item);
      return `<div id="suggestion-${index}" role="option" aria-selected="${index === activeSuggestion}" data-suggestion-index="${index}"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.subtitle)}${warning ? ` · <span class="suggestion-filter-warning">${escapeHtml(warning)}</span>` : ''}</small></div>`;
    }).join('');
    status.textContent = message || (suggestionItems.length ? 'Выберите подсказку · ↑ ↓ Enter' : 'Совпадений нет. Уточните запрос.');
    pager.innerHTML = suggestionItems.length > size ? `<button type="button" data-suggestion-page="-1" aria-label="Предыдущие подсказки" ${suggestionPage === 0 ? 'disabled' : ''}>←</button><button type="button" data-suggestion-page="1" aria-label="Следующие подсказки" ${(suggestionPage + 1) * size >= suggestionItems.length ? 'disabled' : ''}>→</button>` : '';
    popup.hidden = false; addressInput.setAttribute('aria-expanded', 'true');
    if (activeSuggestion >= 0) addressInput.setAttribute('aria-activedescendant', `suggestion-${activeSuggestion}`);
    else addressInput.removeAttribute('aria-activedescendant');
  };
  const localSuggestions = (kind, value) => kind === 'school'
    ? searchSchoolCandidates(value, 12, true).map(row => ({kind:'school', row, label:compactSchoolTitle(row), subtitle:row.district + ' район'}))
    : gardenSearchCandidates(value, 12, true).map(row => ({kind:'garden', row,
      label: gardenSearchLabel(row).split(' · ')[0] + (row.properties.status === 'source_only_unlocated' ? ' (граница не определена)' : row.properties.school_numbers.length === 1 ? ' (все адреса)' : ' (территория)'),
      subtitle: row.properties.district + ' район' + (row.properties.municipality ? ' · ' + row.properties.municipality : '')}));
  const chooseSuggestion = index => {
    const item = suggestionItems[index]; if (!item) return;
    cancelPendingSuggestions();
    resetDistrictForSearchResult(item.row.properties?.district || item.row.district);
    if (item.kind === 'school') return selectSchoolByKey(schoolKey(item.row), true);
    if (item.kind === 'garden') return selectGardenById(item.row.properties.territory_id, true);
    // Install only the chosen overview; typing never rebuilds assignment indexes.
    const row = state.addresses.find(row => row.district === item.row.district && row.address_key === item.row.address_key && !row._overview)
      || prepareAddressRows(prepareOverviewAddressRows([{...item.row}]))[0];
    state.addressById.set(row.address_id, row);
    return selectAddressById(row.address_id, true);
  };
  popup?.addEventListener('pointerdown', event => event.preventDefault());
  popup?.addEventListener('click', event => {
    const option = event.target.closest('[data-suggestion-index]');
    if (option) chooseSuggestion(Number(option.dataset.suggestionIndex));
    const page = event.target.closest('[data-suggestion-page]');
    if (page && !page.disabled) { suggestionPage += Number(page.dataset.suggestionPage); activeSuggestion = -1; drawSuggestions(); }
  });
  addressInput.addEventListener('blur', cancelPendingSuggestions);
  addressInput.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { cancelPendingSuggestions(); return; }
    if (popup?.hidden || !suggestionItems.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      activeSuggestion = (activeSuggestion + (event.key === 'ArrowDown' ? 1 : -1) + suggestionItems.length) % suggestionItems.length;
      suggestionPage = Math.floor(activeSuggestion / suggestionPageSize()); drawSuggestions();
    } else if (event.key === 'Enter' && activeSuggestion >= 0) {
      event.preventDefault(); chooseSuggestion(activeSuggestion);
    }
  });
  const scheduleSuggestions = (kind) => {
    clearDistrictSearchNotice();
    cancelPendingSuggestions();
    const sequence = suggestionSequence;
    const input = kind === "school" ? schoolInput : addressInput;
    const value = input.value;
    const district = selectedDistrict();
    suggestionPage = 0; activeSuggestion = -1;
    suggestionItems = localSuggestions(kind, value);
    if (!value.trim() || addressInput.matches(':disabled')) return;
    if (kind === 'school') return drawSuggestions();
    if (!/[а-яa-z]{3}/iu.test(value)) return drawSuggestions('Введите хотя бы 3 буквы названия');
    if (/^\s*(?:снт|сдт|садоводство)\s/iu.test(value)) return drawSuggestions();
    drawSuggestions(suggestionItems.length ? '' : 'Ищем адреса…');
    suggestionTimer = window.setTimeout(async () => {
      suggestionTimer = null;
      if (sequence !== suggestionSequence || input.value !== value || selectedDistrict() !== district) return;
      const key = `${district}|${value.trim().toLowerCase()}`;
      const controller = new AbortController(); suggestionRequest = controller;
      try {
        let rows = suggestionCache.get(key);
        if (!rows) rows = VIEWER_API?.suggest ? await VIEWER_API.suggest(value, district, controller.signal) : searchAddressCandidates(value, 8);
        if (controller.signal.aborted || sequence !== suggestionSequence || selectedDistrict() !== district) return;
        suggestionCache.delete(key); suggestionCache.set(key, rows);
        while (suggestionCache.size > 32) suggestionCache.delete(suggestionCache.keys().next().value);
        const local = localSuggestions(kind, value);
        const gardenRows = local.filter(item => item.kind === 'garden').map(item => item.row);
        const knownGardens = [...state.gardenTerritories,
          ...(VIEWER_BOOTSTRAP?.garden_follow_up || []).map(properties => ({properties}))];
        const distinctRows = window.suppressGardenHouseDuplicates(rows, gardenRows, knownGardens);
        suggestionItems = prioritizeSearchSuggestions([...local, ...distinctRows.map(row => ({kind:'address', row,
          label:atlasStreetLabel(addressTitle(row)), subtitle:row.district + ' район'}))]).slice(0, 12);
        drawSuggestions();
      } catch (error) {
        if (error.name !== 'AbortError' && sequence === suggestionSequence) {
          drawSuggestions(searchFailureText(error, true));
        }
      }
    }, searchInputDelay);
  };

  document.querySelectorAll(".search-mode [data-search-mode]").forEach((button) => {
    button.addEventListener("click", () => switchSearchMode(button.dataset.searchMode, false));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...document.querySelectorAll(".search-mode [data-search-mode]")];
      const current = buttons.indexOf(button);
      let next = current;
      if (event.key === "ArrowLeft") next = (current - 1 + buttons.length) % buttons.length;
      if (event.key === "ArrowRight") next = (current + 1) % buttons.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = buttons.length - 1;
      buttons[next].focus();
      switchSearchMode(buttons[next].dataset.searchMode, false);
    });
  });

  document.getElementById("addressSearchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (unifiedSearchEnabled()) submitUnifiedSearch();
    else submitAddressSearch();
  });

  addressInput.addEventListener("input", (event) => {
    returnAreaContext=null; returnSchoolContext='';
    if (event.isComposing) { cancelPendingSuggestions(); return; }
    cancelDetailRequest();
    const cancelledPendingSelection = selectionCard.getAttribute("aria-busy") === "true";
    state.selectionRequestToken += 1;
    selectionCard.setAttribute("aria-busy", "false");
    if (cancelledPendingSelection) {
      renderSelectionCardPreservingFocus();
      updateStats(0, state.schools.filter((row) => schoolMatchesFilters(row)).length);
    }
    const kind = unifiedSearchEnabled() ? syncUnifiedQuery() : 'address';
    const school = unifiedSearchEnabled() && state.schoolOptionByLabel.get(event.target.value);
    const garden = state.gardenOptionByLabel.get(event.target.value);
    const row = state.addressOptionByLabel.get(event.target.value);
    if (school) selectSchoolByKey(schoolKey(school), true);
    else if (garden) selectGardenById(garden.properties.territory_id, true);
    else if (row) selectAddressById(row.address_id, true);
    else scheduleSuggestions(kind);
  });
  schoolInput.addEventListener("input", (event) => {
    returnAreaContext=null; returnSchoolContext='';
    cancelDetailRequest();
    const cancelledPendingSelection = selectionCard.getAttribute("aria-busy") === "true";
    state.selectionRequestToken += 1;
    selectionCard.setAttribute("aria-busy", "false");
    if (cancelledPendingSelection) {
      renderSelectionCardPreservingFocus();
      updateStats(0, state.schools.filter((row) => schoolMatchesFilters(row)).length);
    }
    const row = state.schoolOptionByLabel.get(event.target.value);
    if (row) selectSchoolByKey(schoolKey(row), true);
    else scheduleSuggestions("school");
  });

  selectionCard.addEventListener("change", (event) => {
    if (event.target.matches?.("[data-school-source-fragment]")) changeSchoolSourceFragment(event.target);
  });
  selectionCard.addEventListener("click", (event) => {
    if (event.target.closest("a")) return;
    if (event.target.closest('[data-retry-school-campuses]')) {
      if (!VIEWER_API && state.schoolCampusLoadStatus === 'error') {
        void loadSchoolCampuses();
        renderSelectionCard();
      }
      return;
    }
    const retryIndex=event.target.closest('[data-retry-area-index]');
    if (retryIndex) {
      const token=state.selectionRequestToken;
      ensureAreaScopeData(retryIndex.dataset.retryAreaIndex).catch(()=>{}).finally(()=>{
        if (token===state.selectionRequestToken) renderSelectionCard();
      });
      return;
    }
    if (event.target.closest('[data-return-school]') && returnSchoolContext) {
      selectSchoolByKey(returnSchoolContext,false); return;
    }
    if (event.target.closest('[data-return-garden]') && returnGardenContext) {
      selectGardenById(returnGardenContext, false); return;
    }
    const column=event.target.closest('[data-comparison-column]');
    if (column) {
      const key = column.dataset.comparisonColumn;
      if (key && !sharedComparisonModel()?.schools.some(school => school.key === key)) return;
      comparisonSchoolKey=key;
      state.comparisonSchoolKey=comparisonSchoolKey;
      renderSchoolSections(); renderSchools(state.schools); renderGardenTerritories();
      renderSelectionHighlights(); renderSelectionCard();
      focusAreaSchoolCoverage(currentSharedAreaContext());
      window.requestAnimationFrame(()=>document.querySelector(`[data-comparison-column="${CSS.escape(comparisonSchoolKey)}"]`)?.focus());
      return;
    }
    const wholeSchool=event.target.closest('[data-full-school]');
    if (wholeSchool) {
      returnAreaContext={...currentSharedAreaContext(),column:comparisonSchoolKey};
      selectSchoolByKey(wholeSchool.dataset.fullSchool,true);
      return;
    }
    if (event.target.closest('[data-return-area]') && returnAreaContext) {
      const previous=returnAreaContext;
      resetDistrictForSearchResult(previous.schoolKeys[0].split('::')[0]);
      document.getElementById('addressSearch').value = '';
      document.getElementById('schoolSearch').value = '';
      showSubmittedSearchState('school',previous.schoolKeys.map(key=>state.schoolByKey.get(key)).filter(Boolean),{...previous});
      comparisonSchoolKey=previous.column || ''; state.comparisonSchoolKey=comparisonSchoolKey;
      void loadSharedComparison(false, {fitCoverage: true}); return;
    }
    const scopeMode=event.target.closest('[data-scope-mode]');
    const areaContext = currentSharedAreaContext();
    if (scopeMode && areaContext) {
      if (!['component', 'all', 'unassigned'].includes(scopeMode.dataset.scopeMode)) return;
      if (scopeMode.dataset.scopeMode === 'unassigned' && !areaContext.unassignedCount) return;
      if (scopeMode.dataset.scopeMode === 'all' && !(areaContext.componentCount > 1)) return;
      if (scopeMode.dataset.scopeMode === 'unassigned') areaContext.previousScopeMode = areaContext.scopeMode;
      areaContext.scopeMode = scopeMode.dataset.scopeMode;
      comparisonSchoolKey=''; state.comparisonSchoolKey='';
      state.focusedSchoolAddressId='';
      renderSchoolSections(); renderSchools(state.schools); renderGardenTerritories();
      void loadSharedComparison(true); return;
    }
    const sharedItem = event.target.closest('[data-shared-area-key]');
    if (sharedItem) {
      const key = sharedItem.dataset.sharedAreaKey;
      const feature = state.schoolAreaTiles?.byFID.get(key)
        || state.sharedSchoolSections.features.find(item => item.properties.shared_area_key === key);
      if (feature) selectAreaFromMap(feature);
      return;
    }
    const retrySchool = event.target.closest('[data-retry-school-key]');
    if (retrySchool) {
      selectSchoolByKey(retrySchool.dataset.retrySchoolKey, false, currentSchoolDetailNotice()?.origin);
      return;
    }
    if (event.target.closest('[data-retry-address]')) {
      const notice = currentAddressDetailNotice();
      if (notice?.status === 'error') selectAddressById(notice.addressId, notice.focus,
        {directoryRow:notice.directoryRow || notice.row, openDocument:notice.openDocument});
      return;
    }
    const addressFilter = event.target.closest('[data-school-address-filter]');
    if (addressFilter) {
      filterSchoolAddresses(addressFilter.dataset.schoolAddressFilter);
      return;
    }
    const gardenItem = event.target.closest("[data-garden-id]");
    if (gardenItem) {
      selectGardenById(gardenItem.dataset.gardenId, true);
      return;
    }
    const tabButton = event.target.closest("[data-card-tab]");
    if (tabButton) {
      activateCardTab(tabButton.dataset.cardTab, true);
      return;
    }
    const streetButton = event.target.closest('[data-school-street]');
    if (streetButton) {
      const school = selectedSchoolRow();
      state.schoolAddressFilter = 'all';
      state.schoolStreetFilter = streetButton.dataset.schoolStreet;
      state.schoolHouseQuery = streetButton.dataset.schoolStreet === 'Другие адреса' ? '' : streetButton.dataset.schoolStreet;
      if (school) state.schoolAddressPageOffsets.set(schoolAddressListKey(school, 'current'), 0);
      activateCardTab('addresses', true);
      return;
    }
    const returnButton = event.target.closest("[data-return-address-id]");
    if (returnButton) {
      selectAddressById(returnButton.dataset.returnAddressId, true);
      return;
    }
    const centerButton = event.target.closest("[data-center-address-id]");
    if (centerButton) {
      const row = state.addressById.get(centerButton.dataset.centerAddressId);
      if (row) centerHouse(row);
      return;
    }
    const historyToggle = event.target.closest("[data-address-history-key]");
    if (historyToggle) {
      const key = historyToggle.dataset.addressHistoryKey;
      if (state.expandedAddressHistories.has(key)) state.expandedAddressHistories.delete(key);
      else state.expandedAddressHistories.add(key);
      renderSelectionCard();
      window.requestAnimationFrame(() => {
        [...selectionCard.querySelectorAll("[data-address-history-key]")]
          .find((item) => item.dataset.addressHistoryKey === key)
          ?.focus();
      });
      return;
    }
    const listToggle = event.target.closest("[data-school-list-key]");
    if (listToggle) {
      const key = listToggle.dataset.schoolListKey;
      const action = listToggle.dataset.schoolListAction;
      if (!moveSchoolAddressPage(selectedSchoolRow(), key, action)) return;
      const direction = action === 'previous' ? -1 : 1;
      renderSelectionCard();
      window.requestAnimationFrame(() => {
        const history = key.endsWith("::historical");
        const container = selectionCard.querySelector(history ? "#schoolHistoryAddressResults" : "#schoolAddressResults");
        const matchingToggle = [...(container?.querySelectorAll("[data-school-list-key]") || [])]
          .find((item) => item.dataset.schoolListKey === key);
        const firstRowAction = container?.querySelector(history ? "[data-address-id]" : "[data-focus-address-id]");
        (matchingToggle || firstRowAction)?.focus();
      });
      announce(direction > 0 ? "Показана следующая страница домов" : "Показана предыдущая страница домов");
      return;
    }
    const focusAddressItem = event.target.closest("[data-focus-address-id]");
    if (focusAddressItem) {
      focusSchoolAddressById(focusAddressItem.dataset.focusAddressId);
      return;
    }
    const addressItem = event.target.closest("[data-address-id]");
    if (addressItem) {
      selectAddressById(addressItem.dataset.addressId, true);
      return;
    }
    const schoolItem = event.target.closest("[data-school-key]");
    if (schoolItem) {
      const origin = selectedAddressRow();
      if (currentSharedAreaContext()) returnAreaContext={...currentSharedAreaContext(),column:comparisonSchoolKey};
      selectSchoolByKey(schoolItem.dataset.schoolKey, true, origin);
    }
  });

  selectionCard.addEventListener("keydown", (event) => {
    const tab = event.target.closest(".card-tabs [data-card-tab]");
    if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tabs = [...selectionCard.querySelectorAll(".card-tabs [data-card-tab]")];
      const current = tabs.indexOf(tab);
      let next = current;
      if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
      if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      activateCardTab(tabs[next].dataset.cardTab, true);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const item = event.target.closest("[role='button']");
    if (!item || item.tagName === "BUTTON") return;
    event.preventDefault();
    item.click();
  });

  selectionCard.addEventListener("input", (event) => {
    if (event.target.id !== "schoolHouseSearch") return;
    state.schoolStreetFilter = "";
    state.schoolHouseQuery = event.target.value;
    const results = selectionCard.querySelector("#schoolAddressResults");
    const school = selectedSchoolRow();
    if (school) state.schoolAddressPageOffsets.set(schoolAddressListKey(school, "current"), 0);
    if (results && school) {
      results.innerHTML = schoolAddressListHtml(school);
      const count = schoolFilteredCurrentAssignments(school).rows.length;
      const status = selectionCard.querySelector("#schoolHouseCount");
      if (status) status.textContent = `${count} ${ruPlural(count, "адрес", "адреса", "адресов")} в списке`;
    }
  });

  document.getElementById("districtFilter").addEventListener("change", async () => {
    returnAreaContext=null; returnSchoolContext=''; comparisonSchoolKey=''; state.comparisonSchoolKey='';
    clearDistrictSearchNotice();
    cancelPendingSuggestions();
    cancelDetailRequest();
    const token = ++districtChangeToken;
    const interactionToken = ++state.selectionRequestToken;
    const loadStartedAt = Date.now();
    const district = selectedDistrict();
    document.getElementById('addressSearch').value = '';
    document.getElementById('schoolSearch').value = '';
    state.searchMode = 'address';
    state.selectedGardenId = '';
    state.sharedAreaSelection = null;
    state.gardenSearchResults = [];
    state.searchSubmitted = false;
    state.addressSearchResults = [];
    state.schoolSearchResults = [];
    state.selectedAddressId = "";
    state.selectedSchoolKey = "";
    state.focusedSchoolAddressId = "";
    state.returnAddressId = "";
    state.returnAddressLabel = "";
    refreshFilterOptions();
    render();
    selectionCard.setAttribute("aria-busy", "true");
    document.getElementById("stats").textContent = `Загрузка: ${loadedDistrictLabel(district)}...`;
    try {
      if (!VIEWER_API) await ensureAssignmentsForDistrict(district);
    } catch (error) {
      if (token === districtChangeToken && district === selectedDistrict()) {
        if (interactionToken === state.selectionRequestToken) showAssignmentLoadError(district, error);
        else render();
      }
      return;
    }
    if (token !== districtChangeToken || district !== selectedDistrict()) return;
    const interactionAdvanced = interactionToken !== state.selectionRequestToken;
    if (interactionAdvanced && state.searchSubmitted && !state.selectedAddressId && !state.selectedSchoolKey) {
      if (state.searchMode === "school") {
        const query = document.getElementById("schoolSearch")?.value || "";
        state.schoolSearchResults = searchSchoolCandidates(query, searchResultLimit);
      } else {
        const query = document.getElementById("addressSearch")?.value || "";
        state.addressSearchResults = searchAddressCandidates(query, 8);
      }
    }
    refreshFilterOptions();
    render();
    document.documentElement.dataset.lastDistrictLoadMs = String(Date.now() - loadStartedAt);
    if (!interactionAdvanced) focusDistrict(district);
    if (controlChecked("toggleAreas")) loadSchoolSections(district);
    if (!interactionAdvanced) announce(`Выбран ${district ? `${district} район` : "весь Санкт-Петербург"}`);
  });

  const mobileMapToggle = document.getElementById("mobileMapToggle");
  function setMobileMapView(showMap) {
    document.body.dataset.mobileView = showMap ? "map" : "result";
    mobileMapToggle.setAttribute("aria-pressed", String(showMap));
    mobileMapToggle.textContent = showMap ? "Результат" : "Карта";
    mobileMapToggle.setAttribute("aria-label", showMap ? "Показывать результат" : "Показывать карту");
    if (showMap) window.requestAnimationFrame(() => refitVisibleSelection());
  }
  document.getElementById("districtColorLegend")?.addEventListener("click", (event) => {
    const district = event.target.closest("[data-legend-district]")?.dataset.legendDistrict;
    if (!district || !state.map) return;
    document.getElementById("mapTools").hidePopover();
    if (window.matchMedia?.("(max-width: 760px)").matches) setMobileMapView(true);
    const filter = document.getElementById("districtFilter");
    filter.value = district;
    filter.dispatchEvent(new Event("change", {bubbles: true}));
  });
  mobileMapToggle.addEventListener("click", () => {
    const showMap = document.body.dataset.mobileView !== "map";
    setMobileMapView(showMap);
    announce(showMap ? "Карта открыта" : "Результат поиска открыт");
  });
  const refitMobileMap = () => {
    if (document.body.dataset.mobileView === "map") refitVisibleSelection();
  };
  window.addEventListener("resize", refitMobileMap);
  window.visualViewport?.addEventListener("resize", refitMobileMap);

  document.getElementById("clearDistrictFilter").addEventListener("click", () => {
    const control = document.getElementById("districtFilter");
    control.value = "";
    control.dispatchEvent(new Event("change"));
  });
}

function addGeojsonSource(id) {
  const options = {
    type: "geojson",
    data: emptyFeatureCollection
  };
  if (id === "schoolSections") {
    options.tolerance = 1.2;
    options.promoteId = "school_key";
  }
  if (id === "sharedSchoolSections") {
    options.tolerance = 1.2;
    options.promoteId = "shared_area_key";
  }
  if (id === "schoolSectionLabels") options.promoteId = "school_key";
  state.map.addSource(id, options);
}

function hexToRgb(hex) {
  const clean = String(hex || "").replace("#", "");
  if (clean.length !== 6) return { r: 71, g: 85, b: 105 };
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function schoolIconImage(style) {
  const pixelRatio = 2;
  const size = 18;
  const canvas = document.createElement("canvas");
  canvas.width = size * pixelRatio;
  canvas.height = size * pixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(pixelRatio, pixelRatio);
  const fill = hexToRgb(style.color);
  const stroke = hexToRgb(style.stroke);
  ctx.clearRect(0, 0, size, size);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.fillStyle = `rgb(${fill.r}, ${fill.g}, ${fill.b})`;
  ctx.strokeStyle = `rgb(${stroke.r}, ${stroke.g}, ${stroke.b})`;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(4.5, 8.2);
  ctx.lineTo(9, 4.4);
  ctx.lineTo(13.5, 8.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(5.5, 8.2, 7, 5.6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillRect(7.1, 9.4, 1.6, 1.6);
  ctx.fillRect(9.3, 9.4, 1.6, 1.6);
  ctx.fillRect(7.1, 11.4, 1.6, 1.6);
  ctx.fillRect(9.3, 11.4, 1.6, 1.6);
  return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
}

function addressDiamondImage(fillColor, strokeColor) {
  const pixelRatio = 2;
  const size = 20;
  const canvas = document.createElement("canvas");
  canvas.width = size * pixelRatio;
  canvas.height = size * pixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(pixelRatio, pixelRatio);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = fillColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(size / 2, 2.5);
  ctx.lineTo(size - 2.5, size / 2);
  ctx.lineTo(size / 2, size - 2.5);
  ctx.lineTo(2.5, size / 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
}

function schoolAreaLabelImageId(value) {
  const number = normalizeSchoolNumber(value);
  return number ? `school-area-number-${encodeURIComponent(number)}` : "";
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function boundedSchoolAreaLabel(label, context, maxWidth = 170) {
  if (context.measureText(label).width <= maxWidth) return label;
  const letters = Array.from(label);
  let low = 0, high = letters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(letters.slice(0, middle).join("") + "…").width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return letters.slice(0, low).join("").trimEnd() + "…";
}

function schoolAreaNumberImage(value) {
  const pixelRatio = 2;
  const number = normalizeSchoolNumber(value);
  const fontSize = number.length >= 5 ? 19 : number.length >= 4 ? 21 : 24;
  const font = `800 ${fontSize}px "Segoe UI", sans-serif`;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = font;
  const label = boundedSchoolAreaLabel(schoolReference(number), probe);
  const width = Math.max(46, Math.ceil(probe.measureText(label).width) + 22);
  const height = 42;
  const canvas = document.createElement("canvas");
  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(pixelRatio, pixelRatio);
  ctx.clearRect(0, 0, width, height);
  ctx.shadowColor = "rgba(15, 23, 42, 0.2)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  roundedRectPath(ctx, 3, 3, width - 6, height - 7, 13);
  ctx.fillStyle = "rgba(255, 253, 245, 0.94)";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "rgba(20, 70, 64, 0.72)";
  ctx.stroke();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.96)";
  ctx.strokeText(label, width / 2, (height - 3) / 2);
  ctx.fillStyle = "#173f3b";
  ctx.fillText(label, width / 2, (height - 3) / 2);
  return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
}

function registerSchoolAreaNumberIcons(features) {
  if (!state.map?.addImage || !state.map?.hasImage) return;
  const numbers = uniqueBy(
    features.map((feature) => normalizeSchoolNumber(feature.properties?.school_number)).filter(Boolean),
    (number) => number
  );
  for (const number of numbers) {
    const id = schoolAreaLabelImageId(number);
    if (!id || state.map.hasImage(id)) continue;
    state.map.addImage(id, schoolAreaNumberImage(number), { pixelRatio: 2 });
  }
}

function registerSchoolIcons() {
  for (const [group, style] of Object.entries(schoolTypeStyles)) {
    const id = `school-icon-${group}`;
    if (state.map.hasImage(id)) continue;
    state.map.addImage(id, schoolIconImage(style), { pixelRatio: 2 });
  }
  if (!state.map.hasImage("address-related-diamond")) {
    state.map.addImage("address-related-diamond", addressDiamondImage("#0f766e", "#ffffff"), { pixelRatio: 2 });
  }
  if (!state.map.hasImage("address-selected-diamond")) {
    state.map.addImage("address-selected-diamond", addressDiamondImage("#fbbf24", "#064e3b"), { pixelRatio: 2 });
  }
}

function setupMapLayers() {
  state.schoolBadges = new SchoolCapsules(state.map);
  if (window.schoolAreaTileModule?.sharedAreaBadgeCandidates && state.map.getContainer) state.sharedAreaBadges = new SharedAreaCounters(state.map);
  const legacyAreaSources = new Set(["schoolSections", "sharedSchoolSections", "schoolSectionLabels"]);
  ["districtBoundaries", "schoolSections", "sharedSchoolSections", "schoolSectionLabels", "gardenBoundaries", "gardenPoints", "addresses", "schools", "selectedAddresses", "selectedAddressPin", "selectedSchools"]
    .filter(id => !SCHOOL_AREA_TILE_PACKAGE || !legacyAreaSources.has(id)).forEach(addGeojsonSource);
  registerSchoolIcons();
  const sectionHighlighted = [
    "any",
    ["==", ["get", "selection_state"], "active"],
    ["boolean", ["feature-state", "highlighted"], false]
  ];
  const sectionDimmed = ["boolean", ["feature-state", "dimmed"], false];

  state.map.addLayer({
    id: layerIds.districtFill,
    type: "fill",
    source: "districtBoundaries",
    paint: {
      "fill-color": "#f8fafc",
      "fill-opacity": [
        "case",
        ["==", ["get", "is_selected_district"], "yes"], 0.1,
        ["==", ["get", "selection_state"], "dim"], 0.01,
        0.025
      ]
    }
  });
  const colors = Object.fromEntries(Object.keys(DISTRICT_SLUGS).map(district => [district, colorForDistrict(district)]));
  const districtAreaColor = ["coalesce", ["get", "area_color"], Object.keys(colors).length
    ? ["match", ["get", "district"], ...Object.entries(colors).flat(), districtColors[9]]
    : districtColors[9]];
  if (SCHOOL_AREA_TILE_PACKAGE) {
    state.schoolAreaTiles = new window.schoolAreaTileModule.SchoolAreaTiles(state.map,
      SCHOOL_AREA_TILE_PACKAGE.source, SCHOOL_AREA_TILE_PACKAGE.metadata, layerIds, colors);
    state.schoolAreaTiles.install();
    state.schoolAreaTiles.installSelectionOutlines(VIEWER_BOOTSTRAP?.selection_outline_display);
    state.schoolSectionsLoaded = true;
    state.map.on("remove", SCHOOL_AREA_TILE_PACKAGE.unregister);
    state.map.on("sourcedata", event => {
      if (event.sourceId === state.schoolAreaTiles.sourceId) {
        document.documentElement.dataset.schoolAreaTilesLoaded = state.map.isSourceLoaded(event.sourceId) ? "yes" : "no";
      }
    });
    state.map.on("error", event => {
      if (event.sourceId === state.schoolAreaTiles.sourceId && !state.schoolSectionsLoadError) {
        state.schoolSectionsLoadError = event.error || new Error("Школьные участки временно недоступны");
        renderSelectionCardPreservingFocus();
      }
    });
  } else {
  state.map.addLayer({
    id: layerIds.schoolSectionsFill,
    type: "fill",
    source: "schoolSections",
    paint: {
      "fill-color": ["case", sectionHighlighted, "#2858f5", districtAreaColor],
      "fill-opacity": [
        "case",
        sectionHighlighted, 0.56,
        sectionDimmed, 0.14,
        0.20
      ]
    }
  });
  state.map.addLayer({
    id: layerIds.sharedSchoolSectionsFill,
    type: "fill",
    source: "sharedSchoolSections",
    filter: ["==", ["get", "shared_kind"], "assignment_zone"],
    paint: {
      "fill-color": ["case", sectionHighlighted, "#2858f5", "#16a6b6"],
      "fill-opacity": [
        "case",
        sectionHighlighted, 0.48,
        sectionDimmed, 0.12,
        0.20
      ]
    }
  });
  state.map.addLayer({
    id: layerIds.sharedSchoolBuildingsFill,
    type: "fill",
    source: "sharedSchoolSections",
    minzoom: 12,
    filter: ["==", ["get", "shared_kind"], "building_surface"],
    paint: {
      "fill-color": ["case", sectionHighlighted, "#2858f5", "#16a6b6"],
      "fill-opacity": [
        "case",
        sectionHighlighted, 0.86,
        sectionDimmed, 0.04,
        ["interpolate", ["linear"], ["zoom"],
          12, 0.03,
          13.2, 0.08,
          14.5, 0.12
        ]
      ]
    }
  });
  state.map.addLayer({
    id: layerIds.schoolSectionsHitbox,
    type: "fill",
    source: "schoolSections",
    paint: {
      "fill-color": "#111827",
      "fill-opacity": 0
    }
  });
  state.map.addLayer({
    id: layerIds.sharedSchoolSectionsHitbox,
    type: "fill",
    source: "sharedSchoolSections",
    paint: {
      "fill-color": "#111827",
      "fill-opacity": 0
    }
  });
  state.map.addLayer({
    id: layerIds.schoolSectionsLine,
    type: "line",
    source: "schoolSections",
    layout: {
      "line-cap": "round",
      "line-join": "round"
    },
    paint: {
      "line-color": ["case", sectionHighlighted, "#2858f5", districtAreaColor],
      "line-width": ["interpolate", ["linear"], ["zoom"],
        9, ["case", sectionHighlighted, 2.2, sectionDimmed, 0.35, 0.55],
        15, ["case", sectionHighlighted, 3.8, sectionDimmed, 0.65, 1.15]
      ],
      "line-opacity": [
        "case",
        sectionHighlighted, 0.95,
        sectionDimmed, 0.38,
        0.55
      ],
      "line-blur": 0.1
    }
  });
  state.map.addLayer({
    id: layerIds.sharedSchoolSectionsLine,
    type: "line",
    source: "sharedSchoolSections",
    filter: ["==", ["get", "shared_kind"], "assignment_zone"],
    paint: {
      "line-color": ["case", sectionHighlighted, "#2858f5", "#087a8b"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, ["case", sectionHighlighted, 2.2, 0.65], 15, ["case", sectionHighlighted, 3.8, 1.1]],
      "line-opacity": ["case", sectionHighlighted, 0.95, sectionDimmed, 0.18, 0.55]
    }
  });
  state.map.addLayer({
    id: layerIds.sharedSchoolBuildingsLine,
    type: "line",
    source: "sharedSchoolSections",
    minzoom: 12,
    filter: ["==", ["get", "shared_kind"], "building_surface"],
    paint: {
      "line-color": ["case", sectionHighlighted, "#10394b", districtAreaColor],
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, ["case", sectionHighlighted, 2.2, 1], 17, ["case", sectionHighlighted, 3.8, 2.5]],
      "line-opacity": 0
    }
  });
  }
  state.map.addLayer({
    id: layerIds.districtLine,
    type: "line",
    source: "districtBoundaries",
    layout: {
      "line-cap": "round",
      "line-join": "round"
    },
    paint: {
      "line-color": "#64748b",
      "line-width": ["interpolate", ["linear"], ["zoom"],
        9, ["case", ["==", ["get", "is_selected_district"], "yes"], 1.5, 0.7],
        15, ["case", ["==", ["get", "is_selected_district"], "yes"], 3.2, 1.4]
      ],
      "line-opacity": [
        "case",
        ["==", ["get", "selection_state"], "dim"], 0.05,
        0.38
      ],
      "line-blur": 0.1
    }
  });

  state.map.addLayer({
    id: layerIds.gardenFill,
    type: "fill",
    source: "gardenBoundaries",
    paint: {
      "fill-color": "#0d9488",
      "fill-opacity": ["case", ["==", ["get", "selection_state"], "active"], 0.23, 0.025]
    }
  });
  state.map.addLayer({
    id: layerIds.gardenLine,
    type: "line",
    source: "gardenBoundaries",
    paint: {
      "line-color": ["case", ["==", ["get", "selection_state"], "active"], "#b45309", "#0f766e"],
      "line-width": ["case", ["==", ["get", "selection_state"], "active"], 2.8, 1.1],
      "line-opacity": ["case", ["==", ["get", "selection_state"], "active"], 0.95, 0.55],
      "line-dasharray": [2, 1.5]
    }
  });
  state.map.addLayer({
    id: layerIds.gardenPoints,
    type: "circle",
    source: "gardenPoints",
    paint: {
      "circle-radius": ["case", ["==", ["get", "selection_state"], "active"], 8, 5],
      "circle-color": ["case", ["==", ["get", "selection_state"], "active"], "#f59e0b", "#0f766e"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
      "circle-opacity": 0.95
    }
  });

  if (!SCHOOL_AREA_TILE_PACKAGE) {
  state.map.addLayer({
    id: layerIds.schoolSectionsLabels,
    type: "symbol",
    source: "schoolSectionLabels",
    layout: {
      "icon-image": ["get", "area_label_icon"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 12, 0.58, 15, 0.9, 17, 1.04],
      "icon-allow-overlap": false,
      "icon-ignore-placement": false,
      "icon-padding": 4
    },
    paint: {
      "icon-opacity": [
        "case",
        sectionHighlighted, 0,
        sectionDimmed, 0.24,
        0.72
      ]
    }
  });

  state.map.addLayer({
    id: layerIds.schoolSectionsLabelsActive,
    type: "symbol",
    source: "schoolSectionLabels",
    layout: {
      "icon-image": ["get", "area_label_icon"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 12, 0.72, 15, 1, 17, 1.12],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    },
    paint: {
      "icon-opacity": ["case", sectionHighlighted, 1, 0]
    }
  });

  }
  state.map.addLayer({
    id: layerIds.addresses,
    type: "circle",
    source: "addresses",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        9, ["case",
          ["==", ["get", "coordinate_precision"], "unrecognized_approximate"], 2.5,
          ["==", ["get", "multi_school"], "yes"], 2.3,
          1.5
        ],
        14, ["case",
          ["==", ["get", "coordinate_precision"], "unrecognized_approximate"], 4.2,
          ["==", ["get", "multi_school"], "yes"], 4,
          2.7
        ],
        17, ["case",
          ["==", ["get", "coordinate_precision"], "unrecognized_approximate"], 6.2,
          ["==", ["get", "multi_school"], "yes"], 5.8,
          4
        ]
      ],
      "circle-color": [
        "case",
        ["==", ["get", "coordinate_precision"], "unrecognized_approximate"], "#a21caf",
        ["==", ["get", "multi_school"], "yes"], "#ea580c",
        "#39766f"
      ],
      "circle-opacity": [
        "case",
        ["==", ["get", "selection_state"], "active"], 0.08,
        ["==", ["get", "selection_state"], "related"], 0.12,
        ["==", ["get", "selection_state"], "dim"], 0.18,
        0.58
      ],
      "circle-stroke-color": [
        "case",
        ["==", ["get", "coordinate_precision"], "unrecognized_approximate"], "#701a75",
        ["==", ["get", "multi_school"], "yes"], "#7c2d12",
        "#ffffff"
      ],
      "circle-stroke-opacity": [
        "case",
        ["==", ["get", "selection_state"], "dim"], 0.45,
        0.9
      ],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"],
        9, ["case", ["==", ["get", "multi_school"], "yes"], 1.1, 0.45],
        14, ["case", ["==", ["get", "multi_school"], "yes"], 1.7, 0.8],
        17, ["case", ["==", ["get", "multi_school"], "yes"], 2.2, 1.1]
      ]
    }
  });

  state.map.addLayer({
    id: layerIds.schools,
    type: "symbol",
    source: "schools",
    layout: {
      "icon-image": ["concat", "school-icon-", ["coalesce", ["get", "school_type_group"], "school"]],
      "icon-size": ["interpolate", ["linear"], ["zoom"],
        9, ["case", ["==", ["get", "campus_evidence_status"], "osm_candidate"], 0.28, 0.42],
        14, ["case", ["==", ["get", "campus_evidence_status"], "osm_candidate"], 0.4, 0.58],
        17, ["case", ["==", ["get", "campus_evidence_status"], "osm_candidate"], 0.52, 0.72]
      ],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    },
    paint: {
      "icon-opacity": [
        "case",
        ["all", ["==", ["get", "selection_state"], "active"], ["==", ["get", "campus_evidence_status"], "osm_candidate"]], 0.58,
        ["==", ["get", "selection_state"], "active"], 1,
        ["==", ["get", "selection_state"], "dim"], 0.22,
        ["==", ["get", "campus_evidence_status"], "osm_candidate"], 0.34,
        0.96
      ]
    }
  });

  state.map.addLayer({
    id: layerIds.selectedAddresses,
    type: "symbol",
    source: "selectedAddresses",
    layout: {
      "icon-image": "address-related-diamond",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.34, 14, 0.56, 17, 0.78],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    },
    paint: {
      "icon-opacity": 0.92
    }
  });

  state.map.addLayer({
    id: layerIds.selectedAddressPin,
    type: "symbol",
    source: "selectedAddressPin",
    layout: {
      "icon-image": "address-selected-diamond",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.52, 14, 0.82, 17, 1.08],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    },
    paint: {
      "icon-opacity": 1
    }
  });

  state.map.addLayer({
    id: layerIds.selectedSchoolHalo,
    type: "circle",
    source: "selectedSchools",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 14, 12, 17, 16],
      "circle-color": "#5eead4",
      "circle-opacity": ["case", ["==", ["get", "campus_evidence_status"], "osm_candidate"], 0.1, 0.28],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-opacity": 0.96,
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 1.4, 14, 2.2, 17, 3]
    }
  });

  state.map.addLayer({
    id: layerIds.selectedSchools,
    type: "symbol",
    source: "selectedSchools",
    layout: {
      "icon-image": ["concat", "school-icon-", ["coalesce", ["get", "school_type_group"], "school"]],
      "icon-size": ["interpolate", ["linear"], ["zoom"],
        9, ["case", ["==", ["get", "campus_evidence_status"], "osm_candidate"], 0.3, 0.46],
        14, ["case", ["==", ["get", "campus_evidence_status"], "osm_candidate"], 0.42, 0.62],
        17, ["case", ["==", ["get", "campus_evidence_status"], "osm_candidate"], 0.54, 0.74]
      ],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "text-field": [
        "case",
        ["==", ["get", "campus_label"], ""],
        "",
        ["concat", ["get", "campus_label"], "\n", ["get", "campus_address"]]
      ],
      "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 12, 17, 13],
      "text-max-width": 20,
      "text-offset": [0, 1.6],
      "text-anchor": "top",
      "text-allow-overlap": true,
      "text-ignore-placement": true,
      "text-optional": true
    },
    paint: {
      "icon-opacity": ["case", ["==", ["get", "campus_evidence_status"], "osm_candidate"], 0.62, 1],
      "text-color": ["case", ["==", ["get", "campus_evidence_status"], "osm_candidate"], "#7c2d12", "#0f172a"],
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.4
    }
  });
  // One badge at the school replaces the old building icon and area-centroid number.
  for (const id of [layerIds.schools, layerIds.selectedSchools, layerIds.selectedSchoolHalo,
    layerIds.schoolSectionsLabels, layerIds.schoolSectionsLabelsActive]) {
    if (state.map.getLayer(id)) state.map.setLayoutProperty(id, "visibility", "none");
  }
  state.map.moveLayer(layerIds.districtLine, layerIds.schoolSectionsFill);
}

function setupInteractions() {
  const clickThroughLayerIds = [
    layerIds.gardenPoints,
    layerIds.selectedAddressPin,
    layerIds.selectedAddresses,
    layerIds.addresses,
    layerIds.selectedSchools,
    layerIds.selectedSchoolHalo,
    layerIds.schools,
    "selectedAreaComponentLine",
    "selectedAreaComponentFill",
    layerIds.schoolSectionsLabelsActive,
    layerIds.schoolSectionsLabels,
    layerIds.sharedSchoolSectionsHitbox,
    layerIds.sharedSchoolBuildingsLine,
    layerIds.sharedSchoolBuildingsFill,
    layerIds.sharedSchoolSectionsLine,
    layerIds.sharedSchoolSectionsFill,
    layerIds.schoolSectionsHitbox,
    layerIds.schoolSectionsLine,
    layerIds.schoolSectionsFill,
    layerIds.gardenLine,
    layerIds.gardenFill
  ];
  const layerClickPriority = new Map(clickThroughLayerIds.map((layerId, index) => [layerId, index]));
  const selectableFeaturesAtPoint = (point) => {
    if (!state.map?.queryRenderedFeatures) return [];
    const availableLayers = clickThroughLayerIds.filter((layerId) => state.map.getLayer(layerId));
    return state.map.queryRenderedFeatures(point, { layers: availableLayers })
      .sort((left, right) => (
        (layerClickPriority.get(left.layer?.id) ?? 999) - (layerClickPriority.get(right.layer?.id) ?? 999)
      ));
  };
  const selectMapFeature = (feature, point) => {
    const props = mapFeatureProperties(feature);
    if (props.selected_component) return true;
    if (props.territory_id) {
      selectGardenById(props.territory_id, false);
      return true;
    }
    if (props.shared_area_key) return selectAreaFromMap(feature, point ? [point.lng,point.lat] : null);
    if (props.address_id) {
      selectAddressById(props.address_id, false);
      return true;
    }
    if (props.school_key) {
      if (VIEWER_BOOTSTRAP?.area_scope_index && state.schoolAreaTiles?.byFID.has(feature.properties?.fid) && point) {
        return selectAreaFromMap(feature, [point.lng, point.lat]);
      }
      selectSchoolFromMap(props.school_key);
      return true;
    }
    return false;
  };
  const selectFeatureAtPoint = (event) => {
    const features=selectableFeaturesAtPoint(event.point);
    const top=mapFeatureProperties(features[0]);
    if (!top.address_id && !top.territory_id && !top.shared_area_key && !top.selected_component
        && ![layerIds.schools, layerIds.selectedSchools, layerIds.selectedSchoolHalo].includes(features[0]?.layer?.id)) {
      const keys=[...new Set(features.map(mapFeatureProperties).filter(props=>props.school_key && !props.shared_area_key).map(props=>props.school_key))];
      const schools=keys.map(key=>state.schoolByKey.get(key)).filter(Boolean);
      if (schools.length>1) {
        showSubmittedSearchState('school',schools);
        const card=document.getElementById('selectionCard');
        card.insertAdjacentHTML?.('afterbegin','<p class="scope-caption">Перекрытие расчётных областей. Выберите школу или найдите конкретный адрес.</p>');
        window.schoolCompactShell?.revealSelection();
        return true;
      }
    }
    for (const feature of features) {
      if (selectMapFeature(feature,event.lngLat)) return true;
    }
    return false;
  };
  state.map.on("click", (event) => {
    if (!selectFeatureAtPoint(event)) clearMapSelection();
  });

  // Resolve overlapping fill/line/shared layers once per frame. Per-layer
  // enter/leave listeners can clear each other's state at the same point.
  let hoverPoint = null, hoverFramePending = false, hoverDisposed = false;
  const queueHover = point => {
    hoverPoint = point;
    if (hoverFramePending || hoverDisposed) return;
    hoverFramePending = true;
    window.requestAnimationFrame(() => {
      hoverFramePending = false;
      if (hoverDisposed) return;
      const feature = hoverPoint ? selectableFeaturesAtPoint(hoverPoint)[0] : null;
      const props = mapFeatureProperties(feature);
      state.map.getCanvas().style.cursor = feature ? 'pointer' : '';
      // Hover never changes a committed selection or dims all other badges.
      const preview = !hasMapSelection();
      const shared = preview && props.shared_area_key ? new Set(sharedSectionMemberKeys(feature)) : new Set();
      const school = preview && !shared.size ? props.school_key || '' : '';
      const address = preview ? props.address_id || '' : '';
      if (school === state.hoverSchoolKey && address === state.hoverAddressId
          && shared.size === state.hoverSharedSchoolKeys.size
          && [...shared].every(key => state.hoverSharedSchoolKeys.has(key))) return;
      state.hoverSchoolKey = school;
      state.hoverAddressId = address;
      state.hoverSharedSchoolKeys = shared;
      // Feature state only: no GeoJSON setData, school lookup, card or badge rebuild.
      syncSchoolAreaFeatureStates();
    });
  };
  state.map.on('mousemove', event => queueHover(event.point));
  state.map.on('mouseout', event => {
    if (!event.originalEvent?.relatedTarget?.closest?.('.school-capsule')) queueHover(null);
  });
  state.map.on('remove', () => { hoverDisposed = true; hoverPoint = null; });

  state.map.on("moveend", () => {
    if (!selectedDistrict() && controlChecked("toggleAddresses")) renderAddresses(state.addresses);
  });
}

function createMap() {
  maplibregl.setWorkerCount?.(1);
  state.map = new maplibregl.Map({
    container: "map",
    center: [30.3141, 59.9386],
    zoom: 10,
    minZoom: 9,
    maxZoom: 18,
    maxTileCacheSize: 1,
    maxTileCacheZoomLevels: 1,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: false,
    locale: {
      "Map.Title": "Карта школ и закреплённых домов",
      "NavigationControl.ZoomIn": "Приблизить",
      "NavigationControl.ZoomOut": "Отдалить",
      "NavigationControl.ResetBearing": "Сбросить направление",
      "AttributionControl.ToggleAttribution": "Показать сведения об источниках карты"
    },
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
        }
      },
      layers: [
        {
          id: "background",
          type: "background",
          paint: {
            "background-color": "#e5e7eb"
          }
        },
        {
          id: "osm",
          type: "raster",
          source: "osm",
          paint: {
            "raster-saturation": -0.92,
            "raster-contrast": -0.16,
            "raster-brightness-min": 0.12,
            "raster-brightness-max": 0.96,
            "raster-opacity": 0.9
          }
        }
      ]
    }
  });
  state.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  state.map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");
}

function waitForMapReady(timeoutMs = 20000) {
  if (state.map.loaded() || state.map.isStyleLoaded?.()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let resolved = false;
    let intervalId = null;
    let timeoutId = null;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
      resolve();
    };
    state.map.once("load", finish);
    state.map.once("style.load", finish);
    state.map.once("styledata", () => {
      if (state.map.isStyleLoaded?.()) finish();
    });
    intervalId = setInterval(() => {
      if (state.map.loaded() || state.map.isStyleLoaded?.()) finish();
    }, 100);
    timeoutId = setTimeout(() => {
      if (state.map.loaded() || state.map.isStyleLoaded?.()) {
        finish();
        return;
      }
      if (resolved) return;
      resolved = true;
      if (intervalId) clearInterval(intervalId);
      reject(new Error("Карта не успела загрузить стиль"));
    }, timeoutMs);
  });
}

async function init() {
  const initStartedAt = performance.now();
  await loadDistrictConfig();
  const reviewDecisionsPromise = VIEWER_API ? Promise.resolve(VIEWER_BOOTSTRAP.review_decisions) : fetchDistrictEvidenceCsvs(
    DISTRICT_REVIEW_DECISION_FILES,
    state.reviewDecisionLoadFailures,
    "Результаты проверки адресов недоступны"
  );
  const coordinateReviewsPromise = VIEWER_API ? Promise.resolve(VIEWER_BOOTSTRAP.coordinate_reviews) : fetchDistrictEvidenceCsvs(
    DISTRICT_COORDINATE_REVIEW_FILES,
    state.coordinateReviewLoadFailures,
    "Координатные проверки недоступны"
  );

  const dataPromise = Promise.all([
    fetchInitialAssignments(),
    fetchViewerSchools(),
    VIEWER_API ? VIEWER_BOOTSTRAP.district_sources : fetchCsv("district_sources.csv"),
    VIEWER_API ? VIEWER_BOOTSTRAP.primary_sources : fetchCsv("primary_accounting_sources.csv"),
    fetchViewerBoundaries(),
    VIEWER_API
      ? mergeTerritoryCatalogs([VIEWER_BOOTSTRAP.gardens, VIEWER_BOOTSTRAP.locality_territories || emptyFeatureCollection])
      : Promise.all([fetchJson("garden_territory_candidates.geojson"), fetchJson("locality_territory_candidates.geojson")]).then(mergeTerritoryCatalogs),
    reviewDecisionsPromise,
    coordinateReviewsPromise
  ]).then((rows) => {
    document.documentElement.dataset.viewerDataFetchMs = String(Math.round(performance.now() - initStartedAt));
    return rows;
  });

  createMap();
  await waitForMapReady();
  document.documentElement.dataset.viewerMapReadyMs = String(Math.round(performance.now() - initStartedAt));
  setupMapLayers();
  setupInteractions();

  const [
    assignments,
    allSchools,
    districtSources,
    primarySources,
    districtBoundaries,
    gardenCatalog,
    reviewDecisions,
    coordinateReviews
  ] = await dataPromise;

  const prepareStartedAt = performance.now();

  state.districtBoundaries = districtBoundaries || emptyFeatureCollection;
  if (gardenCatalog?.type !== "FeatureCollection" || !Array.isArray(gardenCatalog.features)) {
    throw new Error("Каталог территорий СНТ недоступен или повреждён");
  }
  for (const feature of gardenCatalog.features) {
    const props = feature.properties || {};
    if (!props.territory_id || !Array.isArray(props.point) || props.point.length !== 2
      || !Array.isArray(props.school_numbers) || !props.school_numbers.length
      || !feature.geometry || state.gardenById.has(props.territory_id)) {
      throw new Error("Каталог территорий СНТ содержит некорректную запись");
    }
    state.gardenById.set(props.territory_id, feature);
  }
  state.gardenTerritories = gardenCatalog.features;
  state.sourceOnlyGardenTerritories = window.sourceOnlyGardenFeatures(VIEWER_BOOTSTRAP?.garden_follow_up || [], state.gardenTerritories);
  for (const feature of state.sourceOnlyGardenTerritories) state.gardenById.set(feature.properties.territory_id, feature);
  buildDistrictGeometryIndex(state.districtBoundaries);
  let phaseStartedAt = performance.now();
  prepareAddressRows(assignments);
  document.documentElement.dataset.viewerAddressPrepareMs = String(Math.round(performance.now() - phaseStartedAt));
  phaseStartedAt = performance.now();
  state.outsideDistrictAddressCount = markAddressCoordinateQuality(assignments);
  document.documentElement.dataset.viewerCoordinateQaMs = String(Math.round(performance.now() - phaseStartedAt));
  const visibleSchools = allSchools.filter((row) => row.map_visible === "yes");
  prepareSchoolRows(visibleSchools);

  state.allAddresses = assignments;
  state.addresses = assignments.filter((row) => row.is_current === "yes" && row.record_kind !== "scan_rule");
  for (const district of new Set(assignments.map((row) => row.district).filter(Boolean))) {
    state.loadedAssignmentDistricts.add(district);
    state.assignmentLevelByDistrict.set(district, assignments.some((row) => row.district === district && row._overview) ? "overview" : "full");
  }
  state.scanSchools = [];
  state.schools = visibleSchools;
  if (VIEWER_API) {
    buildSchoolCampusMetadataIndex(VIEWER_BOOTSTRAP.campus_metadata || []);
    buildSchoolCampusIndex(VIEWER_BOOTSTRAP.campus_points || []);
    state.schoolCampusesLoaded = true;
    state.schoolCampusLoadStatus = "loaded";
  }
  state.reviewDecisions = reviewDecisions;
  state.coordinateReviewSources = coordinateReviews;
  updateDebugDataset();

  buildSourceIndex(districtSources, primarySources);
  phaseStartedAt = performance.now();
  buildIndexes();
  document.documentElement.dataset.viewerSearchIndexMs = String(Math.round(performance.now() - phaseStartedAt));
  phaseStartedAt = performance.now();
  buildAssignmentIndexes(assignments);
  document.documentElement.dataset.viewerAssignmentIndexMs = String(Math.round(performance.now() - phaseStartedAt));
  buildReviewDecisionIndexes(reviewDecisions);
  buildCoordinateReviewIndexes(coordinateReviews);
  setupDistricts();
  applySearchModeUI();
  refreshFilterOptions();
  wireControls();
  phaseStartedAt = performance.now();
  render();
  document.documentElement.dataset.viewerInitialRenderMs = String(Math.round(performance.now() - phaseStartedAt));
  document.documentElement.dataset.viewerPrepareMs = String(Math.round(performance.now() - prepareStartedAt));
  document.documentElement.dataset.viewerReadyMs = String(Math.round(performance.now() - initStartedAt));
  focusDistrict(selectedDistrict(), 0);
  if (!VIEWER_API && controlChecked("toggleSchools")) scheduleIdleTask(loadSchoolCampuses);
  if (controlChecked("toggleAreas")) {
    scheduleIdleTask(() => {
      if (controlChecked("toggleAreas")) loadSchoolSections(selectedDistrict());
    });
  }
  await restoreSessionView();
  window.addEventListener("pagehide", saveSessionView);
}

init().catch((error) => {
  console.error(error);
  document.getElementById("stats").textContent = `Ошибка загрузки: ${error.message}`;
  const card = document.getElementById("selectionCard");
  if (card) {
    card.setAttribute("aria-busy", "false");
    card.innerHTML = `<div class="search-empty"><strong>Не удалось загрузить карту</strong><span>${escapeHtml(error.message)}</span><button id="retryViewer" type="button">Попробовать ещё раз</button></div>`;
    document.getElementById("retryViewer")?.addEventListener("click", () => window.location.reload());
  }
  announce("Ошибка загрузки данных");
});
