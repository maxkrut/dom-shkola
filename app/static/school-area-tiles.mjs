/* Display-only school geometry. Canonical coordinates stay in district packages. */
import { buildAreaColorPlan, areaColorExpression } from './area-colors.mjs';
export { colorizeAreaFeatures } from './area-colors.mjs';
const empty = Object.freeze([]);
const scopeManifests = new Map();
const scopeDistricts = new Map();

export async function loadAreaScopes(bootstrap, district, {signal, fetch:fetcher = globalThis.fetch, root = new URL('../../', import.meta.url)} = {}) {
  const descriptor = bootstrap?.area_scope_index;
  if (!descriptor) throw new Error('Список адресов участка ещё не подготовлен');
  const manifestSha = descriptor.manifest.sha256;
  let manifest = scopeManifests.get(manifestSha);
  if (!manifest) {
    manifest = JSON.parse(new TextDecoder().decode(await boundBytes(descriptor.manifest,root,1024*1024,fetcher,signal)));
    signal?.throwIfAborted();
    if (manifest.schema !== 1 || !manifest.districts) throw new Error('Некорректный индекс адресов участка');
    scopeManifests.set(manifestSha, manifest);
    while (scopeManifests.size > 2) scopeManifests.delete(scopeManifests.keys().next().value);
  }
  if (manifest.map_sha256 !== bootstrap.map_display.manifest.sha256
      || manifest.register_sha256 !== bootstrap.register_data.manifest.sha256) throw new Error('Версии карты и адресов участка различаются');
  signal?.throwIfAborted();
  const cacheKey = `${manifestSha}:${district}`;
  if (scopeDistricts.has(cacheKey)) return scopeDistricts.get(cacheKey);
  const record = manifest.districts[district];
  const value = JSON.parse(new TextDecoder().decode(await boundBytes(record,root,24*1024*1024,fetcher,signal)));
  signal?.throwIfAborted();
  if (value.schema !== 1 || value.district !== district || !value.areas || !value.addresses || !value.gardens) throw new Error('Некорректный список адресов участка');
  for (const area of Object.values(value.areas)) for (const part of area.components) {
    if (!/^[a-f0-9]{24}$/.test(part.id) || part.geometry?.type !== 'Polygon'
        || !part.keys.every(key=>Object.hasOwn(value.addresses,key))) throw new Error('Некорректная часть области');
  }
  scopeDistricts.set(cacheKey,value);
  while (scopeDistricts.size > 4) scopeDistricts.delete(scopeDistricts.keys().next().value);
  return value;
}

export function componentContains(component, point) {
  if (!point || !component?.geometry?.coordinates) return false;
  const [x,y] = point;
  function ringContains(ring) {
    let inside = false;
    for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const [a,b]=ring[i],[c,d]=ring[j];
      const cross=(x-a)*(d-b)-(y-b)*(c-a);
      if (Math.abs(cross)<1e-14 && x>=Math.min(a,c) && x<=Math.max(a,c) && y>=Math.min(b,d) && y<=Math.max(b,d)) return 2;
      if ((b>y)!==(d>y) && x<(c-a)*(y-b)/(d-b)+a) inside=!inside;
    }
    return inside ? 1 : 0;
  }
  const [outer,...holes]=component.geometry.coordinates;
  const hit=ringContains(outer);
  return hit===2 || (hit===1 && !holes.some(ring=>ringContains(ring)===1));
}
const shared = feature => Boolean(feature.properties.shared_area_key);
const memberKeys = feature => shared(feature)
  ? String(feature.properties.shared_member_school_keys || "").split("|").map(key => key.trim()).filter(Boolean)
  : [feature.properties.school_key].filter(Boolean);

function publicAssetUrl(path, root) {
  if (typeof path !== "string" || !/^[a-zA-Z0-9_./{}-]+$/.test(path)
      || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Некорректный путь школьных тайлов");
  }
  return new URL(path, root).href.replaceAll("%7B", "{").replaceAll("%7D", "}");
}

