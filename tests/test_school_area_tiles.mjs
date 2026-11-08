import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { SchoolAreaTiles, validateAreaMetadata, loadAreaScopes, loadAreaTilePackage, registerAreaTileProtocol, sharedAreaBadgeCandidates } from "../app/static/school-area-tiles.mjs";

const ids = Object.fromEntries(["schoolSectionsFill", "sharedSchoolSectionsFill", "schoolSectionsLine", "sharedSchoolSectionsLine"].map(id => [id, id]));
const source = { type: "vector", tiles: ["https://example.test/tiles/{z}/{x}/{y}.pbf"], minzoom: 6, maxzoom: 14, promoteId: "fid" };
const own = (key, district) => ({ fid: key, bbox: [30, 59, 31, 60], properties: { school_key: key, district } });
const metadata = { schema: 1, features: [own("А::1", "А"), own("Б::3", "Б"), {
  fid: "shared:1+2", bbox: [30, 59, 31, 60], properties: { district: "А", shared_area_key: "shared:1+2", shared_kind: "assignment_zone", shared_member_school_keys: "А::1 | Б::2" }
}] };

test('parallel area scopes remain bound to their own manifest revision', async () => {
  const bytesFor = value => Buffer.from(JSON.stringify(value));
  const record = (path, bytes) => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const mapSha = 'a'.repeat(64), registerSha = 'b'.repeat(64), files = new Map();
  function version(label) {
    const districtBytes = bytesFor({schema:1, district:'А', areas:{}, addresses:{}, gardens:{}, label});
    const district = record(`scopes/${label}.json`, districtBytes);
    const manifestBytes = bytesFor({schema:1, map_sha256:mapSha, register_sha256:registerSha, districts:{'А':district}});
    const manifest = record(`scopes/manifest-${label}.json`, manifestBytes);
    files.set(district.path, districtBytes); files.set(manifest.path, manifestBytes);
    return {area_scope_index:{manifest}, map_display:{manifest:{sha256:mapSha}}, register_data:{manifest:{sha256:registerSha}}};
  }
  const old = version('old'), next = version('new'), calls = [];
  let releaseOld, announceOld;
  const oldStarted = new Promise(resolve => { announceOld = resolve; });
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const fetcher = async url => {
    const path = new URL(url).pathname.replace(/^\/project\//, ''); calls.push(path);
    if (path === 'scopes/old.json') { announceOld(); await oldGate; }
    return new Response(files.get(path));
  };
  const options = {fetch:fetcher, root:new URL('https://example.test/project/')};
  const first = loadAreaScopes(old, 'А', options);
  await oldStarted;
  assert.equal((await loadAreaScopes(next, 'А', options)).label, 'new');
  releaseOld();
  assert.equal((await first).label, 'old');
  assert.equal((await loadAreaScopes(next, 'А', options)).label, 'new');
  assert.equal(calls.filter(path => path === 'scopes/new.json').length, 1);
  await assert.rejects(loadAreaScopes({...next,map_display:{manifest:{sha256:'c'.repeat(64)}}}, 'А', options), /различаются/);
});

test('an unknown area key cannot clear or replace the current map selection', () => {
  const h = harness();
  h.runtime.select(new Set(['А::1']), {focusOnly:true});
  const before = [...h.runtime.active], filterCount = h.filters.size, stateCount = h.states.length;
  assert.equal(h.runtime.select(new Set(['А::1']), {focusOnly:true, areaKey:'missing'}), false);
  assert.deepEqual([...h.runtime.active], before);
  assert.equal(h.filters.size, filterCount);
  assert.equal(h.states.length, stateCount);
});
function harness(input = metadata) {
  const sources = new Map(), layers = new Map(), states = [], filters = new Map(), visibility = new Map(), paints = [];
  const map = { addSource: (id, options) => sources.set(id, options), addLayer: layer => layers.set(layer.id, layer),
    getSource: id => ({setData:data=>{sources.get(id).data=data;}}),
    setFeatureState: (target, value) => states.push({ target, value }), setFilter: (id, filter) => filters.set(id, filter),
    setLayoutProperty: (id, property, value) => visibility.set(id, value),
    setPaintProperty: (id, property, value) => paints.push({ id, property, value }) };
  const runtime = new SchoolAreaTiles(map, source, structuredClone(input), ids);
  runtime.install();
  return { runtime, sources, layers, states, filters, visibility, paints };
}

test('reviewed school outlines replace internal selected seams and do not rewrite fill geometry or repeat data on the same selection',()=>{
  const h=harness();
  const line={type:'Feature',properties:{},geometry:{type:'MultiLineString',coordinates:[[[30,59],[31,60]]]}};
  h.runtime.installSelectionOutlines({schema:1,by_school:{'А::1':line},by_area:{'shared:1+2':line}});
  h.runtime.select(new Set(['А::1']),{focusOnly:true});
  assert.deepEqual(h.sources.get('schoolAreaSelectionOutline').data.features,[line]);
  assert(h.states.filter(item=>item.value.highlighted).every(item=>item.value.outline_hidden));
  const same=h.sources.get('schoolAreaSelectionOutline').data;
  h.runtime.select(new Set(['А::1']),{focusOnly:true});
  assert.equal(h.sources.get('schoolAreaSelectionOutline').data,same);
  h.runtime.select(new Set(['Б::3']),{focusOnly:true});
  assert.deepEqual(h.sources.get('schoolAreaSelectionOutline').data.features,[]);
  assert(h.states.filter(item=>item.target.id==='А::1').at(-1).value.outline_hidden===false);
  assert.throws(()=>harness().runtime.installSelectionOutlines({schema:1,by_school:{'unknown':line},by_area:{}}),/версии/);
});

test('choosing a shared region selects only that region; choosing a school selects all its actual regions', () => {
  const data = structuredClone(metadata);
  data.features.push({ ...structuredClone(data.features[2]), fid: 'shared:1+3', properties: {
    ...data.features[2].properties, shared_area_key: 'shared:1+3', shared_member_school_keys: 'А::1 | Б::3'
  } });
  const h = harness(data);
  h.runtime.select(new Set(['А::1', 'Б::2']), { focusOnly: true, areaKey: 'shared:1+2' });
  assert.deepEqual([...h.runtime.active], ['shared:1+2']);
  for (const filter of h.filters.values()) assert.deepEqual(filter[2][2][1], ['shared:1+2']);
  const writes = h.states.length;
  h.runtime.select(new Set(['А::1', 'Б::2']), { focusOnly: true, areaKey: 'shared:1+2' });
  assert.equal(h.states.length, writes, 'same shared region must not flash or restyle');
  h.runtime.select(new Set(['А::1']), { focusOnly: true });
  assert.deepEqual([...h.runtime.active].sort(), ['А::1', 'shared:1+2', 'shared:1+3'].sort());
  assert.deepEqual(h.layers.get(ids.schoolSectionsFill).paint['fill-color'].slice(0, 3),
    h.layers.get(ids.sharedSchoolSectionsFill).paint['fill-color'].slice(0, 3), 'selected areas use one colour');
  assert(!Object.hasOwn(h.layers.get(ids.sharedSchoolSectionsLine).paint, 'line-dasharray'));
});

test('shared counters stay inside visible land, outside holes, and deduplicate tile fragments', () => {
  const props = { shared_area_key: 'courtyard', shared_kind: 'assignment_zone', shared_member_school_keys: 'А::1 | Б::2 | А::1' };
  const ring = (x, y, width, height) => [[x,y],[x+width,y],[x+width,y+height],[x,y+height],[x,y]];
  const feature = { properties: props, geometry: { type: 'Polygon', coordinates: [ring(0,0,400,400), ring(80,80,240,240)] } };
  const project = ([x,y]) => ({x,y});
  const candidates = sharedAreaBadgeCandidates([feature, feature], f => f.properties, project, 400, 400);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].members.length, 2, 'count unique schools, not source duplicates');
  const {x,y} = candidates[0];
  assert(x > 0 && x < 400 && y > 0 && y < 400);
  assert(!(x > 80 && x < 320 && y > 80 && y < 320), 'badge cannot appear in an unassigned courtyard');
  const narrow = { ...feature, geometry: {type:'Polygon', coordinates:[ring(0,0,40,200)]} };
  assert.equal(sharedAreaBadgeCandidates([narrow], f => f.properties, project, 400, 400).length, 0);
  const building = { ...feature, properties: {...props, shared_kind:'building_surface'} };
  assert.equal(sharedAreaBadgeCandidates([building], f => f.properties, project, 400, 400).length, 0);
  const other = { ...feature, properties: {...props, shared_area_key:'other'} };
  assert.equal(sharedAreaBadgeCandidates([feature, other], f => f.properties, project, 400, 400).length, 1, 'counter labels cannot overlap');
  const moved = sharedAreaBadgeCandidates([feature], f => f.properties, project, 400, 400, 48, [{x,y}]);
  assert.equal(moved.length, 1, 'a nearby school badge moves the counter rather than hiding the area');
  assert(Math.abs(moved[0].x-x) >= 78 || Math.abs(moved[0].y-y) >= 35);
});

