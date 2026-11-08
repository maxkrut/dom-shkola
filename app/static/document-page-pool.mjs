/* Verified static WebP pages. Bounds cover our jobs, URLs and pixel estimates,
 * not the browser's internal decoded-image cache or total process memory. */
const MiB = 1024 * 1024;
const abortError = () => new DOMException("Просмотр страницы отменён", "AbortError");
const require = (condition, message = "Некорректная страница документа") => { if (!condition) throw new Error(message); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const hashPattern = /^[a-f0-9]{64}$/;

/** Strict static-page profile of Google's WebP RIFF/lossless specs and RFC6386.
 * Entropy validity still requires native decode. EXIF is deliberately unsupported:
 * implicit mirror/180-degree orientation would silently misalign physical boxes. */
export function inspectStaticWebP(bytes) {
  require(bytes instanceof Uint8Array && bytes.length >= 20);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const four = p => String.fromCharCode(...bytes.subarray(p, p + 4));
  const u24 = p => bytes[p] + bytes[p + 1] * 256 + bytes[p + 2] * 65536;
  require(four(0) === "RIFF" && four(8) === "WEBP" && view.getUint32(4, true) + 8 === bytes.length);
  let canvas, image, alpha, codec, flags = 0, chunks = 0, icc = false, xmp = false;
  for (let at = 12; at < bytes.length;) {
    require(++chunks <= 1024 && bytes.length - at >= 8);
    const kind = four(at), size = view.getUint32(at + 4, true), start = at + 8;
    require(size <= bytes.length - start);
    const end = start + size, next = end + (size % 2);
    require(next <= bytes.length && (!(size % 2) || bytes[end] === 0));
    require(kind !== "ANIM" && kind !== "ANMF", "Анимированные страницы не поддерживаются");
    require(kind !== "EXIF", "Страница содержит неподдерживаемые EXIF-преобразования");
    if (kind === "VP8X") {
      require(at === 12 && !canvas && size === 10);
      flags = bytes[start];
      require(!(flags & 0xc3) && !bytes[start + 1] && !bytes[start + 2] && !bytes[start + 3]);
      canvas = { width: u24(start + 4) + 1, height: u24(start + 7) + 1 };
      require(canvas.width * canvas.height <= 0xffffffff);
    } else if (kind === "VP8 " || kind === "VP8L") {
      require(!image && (canvas || at === 12), "В странице должно быть ровно одно изображение");
      codec = kind;
      if (kind === "VP8 ") {
        require(size >= 11);
        const tag = u24(start), partition = tag >>> 5;
        require(!(tag & 1) && ((tag >>> 1) & 7) <= 3 && (tag & 16) && partition > 0 && partition <= size - 10);
        require(bytes[start + 3] === 0x9d && bytes[start + 4] === 1 && bytes[start + 5] === 0x2a);
        image = { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff };
        require(image.width > 0 && image.height > 0);
      } else {
        require(!alpha && size >= 6 && bytes[start] === 0x2f);
        const bits = view.getUint32(start + 1, true);
        require((bits >>> 29) === 0);
        image = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    } else if (kind === "ALPH") {
      require(canvas && !image && !alpha && size >= 2);
      const header = bytes[start], method = header & 3;
      require(method <= 1 && ((header >>> 4) & 3) <= 1 && (header >>> 6) === 0);
      alpha = { size, method };
    } else if (kind === "ICCP") {
      require(canvas && !image && !alpha && !icc && size > 0); icc = true;
    } else if (kind === "XMP ") {
      require(canvas && !xmp && size > 0); xmp = true;
    } else {
      // Unknown RIFF chunks are skipped, but cannot masquerade as a simple header.
      require(canvas || image);
    }
    at = next;
  }
  require(image);
  if (canvas) {
    require(canvas.width === image.width && canvas.height === image.height);
    require(Boolean(flags & 0x20) === icc && Boolean(flags & 0x04) === xmp && !(flags & 0x08));
    if (alpha) require(flags & 0x10);
    if (codec === "VP8 ") require(Boolean(flags & 0x10) === Boolean(alpha));
  }
  if (alpha?.method === 0) require(alpha.size === 1 + image.width * image.height);
  return { ...image, chunks };
}

export class PageAssetPool {
  constructor({ root, fetch: fetcher = globalThis.fetch, createImage = () => new Image(), urlApi = URL,
    maxEncodedBytes = 8 * MiB, maxSide = 3000, maxPixels = 9000000, maxPixelBytes = 64 * MiB, idleMs = 2000, maxEntries = 2 } = {}) {
    this.root = new URL(root);
    require(["https:", "http:"].includes(this.root.protocol) && !this.root.username && !this.root.password
      && !this.root.search && !this.root.hash && this.root.pathname.endsWith("/"));
    require([maxEncodedBytes, maxSide, maxPixels, maxPixelBytes, idleMs].every(positive));
    require(maxEntries === 1 || maxEntries === 2);
    require(typeof fetcher === "function" && typeof createImage === "function"
      && typeof urlApi?.createObjectURL === "function" && typeof urlApi?.revokeObjectURL === "function");
    Object.assign(this, { fetcher: fetcher.bind(globalThis), createImage, urlApi, maxEncodedBytes, maxSide, maxPixels, maxPixelBytes, idleMs, maxEntries });
    this.entries = new Map(); this.current = null; this.active = null; this.job = null; this.queued = null;
    this.epoch = 0; this.idleTimer = null; this.deactivationErrors = 0; this.clearing = false; this.deactivating = false;
  }

  descriptor(input) {
    const { sourceSha, page, asset, width, height, mime } = input || {};
    require(hashPattern.test(sourceSha || "") && positive(page) && mime === "image/webp"
      && hashPattern.test(asset?.sha256 || "") && positive(asset?.bytes) && asset.bytes <= this.maxEncodedBytes
      && typeof asset.path === "string" && /^[a-zA-Z0-9_./-]+$/.test(asset.path)
      && asset.path.split("/").every(part => part && part !== "." && part !== ".."));
    require(positive(width) && positive(height) && width <= this.maxSide && height <= this.maxSide
      && width * height <= this.maxPixels && width * height * 4 <= this.maxPixelBytes,
    "Размер страницы превышает допустимый объём");
    return { sourceSha, page, asset: { path: asset.path, sha256: asset.sha256, bytes: asset.bytes }, width, height, mime, pixelBytes: width * height * 4,
      key: `${sourceSha}:${page}:${asset.sha256}:${width}:${height}:${asset.bytes}` };
  }

  acquire(input, { owner, signal, onDeactivate } = {}) {
    let record;
    try {
      if (this.clearing || this.deactivating) throw abortError();
      signal?.throwIfAborted(); record = this.descriptor(input);
      require(owner != null && (onDeactivate === undefined || typeof onDeactivate === "function"));
    } catch (error) { return Promise.reject(error); }
    const request = { record, owner, signal, onDeactivate, state: "pending" };
    const promise = new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
    request.cancel = () => this.cancel(request);
    signal?.addEventListener("abort", request.cancel, { once: true });
    if (signal?.aborted) this.reject(request);
    else {
      try { this.replace(request); }
      catch (error) {
        if (this.current === request) this.current = null;
        if (this.queued === request) this.queued = null;
        this.reject(request, error);
      }
    }
    return promise;
  }

  reject(request, error = abortError()) {
    if (!request || request.state !== "pending") return;
    request.state = "retired"; request.signal?.removeEventListener("abort", request.cancel); request.reject(error);
  }

  retireActive() {
    const active = this.active;
    if (!active) return null;
    this.active = null;
    const { request, entry } = active;
    request.state = "retired"; request.signal?.removeEventListener("abort", request.cancel);
    entry.state = "warm";
    let failure = null;
    this.deactivating = true;
    try { request.onDeactivate?.(); }
    catch (error) { this.deactivationErrors++; failure = error instanceof Error ? error : new Error("Не удалось завершить предыдущий просмотр"); this.disposeEntry(entry); }
    finally { this.deactivating = false; }
    this.trim(entry);
    return failure;
  }

  replace(request) {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    const previous = this.current; this.current = request;
    this.reject(previous); this.reject(this.queued); this.queued = null;
    if (this.job) { this.reject(this.job.request); this.job.request = null; }
    // Preserve a requested warm A while retiring active B. Otherwise retiring B
    // would evict A just before the A -> B -> A cache hit.
    const reserved = this.entries.get(request.record.key);
    if (reserved?.state === "warm") reserved.state = "reserved";
    const failure = this.retireActive();
    // A deactivation callback may synchronously clear the pool or select again.
    if (this.current !== request || request.state !== "pending" || failure) {
      if (reserved?.state === "reserved") reserved.state = "warm";
      this.trim();
      if (failure) { this.current = null; this.reject(request, failure); this.job?.controller.abort(); }
      this.armIdle(); return;
    }
    const cached = this.entries.get(request.record.key);
    if (cached?.state === "warm" || cached?.state === "reserved") {
      this.job?.controller.abort(); this.activate(cached, request); return;
    }
    if (this.job) {
      const job = this.job;
      if (job.epoch === this.epoch && job.record.key === request.record.key
        && (job.stage === "decode" || !job.controller.signal.aborted)) job.request = request;
      else { job.controller.abort(); this.queued = request; }
    } else this.start(request);
  }

  cancel(request) {
    if (request.state === "retired") return;
    if (this.current === request) this.current = null;
    if (this.queued === request) this.queued = null;
    if (this.job?.request === request) { this.job.request = null; this.job.controller.abort(); }
    if (this.active?.request === request) this.retireActive();
    this.reject(request); this.armIdle();
  }

  activate(entry, request) {
    if (this.current !== request || request.state !== "pending" || request.signal?.aborted) { this.cancel(request); return; }
    entry.state = "active";
    this.active = { entry, request }; request.state = "active";
    const lease = Object.freeze({ url: entry.url, release: () => this.cancel(request) });
    request.resolve(lease); this.trim(entry); this.armIdle();
  }

  trim(preferred) {
    // One warm page maximum; decoding and the current active page cannot be evicted.
    let warm = [...this.entries.values()].filter(entry => entry.state === "warm");
    if (this.maxEntries === 1) {
      for (const entry of warm) if (entry.record.key !== this.current?.record.key) this.disposeEntry(entry);
      return;
    }
    if (warm.length > 1) {
      const keep = warm.includes(preferred) ? preferred : warm.at(-1);
      for (const entry of warm) if (entry !== keep) this.disposeEntry(entry);
    }
  }

  reserve(record) {
    for (const entry of [...this.entries.values()]) {
      const entries = [...this.entries.values()];
      if (entries.length < this.maxEntries && entries.reduce((n, e) => n + e.record.pixelBytes, 0) + record.pixelBytes <= this.maxPixelBytes
          && entries.reduce((n, e) => n + e.record.asset.bytes, 0) + record.asset.bytes <= this.maxEncodedBytes) break;
      if (entry.state === "warm") this.disposeEntry(entry);
    }
    const remaining = [...this.entries.values()];
    require(remaining.length < this.maxEntries && remaining.reduce((n, e) => n + e.record.pixelBytes, 0) + record.pixelBytes <= this.maxPixelBytes
      && remaining.reduce((n, e) => n + e.record.asset.bytes, 0) + record.asset.bytes <= this.maxEncodedBytes);
  }

  start(request) {
    if (this.current !== request || request.state !== "pending") return;
    this.reserve(request.record);
    const job = { record: request.record, request, controller: new AbortController(), epoch: this.epoch, stage: "fetch", entry: null };
    this.job = job;
    // Exactly one running promise, not a chain appended on every selection.
    job.done = this.run(job);
  }

  async body(record, signal) {
    const url = new URL(record.asset.path, this.root); url.searchParams.set("revision", record.asset.sha256);
    const response = await this.fetcher(url.href, { signal, cache: "force-cache" });
    if (!response.ok || signal.aborted) {
      try { await response.body?.cancel(); } catch { /* Preserve the original failure. */ }
      signal.throwIfAborted(); throw new Error(`Не удалось загрузить страницу (${response.status})`);
    }
    require(response.body?.getReader, "Страница не содержит поток изображения");
    const reader = response.body.getReader(), buffer = new Uint8Array(record.asset.bytes);
    let offset = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); signal.throwIfAborted();
        if (done) break;
        require(value instanceof Uint8Array && offset + value.byteLength <= buffer.length, "Размер страницы изменился");
        buffer.set(value, offset); offset += value.byteLength;
      }
      require(offset === buffer.length, "Размер страницы изменился");
      return buffer;
    } finally { try { await reader.cancel(); } catch { /* The stream may already be aborted. */ } reader.releaseLock(); }
  }

  async run(job) {
    try {
      const { record, controller } = job, buffer = await this.body(record, controller.signal);
      controller.signal.throwIfAborted(); job.stage = "verify";
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map(v => v.toString(16).padStart(2, "0")).join("");
      controller.signal.throwIfAborted();
      require(digest === record.asset.sha256, "Страница изменилась. Обновите данные.");
      const dimensions = inspectStaticWebP(buffer);
      require(dimensions.width === record.width && dimensions.height === record.height, "Размеры страницы не соответствуют описанию");
      // Descriptor pixel bounds were checked before fetch, and verified against
      // the encoded header before any URL/Image/native decode allocation.
      const entry = { record, state: "decoding", image: null, url: null };
      job.entry = entry; this.entries.set(record.key, entry);
      entry.url = this.urlApi.createObjectURL(new Blob([buffer], { type: "image/webp" }));
      entry.image = this.createImage();
      require(entry.image && typeof entry.image.decode === "function" && typeof entry.image.removeAttribute === "function");
      entry.image.decoding = "async"; entry.image.src = entry.url; job.stage = "decode";
      await entry.image.decode();
      require(entry.image.naturalWidth === record.width && entry.image.naturalHeight === record.height,
        "Декодированная страница имеет другие размеры");
      const request = job.request;
      if (job.epoch === this.epoch && request && this.current === request && !request.signal?.aborted) this.activate(entry, request);
      else this.disposeEntry(entry);
    } catch (error) {
      if (job.entry) this.disposeEntry(job.entry);
      if (this.current === job.request) this.current = null;
      this.reject(job.request, error);
    } finally {
      job.request = null;
      if (this.job === job) this.job = null;
      const next = this.queued; this.queued = null;
      if (next && this.current === next && next.state === "pending") this.start(next);
      this.armIdle();
    }
  }

  disposeEntry(entry) {
    if (entry.state === "disposed") return;
    entry.state = "disposed";
    if (this.entries.get(entry.record.key) === entry) this.entries.delete(entry.record.key);
    if (entry.image) { entry.image.onload = null; entry.image.onerror = null; entry.image.removeAttribute?.("src"); entry.image = null; }
    if (entry.url) { this.urlApi.revokeObjectURL(entry.url); entry.url = null; }
  }

  armIdle() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    if ([...this.entries.values()].some(entry => entry.state === "warm")) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        for (const entry of [...this.entries.values()]) if (entry.state === "warm") this.disposeEntry(entry);
      }, this.idleMs);
      this.idleTimer.unref?.();
    }
  }

  clear() {
    if (this.clearing) return this.job?.done || Promise.resolve();
    this.clearing = true;
    try {
      this.epoch++; clearTimeout(this.idleTimer); this.idleTimer = null;
      const current = this.current; this.current = null;
      this.reject(current); this.reject(this.queued); this.queued = null;
      if (this.job) { this.reject(this.job.request); this.job.request = null; this.job.controller.abort(); }
      this.retireActive();
      for (const entry of [...this.entries.values()]) if (entry.state !== "decoding") this.disposeEntry(entry);
    } finally { this.clearing = false; }
    // A native decode is not abortable. Its single slot/URL remains owned until
    // settlement; future acquire calls replace the one waiting request.
    return this.job?.done || Promise.resolve();
  }

  diagnostics() {
    const entries = [...this.entries.values()];
    return { entries: entries.length, urls: entries.filter(e => e.url).length, activeOwners: this.active ? 1 : 0,
      warm: entries.filter(e => e.state === "warm").length, decodes: this.job?.stage === "decode" ? 1 : 0,
      jobs: this.job ? 1 : 0, queued: this.queued ? 1 : 0,
      activeBodyBytes: this.job && this.job.stage !== "decode" ? this.job.record.asset.bytes : 0,
      pixelBytesEstimate: entries.reduce((n, e) => n + e.record.pixelBytes, 0),
      encodedBytesEstimate: entries.reduce((n, e) => n + e.record.asset.bytes, 0), deactivationErrors: this.deactivationErrors };
  }
}