async function boundBytes(record, root, maxBytes, fetcher, signal) {
  signal?.throwIfAborted();
  if (!record || !/^[a-f0-9]{64}$/.test(record.sha256 || "") || !Number.isSafeInteger(record.bytes)
      || record.bytes < 1 || record.bytes > maxBytes) throw new Error("Не указана версия или размер школьных участков");
  const url = new URL(publicAssetUrl(record.path, root));
  url.searchParams.set("revision", record.sha256);
  const response = await fetcher(url.href, { cache: "force-cache", signal });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Preserve the HTTP error. */ }
    throw new Error(`Школьные участки временно недоступны (${response.status})`);
  }
  const bytes = new Uint8Array(record.bytes), reader = response.body?.getReader();
  let offset = 0;
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        if (offset + value.byteLength > record.bytes) throw new Error("Размер каталога школьных участков изменился");
        bytes.set(value, offset); offset += value.byteLength;
      }
    } else {
      const value = new Uint8Array(await response.arrayBuffer());
      if (value.byteLength !== record.bytes) throw new Error("Размер каталога школьных участков изменился");
      bytes.set(value); offset = value.byteLength;
    }
  } finally {
    if (reader) { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  }
  const data = bytes.buffer;
  signal?.throwIfAborted();
  if (offset !== record.bytes) throw new Error("Размер каталога школьных участков изменился");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(value => value.toString(16).padStart(2, "0")).join("");
  signal?.throwIfAborted();
  if (digest !== record.sha256) throw new Error("Данные школьных участков изменились. Обновите страницу.");
  return data;
}

async function boundJson(record, root, maxBytes, fetcher) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundBytes(record, root, maxBytes, fetcher)));
}

function validBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
    && bounds[0] < bounds[2] && bounds[1] < bounds[3] && bounds[0] >= -180 && bounds[2] <= 180
    && bounds[1] >= -85.052 && bounds[3] <= 85.052;
}

function tileWithinBounds(z, x, y, bounds) {
  const mercatorY = latitude => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
  const scale = 2 ** z;
  return (x + 1) / scale >= (bounds[0] + 180) / 360 && x / scale <= (bounds[2] + 180) / 360
    && (y + 1) / scale >= mercatorY(bounds[3]) && y / scale <= mercatorY(bounds[1]);
}