test("school selection changes only its own and actual shared FIDs; repeated selection is a no-op", () => {
  const h = harness();
  h.runtime.select(new Set(["А::1"]));
  assert.deepEqual(h.states.map(x => x.target.id).sort(), ["shared:1+2", "А::1"].sort());
  assert(h.states.every(x => x.target.source === "schoolAreaTiles" && x.target.sourceLayer === "areas" && x.value.highlighted));
  h.runtime.select(new Set(["А::1"]));
  assert.equal(h.states.length, 2);
  h.runtime.select(new Set(["Б::3"]));
  assert.equal(h.states.length, 5);
  assert(h.states.slice(2, 4).every(x => x.value.highlighted === false));
  assert.equal(h.states[4].target.id, "Б::3");
  h.runtime.select(new Set());
  assert.equal(h.states.at(-1).value.highlighted, false);
});

test("selection filters unrelated areas and strengthens the outline; clearing restores all layers", () => {
  const h = harness();
  h.runtime.select(new Set(["А::1"]));
  assert.equal(h.paints.length, 0, "hover alone must not dim the whole map");
  const original = structuredClone([...h.layers.values()]);
  h.runtime.select(new Set(["А::1"]), { focusOnly: true });
  assert.equal(h.paints.length, 0, 'selection must never change expression kinds while tiles decode');
  const fill = h.layers.get(ids.schoolSectionsFill).paint['fill-opacity'];
  assert.equal(fill[2], 0.68, "selected fill stays visible");
  for (const filter of h.filters.values()) assert.deepEqual(filter[2][2][1], ['shared:1+2', 'А::1'].sort());
  const line = h.layers.get(ids.schoolSectionsLine).paint['line-width'];
  assert(line[4][2] > line[4][3] && line[6][2] > line[6][3], "selection has a stronger outline at both zoom levels");
  const beforeSwitch = h.states.length;
  h.runtime.select(new Set(["Б::3"]), { focusOnly: true });
  assert.equal(h.states.length - beforeSwitch, 3, "switching schools updates only changed membership");
  h.runtime.select(new Set());
  assert.equal(h.states.at(-1).value.highlighted, false);
  for (const layer of original) assert.deepEqual(h.filters.get(layer.id), layer.filter);
  const afterClear = h.states.length;
  h.runtime.select(new Set(["нет такой школы"]), { focusOnly: true });
  assert.equal(h.states.length, afterClear);
  for (const filter of h.filters.values()) assert.deepEqual(filter, ["==", ["get", "fid"], ""]);
  assert.deepEqual([...h.layers.values()], original);
  assert.equal(h.paints.length, 0);
});

