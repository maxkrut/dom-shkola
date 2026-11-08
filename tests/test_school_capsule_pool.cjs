const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
let created = 0, textWrites = 0, attributeWrites = 0, scaleWrites = 0;
function node(tag) {
  if (tag === "button") created++;
  let text = "";
  const classes = new Set();
  return { dataset: {}, style: { setProperty(name) { if (name === "--capsule-scale") scaleWrites++; } }, classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } }, attributes: {}, listeners: {},
    firstElementChild: { get textContent() { return text; }, set textContent(value) { text = value; textWrites++; } }, clientWidth: 1000, clientHeight: 600,
    append(child) { child.parent = this; }, remove() { this.parent = null; },
    setAttribute(name, value) { this.attributes[name] = value; attributeWrites++; }, getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(name, callback) { this.listeners[name] = callback; } };
}
let shift = 0;
const events = {}, map = { getContainer: () => node("div"), on: (name, callback) => events[name] = callback,
  getZoom: () => 10, project: coordinates => ({ x: coordinates[0] + shift, y: coordinates[1] }) };
const context = { console, URL, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  window: {}, document: { documentElement: { dataset: {} }, createElement: node, getElementById: () => ({ value: "" }) }, __map: map };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../app/static/app.js"), "utf8").split("\ninit().catch")[0], context);
const run = source => vm.runInContext(source, context);
run("state.schoolByKey.set('А::1000', {}); selectSchoolByKey=(key, focus)=>{window.selected=key; window.selectedFocus=focus}; window.badges=new SchoolCapsules(__map)");
const badges = context.window.badges;
function features(start, count) {
  return Array.from({ length: count }, (_, i) => ({ geometry: { coordinates: [100 + i % 700, 50] },
    properties: { school_key: `А::${start + i}`, district: "А", school_number: String(start + i) } }));
}
badges.update(features(0, 600), new Set()); badges.render();
assert.equal(created, 600); assert.equal(badges.buttons.size, 600);
const initialTextWrites = textWrites, initialAttributeWrites = attributeWrites;
for (let i = 0; i < 20; i++) badges.render();
assert.equal(textWrites, initialTextWrites, "moving existing badges must not replace unchanged text nodes");
assert.equal(attributeWrites, initialAttributeWrites, "unchanged accessible labels and states must not be rewritten every frame");
assert.equal(scaleWrites, 1, "panning at a fixed scale must not invalidate inherited scale on every badge");
assert.match(badges.buttons.get("А::0").style.transform, /^translate\(100px, 50px\) translate\(-50%, -50%\) scale\(/);
for (let i = 0; i < 20; i++) {
  shift = 2000; badges.render(); assert.equal(badges.buttons.size, 0);
  shift = 0; badges.render(); assert.equal(badges.buttons.size, 600);
}
assert.equal(created, 600, "revisiting the same schools must not allocate new button trees every pan");
shift = 2000; badges.render(); shift = 0;
badges.update(features(1000, 600), new Set(["А::1000"])); badges.render();
assert.equal(created, 600, "offscreen buttons must be reusable by different school identities");
const button = badges.buttons.get("А::1000");
run("state.selectedSchoolKey = 'А::1000'");
badges.render();
assert.equal(badges.buttons.size, 1, "selection leaves only the selected badge");
let stopped = false;
button.listeners.click({ currentTarget: button, stopPropagation() { stopped = true; } });
assert.equal(context.window.selected, "А::1000", "a recycled button must select its current school, not its original closure");
assert.equal(context.window.selectedFocus, false, "a map click must retain the map view");
assert(stopped, "a capsule click must not also select the area beneath it");
assert.equal(button.firstElementChild.textContent, "1000");
assert.equal(button.attributes["aria-pressed"], "true");
const changed = badges.features.find(feature => feature.properties.school_key === "А::1000");
changed.properties.school_number = "new-number";
changed.properties.canonical_school_name = "Новое название";
run("state.selectedSchoolKey = ''");
badges.active = new Set(); badges.render();
assert(badges.buttons.has("А::1001"), "clearing selection restores other badges");
assert.equal(button.firstElementChild.textContent, "new-number");
assert.equal(button.attributes["aria-label"], "Новое название · А");
assert.equal(button.attributes["aria-pressed"], "false");
badges.update(features(2000, 2000), new Set()); badges.render(); shift = 2000; badges.render();
assert.equal(badges.buttons.size, 0);
assert(badges.buttonPool.length <= 768, "recycling cache must remain bounded even for a larger future city");
events.remove();
assert.equal(badges.buttons.size, 0); assert.equal(badges.buttonPool.length, 0);

test("map selection opens immediately and ignores stale completion", async () => {
  run(`
    state.schoolByKey.set('А::1001', {});
    window.pendingSelections = new Map();
    window.selectionCalls = [];
    window.revealCount = 0;
    window.schoolCompactShell = {revealSelection() { window.revealCount++; }};
    selectSchoolByKey = (key, focus) => {
      state.selectionRequestToken++;
      window.selectionCalls.push({key, focus});
      return new Promise(resolve => window.pendingSelections.set(key, resolve));
    };
  `);
  await run("selectSchoolFromMap('unknown')");
  assert.equal(context.window.selectionCalls.length, 0);
  const older = run("selectSchoolFromMap('А::1000')");
  const newer = run("selectSchoolFromMap('А::1001')");
  assert.equal(context.window.selectionCalls.length, 2);
  assert.equal(context.window.selectionCalls[1].focus, false);
  assert.equal(context.window.revealCount, 2, "each valid click must immediately open the sidebar");
  context.window.pendingSelections.get("А::1000")();
  await older;
  assert.equal(context.window.revealCount, 2, "a stale response must not reopen the sidebar");
  context.window.pendingSelections.get("А::1001")();
  await newer;
  assert.equal(context.window.revealCount, 3, "the current selection must reveal its completed result");
});
console.log("School capsule pool passed: 20 revisits allocate no extra buttons; reused IDs, labels, actions and ARIA remain correct; cache and teardown are bounded.");
