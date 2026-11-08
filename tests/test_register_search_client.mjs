import assert from "node:assert/strict";
import { test } from "node:test";
import { createStaticSearchClient } from "../app/static/register-search-client.mjs";

const release = "a".repeat(64), descriptor = { schema: 1, manifest: { path: "register/manifest.json", sha256: release, bytes: 100 } };
function setup(options = {}) {
  const workers = [];
  class Worker {
    constructor(url, options) { this.sent = []; this.url = url; this.options = options; workers.push(this); }
    postMessage(message) { this.sent.push(message); }
    terminate() { this.closed = true; }
    respond(data) { this.onmessage({ data }); }
  }
  return { workers, client: createStaticSearchClient(descriptor, { root: "https://example.test/project/", districts: [{ name: "Тест", slug: "test" }], Worker, ...options }) };
}
const result = (id, rows = []) => ({ type: "result", release, id, ok: true, result: { rows, measurement: { bytes: 100 } } });

test("Worker is lazy and canceled late replies cannot complete a later query", async () => {
  const { client, workers } = setup(); assert.equal(workers.length, 0);
  const controller = new AbortController(), old = client.search("Мира 1", "", controller.signal), worker = workers[0];
  assert.equal(worker.options.type, "module"); assert(worker.url.pathname.endsWith("/register-search-worker.mjs"));
  assert.equal(worker.sent[0].root, "https://example.test/project/");
  controller.abort(); await assert.rejects(old, error => error.name === "AbortError");
  assert.equal(worker.sent.at(-1).type, "cancel");
  const next = client.search("Мира 2"); worker.respond(result(1, [{ old: true }]));
  assert.equal(client.diagnostics().pending, 1);
  worker.respond(result(2, [{ address_key: "new" }])); assert.deepEqual(await next, [{ address_key: "new" }]);
  client.dispose(); assert(worker.closed); assert.equal(client.diagnostics().pending, 0);
});

test('district preference reaches the worker without turning strict search into citywide search', async () => {
  const {client,workers} = setup();
  const preferred = client.search('Мира', 'Тест', undefined, true, true);
  assert.equal(workers[0].sent.at(-1).preferDistrict, true);
  assert.equal(workers[0].sent.at(-1).district, 'Тест');
  workers[0].respond(result(1)); await preferred;
  const strict = client.search('Мира 1', 'Тест');
  assert.equal(workers[0].sent.at(-1).preferDistrict, false);
  workers[0].respond(result(2)); await strict; client.dispose();
});

test("release mismatch terminates the worker and retry starts a new isolated instance", async () => {
  const { client, workers } = setup();
  const request = client.search("Мира 1"); workers[0].respond({ ...result(1), release: "b".repeat(64) });
  await assert.rejects(request, /обновились/); assert(workers[0].closed);
  const retry = client.search("Мира 1"); assert.equal(workers.length, 2);
  workers[0].respond(result(2, [{ stale: true }])); assert.equal(client.diagnostics().pending, 1);
  workers[1].respond(result(2)); assert.deepEqual(await retry, []); client.dispose();
});

test("wide-query and failed-worker errors never become successful empty results", async () => {
  const { client, workers } = setup();
  const request = client.search("улица 1"); workers[0].respond({ type: "result", id: 1, release, ok: false, error: { message: "Уточните адрес", code: "SEARCH_TOO_BROAD" } });
  await assert.rejects(request, error => error.code === "SEARCH_TOO_BROAD");
  const second = client.search("Мира 1"); workers[0].onerror({ preventDefault() {} }); await assert.rejects(second, /недоступен/);
  assert(workers[0].closed); assert.equal(client.diagnostics().pending, 0);
});

test("a failed message transfer rejects and releases pending callbacks", async () => {
  const { client, workers } = setup();
  const first = client.search("Мира 1"); workers[0].respond(result(1)); await first;
  workers[0].postMessage = () => { throw new Error("Transfer failed"); };
  await assert.rejects(client.search("Мира 2"), /Transfer failed/);
  assert.equal(client.diagnostics().pending, 0); assert(workers[0].closed);
});

test("idle reclamation releases the Worker, preserves active work and permits a fresh search", async () => {
  const { client, workers } = setup({ idleMs: 10 });
  const first = client.search("Мира 1"); assert.equal(client.releaseIdle(), false);
  await new Promise(resolve => setTimeout(resolve, 15)); assert(!workers[0].closed, "idle timeout cannot terminate an active query");
  workers[0].respond(result(1)); await first;
  await new Promise(resolve => setTimeout(resolve, 20)); assert(workers[0].closed);
  assert.equal(client.diagnostics().workerCreated, false);
  const next = client.search("Мира 2"); assert.equal(workers.length, 2);
  workers[1].respond(result(2)); await next; assert.equal(client.releaseIdle(), true);
  assert(workers[1].closed); client.dispose();
});

test("a stalled worker times out, releases all pending requests and permits retry", async () => {
  const { client, workers } = setup({ timeoutMs: 15 });
  const first = client.search("Мира 1"), second = client.search("Мира 2");
  const results = await Promise.allSettled([first, second]);
  assert(results.every(result => result.status === 'rejected' && /слишком много времени/.test(result.reason.message)));
  assert.equal(client.diagnostics().pending, 0);
  assert(workers[0].closed);
  const retry = client.search("Мира 3");
  workers[1].respond(result(3, [{ address_key: "new" }]));
  assert.deepEqual(await retry, [{ address_key: "new" }]);
  client.dispose();
});
