import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginalSourceIndex } from '../app/static/original-source-links.mjs';
import { buildLabel, documentSetsHtml } from '../app/static/delivery-info.mjs';
const row = { source_raw_file:'raw/district/test.pdf', sha256:'a'.repeat(64), document_url:'https://www.gov.spb.ru/original.pdf', page_url:'', status:'document_registered', availability:'not_rechecked' };
const manifest = documents => ({schema:1,kind:'external_original_sources',documents});
test('external originals bind both raw identity and SHA; missing/mismatched documents never gain a local link',()=>{
 const resolve=createOriginalSourceIndex(manifest([row]));
 assert.equal(resolve(row.source_raw_file,row.sha256,3).url,row.document_url+'#page=3');
 assert.equal(resolve(row.source_raw_file,row.sha256,3).label,'Оригинал документа');
 assert.equal(resolve(row.source_raw_file,'b'.repeat(64)).url,'');
 assert.equal(resolve('raw/other.pdf').status,'unavailable');
});
test('district page is labelled as a page, not a confirmed original or requested PDF page',()=>{
 const resolve=createOriginalSourceIndex(manifest([{...row,document_url:'',page_url:'https://www.gov.spb.ru/district/',status:'district_page_only'}]));
 const link=resolve(row.source_raw_file,row.sha256,3);
 assert.equal(link.url,'https://www.gov.spb.ru/district/');assert.equal(link.label,'Страница администрации');
 assert.match(link.note,/не подтверждена/);
});
test('verified district page stays separate from the document and is empty for unknown originals',()=>{
 const page='https://www.gov.spb.ru/district/';
 const resolve=createOriginalSourceIndex(manifest([{...row,page_url:page}]));
 const link=resolve(row.source_raw_file,row.sha256);
 assert.equal(link.url,row.document_url);assert.equal(link.pageUrl,page);
 assert.equal(resolve('raw/other.pdf').pageUrl,'');
 assert.equal(resolve(row.source_raw_file,'b'.repeat(64)).pageUrl,'');
});
test('reject injection, duplicate identity, traversal and misleading statuses',()=>{
 for(const document_url of ['javascript:alert(1)','file:///raw/test.pdf','https://user:secret@gov.spb.ru/a','https://www.gov.spb.ru/a\n'])assert.throws(()=>createOriginalSourceIndex(manifest([{...row,document_url}])));
 for(const source_raw_file of ['raw/../other.pdf','raw\\other.pdf','/raw/test.pdf','raw/test.pdf?x'])assert.throws(()=>createOriginalSourceIndex(manifest([{...row,source_raw_file}])));
 assert.throws(()=>createOriginalSourceIndex(manifest([row,row])));
 assert.throws(()=>createOriginalSourceIndex(manifest([{...row,status:'unavailable'}])));
});
test('build label uses actual fixed build timestamp in Moscow, not viewing time',()=>{
 const info={schema:1,version:'build-abcdef012345',version_basis:'frontend_sha256',frontend_sha256:'a'.repeat(64),built_at:'2026-10-26T23:00:00Z'};
 assert.equal(buildLabel(info),'Сборка abcdef012345 · 27.10.2026');
 assert.throws(()=>buildLabel({...info,built_at:'today'}));
});
test('all district acts remain visible and absent source verification is explicit',()=>{
 const districts=Array.from({length:18},(_,i)=>({district:`Район ${i}`,source_set_checked_at:null,documents:[{act_date:'2026-02-12',act_number:'485-р',sources:[{source_raw_file:row.source_raw_file,sha256:row.sha256}]}]}));
 districts[0].documents.push({...districts[0].documents[0],act_date:'2026-03-05',act_number:'500-р'});
 const html=documentSetsHtml({schema:1,kind:'accepted_district_document_sets',districts},createOriginalSourceIndex(manifest([row])));
 assert.equal((html.match(/scope="rowgroup"/g)||[]).length,18);assert.equal((html.match(/<tr>/g)||[]).length,19);
 assert.match(html,/rowspan="2"/);assert.match(html,/12\.02\.2026/);assert.match(html,/05\.03\.2026/);assert.match(html,/>не указана<\/td>/);
 assert.throws(()=>documentSetsHtml({schema:1,kind:'accepted_district_document_sets',districts:districts.slice(1)},()=>null));
});
