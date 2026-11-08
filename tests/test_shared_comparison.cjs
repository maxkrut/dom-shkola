const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function rig(api = null) {
  const context = {console,URL,TextDecoder,AbortController,setTimeout,clearTimeout,
    window:{schoolViewerApi:api},document:{documentElement:{dataset:{}},getElementById(){return {value:''};}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('app/static/app.js','utf8').split('\ninit().catch')[0],context);
  return {context,run:source=>vm.runInContext(source,context)};
}
const district='Петродворцовый',gym='Петергофская гимназия императора Александра II';
const keys=['413','421',gym].map(number=>district+'::'+number);
const row=(key,house,members,extra={})=>({district,address_key:key,address_id:'id-'+key,school_number:members[0],
  current_school_number:members.join(' | '),is_current:'yes',record_kind:'scan_literal',parsed_street:'Боровая ул.',
  parsed_house:house,canonical_address:`Санкт-Петербург, посёлок Стрельна, Боровая улица, дом ${house}, литера А`,
  source_locality_hint:'стрельна',coordinate_precision:'exact_house',lat:'59.8',lon:'30.0',...extra});

test('geographic matrix includes other schools and keeps the full physical membership',()=>{
  const r=rig();r.context.__keys=keys.slice(0,2);
  r.context.__rows=[row('other','1',['999']),row('partial','2',['413','999'])];
  const model=r.run('buildSharedComparisonModel(__rows,__keys,"geographic",{geographic:true})');
  assert.equal(model.addresses.size,2);
  assert(model.schools.some(school=>school.number==='999'));
  assert(model.addresses.get('partial').members.has(district+'::999'));
});

test('a whole garden with no materialized houses still appears in the school directory',()=>{
  const r=rig();
  r.run(`state.gardenById.set('empty',{properties:{district:'Петродворцовый',territory_id:'empty',name:'СНТ Тест',school_numbers:['413'],source_fragment_ids:['f']}});
    state.selectedSchoolKey='Петродворцовый::413';state.schoolByKey.set(state.selectedSchoolKey,{district:'Петродворцовый',school_number:'413'});
    schoolAssignments=()=>[];schoolCurrentAssignments=()=>[];`);
  const model=r.run('schoolAddressDirectory()');
  assert.equal(model.gardenCount,1);assert.equal(model.houseCount,0);
  assert.match(model.streets[0].name,/СНТ Тест \(все\)/);
});

test('a second click on the same shared object while its index loads never leaves permanent loading',async()=>{
  const pending=[];
  const r=rig();r.context.__keys=keys;
  r.run(`VIEWER_BOOTSTRAP={area_scope_index:{}};renderSelectionCard=()=>{};renderSchoolSections=()=>{};renderSelectionHighlights=()=>{};
    state.searchMode='school';state.sharedAreaSelection={key:'area',schoolKeys:[],token:state.selectionRequestToken};`);
  r.context.__next=()=>new Promise(resolve=>pending.push(resolve));
  r.run(`window.schoolAreaTileModule={loadAreaScopes:()=>__next(),componentContains:()=>true};state.sharedAreaSelection.schoolKeys=__keys;`);
  const first=r.run('loadSharedComparison()');
  r.run('state.sharedAreaSelection={...state.sharedAreaSelection,clickPoint:[30.1,59.8]}');
  const second=r.run('loadSharedComparison()');
  const data={addresses:{},gardens:{},areas:{area:{members:keys,unassigned_keys:[],components:[{id:'part',keys:[],geometry:{type:'Polygon',coordinates:[]}}]}}};
  pending[0](data);pending[1](data);
  await Promise.all([first,second]);
  assert.equal(r.run('sharedComparisonCache.status'),'ready');
  assert.equal(r.run('currentSharedAreaContext().componentId'),'part');
});
test('current matrix keeps real differing memberships, all house suffixes, source localities and unique address identities',()=>{
  const r=rig();r.context.__keys=keys;r.context.__rows=[row('39','39',['413','421',gym]),row('46','46',['413','421']),
    row('unscoped','46',[gym],{source_locality_hint:'',canonical_address:'Санкт-Петербург г. > Боровая ул., д. 46'}),
    row('39','39',['421']),row('old','99',['413'],{is_current:'no'}),row('rule','1',['413'],{record_kind:'scan_rule'})];
  const model=r.run('buildSharedComparisonModel(__rows,__keys)');
  assert.equal(model.addresses.size,3);assert.equal(model.streets.length,2);
  const street=model.streets.find(street=>street.locality==='Стрельна');
  assert.deepEqual(Array.from(street.counts),[2,2,1]);
  assert.equal(street.items.length,2);assert.match(street.items[0].label,/39/);assert.match(street.items[0].label,/А/);
  assert.equal(model.streets.find(street=>street.key.startsWith('|')).locality,'Населённый пункт не указан');
});
test('whole garden stays one matrix row and only differing household memberships appear as exceptions',()=>{
  const r=rig();r.context.__keys=keys;
  r.run(`state.gardenById.set('g',{properties:{district:'Петродворцовый',territory_id:'g',name:'СНТ Ягодка',source_fragment_ids:['f'],school_numbers:['413','421','${gym}']}})`);
  r.context.__rows=[row('g1','1',['413','421',gym],{canonical_address:'СНТ Ягодка, дом 1',source_fragment_id:'f'}),
    row('g2','2',['413','421'],{canonical_address:'СНТ Ягодка, дом 2',source_fragment_id:'f'})];
  const model=r.run('buildSharedComparisonModel(__rows,__keys)');
  assert.equal(model.streets.length,1);assert.equal(model.streets[0].name,'СНТ Ягодка (все)');
  assert.deepEqual(Array.from(model.streets[0].counts),[1,1,1]);assert.equal(model.streets[0].items.length,1);
  assert.equal(model.streets[0].items[0].key,'g2');
});

test('explicit settlement prefixes, suffixes and capitalization reconcile without absorbing a city homonym',()=>{
  const r=rig();r.context.__keys=keys;r.context.__rows=[row('a','1',['413']),
    row('b','2',['413'],{source_locality_hint:'Стрельна'}),
    row('c','3',['413'],{source_locality_hint:'',canonical_address:'Санкт-Петербург, Стрельна п., Арктический пер., дом 3'}),
    row('d','4',['413'],{source_locality_hint:'',canonical_address:'Санкт-Петербург г. > Боровая ул., д. 4'})];
  const model=r.run('buildSharedComparisonModel(__rows,__keys)');
  assert.equal(model.streets.length,2);
  assert.equal(model.streets.find(street=>street.locality==='Стрельна').items.length,3);
  assert.equal(model.streets.find(street=>street.locality==='Населённый пункт не указан').items.length,1);
});
test('compact comparison never promotes a proxy or explicitly ineligible house to a mapped home',()=>{
  const r=rig();r.context.__keys=keys;r.context.__rows=[row('proxy','1',['413'],{coordinate_source:'manual_proxy'}),row('blocked','2',['413'],{home_point_eligible:false})];
  const model=r.run('buildSharedComparisonModel(__rows,__keys)');
  assert(model.streets[0].items.every(item=>!item.located));
});
test('centering a house fits its point without pulling in the complete school territory',()=>{
  const r=rig();r.context.__row=row('39','39',['413','421',gym]);
  r.run(`fitFeatures=(features,options)=>{window.lastFocus={features,options}};focusAddress=()=>{throw Error('Whole school focus is not house centering')};centerHouse(__row)`);
  assert.equal(r.run('window.lastFocus.features.length'),1);
  assert.equal(r.run('window.lastFocus.features[0].geometry.type'),'Point');
  assert.equal(r.run('window.lastFocus.options.maxZoom'),16);
});
test('comparison skips another full package only after exact current member coverage and does not reload when a column changes',async()=>{
  const calls=[];const r=rig({school:async key=>{calls.push(key);return [row('39','39',['413','421',gym]),row('46','46',['413','421'])];}});
  r.context.__keys=keys;
  r.run(`state.searchMode='school';state.sharedAreaSelection={key:'area',schoolKeys:__keys,token:state.selectionRequestToken};
    __keys.forEach((key,i)=>state.schoolByKey.set(key,{district:'Петродворцовый',school_number:key.split('::')[1],current_address_count:i===2?'1':'2'}));renderSelectionCard=()=>{};`);
  await r.run('loadSharedComparison()');
  assert.equal(calls.length,1);assert.equal(r.run('sharedComparisonModel().addresses.size'),2);
  r.run(`state.selectedSchoolKey=__keys[1]`);await r.run('loadSharedComparison()');assert.equal(calls.length,1);
});
test('a late comparison response cannot populate a different selected territory',async()=>{
  let done;const r=rig({school:()=>new Promise(resolve=>{done=resolve;})});r.context.__keys=keys;
  r.run(`state.searchMode='school';state.sharedAreaSelection={key:'area',schoolKeys:__keys,token:state.selectionRequestToken};renderSelectionCard=()=>{};`);
  const work=r.run('loadSharedComparison()');r.run(`state.sharedAreaSelection={key:'other',schoolKeys:__keys,token:state.selectionRequestToken}`);
  done([row('39','39',['413','421',gym])]);await work;assert.equal(r.run('sharedComparisonModel()'),null);
});
test('school card uses the verified district page and never substitutes an unrelated fallback',async()=>{
  const {createOriginalSourceIndex}=await import('../app/static/original-source-links.mjs');
  const page='https://www.gov.spb.ru/district/';
  const raw='raw/district/current.pdf';
  const resolve=createOriginalSourceIndex({schema:1,kind:'external_original_sources',documents:[{
    source_raw_file:raw,sha256:'a'.repeat(64),document_url:'',page_url:page,
    status:'district_page_only',availability:'not_rechecked'}]});
  const r=rig({originalDocument:resolve});
  r.context.__school={district:'Курортный',school_number:'556'};
  r.context.__source={source_raw_file:raw,source_page_url:'https://unrelated.example/'};
  r.run(`state.sourceByDistrict.set('Курортный',{source_url:'https://unrelated.example/'});`);
  const html=r.run('schoolCardActionsHtml(__school,__source,false)');
  assert.match(html,/https:\/\/www\.gov\.spb\.ru\/district\//);
  assert.match(html,/Источник документа/);
  assert.doesNotMatch(html,/unrelated\.example/);
  r.context.__source.source_raw_file='raw/district/unknown.pdf';
  assert.doesNotMatch(r.run('schoolCardActionsHtml(__school,__source,false)'),/Источник документа|unrelated\.example/);
});
test('school card falls back to the verified document when no district page is available',async()=>{
  const {createOriginalSourceIndex}=await import('../app/static/original-source-links.mjs');
  const raw='raw/district/current.pdf', url='https://www.school12.spb.ru/document.pdf';
  const resolve=createOriginalSourceIndex({schema:1,kind:'external_original_sources',documents:[{
    source_raw_file:raw,sha256:'a'.repeat(64),document_url:url,page_url:'',
    status:'document_registered',availability:'not_rechecked'}]});
  const r=rig({originalDocument:resolve});
  r.context.__school={district:'Василеостровский',school_number:'12'};
  r.context.__source={source_raw_file:raw};
  const html=r.run('schoolCardActionsHtml(__school,__source,false)');
  assert.match(html,/https:\/\/www\.school12\.spb\.ru\/document\.pdf/);
  assert.match(html,/Источник документа/);
});
test('school-hosted document source is not labelled as district administration',async()=>{
  const {createOriginalSourceIndex}=await import('../app/static/original-source-links.mjs');
  const raw='raw/district/current.pdf';
  const resolve=createOriginalSourceIndex({schema:1,kind:'external_original_sources',documents:[{
    source_raw_file:raw,sha256:'a'.repeat(64),document_url:'',page_url:'https://school321.ru/parents1/1klass',
    status:'district_page_only',availability:'not_rechecked'}]});
  const r=rig({originalDocument:resolve});
  r.context.__school={district:'Центральный',school_number:'239'};
  r.context.__source={source_raw_file:raw};
  const html=r.run('schoolCardActionsHtml(__school,__source,false)');
  assert.match(html,/https:\/\/school321\.ru\/parents1\/1klass/);
  assert.match(html,/Источник документа/);
  assert.doesNotMatch(html,/Администрация района/);
});