export async function loadAreaTilePackage(descriptor, options = {}) {
  const root = options.root || new URL("../../", import.meta.url);
  const fetcher = options.fetch || fetch;
  if (descriptor?.schema !== 1 || !descriptor.manifest) throw new Error("Некорректный каталог школьных тайлов");
  const manifest = await boundJson(descriptor.manifest, root, 512 * 1024, fetcher);
  if (manifest?.schema !== 1 || manifest.kind !== "school_area_mvt" || manifest.source_layer !== "areas"
      || manifest.promote_id !== "fid" || !validBounds(manifest.bounds)
      || !Number.isInteger(manifest.minzoom) || !Number.isInteger(manifest.maxzoom)
      || manifest.minzoom < 0 || manifest.maxzoom < manifest.minzoom || manifest.maxzoom > 18
      || manifest.empty_policy !== "complete_sparse_xyz_within_bounds" || !manifest.tile_index || !manifest.empty_tile) {
    throw new Error("Неподдерживаемый формат школьных тайлов");
  }
  const base = new URL(".", publicAssetUrl(descriptor.manifest.path, root));
  const [rawMetadata, index] = await Promise.all([
    boundJson(manifest.metadata, base, 2 * 1024 * 1024, fetcher),
    boundJson(manifest.tile_index, base, 4 * 1024 * 1024, fetcher)
  ]);
  if (rawMetadata?.schema !== 1 || !rawMetadata.features || Array.isArray(rawMetadata.features)
      || typeof rawMetadata.features !== "object" || !rawMetadata.school_features || Array.isArray(rawMetadata.school_features)) {
    throw new Error("Некорректные сведения о школьных участках");
  }
  const metadata = { schema: 1, features: Object.entries(rawMetadata.features).map(([fid, feature]) => ({ ...feature, fid })) };
  validateAreaMetadata(metadata);
  const reverse = new Map();
  for (const feature of metadata.features) for (const key of memberKeys(feature)) {
    if (!reverse.has(key)) reverse.set(key, { exclusive: [], shared: [] });
    reverse.get(key)[shared(feature) ? "shared" : "exclusive"].push(feature.fid);
  }
  for (const key of new Set([...reverse.keys(), ...Object.keys(rawMetadata.school_features)])) {
    const record = rawMetadata.school_features[key], derived = reverse.get(key) || { exclusive: [], shared: [] };
    if (!record || !["exclusive", "shared"].every(kind => Array.isArray(record[kind])
      && JSON.stringify([...record[kind]].sort()) === JSON.stringify(derived[kind].sort()))) {
      throw new Error("Несовместимая привязка школьных участков");
    }
  }
  if (index?.schema !== 1 || index.domain?.scheme !== "xyz" || index.domain.complete !== true
      || index.domain.missing_key !== "empty_within_domain" || index.domain.minzoom !== manifest.minzoom
      || index.domain.maxzoom !== manifest.maxzoom || JSON.stringify(index.domain.bounds) !== JSON.stringify(manifest.bounds)
      || !index.tiles || typeof index.tiles !== "object" || Array.isArray(index.tiles)) throw new Error("Некорректный индекс школьных тайлов");
  for (const [key, record] of Object.entries(index.tiles)) {
    const parts = /^(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(key);
    if (!parts || !/^[a-f0-9]{64}$/.test(record?.sha256 || "") || record.path !== `tiles/${record.sha256}.pbf`
        || !Number.isInteger(record.bytes) || record.bytes <= 0 || record.bytes > 8 * 1024 * 1024) throw new Error("Некорректная запись школьного тайла");
    const [z, x, y] = parts.slice(1).map(Number);
    if (z < manifest.minzoom || z > manifest.maxzoom || x >= 2 ** z || y >= 2 ** z
        || !tileWithinBounds(z, x, y, manifest.bounds)) throw new Error("Школьный тайл вне объявленной области");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.empty_tile.sha256 || "")) throw new Error("Не объявлен пустой школьный тайл");
  const token = descriptor.manifest.sha256;
  const source = { type: "vector", tiles: [`school-mvt://${token}/{z}/{x}/{y}.pbf`],
    minzoom: manifest.minzoom, maxzoom: manifest.maxzoom, bounds: manifest.bounds, promoteId: "fid" };
  return { source, metadata, manifest, index, base, token, fetcher };
}

export function registerAreaTileProtocol(engine, bundle) {
  const { manifest, index, token, base, fetcher } = bundle;
  const handler = async (request, controller) => {
    const match = /^school-mvt:\/\/([a-f0-9]{64})\/(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)\.pbf$/.exec(request.url);
    if (!match || match[1] !== token) throw new Error("Несовместимая версия школьных тайлов");
    const [z, x, y] = match.slice(2).map(Number);
    if (z < manifest.minzoom || z > manifest.maxzoom || x >= 2 ** z || y >= 2 ** z
        || !tileWithinBounds(z, x, y, manifest.bounds)) throw new Error("Запрошен школьный тайл вне объявленной области");
    const record = index.tiles[`${z}/${x}/${y}`] || manifest.empty_tile;
    const data = await boundBytes(record, base, 8 * 1024 * 1024, fetcher, controller?.signal);
    return { data, cacheControl: "public, max-age=31536000, immutable" };
  };
  engine.addProtocol("school-mvt", handler);
  return () => engine.removeProtocol("school-mvt");
}

export function validateAreaMetadata(metadata) {
  if (metadata?.schema !== 1 || !Array.isArray(metadata.features) || metadata.features.length > 50000) {
    throw new Error("Некорректный каталог школьных участков");
  }
  const ids = new Set();
  for (const feature of metadata.features) {
    const p = feature?.properties;
    const b = feature?.bbox;
    if (!p || typeof feature.fid !== "string" || !feature.fid || ids.has(feature.fid)
        || feature.fid !== (p.shared_area_key || p.school_key) || !p.district
        || (feature.geometry != null) || !Array.isArray(b) || b.length !== 4
        || !b.every(Number.isFinite) || b[0] > b[2] || b[1] > b[3]
        || b[0] < -180 || b[2] > 180 || b[1] < -85.052 || b[3] > 85.052
        || !memberKeys(feature).length || (shared(feature) && !["assignment_zone", "building_surface"].includes(p.shared_kind))) {
      throw new Error("Некорректная запись школьного участка");
    }
    ids.add(feature.fid);
  }
  return metadata;
}

