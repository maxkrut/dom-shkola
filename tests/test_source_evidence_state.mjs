import assert from 'node:assert/strict';
import { test } from 'node:test';

test('invalid source metadata produces a visible error in inline and modal views', async () => {
  const previous = { HTMLElement:globalThis.HTMLElement, customElements:globalThis.customElements, document:globalThis.document };
  let Evidence;
  class Element {
    constructor() { this.innerHTML = ''; this.attributes = new Map(); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    setAttribute(name, value) { this.attributes.set(name, value); }
  }
  const dialog = {innerHTML:'', opened:false, addEventListener() {}, removeEventListener() {},
    querySelector() { return {addEventListener() {}}; }, showModal() { this.opened = true; }};
  globalThis.HTMLElement = Element;
  globalThis.customElements = {get() { return null; }, define(name, constructor) { if (name === 'source-evidence') Evidence = constructor; }};
  globalThis.document = {addEventListener() {}, getElementById() { return dialog; }};
  try {
    await import('../app/static/source-evidence.mjs?invalid-source-state-test');
    const inline = new Evidence(); inline.setAttribute('data-source', '{broken'); inline.connectedCallback();
    assert.match(inline.innerHTML, /Не удалось открыть фрагмент/);
    assert.match(inline.innerHTML, /role="alert"/);
    inline.setAttribute('data-source', 'null'); await inline.prepare(inline.ticket);
    assert.match(inline.innerHTML, /Обновите страницу/);
    const modal = new Evidence(); modal.setAttribute('data-modal-only', ''); modal.setAttribute('data-source', '[');
    modal.connectedCallback();
    assert(dialog.opened);
    assert.match(dialog.innerHTML, /Не удалось открыть фрагмент/);
  } finally {
    for (const [key,value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
