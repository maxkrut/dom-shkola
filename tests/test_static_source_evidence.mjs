import test from 'node:test';
import assert from 'node:assert/strict';
import { StaticSourceEvidence } from '../app/static/static-source-evidence.mjs';
import { sourceSvg, sourceViewPoint, sourceViewGeometry, sourceZoomWidth, inlineSourceFragment, bindSourcePageAction } from '../app/static/source-evidence.mjs';

// A small event surface, not a browser/layout substitute. Real SVG generation
// and async owner/lease transitions are exercised; browser checks remain separate.
class Surface extends EventTarget {
  constructor() { super(); this.isConnected = true; this.dataset = {}; this.controls = new Map(); this.clientWidth = 400; }
  set innerHTML(value) {
    for (const nodes of this.controls.values()) for (const node of nodes) node.isConnected = false;
    this.controls.clear(); this.html = value;
  }
  get innerHTML() { return this.html || ''; }
  querySelectorAll(selector) {
    if (this.controls.has(selector)) return this.controls.get(selector);
    const nodes = [];
    if (selector === 'svg') {
      for (const match of this.innerHTML.matchAll(/<svg\b[^]*?<\/svg>/g)) {
        const node = new Surface(); node.remove = () => { this.html = this.html.replace(match[0], ''); }; nodes.push(node);
      }
    } else {
      const attr = /^\[(data-[a-z-]+)\]$/.exec(selector)?.[1];
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      for (const match of this.innerHTML.matchAll(/<(?:button|div|input|select|p)\b([^>]+)>/g)) {
        const attributes = match[1];
        if (attr ? !new RegExp(`\\b${attr}(?:=|\\s|$)`).test(attributes)
          : !cls || !new RegExp(`class="[^"]*\\b${cls}\\b`).test(attributes)) continue;
        const node = new Surface();
        for (const value of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
          node.dataset[value[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value[2];
        }
        nodes.push(node);
      }
    }
    this.controls.set(selector, nodes); return nodes;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus(options) { this.focused = true; this.focusOptions = options; }
  scrollIntoView(options) { this.scrollOptions = options; }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
}
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const helpers = { svg: sourceSvg, sourceViewPoint, sourceViewGeometry, sourceZoomWidth, escape, inlineSourceFragment, bindSourcePageAction,
  schoolLabel: n => `Школа №${n}`, localPdfHref: (raw, page) => `/${raw}#page=${page}` };
function fixture() {
  const calls = [], releases = [], host = new Surface(), spec = { rawFile: 'raw/test.pdf', school: '1', label: 'Дом 10' };
  const plan = { sha256: 'a'.repeat(64), page: { number: 2, width: 600, height: 800 }, crop: [100, 200, 300, 70],
    school: [100, 100, 150, 140], address: [[120, 210, 250, 240]], exact: true, display_rotation: 90,
    contexts: [{ page: { number: 4, width: 800, height: 600 }, crop: [60, 150, 150, 80], school: null,
      address: [[75, 160, 170, 210]], display_rotation: 270, label: 'Продолжение', exact: true }] };
  const api = { documentPage(region, options) {
    const job = pending(); const call = { region, options, ...job }; calls.push(call); return job.promise;
  } };
  const view = new StaticSourceEvidence(host, spec, plan, helpers, api);
  const complete = (index, url = `blob:page-${index}`) => calls[index].resolve({ url, release() { releases.push(index); } });
  return { view, host, plan, calls, releases, complete };
}

test('one full physical image under crop/rotation; contexts remain lazy and use their own frame', async () => {
  const f = fixture();
  try {
    const loading = f.view.load(); assert.equal(f.calls.length, 1);
    f.complete(0); await loading;
    assert.match(f.host.innerHTML, /<image href="blob:page-0" x="0" y="0" width="600" height="800"/);
    assert.match(f.host.innerHTML, /rotate\(90\)/);
    assert.match(f.host.innerHTML, /data-context="0"/);
    assert.equal(f.calls.length, 1, 'context images do not load eagerly');
    assert.equal(f.host.querySelector('.source-crop-button').focused, undefined, 'automatic preview does not steal keyboard focus');
    const zoom = f.host.querySelector('.source-crop-button');
    zoom.dispatchEvent(new Event('click'));
    assert.equal(zoom['aria-expanded'], 'true');
    assert.equal(f.calls.length, 1, 'inline zoom reuses the already displayed image');
    zoom.dispatchEvent(new Event('click'));
    assert.equal(zoom['aria-expanded'], 'false');
    assert.doesNotMatch(f.host.innerHTML, /data-evidence-view="fragment"/);
    f.host.querySelector('[data-context]').dispatchEvent(new Event('click'));
    assert.equal(f.calls[1].region.page.number, 4);
    f.complete(1); await turn();
    assert.match(f.host.innerHTML, /width="800" height="600"/);
    assert.match(f.host.innerHTML, /rotate\(270\)/);
    assert.equal(f.host.querySelector('.source-crop-button').scrollOptions.block, 'start');
    assert.equal(f.host.querySelector('.source-crop-button').focusOptions.preventScroll, true);
    assert.deepEqual(f.releases, [0]);
  } finally { f.view.dispose(); }
});

test('late completion, deactivation and disconnect cannot retain stale SVG or lease', async () => {
  const f = fixture();
  try {
    const old = f.view.load(), latest = f.view.load(f.plan.contexts[0]);
    assert.equal(f.calls[0].options.signal.aborted, true);
    f.complete(0); await old; assert.deepEqual(f.releases, [0]);
    assert(!f.host.innerHTML.includes('blob:page-0'));
    f.complete(1); await latest;
    f.calls[1].options.onDeactivate();
    assert(!f.host.innerHTML.includes('<svg')); assert(f.host.innerHTML.includes('data-load-static-page'));
    const last = f.view.load(); f.host.isConnected = false; f.view.dispose(); f.complete(2); await last;
    assert(!f.host.innerHTML.includes('<svg')); assert.deepEqual(f.releases, [0, 1, 2]);
  } finally { f.view.dispose(); }
});

test('failed image leaves original link and retry, not an invented empty region', async () => {
  const f = fixture();
  try {
    const first = f.view.load(); f.calls[0].reject(new Error('HTTP503')); await first;
    assert.match(f.host.innerHTML, /Не удалось загрузить страницу/);
    assert.match(f.host.innerHTML, /raw\/test.pdf#page=2/);
    f.host.querySelector('.evidence-retry').dispatchEvent(new Event('click'));
    f.complete(1); await turn(); assert.match(f.host.innerHTML, /blob:page-1/);
  } finally { f.view.dispose(); }
});

test('modal owner handoff, profile races, marks and close release their own leases', async () => {
  const original = globalThis.document, dialog = new Surface(), f = fixture();
  globalThis.document = { getElementById: id => id === 'sourceDocumentDialog' ? dialog : null };
  try {
    const initial = f.view.load(); f.complete(0); await initial;
    const trigger = f.host.querySelector('[data-evidence-view]');
    trigger.dispatchEvent(new Event('click'));
    assert.equal(dialog.open, true); assert.notEqual(f.calls[0].options.owner, f.calls[1].options.owner);
    f.calls[0].options.onDeactivate();
    assert.equal(f.calls[1].options.signal.aborted, false, 'modal has an independent controller');
    f.complete(1); await turn();
    const canvas = dialog.querySelector('.source-dialog-canvas');
    assert.match(canvas.innerHTML, /x="0" y="0" width="600" height="800"/);
    assert.equal(canvas.dataset.view, 'page');
    assert.equal(canvas.dataset.fit, 'true', 'the full-page action initially fits the page');
    dialog.querySelectorAll('[data-modal-view]')[0].dispatchEvent(new Event('click'));
    assert.equal(canvas.dataset.fit, 'false', 'the fragment tab uses readable PDF text size');
    const zoom = dialog.querySelector('[data-source-zoom]');
    zoom.value = '2'; zoom.dispatchEvent(new Event('change'));
    assert.equal(f.calls[2].options.profile, 'detail');
    zoom.value = '1'; zoom.dispatchEvent(new Event('change'));
    assert.equal(f.calls[2].options.signal.aborted, true);
    assert.equal(f.calls[3].options.profile, 'preview');
    f.complete(3); await turn(); f.complete(2); await turn();
    assert.equal(canvas.dataset.fit, 'false', 'explicit zoom restores a scrollable fragment');
    assert.match(canvas.innerHTML, /blob:page-3/); assert(!canvas.innerHTML.includes('blob:page-2'));
    const marks = dialog.querySelector('[data-mark-toggle]'); marks.checked = false; marks.dispatchEvent(new Event('change'));
    assert(!canvas.innerHTML.includes('evidence-mark'));
    dialog.querySelectorAll('[data-modal-view]')[1].dispatchEvent(new Event('click'));
    assert.equal(canvas.dataset.view, 'page');
    dialog.querySelector('[data-close-source]').dispatchEvent(new Event('click'));
    assert.equal(dialog.open, false); assert.equal(dialog.innerHTML, '');
    assert.equal(f.host.querySelector('[data-load-static-page]').focused, true, 'keyboard focus returns to the surviving page action');
    assert(f.releases.includes(2) && f.releases.includes(3));
  } finally { f.view.dispose(); globalThis.document = original; }
});

test('replacing the shared modal cannot let its previous owner close or draw over the new one', async () => {
  const original = globalThis.document, dialog = new Surface(), first = fixture(), second = fixture(), trigger = new Surface();
  globalThis.document = { getElementById: () => dialog };
  try {
    first.view.open(first.plan, 'fragment', trigger);
    second.view.open(second.plan.contexts[0], 'page', trigger);
    assert.equal(first.calls[0].options.signal.aborted, true);
    assert.equal(dialog.open, true);
    dialog.dispatchEvent(new Event('close')); // Previous native close task arrives late.
    assert.equal(dialog.open, true);
    second.complete(0, 'blob:new-owner'); await turn();
    first.complete(0, 'blob:stale-owner'); await turn();
    first.calls[0].options.onDeactivate();
    assert.equal(dialog.open, true);
    assert.match(dialog.querySelector('.source-dialog-canvas').innerHTML, /blob:new-owner/);
    assert(!dialog.innerHTML.includes('blob:stale-owner'));
    assert.deepEqual(first.releases, [0]);
    dialog.close(); assert.equal(dialog.innerHTML, ''); assert.deepEqual(second.releases, [0]);
  } finally { first.view.dispose(); second.view.dispose(); globalThis.document = original; }
});

test('direct modal context navigation keeps one image owner and returns to the same row', async () => {
  const original = globalThis.document, dialog = new Surface(), f = fixture(), trigger = new Surface();
  globalThis.document = { getElementById: () => dialog };
  try {
    f.view.open(f.plan, 'fragment', trigger);
    assert.equal(f.calls.length, 1, 'no hidden inline image is loaded first');
    dialog.querySelectorAll('[data-modal-context]')[1].dispatchEvent(new Event('click'));
    assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(f.calls[1].region.page.number, 4);
    f.complete(1, 'blob:context'); await turn();
    f.complete(0, 'blob:stale-main'); await turn();
    assert.match(dialog.querySelector('.source-dialog-canvas').innerHTML, /blob:context/);
    assert(!dialog.querySelector('.source-dialog-canvas').innerHTML.includes('blob:stale-main'));
    dialog.querySelectorAll('[data-modal-context]')[0].dispatchEvent(new Event('click'));
    assert.equal(f.calls[2].region.page.number, 2);
    f.complete(2, 'blob:main'); await turn();
    dialog.close();
    assert.equal(trigger.focused, true);
    assert.deepEqual([...f.releases].sort(), [0, 1, 2]);
    assert(!f.host.innerHTML.includes('<svg'));
  } finally { f.view.dispose(); globalThis.document = original; }
});