export class SchoolAreaTiles {
  constructor(map, source, metadata, layerIds, colors = {}) {
    validateAreaMetadata(metadata);
    if (source?.type !== "vector" || source.promoteId !== "fid"
        || !Array.isArray(source.tiles) || source.tiles.length !== 1
        || typeof source.tiles[0] !== "string" || !["{z}", "{x}", "{y}"].every(part => source.tiles[0].includes(part))
        || Object.hasOwn(source, "data")
        || !Number.isInteger(source.minzoom) || !Number.isInteger(source.maxzoom)
        || source.minzoom < 0 || source.maxzoom < source.minzoom || source.maxzoom > 18) {
      throw new Error("Некорректный источник школьных тайлов");
    }
    this.map = map;
    this.source = source;
    this.sourceId = "schoolAreaTiles";
    this.sourceLayer = "areas";
    this.layerIds = layerIds;
    this.colors = colors;
    this.colorPlan = buildAreaColorPlan(metadata.features, colors);
    this.features = metadata.features;
    this.byFID = new Map(this.features.map(feature => [feature.fid, feature]));
    this.bySchool = new Map();
    this.byDistrict = new Map();
    this.active = new Set();
    this.focused = false;
    this.highlightAreas = true;
    this.district = null;
    this.visible = null;
    for (const feature of this.features) {
      for (const key of new Set(memberKeys(feature))) {
        if (!this.bySchool.has(key)) this.bySchool.set(key, []);
        this.bySchool.get(key).push(feature);
      }
      const districts = new Set([feature.properties.district, ...memberKeys(feature).map(key => key.split("::")[0])]);
      for (const district of districts) {
        if (!this.byDistrict.has(district)) this.byDistrict.set(district, new Set());
        this.byDistrict.get(district).add(feature.fid);
      }
    }
  }