test("a home, garden or component overlay can hide all tile geometry", () => {
  const h = harness();
  h.runtime.select(new Set(), {focusOnly:true});
  assert.equal(h.runtime.active.size, 0);
  assert.equal(h.runtime.focused, true);
  assert.equal(h.states.length, 0);
  for (const filter of h.filters.values()) assert.deepEqual(filter, ["==", ["get", "fid"], ""]);
  h.runtime.select(new Set());
  assert.equal(h.runtime.focused, false);
  for (const layer of h.layers.values()) assert.deepEqual(h.filters.get(layer.id), layer.filter);
});

test("shared-only school and district across a shared boundary preserve membership", () => {
  const h = harness();
  assert.equal(h.runtime.exclusiveForSchool("Б::2"), null);
  assert.deepEqual(h.runtime.sharedForSchool("Б::2").map(f => f.fid), ["shared:1+2"]);
  h.runtime.updateVisibility("Б", true);
  assert.deepEqual(h.runtime.selectedFeatures(new Set(["А::1"]), "Б").map(f => f.fid), ["shared:1+2"]);
  for (const filter of h.filters.values()) assert.deepEqual(new Set(filter[2][2][1]), new Set(["Б::3", "shared:1+2"]));
  h.runtime.updateVisibility("Б", false);
  assert([...h.visibility.values()].every(value => value === "none"));
  assert.equal(h.sources.size, 1, "filtering must not replace or append sources");
});

