import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { PageAssetPool, inspectStaticWebP } from "../app/static/document-page-pool.mjs";

// Synthetic 8x6 checker images made in memory with existing Pillow, not source
// documents. RGB lossless, RGB lossy and RGBA lossy exercise real encoder headers.
const fixtures = [
  "UklGRioAAABXRUJQVlA4TB0AAAAvB0ABAA/wlP9X/L/2f/7jAQKBRCaZ9aaP6H/kDAA=",
  "UklGRpgAAABXRUJQVlA4IIwAAAAQAwCdASoIAAYAAQAcJaACdAbwB5GfKMf0D8mS754h7QAA/vcXX/x1Pxs/LIiAq5zH52nrSr9eyMtQQ0L85lH9mEiwv2cQu8XP6HnxreQClfndWW6ufxetenoGP/2QWpyr/yd19q+2a/0iv/G8/f3tWE/0UCgRbN/x2T//BvmPy0AP9TgEfziG5hgAAA==",
  "UklGRr4AAABXRUJQVlA4WAoAAAAQAAAABwAABQAAQUxQSBMAAAABD/Cy/4iIIBBIZJJZb/qI/kfOAFZQOCCEAAAA8AIAnQEqCAAGAAEAHCUAToDeAPIz5Rj+gfkyXfPEPaAA/vcXX/x1Pxs/LIiAq5zH52nrSr9eyMtQQ0L85lH9mEiwv2cQu8XP6HnxreQClfndWW6ufxetenoGP/2QWpyr/yd19q+2a/0ivikNXStt4FFQe5n6UyT+DZxcoIEG1BGqQAAA"
].map(value => Buffer.from(value, "base64"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const root = "https://example.test/project/pages/";
const descriptor = (page = 1, bytes = fixtures[0], overrides = {}) => ({ sourceSha: "a".repeat(64), page,
  asset: { path: `objects/${page}-${hash(bytes)}.webp`, sha256: hash(bytes), bytes: bytes.length }, width: 8, height: 6, mime: "image/webp", ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const observed = promise => { promise.catch(() => {}); return promise; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  // WebCrypto completion uses a native queue. A fixed number of immediate
  // turns can expire in 2 ms while other test files are still using that queue.
  const deadline = performance.now() + 2000;
  while (!predicate() && performance.now() < deadline) await turn();
  assert(predicate(), "condition did not settle within 2 seconds");
}
const aborted = error => error?.name === "AbortError";
function rig(options = {}) {
  const images = [], urls = new Set(), revoked = [], calls = [], decodes = [];
  let nextUrl = 0, activeDecodes = 0, peakDecodes = 0;
  const pool = new PageAssetPool({ root, idleMs: 1000,
    fetch: async (url, settings) => { calls.push({ url, settings }); return new Response(fixtures[0]); },
    urlApi: { createObjectURL(blob) { assert.equal(blob.type, "image/webp"); const url = `blob:fixture-${++nextUrl}`; urls.add(url); return url; },
      revokeObjectURL(url) { assert(urls.delete(url), "URL is revoked exactly once"); revoked.push(url); } },
    createImage: () => {
      const image = { naturalWidth: 8, naturalHeight: 6, removed: false,
        removeAttribute(name) { assert.equal(name, "src"); delete this.src; this.removed = true; },
        decode() {
          activeDecodes++; peakDecodes = Math.max(peakDecodes, activeDecodes);
          const d = deferred(); decodes.push(d); if (!options.manual) d.resolve();
          return d.promise.finally(() => activeDecodes--);
        } };
      images.push(image); return image;
    }, ...options });
  const acquire = (page = 1, opts = {}) => observed(pool.acquire(descriptor(page), { owner: {}, ...opts }));
  const bounds = () => {
    const d = pool.diagnostics(); assert(d.entries <= 2 && d.urls <= 2 && d.warm <= 1 && d.activeOwners <= 1 && d.decodes <= 1 && d.jobs <= 1 && d.queued <= 1);
    assert.equal(d.urls, urls.size); assert(peakDecodes <= 1); return d;
  };
  return { pool, acquire, images, urls, revoked, calls, decodes, bounds, peak: () => peakDecodes };
}
function chunk(kind, data) { const head = Buffer.alloc(8); head.write(kind); head.writeUInt32LE(data.length, 4); return Buffer.concat([head, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]); }
function riff(parts) { const body = Buffer.concat([Buffer.from("WEBP"), ...parts]), head = Buffer.alloc(8); head.write("RIFF"); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]); }
function extended(flags = 0, width = 8, height = 6) { const b = Buffer.alloc(10); b[0] = flags; b.writeUIntLE(width - 1, 4, 3); b.writeUIntLE(height - 1, 7, 3); return chunk("VP8X", b); }
const losslessChunk = fixtures[0].subarray(12), lossyChunk = fixtures[1].subarray(12);

test("real synthetic VP8, VP8L and VP8X+ALPH headers preserve dimensions", () => {
  assert.equal(hash(fixtures[0]), "716ee24e6e4a76345701f16898b5a1c39bd5a45073cbc14c4a11f100068a3580");
  for (const image of fixtures) assert.deepEqual([inspectStaticWebP(image).width, inspectStaticWebP(image).height], [8, 6]);
  const metadata = riff([extended(0x24), chunk("ICCP", Buffer.from("profile")), losslessChunk, chunk("XMP ", Buffer.from("<xmp/>"))]);
  assert.equal(inspectStaticWebP(metadata).width, 8);
  assert.equal(inspectStaticWebP(riff([extended(), losslessChunk])).height, 6);
});

test("the entire container is checked: animation, duplicate images, malformed chunks and EXIF fail", () => {
  const corrupt = [
    riff([losslessChunk, lossyChunk]), riff([losslessChunk, chunk("ANMF", Buffer.alloc(16))]),
    riff([extended(2), losslessChunk]), riff([extended(), extended(), losslessChunk]),
    riff([extended(0x40), losslessChunk]), riff([extended(0, 9), losslessChunk]),
    riff([extended(0x08), losslessChunk]), riff([extended(0x08), losslessChunk, chunk("EXIF", Buffer.from("bad"))]),
    riff([extended(0x10), lossyChunk]), riff([extended(0x20), losslessChunk]),
    riff([extended(0x10), chunk("ALPH", Buffer.from([0, 1])), lossyChunk]),
    riff([extended(0x10), chunk("ALPH", Buffer.from([1, 1])), losslessChunk]),
    riff([extended(0x30), chunk("ALPH", Buffer.from([1, 1])), chunk("ICCP", Buffer.from("profile")), lossyChunk])
  ];
  const overflow = Buffer.from(fixtures[0]); overflow.writeUInt32LE(0xffffffff, 16); corrupt.push(overflow);
  const pad = Buffer.from(fixtures[0]); pad[pad.length - 1] = 1; corrupt.push(pad);
  const version = Buffer.from(fixtures[0]); version[24] |= 0xe0; corrupt.push(version);
  const inter = Buffer.from(fixtures[1]); inter[20] |= 1; corrupt.push(inter);
  const partition = Buffer.from(fixtures[1]); partition[20] = 0xf0; partition[21] = partition[22] = 0xff; corrupt.push(partition);
  for (const b of corrupt) assert.throws(() => inspectStaticWebP(b));
  for (let n = 0; n < fixtures[2].length; n++) assert.throws(() => inspectStaticWebP(fixtures[2].subarray(0, n)));
  assert.throws(() => inspectStaticWebP(Buffer.concat([fixtures[0], Buffer.from([0])])));
});

test("initial is empty; crop-free same-page transfer reuses URL and stale lease cannot release new owner", async () => {
  const r = rig(); assert.equal(r.bounds().entries, 0); assert.equal(r.calls.length, 0);
  let deactivated = 0;
  const a = await r.acquire(1, { onDeactivate: () => deactivated++ });
  const b = await r.acquire(1);
  assert.equal(a.url, b.url); assert.equal(r.calls.length, 1); assert.equal(r.images.length, 1); assert.equal(deactivated, 1);
  a.release(); assert.equal(r.bounds().activeOwners, 1);
  b.release(); b.release(); assert.equal(r.bounds().warm, 1);
  await r.pool.clear(); assert.equal(r.bounds().urls, 0); assert(r.images.every(i => i.removed));
});

test("A to B to A while native decode is pending rejects stale callers without starting B", async () => {
  const r = rig({ manual: true });
  const a = r.acquire(1); await until(() => r.decodes.length === 1);
  const b = r.acquire(2); await assert.rejects(a, aborted); assert.equal(r.bounds().queued, 1);
  const again = r.acquire(1); await assert.rejects(b, aborted); assert.equal(r.bounds().queued, 0);
  assert.equal(r.images.length, 1); r.decodes[0].resolve();
  const lease = await again; assert.equal(lease.url, "blob:fixture-1"); assert.equal(r.calls.length, 1);
  await r.pool.clear(); assert.equal(r.bounds().urls, 0);
});

test("returning to warm A after completed B reuses A instead of evicting the requested page", async () => {
  const r = rig(); const a = await r.acquire(1), b = await r.acquire(2);
  assert.equal(r.bounds().warm, 1);
  const again = await r.acquire(1);
  assert.equal(again.url, a.url); assert.equal(r.calls.length, 2); assert.equal(r.images.length, 2);
  assert.equal(r.bounds().entries, 2); assert.equal(r.bounds().warm, 1); assert.equal(r.revoked.length, 0);
  a.release(); b.release(); assert.equal(r.bounds().activeOwners, 1);
  await r.pool.clear(); assert.equal(r.revoked.length, 2);
});

test("single-page policy reuses the active physical page and releases other decoded images", async () => {
  const r = rig({maxEntries:1});
  const a = await r.acquire(1);
  const same = await r.acquire(1);
  assert.equal(same.url,a.url); assert.equal(r.images.length,1);
  const b = await r.acquire(2);
  assert.equal(r.bounds().entries,1); assert.equal(r.bounds().warm,0);
  assert(r.revoked.includes(a.url));
  b.release(); assert.equal(r.bounds().entries,0); assert.equal(r.bounds().urls,0);
  await r.acquire(1); assert.equal(r.images.length,3);
  await r.pool.clear();
});

test("rapid selections retain only the last waiting request and wait for stale native decode settlement", async () => {
  const r = rig({ manual: true }); const first = r.acquire(1); await until(() => r.decodes.length === 1);
  let last;
  for (let page = 2; page <= 75; page++) { const old = last; last = r.acquire(page); if (old) await assert.rejects(old, aborted); r.bounds(); }
  await assert.rejects(first, aborted); assert.equal(r.calls.length, 1); assert.equal(r.bounds().queued, 1);
  r.decodes[0].resolve(); await until(() => r.decodes.length === 2);
  assert(r.calls[1].url.includes("/75-")); assert.equal(r.images[0].removed, true); r.bounds();
  r.decodes[1].resolve(); await last; await r.pool.clear(); assert.equal(r.bounds().urls, 0);
});

test("clear is reusable and never overlaps the old nonabortable decode with a new one", async () => {
  const r = rig({ manual: true }); const a = r.acquire(); await until(() => r.decodes.length === 1);
  const cleared = r.pool.clear(); await assert.rejects(a, aborted);
  const b = r.acquire(2); assert.equal(r.bounds().queued, 1); assert.equal(r.images.length, 1);
  r.decodes[0].resolve(); await cleared; await until(() => r.decodes.length === 2);
  assert.equal(r.revoked.length, 1); r.decodes[1].resolve(); await b; await r.pool.clear(); r.bounds();
});

test("reentrant acquire inside clear's deactivate callback is aborted instead of receiving a revoked URL", async () => {
  const r = rig(); let reentered;
  await r.acquire(1, { onDeactivate: () => { reentered = r.acquire(1); } });
  await r.pool.clear(); await assert.rejects(reentered, aborted);
  assert.equal(r.bounds().activeOwners, 0); assert.equal(r.bounds().entries, 0);
  await r.acquire(2); await r.pool.clear();
});

test("synchronous acquire during deactivation is aborted without stealing a retiring URL", async () => {
  const r = rig(); let inner;
  await r.acquire(1, { onDeactivate: () => { inner = r.acquire(3); } });
  const outer = r.acquire(2); await assert.rejects(inner, aborted); await outer;
  assert.equal(r.bounds().activeOwners, 1); assert.equal(r.calls.length, 2); assert(r.calls[1].url.includes("/2-"));
  await r.pool.clear();
});

test("same-page in-flight fetch handoff preserves the survivor's independent cancellation", async () => {
  const response = deferred(), r = rig({ fetch: () => response.promise });
  const oldController = new AbortController(), a = r.acquire(1, { signal: oldController.signal });
  const b = r.acquire(1); await assert.rejects(a, aborted); oldController.abort();
  response.resolve(new Response(fixtures[0])); await b; assert.equal(r.images.length, 1); r.bounds(); await r.pool.clear();
});

test("late fetch completion after abort is canceled before allocating URL or Image", async () => {
  let bodyCanceled = 0; const response = deferred(), r = rig({ fetch: () => response.promise }), controller = new AbortController();
  const a = r.acquire(1, { signal: controller.signal }); controller.abort(); await assert.rejects(a, aborted);
  response.resolve(new Response(new ReadableStream({ cancel() { bodyCanceled++; } })));
  await until(() => r.bounds().jobs === 0); assert.equal(bodyCanceled, 1); assert.equal(r.images.length, 0); await r.pool.clear();
});

test("late native decode abort does not revoke early, and a failed decode cleans up", async () => {
  for (const fail of [false, true]) {
    const r = rig({ manual: true }), controller = new AbortController();
    const p = r.acquire(1, { signal: controller.signal }); await until(() => r.decodes.length === 1);
    controller.abort(); await assert.rejects(p, aborted); assert.equal(r.bounds().urls, 1);
    if (fail) r.decodes[0].reject(new Error("decode failed")); else r.decodes[0].resolve();
    await until(() => r.bounds().jobs === 0); assert.equal(r.bounds().urls, 0); assert(r.images[0].removed); await r.pool.clear();
  }
});

test("failure before decode is bounded and never creates Image or URL", async () => {
  const bigger = Buffer.from(fixtures[0]); bigger.writeUInt32LE(((5 << 14) | (4000 - 1)), 21);
  const cases = [
    { bytes: Buffer.from(fixtures[0]).fill(0, 25, 26), record: descriptor() },
    { bytes: fixtures[0].subarray(0, -1), record: descriptor() },
    { bytes: Buffer.concat([fixtures[0], Buffer.from([0])]), record: descriptor() },
    { bytes: bigger, record: descriptor(1, bigger) },
    { bytes: fixtures[2], record: descriptor(1, fixtures[2], { width: 9 }) }
  ];
  for (const { bytes, record } of cases) {
    const r = rig({ fetch: async () => new Response(bytes) });
    await assert.rejects(r.pool.acquire(record, { owner: {} })); assert.equal(r.images.length, 0); assert.equal(r.bounds().urls, 0); await r.pool.clear();
  }
});

test("natural decoded dimensions and entropy failures reject and revoke the object URL", async () => {
  for (const badSize of [true, false]) {
    const r = rig({ manual: true }); const p = r.acquire(); await until(() => r.decodes.length === 1);
    if (badSize) { r.images[0].naturalWidth = 7; r.decodes[0].resolve(); }
    else r.decodes[0].reject(new Error("Invalid entropy stream"));
    await assert.rejects(p); assert.equal(r.bounds().urls, 0); assert(r.images[0].removed); await r.pool.clear();
  }
});

test("invalid descriptor, path and pixel budgets reject before fetching", async () => {
  const r = rig({ maxPixels: 48, maxPixelBytes: 192 });
  const base = descriptor();
  for (const record of [ { ...base, width: 3001 }, { ...base, width: 9 }, { ...base, sourceSha: "bad" },
    { ...base, page: 0 }, { ...base, mime: "image/png" }, { ...base, asset: { ...base.asset, bytes: 9 * 1024 * 1024 } },
    ...["../secret.webp", "/absolute.webp", "a//b.webp", "a/./b.webp", "https://other.test/a.webp", "a.webp?q=1"].map(path => ({ ...base, asset: { ...base.asset, path } })) ]) {
    await assert.rejects(r.pool.acquire(record, { owner: {} }));
  }
  const abortedController = new AbortController(); abortedController.abort(); await assert.rejects(r.acquire(1, { signal: abortedController.signal }), aborted);
  assert.equal(r.calls.length, 0); assert.equal(r.images.length, 0); await r.pool.clear();
});

test("an HTTP error body is canceled before the job slot is released", async () => {
  let canceled = 0;
  const r = rig({ fetch: async () => new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 404 }) });
  await assert.rejects(r.acquire(), /404/); assert.equal(canceled, 1); assert.equal(r.bounds().jobs, 0); await r.pool.clear();
});

