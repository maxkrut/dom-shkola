import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StaticDocumentPages } from '../app/static/document-pages.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const A = 'a'.repeat(64), B = 'b'.repeat(64), file = 'raw/districts/test/Документ.pdf', alias = 'raw/districts/test/Копия.pdf';
function fixture({ rootChange = value => value, childChange = value => value, response } = {}) {
  const files = new Map(), calls = [], poolCalls = [];
  const add = (path, value) => { const bytes = JSON.stringify(value); files.set('/project/documents/' + path, bytes); return { path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) }; };
  const region = { sha256: A, source_raw_file: file, page: { number: 2, width: 598.2000122070312, height: 843.8500366210938 } };
  const image = { asset: { path: 'pages/test.webp', sha256: B, bytes: 75 }, width: 1347, height: 1900, mime: 'image/webp' };
  const child = add('doc.json', childChange({ schema: 1, kind: 'school_document_pages_document', reference_base: 'root_manifest',
    sha256: A, source_raw_files: [file, alias], pages: { 2: { ...region.page, renditions: { preview: image, detail: { ...image, width: 2127, height: 3000 } } } } }));
  const root = add('manifest.json', rootChange({ schema: 1, kind: 'school_document_pages', reference_base: 'root_manifest',
    documents: { [A]: { manifest: child, source_raw_files: [file, alias] } }, source_aliases: { [file]: A, [alias]: A } }));
  const fetcher = async (url, options) => { calls.push(String(url)); options.signal?.throwIfAborted();
    const body = files.get(new URL(url).pathname); return response ? response(body, url, options) : new Response(body, { status: body ? 200 : 404 }); };
  const client = new StaticDocumentPages({ root: 'https://example.test/project/', descriptor: { schema: 1, manifest: { ...root, path: 'documents/manifest.json' } }, fetch: fetcher,
    poolFactory: options => ({ acquire: (asset, owner) => { poolCalls.push({ options, asset, owner }); return { url: 'blob:test', release() {} }; }, clear() { poolCalls.push('clear'); } }) });
  return { client, region, calls, poolCalls, files };
}

test('lazy root-relative metadata, physical frame, both aliases and shared image pool', async () => {
  const { client, region, calls, poolCalls } = fixture();
  assert.equal(calls.length, 0);
  const expected = await client.resolve(region);
  assert.equal(expected.page, 2); assert.equal(expected.width, 1347);
  assert.equal(calls.length, 2); assert.equal(poolCalls.length, 0, 'metadata never decodes an image');
  assert.equal((await client.resolve({ ...region, source_raw_file: alias }, 'detail')).height, 3000);
  const signal = new AbortController().signal, owner = {};
  assert.equal((await client.acquire(region, { owner, signal })).url, 'blob:test');
  assert.equal(poolCalls[0].options.root.href, 'https://example.test/project/documents/');
  assert.equal(poolCalls[0].owner.owner, owner); assert.notEqual(poolCalls[0].owner.signal, signal);
  assert(calls.every(url => new URL(url).pathname.startsWith('/project/documents/')));
  client.clear(); assert.equal(poolCalls.at(-1), 'clear');
});

test('older slow metadata cannot steal the page selected by a later caller', async () => {
  const { client, region, poolCalls } = fixture();
  const resolve = client.resolve.bind(client); let finish;
  const slow = new Promise(done => { finish = done; }); let count = 0;
  client.resolve = async (...args) => { if (++count === 1) { await slow; return { page: 99 }; } return resolve(...args); };
  const old = client.acquire(region); old.catch(() => {});
  const controller = new AbortController();
  const latest = await client.acquire(region, { owner: 'latest', signal: controller.signal });
  finish(); await assert.rejects(old, { name: 'AbortError' });
  assert.equal(poolCalls.length, 1); assert.equal(poolCalls[0].asset.page, 2);
  assert.equal(poolCalls[0].owner.signal.aborted, false);
  controller.abort(); assert.equal(poolCalls[0].owner.signal.aborted, true, 'active lease keeps caller cancellation');
  latest.release();
});

test('rehashed corrupt alias/frame/rendition graphs are refused', async () => {
  const mutations = [
    { rootChange: root => ({ ...root, source_aliases: { [file]: A } }) },
    { rootChange: root => ({ ...root, source_aliases: { ...root.source_aliases, 'raw/extra.pdf': A } }) },
    { rootChange: root => ({ ...root, documents: { ...root.documents, [B]: { ...root.documents[A] } } }) },
    { rootChange: root => ({ ...root, documents: { [A]: { ...root.documents[A], manifest: { ...root.documents[A].manifest, path: '../escape.json' } } } }) },
    { childChange: child => ({ ...child, sha256: B }) },
    { childChange: child => ({ ...child, source_raw_files: [file] }) },
    { childChange: child => { child.pages[2].width += 0.00001; return child; } },
    { childChange: child => { child.pages[2].number = 3; return child; } },
    { childChange: child => { child.pages[2].renditions.preview.width = 3001; return child; } },
    { childChange: child => { child.pages[2].renditions.preview.asset.bytes = 8 * 1024 * 1024 + 1; return child; } },
    { childChange: child => { child.pages[2].renditions.preview.asset.path = '../escape.webp'; return child; } },
    { childChange: child => { child.pages[2].renditions.preview.mime = 'image/png'; return child; } }
    ,{ childChange: child => { child.pages[2].renditions.preview.width = 1200; return child; } }
  ];
  for (const mutation of mutations) {
    const { client, region, poolCalls } = fixture(mutation);
    await assert.rejects(client.acquire(region), /страниц|документ/);
    assert.equal(poolCalls.length, 0);
  }
  for (const change of [{ sha256: B }, { source_raw_file: 'raw/other.pdf' }, { page: { number: 1, width: 1, height: 1 } }]) {
    const { client, region } = fixture(); await assert.rejects(client.resolve({ ...region, ...change }), /страниц|оригинал|документ/);
  }
});

test('clear while metadata is in flight cannot create a late image pool', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { client, region, poolCalls } = fixture({ response: async body => { await gate; return new Response(body); } });
  const pending = client.acquire(region); pending.catch(() => {});
  client.clear(); finish();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(poolCalls.length, 0);
  assert.equal((await client.acquire(region)).url, 'blob:test', 'clear remains reusable');
});

test('abort, HTTP retry and damaged bytes cannot acquire an image', async () => {
  const { client, region, calls, poolCalls } = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.acquire(region, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0); assert.equal(poolCalls.length, 0);
  const retry = fixture(); let failed = false;
  const original = retry.client.pointerReader.fetcher;
  retry.client.pointerReader.fetcher = async (...args) => { if (!failed) { failed = true; return new Response('bad', { status: 503 }); } return original(...args); };
  await assert.rejects(retry.client.resolve(retry.region), /503/);
  assert.equal((await retry.client.resolve(retry.region)).page, 2);
  const damaged = fixture({ response: body => new Response(body.slice(0, -1) + ' ') });
  await assert.rejects(damaged.client.acquire(damaged.region), /изменились/);
  assert.equal(damaged.poolCalls.length, 0);
});