test("display receives no complete GeoJSON and creates only four visible polygon layers", () => {
  const h = harness();
  assert.equal(h.sources.size, 1);
  assert.equal(h.layers.size, 4);
  assert.deepEqual([...h.sources.values()].map(s => s.type), ["vector"]);
  assert(!Object.hasOwn([...h.sources.values()][0], "data"));
  assert([...h.layers.values()].every(layer => ["fill", "line"].includes(layer.type)));
  assert(h.runtime.features.every(feature => feature.geometry == null));
  assert.deepEqual(h.runtime.selectedFeatures(new Set(["нет такой школы"])), []);
});

test("malformed metadata/source fail closed rather than falling back to city GeoJSON", () => {
  for (const mutate of [
    data => data.features.push(data.features[0]),
    data => data.features[0].bbox = [31, 59, 30, 60],
    data => data.features[0].geometry = { type: "Point", coordinates: [30, 59] },
    data => data.features[2].properties.shared_member_school_keys = "",
    data => data.features[2].properties.shared_kind = "unknown_kind"
  ]) {
    const data = structuredClone(metadata); mutate(data);
    assert.throws(() => validateAreaMetadata(data));
  }
  assert.throws(() => new SchoolAreaTiles({}, { ...source, data: { type: "FeatureCollection", features: [] } }, metadata, ids));
});

function fixture() {
  const files = new Map(), calls = [];
  const bytes = (name, value) => {
    const data = typeof value === "string" ? Buffer.from(value) : Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const sha256 = createHash("sha256").update(data).digest("hex");
    files.set(name, data);
    return { path: name, sha256, bytes: data.length };
  };
  const tile = bytes("tile", Buffer.from([26, 0]));
  const emptyTile = bytes("empty", Buffer.from([26, 1, 0]));
  files.set(`tiles/${tile.sha256}.pbf`, files.get("tile"));
  files.set(`tiles/${emptyTile.sha256}.pbf`, files.get("empty"));
  const bounds = [-180, -85, 180, 85];
  const index = bytes("index.json", { schema: 1, domain: { scheme: "xyz", minzoom: 1, maxzoom: 2, bounds, complete: true, missing_key: "empty_within_domain" },
    tiles: { "1/1/0": { ...tile, path: `tiles/${tile.sha256}.pbf` } } });
  const meta = bytes("metadata.json", { schema: 1, features: Object.fromEntries(metadata.features.map(({ fid, ...feature }) => [fid, feature])), school_features: {
    "А::1": { exclusive: ["А::1"], shared: ["shared:1+2"] }, "Б::2": { exclusive: [], shared: ["shared:1+2"] }, "Б::3": { exclusive: ["Б::3"], shared: [] }
  } });
  const manifest = bytes("manifest.json", { schema: 1, kind: "school_area_mvt", source_layer: "areas", promote_id: "fid", minzoom: 1, maxzoom: 2, bounds,
    metadata: meta, tile_index: index, empty_tile: { ...emptyTile, path: `tiles/${emptyTile.sha256}.pbf` }, empty_policy: "complete_sparse_xyz_within_bounds" });
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname.replace("/project/map/", ""); calls.push({ path, options });
    const data = files.get(path);
    return data ? new Response(data) : new Response("missing", { status: 404 });
  };
  return { files, calls, descriptor: { schema: 1, manifest: { ...manifest, path: "map/manifest.json" } }, fetcher, tile, emptyTile };
}

