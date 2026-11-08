const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

(async () => {
  const module = await import("../app/static/school-area-tiles.mjs");
  const sources = new Map(), layers = new Map(), listeners = [], states = [];
  const map = {
    addSource(id, source) { assert(!sources.has(id)); sources.set(id, { ...source, setData(data) { this.data = data; } }); },
    getSource(id) { return sources.get(id); },
    addLayer(layer) { assert(!layers.has(layer.id)); layers.set(layer.id, layer); },
    getLayer(id) { return layers.get(id); },
    setLayoutProperty(id) { assert(layers.has(id)); },
    setFilter(id) { assert(layers.has(id)); },
    setFeatureState(target, state) { states.push({ target, state }); },
    setPaintProperty(id) { assert(layers.has(id)); },
    queryRenderedFeatures() { return []; },
    moveLayer(id, before) { assert(layers.has(id) && layers.has(before)); },
    on(type, layer, handler) {
      if (typeof layer === "string") assert(layers.has(layer), `listener on absent layer ${layer}`);
      listeners.push({ type, layer, handler });
    }
  };
  const metadata = { schema: 1, features: [
    { fid: "А::1", bbox: [30, 59, 31, 60], properties: { school_key: "А::1", district: "А", area_m2: 1234 } },
    { fid: "shared", bbox: [30.5, 59.5, 31, 60], properties: { district: "А", shared_area_key: "shared", shared_kind: "assignment_zone", shared_member_school_keys: "А::1 | Б::2" } }
  ] };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", checked: true, getAttribute: () => null, setAttribute() {}, focus() {} });
    return elements.get(id);
  };
  const context = { console, URL, TextDecoder, AbortController, setTimeout, clearTimeout,
    window: { schoolAreaTileModule: module, requestAnimationFrame: callback => callback(), setTimeout, clearTimeout },
    document: { documentElement: { dataset: {} }, getElementById: element },
    fetch: () => { throw Error("Tile viewer must not fetch a city GeoJSON/CSV"); },
    __map: map, __metadata: metadata };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../app/static/app.js"), "utf8").split("\ninit().catch")[0], context);
  const run = source => vm.runInContext(source, context);
  run(`SchoolCapsules = class { constructor() {} update() {} };
    registerSchoolIcons = () => {};
    DISTRICT_SLUGS = {А:'a',Б:'b'}; state.map = __map;
    SCHOOL_AREA_TILE_PACKAGE = { source: {type:'vector',tiles:['school-mvt://'+'a'.repeat(64)+'/{z}/{x}/{y}.pbf'],minzoom:8,maxzoom:14,promoteId:'fid'}, metadata:__metadata, unregister:()=>{} };
    setupMapLayers(); setupInteractions(); renderSchoolSections();`);
  assert(sources.has("schoolAreaTiles"));
  for (const id of ["schoolSections", "sharedSchoolSections", "schoolSectionLabels"]) assert(!sources.has(id), `unwanted source ${id}`);
  for (const id of ["school-sections-hitbox", "shared-school-sections-hitbox", "school-sections-labels", "school-sections-labels-active"]) assert(!layers.has(id), `unwanted layer ${id}`);
  assert.equal(layers.get("school-sections-fill").source, "schoolAreaTiles");
  await run("loadSchoolSections()");
  assert.equal(run("state.schoolSections.features.length + state.sharedSchoolSections.features.length"), 0);
  run("state.selectedSchoolKey='А::1';syncSchoolAreaFeatureStates()");
  assert.deepEqual(states.map(item => item.target.id).sort(), ["shared", "А::1"].sort());
  assert.equal(run("schoolAreaFeature({district:'А',school_number:'1'}).properties.area_m2"), 1234);
  assert.equal(run("sharedSectionMemberKeys({properties:{fid:'shared'}}).length"), 2);
  assert.equal(run("mapFeatureProperties({properties:{fid:'А::1'}}).school_key"), "А::1");
  assert.equal(run("selectedSectionFeatures().length"), 2);
  const click = listeners.find(listener => listener.type === "click" && typeof listener.layer === "function").layer;
  run(`const realSelectSchoolFromMap = selectSchoolFromMap;
    selectSchoolFromMap = key => { state.selectedSchoolKey = key; };
    applySearchModeUI = () => {}; refreshFilterOptions = () => {}; render = () => {}; announce = () => {};`);
  map.queryRenderedFeatures = () => [{ layer: { id: "school-sections-fill" }, properties: { school_key: "Б::3" } }];
  click({ point: { x: 0, y: 0 } });
  assert.equal(run("state.selectedSchoolKey"), "Б::3", "clicking another school switches immediately");
  element("districtFilter").value = "А";
  element("addressSearch").value = "Школа №3";
  map.queryRenderedFeatures = () => [];
  click({ point: { x: 0, y: 0 } });
  assert.equal(run("state.selectedSchoolKey"), "", "clicking empty map clears selection");
  assert.equal(element("districtFilter").value, "А", "clearing selection keeps the district filter");
  assert.equal(element("addressSearch").value, "");
  run(`state.schoolByKey.set('А::1',{district:'А',school_number:'1'});
    state.schoolByKey.set('Б::2',{district:'Б',school_number:'2'});
    let reveals=0;window.schoolCompactShell={revealSelection(){reveals++}};
    renderSelectionHighlights=()=>{};updateStats=()=>{};
    renderSchools=()=>{};renderGardenTerritories=()=>{};
    state.selectedAddressId='old-home';state.returnAddressId='old-home';
    const obsoleteToken=state.selectionRequestToken;`);
  map.queryRenderedFeatures = () => [{layer:{id:'shared-school-sections-fill'},properties:{fid:'shared'}}];
  click({point:{x:0,y:0}});
  assert.equal(run('state.selectedAddressId+state.selectedSchoolKey+state.returnAddressId'),'');
  assert.equal(run("state.schoolSearchResults.map(schoolKey).join('|')"),'А::1|Б::2');
  assert.match(element('selectionCard').innerHTML,/Общая территория/);
  assert.match(element('selectionCard').innerHTML,/data-school-key="Б::2"/);
  assert.match(element('selectionCard').innerHTML,/2 школы/);
  assert.equal(run("[...state.schoolAreaTiles.active].sort().join('|')"),'shared|А::1','shared selection shows the regions of its member schools');
  assert.equal(run('reveals'),1,'clicking a shared area reveals the result even from the collapsed map');
  assert.equal(run('state.selectionRequestToken > obsoleteToken'),true,'old async selection cannot restore the previous home');
  run("state.hoverSchoolKey='Б::3';state.hoverSharedSchoolKeys=new Set(['Б::3'])");
  assert.equal(run("[...activeSchoolKeysForSelection()].join('|')"),'А::1|Б::2','moving the pointer cannot change a selected shared area');
  run("comparisonSchoolKey='Б::2';syncSchoolAreaFeatureStates()");
  assert.equal(run("[...state.schoolAreaTiles.active].join('|')"),'shared','choosing a comparison school hides the other school’s exclusive regions');
  run("comparisonSchoolKey='';syncSchoolAreaFeatureStates()");
  assert.equal(run('state.schoolAreaTiles.active.size'),2);
  map.queryRenderedFeatures = () => [];
  click({point:{x:0,y:0}});
  assert.equal(run('selectedSharedArea()'),null,'empty-map click clears the shared selection');
  assert.equal(run('activeSchoolKeysForSelection().size'),0);
  run("showSubmittedSearchState('school',[])");
  assert(!element('selectionCard').innerHTML.includes('Общая территория'),'ordinary search must not inherit the shared-area caption');
  run(`selectAreaFromMap({properties:{fid:'shared'}});
    state.assignmentLevelByDistrict.set('А','full');state.assignmentLevelByDistrict.set('Б','full');`);
  await run(`selectSchoolByKey('А::1',false)`);
  assert.equal(run('selectedSharedArea()'),null,'a school is a different selection from its shared region');
  assert.equal(run('currentSharedAreaContext()'),null,'full-school selection leaves the area comparison');
  assert.equal(run('state.selectedSchoolKey'),'А::1');
  await run(`selectSchoolByKey('Б::2',false)`);
  assert.equal(run('currentSharedAreaContext()'),null,'switching schools keeps full-school scope');
  assert.equal(run('state.selectedSchoolKey'),'Б::2');
  run(`selectAreaFromMap({properties:{fid:'shared'}})`);
  assert.equal(run('selectedSharedArea().key'),'shared','return to the whole shared region');
  run('clearMapSelection()');
  assert.equal(run('currentSharedAreaContext()'),null,'clear selection removes the comparison context');
  run(`VIEWER_BOOTSTRAP={area_scope_index:{}};
    loadSharedComparison=async()=>{};
    selectSchoolFromMap=realSelectSchoolFromMap;
    focusSchool=school=>{state.testFocusedSchool=schoolKey(school)};
    state.schoolByKey.set('А::1',{district:'А',school_number:'1'});`);
  map.queryRenderedFeatures = () => [{layer:{id:'school-sections-fill'},properties:{fid:'А::1'}}];
  click({point:{x:0,y:0},lngLat:{lng:30.3,lat:59.8}});
  assert.equal(run('selectedSharedArea()'),null,'a single-school polygon does not open the area comparison');
  assert.equal(run('state.selectedSchoolKey'),'А::1','a single-school polygon opens its school');
  assert.equal(run('state.testFocusedSchool'),'А::1','a single-school polygon frames the school coverage');
  run('syncSchoolAreaFeatureStates()');
  assert.equal(run("[...state.schoolAreaTiles.active].sort().join('|')"),'shared|А::1','the school view shows its exclusive and shared regions');
  map.queryRenderedFeatures = () => [];
  click({point:{x:0,y:0}});
  assert.equal(run('selectedSharedArea()'),null);
  run('VIEWER_BOOTSTRAP=null');
  // Hover is a single frame-coalesced preview, never a new selected-school view.
  const frames = [], canvas = {style:{}};
  context.window.requestAnimationFrame = callback => frames.push(callback);
  map.getCanvas = () => canvas;
  const move = listeners.find(item => item.type === 'mousemove' && typeof item.layer === 'function').layer;
  const out = listeners.find(item => item.type === 'mouseout' && typeof item.layer === 'function').layer;
  const remove = () => listeners.filter(item => item.type === 'remove' && typeof item.layer === 'function').forEach(item => item.layer());
  assert(!listeners.some(item => item.type === 'mousemove' && typeof item.layer === 'string'), 'overlapping layers must not have competing hover handlers');
  run(`setSourceData=()=>{throw Error('hover must not replace GeoJSON')};
    renderSelectionHighlights=()=>{throw Error('hover must not rebuild selection overlays')};
    state.schoolBadges.update=()=>{throw Error('hover must not rebuild or dim badges')};`);
  let queries = 0;
  let hovered = [
    {layer:{id:'school-sections-line'},properties:{fid:'А::1'}},
    {layer:{id:'school-sections-fill'},properties:{fid:'А::1'}}
  ];
  map.queryRenderedFeatures = () => { queries++; return hovered; };
  states.length = 0;
  for (let i=0; i<50; i++) move({point:{x:i,y:10}});
  assert.equal(frames.length,1,'50 pointer events must schedule one update');
  assert.equal(queries,0);
  frames.shift()();
  assert.equal(queries,1);
  assert.equal(run('state.hoverSchoolKey'),'А::1');
  assert.equal(run('activeSchoolKeysForSelection(false).size'),0,'hover must not activate badge dimming');
  assert(states.every(item => !item.state.dimmed),'preview must not dim the map');
  const firstHoverWrites = states.length;
  move({point:{x:50,y:10}}); frames.shift()();
  assert.equal(states.length,firstHoverWrites,'moving inside the same area does not restyle it');
  hovered.push({layer:{id:'shared-school-sections-fill'},properties:{fid:'shared'}});
  move({point:{x:51,y:10}}); frames.shift()();
  assert.equal(run('state.hoverSchoolKey'),'');
  assert.equal(run('state.hoverSharedSchoolKeys.size'),2,'shared area takes the same priority as clicking');
  const sharedWrites = states.length;
  out({}); move({point:{x:52,y:10}}); frames.shift()();
  assert.equal(states.length,sharedWrites,'leave/enter in one frame must not flash an empty state');
  out({}); frames.shift()();
  assert.equal(run('activeSchoolKeysForSelection().size'),0);
  run("state.selectedSchoolKey='А::1';syncSchoolAreaFeatureStates()");
  const selectedWrites = states.length;
  move({point:{x:53,y:10}}); frames.shift()();
  assert.equal(states.length,selectedWrites,'hover must not repaint an existing selection');
  move({point:{x:54,y:10}});
  const queriesBeforeRemove = queries;
  remove(); frames.shift()();
  assert.equal(queries,queriesBeforeRemove,'queued hover must stop after map removal');
  console.log('Hover passed: 50 moves -> 1 hit test; same-area/selected-area moves -> 0 state writes; no source or badge updates.');
  console.log("Tile viewer bridge passed: no city geometry fetch or hidden area atlas; stable FID selection, shared hover, metadata cards and layer listeners.");
})().catch(error => { console.error(error); process.exitCode = 1; });
