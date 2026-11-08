/* Worker-local immutable JSON transport. Limits cover cache and active response bodies. */
const abort = signal => signal?.throwIfAborted();

function decodedWeight(value, limit) {
  const pending = [value];
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") bytes += 24 + item.length * 2;
    else if (item && typeof item === "object") {
      const array = Array.isArray(item);
      const entries = Object.entries(item);
      bytes += (array ? 32 : 64) + entries.length * 8;
      for (const [key, child] of entries) {
        if (!array) bytes += 24 + key.length * 2;
        pending.push(child);
      }
    } else bytes += 8;
    if (bytes > limit || pending.length * 8 > limit) throw new Error("Пакет данных превышает допустимый объём");
  }
  return bytes;
}

export class StaticJsonReader {
  constructor({ root, fetch: fetcher = fetch, maxObjectBytes = 512 * 1024,
    maxCacheBytes = 16 * 1024 * 1024, maxActiveBytes = 1024 * 1024, maxConcurrent = 6, maxQueued = 256 } = {}) {
    this.root = new URL(root);
    if (![maxObjectBytes, maxCacheBytes, maxActiveBytes, maxConcurrent, maxQueued].every(value => Number.isSafeInteger(value) && value > 0)
        || maxObjectBytes > maxActiveBytes || maxConcurrent > 16 || maxQueued > 1024 || !["http:", "https:"].includes(this.root.protocol)) throw new Error("Некорректные ограничения статических данных");
    Object.assign(this, { fetcher: fetcher.bind(globalThis), maxObjectBytes, maxCacheBytes, maxActiveBytes, maxConcurrent, maxQueued });
    this.cache = new Map(); this.cacheBytes = 0; this.activeBytes = 0; this.active = 0; this.queue = []; this.generation = 0;
  }

  acquire(bytes, signal) {
    abort(signal);
    if (this.queue.length >= this.maxQueued) throw new Error("Слишком много данных. Уточните адрес.");
    return new Promise((resolve, reject) => {
      const request = { bytes, signal, resolve, reject };
      request.cancel = () => {
        const index = this.queue.indexOf(request);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
        this.drain();
      };
      signal?.addEventListener("abort", request.cancel, { once: true });
      this.queue.push(request); this.drain();
    });
  }

  drain() {
    while (this.queue.length && this.active < this.maxConcurrent) {
      const next = this.queue[0];
      if (this.activeBytes + next.bytes > this.maxActiveBytes) break;
      this.queue.shift(); next.signal?.removeEventListener("abort", next.cancel);
      this.active++; this.activeBytes += next.bytes;
      next.resolve(() => { this.active--; this.activeBytes -= next.bytes; this.drain(); });
    }
  }

  cached(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    this.cache.delete(key); this.cache.set(key, entry);
    return entry;
  }

  async read(record, { signal } = {}) {
    abort(signal);
    const generation = this.generation;
    if (!record || !/^[a-f0-9]{64}$/.test(record.sha256 || "") || !Number.isSafeInteger(record.bytes)
        || record.bytes < 1 || record.bytes > this.maxObjectBytes || typeof record.path !== "string"
        || !/^[a-zA-Z0-9_./-]+$/.test(record.path) || record.path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Некорректная ссылка статических данных");
    const key = `${record.sha256}:${record.bytes}`;
    const hit = this.cached(key);
    if (hit) return hit.value;
    const release = await this.acquire(record.bytes, signal);
    try {
      abort(signal);
      const ready = this.cached(key);
      if (ready) return ready.value;
      const url = new URL(record.path, this.root);
      url.searchParams.set("revision", record.sha256);
      const response = await this.fetcher(url.href, { signal, cache: "force-cache" });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* Preserve the HTTP error. */ }
        throw new Error(`Не удалось загрузить данные (${response.status})`);
      }
      const buffer = new Uint8Array(record.bytes);
      const reader = response.body?.getReader();
      let offset = 0;
      try {
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            abort(signal);
            if (done) break;
            if (offset + value.byteLength > record.bytes) throw new Error("Размер пакета данных изменился");
            buffer.set(value, offset); offset += value.byteLength;
          }
        } else {
          const value = new Uint8Array(await response.arrayBuffer());
          if (value.byteLength !== record.bytes) throw new Error("Размер пакета данных изменился");
          buffer.set(value); offset = value.byteLength;
        }
      } finally {
        if (reader) { try { await reader.cancel(); } finally { reader.releaseLock(); } }
      }
      if (offset !== record.bytes) throw new Error("Размер пакета данных изменился");
      abort(signal);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      abort(signal);
      if (digest !== record.sha256) throw new Error("Данные изменились. Обновите страницу.");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      const weight = record.bytes + decodedWeight(value, this.maxCacheBytes - record.bytes);
      abort(signal);
      // A clear invalidates cache writes already in flight, but the caller may
      // still consume its verified result if it did not cancel the request.
      if (generation !== this.generation) return value;
      // Independent readers can finish the same immutable object concurrently.
      const previous = this.cache.get(key);
      if (previous) { this.cacheBytes -= previous.weight; this.cache.delete(key); }
      while (this.cache.size && this.cacheBytes + weight > this.maxCacheBytes) {
        const oldest = this.cache.keys().next().value;
        this.cacheBytes -= this.cache.get(oldest).weight; this.cache.delete(oldest);
      }
      this.cache.set(key, { value, weight }); this.cacheBytes += weight;
      return value;
    } finally { release(); }
  }

  clear() { this.generation++; this.cache.clear(); this.cacheBytes = 0; }
  diagnostics() { return { cacheBytesEstimate: this.cacheBytes, cacheEntries: this.cache.size, activeBodyBytes: this.activeBytes, activeRequests: this.active, queuedRequests: this.queue.length }; }
}