test("active plus one warm page respects encoded and pixel budgets before allocating the next image", async () => {
  const r = rig({ maxPixelBytes: 384, maxEncodedBytes: 100 });
  await r.acquire(1); await r.acquire(2); assert.equal(r.bounds().entries, 2);
  await r.acquire(3); assert.equal(r.bounds().entries, 2); assert.equal(r.revoked.length, 1);
  assert(r.bounds().pixelBytesEstimate <= 384 && r.bounds().encodedBytesEstimate <= 100); await r.pool.clear();
  const single = rig({ maxPixelBytes: 192 }); await single.acquire(1); await single.acquire(2);
  assert.equal(single.bounds().entries, 1); assert.equal(single.revoked.length, 1); await single.pool.clear();
});

test("warm idle reclamation preserves an active owner and leaves clear reusable", async () => {
  const r = rig({ idleMs: 10 }); const a = await r.acquire(1); await r.acquire(2);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(r.bounds().entries, 1); assert.equal(r.bounds().activeOwners, 1);
  a.release(); assert.equal(r.bounds().activeOwners, 1);
  await r.pool.clear(); const next = await r.acquire(3); next.release();
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(r.bounds().entries, 0); await r.pool.clear();
});

test("a throwing deactivation callback fails closed without leaving a stale active owner", async () => {
  const r = rig(); await r.acquire(1, { onDeactivate: () => { throw new Error("DOM cleanup failed"); } });
  await assert.rejects(r.acquire(2), /DOM cleanup failed/); assert.equal(r.bounds().activeOwners, 0);
  assert.equal(r.bounds().entries, 0); assert.equal(r.bounds().deactivationErrors, 1); await r.pool.clear();
});