  install() {
    const map = this.map, ids = this.layerIds;
    map.addSource(this.sourceId, this.source);
    const active = ["boolean", ["feature-state", "highlighted"], false];
    const outlineHidden = ["boolean", ["feature-state", "outline_hidden"], false];
    const exclusive = ["==", ["get", "kind"], "exclusive"];
    const common = ["==", ["get", "kind"], "shared"];
    const districtColor = areaColorExpression(this.colorPlan, "#00C084");
    this.layers = [
      { id: ids.schoolSectionsFill, type: "fill", filter: exclusive, paint: {
        "fill-color": ["case", active, "#2858f5", districtColor],
        "fill-opacity": ["case", active, 0.68, 0.38]
      } },
      { id: ids.sharedSchoolSectionsFill, type: "fill", filter: common, paint: {
        "fill-color": ["case", active, "#2858f5", "#16a6b6"], "fill-opacity": ["case", active, 0.68, 0.25]
      } },
      { id: ids.schoolSectionsLine, type: "line", filter: exclusive,
        layout: { "line-cap": "round", "line-join": "round" }, paint: {
          "line-color": ["case", active, "#2858f5", districtColor],
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, ["case", active, 2.2, 0.55], 15, ["case", active, 3.8, 1.15]],
        "line-opacity": ["case", outlineHidden, 0, active, 1, 0.8]
        } },
      { id: ids.sharedSchoolSectionsLine, type: "line", filter: common, paint: {
        "line-color": ["case", active, "#2858f5", "#087a8b"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, ["case", active, 2.2, 0.65], 15, ["case", active, 3.8, 1.1]],
        // Shared buildings remain selectable, without a maze of internal outlines.
        "line-opacity": ["case", outlineHidden, 0, ["==", ["get", "shared_kind"], "building_surface"], 0, active, 1, 0.55]
      } }
    ];
    for (const layer of this.layers) map.addLayer({ ...layer, source: this.sourceId, "source-layer": this.sourceLayer });
  }

  updateVisibility(district = "", visible = true) {
    if (this.district !== district) {
      this.district = district;
      this.updateFilters();
    }
    if (this.visible !== visible) {
      for (const layer of this.layers) this.map.setLayoutProperty(layer.id, "visibility", visible ? "visible" : "none");
      this.visible = visible;
    }
    if (this.outlinePayload) this.map.setLayoutProperty('schoolAreaSelectionOutlineLine','visibility',visible && (!district || this.outlineDistrict === district) ? 'visible' : 'none');
  }

  updateFilters() {
    const districtIds = this.district ? this.byDistrict.get(this.district) || new Set() : null;
    const allowed = this.focused ? [...this.active].filter(id => !districtIds || districtIds.has(id))
      : districtIds ? [...districtIds] : null;
    const key = allowed === null ? null : JSON.stringify(allowed.sort());
    if (this.filterKey === key) return;
    this.filterKey = key;
    for (const layer of this.layers) this.map.setFilter(layer.id, allowed === null ? layer.filter
      : allowed.length ? ["all", layer.filter, ["in", ["get", "fid"], ["literal", allowed]]]
      : ["==", ["get", "fid"], ""]);
  }

  installSelectionOutlines(payload) {
    if (!payload) return;
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (payload.schema !== 1 || !object(payload.by_school) || !object(payload.by_area)
        || Object.keys(payload.by_school).length > 32 || Object.keys(payload.by_area).length > 32) throw new Error('Некорректные контуры выделения');
    let vertices = 0;
    for (const [kind,entries] of [['school',payload.by_school],['area',payload.by_area]]) for (const [key,feature] of Object.entries(entries)) {
      if (kind === 'school' ? !this.bySchool.has(key) : !this.byFID.has(key)) throw new Error('Контур выделения другой версии карты');
      if (feature?.type !== 'Feature' || feature.geometry?.type !== 'MultiLineString' || !Array.isArray(feature.geometry.coordinates)) throw new Error('Некорректная линия выделения');
      for (const line of feature.geometry.coordinates) {
        if (!Array.isArray(line) || line.length < 2) throw new Error('Пустая линия выделения');
        for (const point of line) if (++vertices > 50000 || !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)
            || point[0] < -180 || point[0] > 180 || point[1] < -85.052 || point[1] > 85.052) throw new Error('Некорректная точка контура');
      }
    }
    this.outlinePayload = payload; this.outlineKey = ''; this.outlineDistrict = '';
    this.map.addSource('schoolAreaSelectionOutline',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    this.map.addLayer({id:'schoolAreaSelectionOutlineLine',type:'line',source:'schoolAreaSelectionOutline',
      layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#2858f5','line-width':['interpolate',['linear'],['zoom'],9,2.2,15,3.8]}});
  }

  selectedFeatures(schoolKeys, district = "") {
    const selected = new Map(), allowed = district ? this.byDistrict.get(district) : null;
    for (const key of schoolKeys) for (const feature of this.bySchool.get(key) || empty) {
      if (!district || allowed?.has(feature.fid)) selected.set(feature.fid, feature);
    }
    return [...selected.values()];
  }

  select(schoolKeys, { focusOnly = false, areaKey = "", highlight = true } = {}) {
    if (areaKey && !this.byFID.has(areaKey)) return false;
    const school = schoolKeys.size === 1 ? [...schoolKeys][0] : '';
    const outline = highlight && this.outlinePayload && (areaKey ? this.outlinePayload.by_area[areaKey] : focusOnly && school ? this.outlinePayload.by_school[school] : null);
    const outlineKey = outline ? areaKey || school : '';
    const outlineChanged = outlineKey !== (this.outlineKey || '');
    if (outlineChanged && this.outlinePayload) {
      this.outlineKey = outlineKey;
      this.outlineDistrict = areaKey ? this.byFID.get(areaKey)?.properties.district : school.split('::')[0];
      this.map.getSource('schoolAreaSelectionOutline').setData({type:'FeatureCollection',features:outline ? [outline] : []});
      this.map.setLayoutProperty('schoolAreaSelectionOutlineLine','visibility',this.visible !== false && (!this.district || this.outlineDistrict === this.district) ? 'visible' : 'none');
    }
    const next = areaKey ? new Set(this.byFID.has(areaKey) ? [areaKey] : [])
      : new Set(this.selectedFeatures(schoolKeys).map(feature => feature.fid));
    const changed = new Set([...this.active, ...next].filter(id => outlineChanged || highlight !== this.highlightAreas || this.active.has(id) !== next.has(id)));
    for (const id of changed) this.map.setFeatureState(
      { source: this.sourceId, sourceLayer: this.sourceLayer, id },
      { highlighted: highlight && next.has(id), ...(this.outlinePayload ? {outline_hidden:Boolean(outline && next.has(id))} : {}) }
    );
    const filtersChanged = focusOnly !== this.focused || (focusOnly && changed.size > 0);
    this.active = next;
    this.focused = focusOnly;
    this.highlightAreas = highlight;
    if (filtersChanged) this.updateFilters();
  }

  exclusiveForSchool(key) { return (this.bySchool.get(key) || empty).find(feature => !shared(feature)) || null; }
  selectComponent(feature, key = '') {
    if (this.componentKey === key) return;
    const map=this.map, id='selectedAreaComponent';
    if (!map.getSource(id)) {
      map.addSource(id,{type:'geojson',data:{type:'FeatureCollection',features:[]}});
      const before=map.getLayer(this.layerIds.addresses) ? this.layerIds.addresses : undefined;
      map.addLayer({id:id+'Fill',type:'fill',source:id,paint:{'fill-color':'#2858f5','fill-opacity':0.45}},before);
      map.addLayer({id:id+'Line',type:'line',source:id,paint:{'line-color':'#2858f5','line-width':3}},before);
    }
    this.componentKey=key;
    map.getSource(id).setData({type:'FeatureCollection',features:feature ? [feature] : []});
  }
  sharedForSchool(key) { return (this.bySchool.get(key) || empty).filter(shared); }
  propertiesForFeature(feature) { return this.byFID.get(feature?.properties?.fid)?.properties || feature?.properties || {}; }
}

// Work only on currently rendered tile fragments, never the city geometry.
// An even/odd scanline across all rings puts the badge inside the visible
// polygon and outside holes; a bbox centre does not provide that guarantee.
export function sharedAreaBadgeCandidates(features, properties, project, width, height, limit = 48, avoid = []) {
  const candidates = new Map();
  for (const feature of features) {
    const p = properties(feature);
    if (!p.shared_area_key || p.shared_kind !== "assignment_zone") continue;
    const members = [...new Set(String(p.shared_member_school_keys || "").split("|").map(x => x.trim()).filter(Boolean))];
    if (members.length < 2) continue;
    const polygons = feature.geometry?.type === "Polygon" ? [feature.geometry.coordinates]
      : feature.geometry?.type === "MultiPolygon" ? feature.geometry.coordinates : [];
    for (const polygon of polygons) {
      const rings = polygon.map(ring => ring.map(project));
      let low = height, high = 0;
      for (const point of rings[0] || []) { low = Math.min(low, point.y); high = Math.max(high, point.y); }
      low = Math.max(24, low); high = Math.min(height - 24, high);
      if (high - low < 44) continue;
      for (const fraction of [0.5, 0.25, 0.75, 0.125, 0.875]) {
        const y = low + (high - low) * fraction, crosses = [];
        for (const ring of rings) for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1], b = ring[i];
          if ((a.y > y) !== (b.y > y)) crosses.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
        }
        crosses.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crosses.length; i += 2) {
          const left = Math.max(8, crosses[i]), right = Math.min(width - 8, crosses[i + 1]);
          const span = right - left;
          if (span < 104) continue;
          const candidate = { key: p.shared_area_key, properties: p, members, x: (left + right) / 2, y,
            score: Math.min(span, high - low) - Math.abs(fraction - 0.5) * 15 };
          if (avoid.some(point => Math.abs(point.x - candidate.x) < 78 && Math.abs(point.y - candidate.y) < 35)) continue;
          if (!candidates.has(candidate.key) || candidates.get(candidate.key).score < candidate.score) candidates.set(candidate.key, candidate);
        }
      }
    }
  }
  const placed = [];
  for (const candidate of [...candidates.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))) {
    if (placed.some(other => Math.abs(other.x - candidate.x) < 112 && Math.abs(other.y - candidate.y) < 44)) continue;
    placed.push(candidate);
    if (placed.length >= limit) break;
  }
  return placed;
}
