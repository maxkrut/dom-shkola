import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { StaticJsonReader } from "../app/static/static-json-reader.mjs";

const root = "https://example.test/project/register/";
function object(value) {
  const bytes = Buffer.from(JSON.stringify(value)), sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, record: { path: `objects/${sha256}.json`, sha256, bytes: bytes.length } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("verified JSON resolves under a Pages subpath and corrupt bytes can be retried", async () => {
  const item = object({ x: 1 }), calls = [];
  const reader = new StaticJsonReader({ root, fetch: async (url, options) => {
    calls.push({ url, options }); return new Response(calls.length === 1 ? '{"x":2}' : item.bytes);
  } });
  await assert.rejects(reader.read(item.record), /изменились/);
  assert.deepEqual(reader.diagnostics(), { cacheBytesEstimate: 0, cacheEntries: 0, activeBodyBytes: 0, activeRequests: 0, queuedRequests: 0 });
  assert.deepEqual(await reader.read(item.record), { x: 1 });
  assert.deepEqual(await reader.read(item.record), { x: 1 });
  assert.equal(calls.length, 2);
  assert(calls[0].url.startsWith(root + item.record.path + "?revision="));
  assert.equal(calls[0].options.cache, "force-cache");
  await assert.rejects(reader.read({ ...item.record, path: "../private.json" }), /Некорректная/);
  await assert.rejects(reader.read({ ...item.record, bytes: 1e9 }), /Некорректная/);
});

test("cache weight includes parsed strings/containers and LRU releases old objects", async () => {
  const a = object({ n: "а".repeat(40) }), b = object({ n: "б".repeat(40) }), values = new Map([a, b].map(item => [item.record.path, item.bytes]));
  let calls = 0;
  const reader = new StaticJsonReader({ root, maxObjectBytes: 128, maxActiveBytes: 128, maxCacheBytes: 400,
    fetch: async url => { calls++; return new Response(values.get(new URL(url).pathname.replace("/project/register/", ""))); } });
  await reader.read(a.record); await reader.read(a.record);
  assert.equal(calls, 1);
  await reader.read(b.record); await reader.read(a.record);
  assert.equal(calls, 3);
  assert.equal(reader.diagnostics().cacheEntries, 1);
  assert(reader.diagnostics().cacheBytesEstimate <= 400);
  assert(reader.diagnostics().cacheBytesEstimate > a.bytes.length);
  reader.clear(); assert.equal(reader.diagnostics().cacheBytesEstimate, 0);
});

test("active payload bytes are bounded and cancellation removes a queued request", async () => {
  const items = [0, 1, 2].map(i => object({ i, row: "a".repeat(40) })), pending = [];
  const reader = new StaticJsonReader({ root, maxObjectBytes: 64, maxActiveBytes: 64, maxConcurrent: 6,
    fetch: url => new Promise(resolve => pending.push({ url, resolve })) });
  const controller = new AbortController();
  const first = reader.read(items[0].record), canceled = reader.read(items[1].record, { signal: controller.signal }), last = reader.read(items[2].record);
  await tick();
  assert.equal(pending.length, 1);
  assert.equal(reader.diagnostics().queuedRequests, 2);
  assert(reader.diagnostics().activeBodyBytes <= 64);
  controller.abort(); await assert.rejects(canceled, error => error.name === "AbortError");
  assert.equal(reader.diagnostics().queuedRequests, 1);
  pending[0].resolve(new Response(items[0].bytes)); await first; await tick();
  assert.equal(pending.length, 2);
  assert(pending[1].url.includes(items[2].record.sha256));
  pending[1].resolve(new Response(items[2].bytes)); await last;
  assert.equal(reader.diagnostics().activeRequests, 0);
  assert.equal(reader.diagnostics().activeBodyBytes, 0);
});

test("concurrent reads of one SHA count one cache entry and preserve the other caller on cancellation", async () => {
  const item = object({ note: "Один проверенный объект" }), pending = [];
  const reader = new StaticJsonReader({ root, fetch: () => new Promise(resolve => pending.push(resolve)) });
  const first = reader.read(item.record), second = reader.read(item.record);
  await tick(); assert.equal(pending.length, 2);
  pending[0](new Response(item.bytes)); await first;
  const single = reader.diagnostics().cacheBytesEstimate;
  pending[1](new Response(item.bytes)); await second;
  assert.equal(reader.diagnostics().cacheEntries, 1);
  assert.equal(reader.diagnostics().cacheBytesEstimate, single, "finishing the same SHA twice cannot inflate cache accounting");
  reader.clear(); assert.equal(reader.diagnostics().cacheBytesEstimate, 0);
  const controller = new AbortController();
  const canceled = reader.read(item.record, { signal: controller.signal }), survivor = reader.read(item.record);
  await tick(); controller.abort();
  pending[2](new Response(item.bytes)); pending[3](new Response(item.bytes));
  await assert.rejects(canceled, error => error.name === "AbortError");
  assert.deepEqual(await survivor, JSON.parse(item.bytes));
  assert.equal(reader.diagnostics().cacheBytesEstimate, single);
  assert.equal(reader.diagnostics().activeRequests, 0);
});

test("oversize, truncated and late canceled responses never enter the cache or hold slots", async () => {
  const item = object({ x: 1 });
  for (const body of ['{"x":123}', '{"x":']) {
    const reader = new StaticJsonReader({ root, fetch: async () => new Response(body) });
    await assert.rejects(reader.read(item.record), /Размер/);
    assert.equal(reader.diagnostics().cacheEntries, 0);
    assert.equal(reader.diagnostics().activeRequests, 0);
  }
  const controller = new AbortController(), reader = new StaticJsonReader({ root, fetch: async () => { controller.abort(); return new Response(item.bytes); } });
  await assert.rejects(reader.read(item.record, { signal: controller.signal }), error => error.name === "AbortError");
  assert.equal(reader.diagnostics().cacheEntries, 0);
  assert.equal(reader.diagnostics().activeRequests, 0);
});

test("native Worker fetch receives its global receiver rather than the cache instance", async () => {
  const item = object({ worker: true });
  const reader = new StaticJsonReader({ root, fetch: function () {
    assert.equal(this, globalThis, "WorkerGlobalScope fetch rejects an unrelated receiver");
    return Promise.resolve(new Response(item.bytes));
  } });
  assert.deepEqual(await reader.read(item.record), { worker: true });
});

test("HTTP failure cancels its unread body before releasing the response budget", async () => {
  const item = object({ x: 1 }); let canceled = 0;
  const reader = new StaticJsonReader({ root, fetch: async () => new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 404 }) });
  await assert.rejects(reader.read(item.record), /404/);
  assert.equal(canceled, 1, "an arbitrarily large error page cannot continue outside the active-body accounting");
  assert.equal(reader.diagnostics().activeRequests, 0);
  assert.equal(reader.diagnostics().activeBodyBytes, 0);
  assert.equal(reader.diagnostics().cacheEntries, 0);
});

test("clearing during a read prevents that older read from repopulating the cache", async () => {
  const item = object({ value: "verified" }); let finish, calls = 0;
  const reader = new StaticJsonReader({ root, fetch: () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(new Response(item.bytes));
  } });
  const pending = reader.read(item.record);
  await tick();
  reader.clear();
  finish(new Response(item.bytes));
  assert.deepEqual(await pending, { value: "verified" });
  assert.equal(reader.diagnostics().cacheEntries, 0);
  assert.deepEqual(await reader.read(item.record), { value: "verified" });
  assert.equal(calls, 2);
  assert.equal(reader.diagnostics().cacheEntries, 1);
});