test("same-page acquire followed by a callback exception never hands out the retiring URL", async () => {
  const r = rig(); let inner;
  await r.acquire(1, { onDeactivate: () => { inner = r.acquire(1); throw new Error("cleanup threw after reentry"); } });
  const outer = r.acquire(2); await assert.rejects(inner, aborted); await assert.rejects(outer, /cleanup threw/);
  assert.equal(r.bounds().activeOwners, 0); assert.equal(r.bounds().urls, 0); assert.equal(r.revoked.length, 1);
  await r.acquire(3); await r.pool.clear();
});

test("aborting a waiting request does not leave a decode successor or pending owner", async () => {
  const r = rig({ manual: true }), controller = new AbortController();
  const a = r.acquire(1); await until(() => r.decodes.length === 1);
  const b = r.acquire(2, { signal: controller.signal }); await assert.rejects(a, aborted);
  controller.abort(); await assert.rejects(b, aborted); assert.equal(r.bounds().queued, 0);
  r.decodes[0].resolve(); await until(() => r.bounds().jobs === 0);
  assert.equal(r.images.length, 1); assert.equal(r.bounds().entries, 0); await r.pool.clear();
});

test("an active owner's abort deactivates once and stale release cannot affect its replacement", async () => {
  const r = rig(), controller = new AbortController(); let deactivated = 0;
  const a = await r.acquire(1, { signal: controller.signal, onDeactivate: () => deactivated++ });
  controller.abort(); assert.equal(deactivated, 1); assert.equal(r.bounds().activeOwners, 0);
  const b = await r.acquire(1); a.release(); a.release(); assert.equal(deactivated, 1); assert.equal(r.bounds().activeOwners, 1);
  b.release(); assert.equal(r.bounds().warm, 1); await r.pool.clear();
});

test("one-byte streaming enforces exact bytes and cancels overflow before SHA or native decode", async () => {
  for (const overflow of [false, true]) {
    let canceled = 0, at = 0;
    const data = overflow ? Buffer.concat([fixtures[0], Buffer.from([0])]) : fixtures[0];
    const r = rig({ fetch: async () => new Response(new ReadableStream({
      pull(controller) { if (at < data.length) controller.enqueue(data.subarray(at, ++at)); else if (!overflow) controller.close(); },
      cancel() { canceled++; }
    })) });
    if (overflow) { await assert.rejects(r.acquire(), /Размер/); assert.equal(r.images.length, 0); assert(canceled > 0); }
    else await r.acquire();
    await r.pool.clear(); assert.equal(r.bounds().urls, 0);
  }
});
