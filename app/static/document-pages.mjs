/* Physical PDF page assets; regions and presentation rotations never change this frame. */
import { StaticJsonReader } from './static-json-reader.mjs?v=20261108-state-fixes';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const valid = (condition, message = 'Некорректные данные страницы документа') => { if (!condition) throw new Error(message); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const raw = value => typeof value === 'string' && value.startsWith('raw/') && value.endsWith('.pdf')
  && !/[\\?#\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const aliases = value => Array.isArray(value) && value.length > 0 && value.length <= 256
  && value.every(raw) && new Set(value).size === value.length;
const dimensions = value => object(value) && [value.width, value.height].every(n => Number.isFinite(n) && n > 0 && n <= 100000);
const reference = value => object(value) && sha(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0
  && typeof value.path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(value.path)
  && value.path.split('/').every(part => part && part !== '.' && part !== '..');

export class StaticDocumentPages {
  constructor({ root, descriptor, fetch: fetcher, poolFactory } = {}) {
    valid(descriptor?.schema === 1 && reference(descriptor.manifest) && descriptor.manifest.bytes <= 512 * 1024);
    this.descriptor = descriptor;
    this.root = new URL('.', new URL(descriptor.manifest.path, root));
    this.pointerReader = new StaticJsonReader({ root, maxCacheBytes: 4 * 1024 * 1024, ...(fetcher ? { fetch: fetcher } : {}) });
    this.reader = new StaticJsonReader({ root: this.root, maxCacheBytes: 4 * 1024 * 1024, ...(fetcher ? { fetch: fetcher } : {}) });
    this.fetcher = fetcher; this.poolFactory = poolFactory; this.generation = 0; this.requestTicket = 0;
  }

  async resolve(region, profile = 'preview', { signal } = {}) {
    signal?.throwIfAborted();
    valid(['preview', 'detail'].includes(profile) && sha(region?.sha256) && raw(region.source_raw_file)
      && dimensions(region.page) && Number.isSafeInteger(region.page.number) && region.page.number > 0);
    const manifest = await this.pointerReader.read(this.descriptor.manifest, { signal });
    valid(manifest?.schema === 1 && manifest.kind === 'school_document_pages' && manifest.reference_base === 'root_manifest'
      && object(manifest.documents) && object(manifest.source_aliases));
    const declared = new Map();
    for (const [digest, entry] of Object.entries(manifest.documents)) {
      valid(sha(digest) && object(entry) && reference(entry.manifest) && aliases(entry.source_raw_files));
      for (const file of entry.source_raw_files) {
        valid(!declared.has(file) && manifest.source_aliases[file] === digest);
        declared.set(file, digest);
      }
    }
    valid(Object.keys(manifest.source_aliases).length === declared.size
      && Object.entries(manifest.source_aliases).every(([file, digest]) => declared.get(file) === digest));
    const entry = manifest.documents[region.sha256];
    valid(entry && declared.get(region.source_raw_file) === region.sha256, 'Страница не относится к выбранному оригиналу');
    const document = await this.reader.read(entry.manifest, { signal });
    valid(document?.schema === 1 && document.kind === 'school_document_pages_document' && document.reference_base === 'root_manifest'
      && document.sha256 === region.sha256 && aliases(document.source_raw_files)
      && document.source_raw_files.length === entry.source_raw_files.length
      && document.source_raw_files.every(file => entry.source_raw_files.includes(file)) && object(document.pages));
    const numbers = Object.keys(document.pages);
    valid(numbers.length > 0 && numbers.length <= 10000
      && numbers.every(n => /^[1-9]\d*$/.test(n) && Number.isSafeInteger(Number(n))));
    const page = document.pages[String(region.page.number)];
    valid(dimensions(page) && page.number === region.page.number && page.width === region.page.width && page.height === region.page.height
      && object(page.renditions), 'Размер или номер страницы отличается от разметки');
    const rendition = page.renditions[profile];
    valid(object(rendition) && rendition.mime === 'image/webp' && reference(rendition.asset)
      && rendition.asset.bytes <= 8 * 1024 * 1024 && dimensions(rendition)
      && Number.isSafeInteger(rendition.width) && Number.isSafeInteger(rendition.height)
      && Math.max(rendition.width, rendition.height) <= 3000 && rendition.width * rendition.height <= 9000000
      && Math.abs(rendition.width * page.height - rendition.height * page.width) <= Math.max(page.width, page.height));
    signal?.throwIfAborted();
    return { sourceSha: region.sha256, page: page.number, asset: { ...rendition.asset },
      width: rendition.width, height: rendition.height, mime: rendition.mime };
  }

  async acquire(region, { profile = 'preview', signal, owner, onDeactivate } = {}) {
    signal?.throwIfAborted();
    this.pending?.abort();
    const controller = new AbortController(), ticket = ++this.requestTicket, generation = this.generation;
    this.pending = controller;
    const forward = () => controller.abort(signal.reason);
    const unlink = () => signal?.removeEventListener('abort', forward);
    signal?.addEventListener('abort', forward, { once: true });
    const current = () => {
      controller.signal.throwIfAborted();
      if (generation !== this.generation || ticket !== this.requestTicket) throw new DOMException('Просмотр страницы отменён', 'AbortError');
    };
    let leased = false;
    try {
      const asset = await this.resolve(region, profile, { signal: controller.signal }); current();
      if (!this.pool) {
        const factory = this.poolFactory || ((options) => new this.Pool(options));
        if (!this.poolFactory) this.Pool = (await import('./document-page-pool.mjs')).PageAssetPool;
        current();
        if (!this.pool) this.pool = factory({ root: this.root, ...(this.fetcher ? { fetch: this.fetcher } : {}) });
      }
      current();
      const lease = await this.pool.acquire(asset, { signal: controller.signal, owner,
        onDeactivate: () => { unlink(); onDeactivate?.(); } });
      try { current(); } catch (error) { lease.release(); throw error; }
      leased = true;
      return { url: lease.url, release() { unlink(); lease.release(); } };
    } finally {
      if (this.pending === controller) this.pending = null;
      if (!leased) unlink();
    }
  }

  clear() { this.generation++; this.requestTicket++; this.pending?.abort(); this.pending = null;
    this.pointerReader.clear(); this.reader.clear(); return this.pool?.clear(); }
  diagnostics() { return { metadata: this.reader.diagnostics(), pointer: this.pointerReader.diagnostics(), images: this.pool?.diagnostics?.() || null }; }
}