test("SHA-bound package resolves under a GitHub Pages subpath and protocol fetches only requested objects", async () => {
  const f = fixture();
  const bundle = await loadAreaTilePackage(f.descriptor, { root: new URL("https://example.test/project/"), fetch: f.fetcher });
  assert.equal(f.calls.length, 3, "bootstrap must load metadata and index, not polygon tile bodies");
  let protocol;
  registerAreaTileProtocol({ addProtocol: (name, handler) => { assert.equal(name, "school-mvt"); protocol = handler; } }, bundle);
  const prefix = `school-mvt://${f.descriptor.manifest.sha256}/`;
  const result = await protocol({ url: prefix + "1/1/0.pbf" }, new AbortController());
  assert.deepEqual(Buffer.from(result.data), f.files.get("tile"));
  assert.equal(f.calls.at(-1).path, `tiles/${f.tile.sha256}.pbf`);
  assert.equal(f.calls.at(-1).options.cache, "force-cache");
  assert(f.calls.at(-1).options.signal);
  const emptyResult = await protocol({ url: prefix + "1/0/0.pbf" }, new AbortController());
  assert.deepEqual(Buffer.from(emptyResult.data), f.files.get("empty"));
  await assert.rejects(protocol({ url: prefix + "3/0/0.pbf" }), /вне объявленной/);
  await assert.rejects(protocol({ url: prefix + "1/01/0.pbf" }), /Несовместимая/);
  await assert.rejects(protocol({ url: prefix.replace(f.descriptor.manifest.sha256, "f".repeat(64)) + "1/1/0.pbf" }), /Несовместимая/);
});

test("changed metadata or tile bytes are rejected, with no fallback or retained PBF cache", async () => {
  const f = fixture(), options = { root: new URL("https://example.test/project/"), fetch: f.fetcher };
  f.files.set("metadata.json", Buffer.from("{}"));
  await assert.rejects(loadAreaTilePackage(f.descriptor, options), /Размер|изменились/);
  const clean = fixture();
  const bundle = await loadAreaTilePackage(clean.descriptor, { ...options, fetch: clean.fetcher });
  let handler;
  registerAreaTileProtocol({ addProtocol: (name, callback) => handler = callback }, bundle);
  const url = `school-mvt://${bundle.token}/1/1/0.pbf`;
  await handler({ url });
  clean.files.set(`tiles/${clean.tile.sha256}.pbf`, Buffer.from([0, 0]));
  await assert.rejects(handler({ url }), /изменились/);
  assert.equal(clean.calls.filter(call => call.path.endsWith(".pbf")).length, 2);
});

test("canceled tile requests cannot return late bytes after async SHA work", async () => {
  const f = fixture(), controller = new AbortController();
  const fetcher = async (url, options) => {
    const response = await f.fetcher(url, options);
    if (url.includes(".pbf")) controller.abort();
    return response;
  };
  const bundle = await loadAreaTilePackage(f.descriptor, { root: new URL("https://example.test/project/"), fetch: fetcher });
  let handler;
  registerAreaTileProtocol({ addProtocol: (name, callback) => handler = callback }, bundle);
  await assert.rejects(handler({ url: `school-mvt://${bundle.token}/1/1/0.pbf` }, controller), error => error.name === "AbortError");
});

test("oversize tile streams and HTTP error bodies are canceled before an unbounded download", async () => {
  for (const status of [200, 404]) {
    const f = fixture(); let canceled = 0;
    const fetcher = async (url, options) => {
      if (!url.includes('.pbf')) return f.fetcher(url, options);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { canceled++; } }), { status });
    };
    const bundle = await loadAreaTilePackage(f.descriptor, { root: new URL('https://example.test/project/'), fetch: fetcher });
    let handler; registerAreaTileProtocol({ addProtocol: (name, callback) => handler = callback }, bundle);
    await assert.rejects(handler({ url: `school-mvt://${bundle.token}/1/1/0.pbf` }), status === 200 ? /Размер/ : /404/);
    assert.equal(canceled, 1, 'do not wait for the rest of an oversized or failed response');
  }
  const f = fixture(), descriptor = structuredClone(f.descriptor); delete descriptor.manifest.bytes;
  await assert.rejects(loadAreaTilePackage(descriptor, { root: new URL('https://example.test/project/'), fetch: f.fetcher }), /размер/);
  assert.equal(f.calls.length, 0, 'a missing declared byte limit fails before network allocation');
});
