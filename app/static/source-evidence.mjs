/* PDF images remain unchanged; SVG overlays are separate from the source. */
import {localPdfHref, planEvidence} from "./document-region-planner.mjs";
const assetRoot = new URL("./source-previews/", import.meta.url);
let indexPromise;
const documentCache = new Map();
let staticAutoOwner = null;
let modalEvidenceHost = null;
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
const rect = (box, kind) => box ? `<rect class="evidence-mark ${kind}" x="${box[0]-1}" y="${box[1]-1}" width="${box[2]-box[0]+2}" height="${box[3]-box[1]+2}"/>` : "";
const schoolLabel = value => {
  const name = String(value ?? "").trim().replace(/^№\s*/, "");
  return /^\d+$/.test(name) ? `Школа №${name}` : name || "Школа";
};

export function inlineSourceFragment(image, label) {
  return `<div class="source-crop-frame"><div class="source-crop-viewport"><button type="button" class="source-crop-button" aria-expanded="false" aria-label="Увеличить фрагмент: ${escape(label)}" title="Увеличить фрагмент">${image}</button></div><span class="source-crop-lens" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10" cy="10" r="6"/><path d="m14.5 14.5 5 5M7 10h6"/><path class="source-crop-plus" d="M10 7v6"/></svg></span></div>`;
}

export function bindInlineSourceFragment(host, label) {
  const button = host.querySelector('.source-crop-button');
  const viewport = host.querySelector('.source-crop-viewport');
  let expanded = false;
  function setExpanded(value) {
    expanded = value;
    const action = expanded ? 'Вернуть обычный размер' : 'Увеличить фрагмент';
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', `${action}: ${label}`);
    button.title = action;
    if (!expanded) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
  }
  button.addEventListener('click', () => setExpanded(!expanded));
  return (image, nextLabel) => {
    button.innerHTML = image;
    label = nextLabel;
    setExpanded(false);
  };
}

export function bindSourcePageAction(host, label, openPage, renderPage) {
  const setFragment = bindInlineSourceFragment(host, label);
  const action = host.querySelector('[data-evidence-view]');
  if (!host.closest?.('#address-document-evidence, #school-history-panel')) {
    action.addEventListener('click', () => openPage(action));
    return;
  }
  // Sidebar evidence uses one viewer for both the crop and the page.
  const fragment = host.querySelector('.source-crop-button').innerHTML;
  const caption = host.querySelector('.address-caption');
  const fragmentCaption = caption.textContent;
  let fullPage = false;
  action.textContent = 'Вся страница';
  action.addEventListener('click', () => {
    fullPage = !fullPage;
    setFragment(fullPage ? renderPage() : fragment, fullPage ? 'страница документа' : label);
    caption.textContent = fullPage ? 'Страница документа' : fragmentCaption;
    action.textContent = fullPage ? 'Вернуться к фрагменту' : 'Вся страница';
  });
}

export {localPdfHref, planEvidence} from "./document-region-planner.mjs";

function originalDocumentLink(spec, page) {
  const link = globalThis.window?.schoolViewerApi?.originalDocument?.(spec.rawFile, spec.sha256 || '', page);
  if (link) return link.url
    ? `<a href="${escape(link.url)}" target="_blank" rel="noopener noreferrer" title="${escape(link.note || '')}">${escape(link.label)} ↗</a>`
    : `<span class="evidence-note">${escape(link.label)}</span>`;
  return `<a href="${escape(localPdfHref(spec.rawFile, page))}" target="_blank" rel="noopener">Открыть исходный PDF ↗</a>`;
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Source preview unavailable");
  return response.json();
}

async function loadDocument(spec) {
  if (!indexPromise) indexPromise = json(new URL("index.json",assetRoot)).catch(error=>{indexPromise=null; throw error;});
  const index = await indexPromise;
  const entry = index.documents?.[spec.rawFile];
  if (!entry || !/^[a-f0-9]{64}\/document\.json$/.test(entry.manifest)) return null;
  if (spec.sha256 && spec.sha256 !== entry.sha256) return null;
  if (!documentCache.has(entry.manifest)) {
    if (documentCache.size >= 4) documentCache.delete(documentCache.keys().next().value);
    documentCache.set(entry.manifest, json(new URL(entry.manifest,assetRoot)).catch(error=>{documentCache.delete(entry.manifest); throw error;}));
  }
  return documentCache.get(entry.manifest);
}

// Presentation-only rotations of immutable originals; all region boxes stay in the physical PDF frame.
const DOCUMENT_DISPLAY = {"raw/districts/kalininsky/Калининский_194-р_05.03.2026.pdf":{"sha256":"6384e00b47673469c05b18cf03041c0d049c934b3f56e89dfb0d76c41f4becc2","pages":{"1":0,"2":90,"3":90,"4":90,"5":90,"6":90,"7":90,"8":90,"9":90,"10":90,"11":90}},"raw/districts/kalininsky/Калининский_229-р_2025.pdf":{"sha256":"330439eeab8f6144dc86101f75d670b1be848bd8d94b3b7c50886393b5a1f9b0","pages":{"1":0,"2":90,"3":90,"4":90,"5":90,"6":90,"7":90,"8":90,"9":90,"10":90,"11":90}},"raw/districts/kalininsky/Калининский_Микрорайоны_2025.pdf":{"sha256":"2a14086915cc2fc3161826c11fe80481656a5ed6adcc4c49aa44e242e1da90ad","pages":{"1":0,"2":90,"3":90,"4":90,"5":90,"6":90,"7":90,"8":90,"9":90,"10":90,"11":90,"12":0,"13":90}}};

export function sourceViewGeometry(view, rotation = 0) {
  if (!Array.isArray(view) || view.length !== 4 || !view.every(Number.isFinite)
      || view[2] <= 0 || view[3] <= 0 || ![0,90,180,270].includes(rotation)) throw new Error("Invalid source display frame");
  const [x,y,w,h] = view;
  if (!rotation) return {viewBox:view, transform:null};
  const [width,height,translation] = rotation === 90 ? [h,w,`${h} 0`]
    : rotation === 180 ? [w,h,`${w} ${h}`] : [h,w,`0 ${w}`];
  return {viewBox:[0,0,width,height], transform:`translate(${translation}) rotate(${rotation}) translate(${-x} ${-y})`};
}

export function sourceZoomWidth(crop, rotation, zoom) {
  const width = sourceViewGeometry(crop, rotation).viewBox[2];
  if (zoom === 'fit') return '100%';
  // PDF coordinates are points. 1.6 CSS px per point keeps typical 9-10 pt
  // document text readable; SVG preserves the original aspect ratio.
  return `max(100%, ${Math.ceil(width * (zoom === 'readable' ? 1.6 : 4 / 3 * Number(zoom)))}px)`;
}

export function sourceViewPoint(point, view, rotation = 0) {
  sourceViewGeometry(view,rotation);
  const [x,y,w,h] = view, [px,py] = point;
  return rotation === 90 ? [h-(py-y),px-x] : rotation === 180 ? [w-(px-x),h-(py-y)]
    : rotation === 270 ? [py-y,w-(px-x)] : [px-x,py-y];
}

export function bindSourceDisplay(plan, spec) {
  const display = spec.display || DOCUMENT_DISPLAY[spec.rawFile];
  if (!display) return plan;
  if (!/^[a-f0-9]{64}$/.test(display.sha256 || "") || display.sha256 !== spec.sha256
      || plan.sha256 && display.sha256 !== plan.sha256 || !display.pages
      || Object.entries(display.pages).some(([page,angle])=>!/^\d+$/.test(page) || Number(page)<1
        || String(Number(page))!==page || ![0,90,180,270].includes(angle))) throw new Error("Source display refers to another original");
  const rotate = item => ({...item, display_rotation:display.pages[String(item.page.number)] || 0});
  return {...rotate(plan), contexts:(plan.contexts || []).map(rotate)};
}

function svg(plan, image, view, label, marks = true, imageView = null) {
  const [x,y,w,h] = imageView || [0,0,plan.page.width,plan.page.height];
  const geometry = sourceViewGeometry(view,plan.display_rotation || 0);
  const content = `<image href="${escape(image)}" x="${x}" y="${y}" width="${w}" height="${h}"/>${marks ? rect(plan.school,"school-mark")+plan.address.map(box=>rect(box,"address-mark")).join("") : ""}`;
  return `<svg class="source-page-image" viewBox="${geometry.viewBox.join(" ")}" role="img" aria-label="${escape(label)}">${geometry.transform ? `<g transform="${geometry.transform}">${content}</g>` : content}</svg>`;
}

export {svg as sourceSvg};

class SourceEvidence extends (globalThis.HTMLElement || class {}) {
  connectedCallback() {
    this.ticket = (this.ticket || 0) + 1;
    let invalidSpec = false;
    try {
      this.spec = JSON.parse(this.getAttribute("data-source") || "{}");
      if (!this.spec || typeof this.spec !== 'object' || Array.isArray(this.spec)) throw new Error('Invalid source');
    }
    catch { this.spec = {}; invalidSpec = true; }
    if (this.hasAttribute('data-modal-only')) {
      this.dialog = document.getElementById('sourceDocumentDialog');
      if (!this.dialog) return;
      this.onDialogClose = () => {
        if (this.dialog.open || modalEvidenceHost !== this) return;
        modalEvidenceHost = null;
        this.remove();
        if (this.trigger?.isConnected) this.trigger.focus();
      };
      this.dialog.addEventListener('close', this.onDialogClose);
      this.showMessage(invalidSpec ? '<p class="evidence-note" role="alert">Не удалось открыть фрагмент. Обновите страницу и попробуйте снова.</p>'
        : '<p class="evidence-note" role="status">Загружаем фрагмент документа…</p>');
      this.dialog.showModal();
      if (!invalidSpec) this.prepare(this.ticket);
      return;
    }
    if (invalidSpec) {
      this.showMessage('<p class="evidence-note" role="alert">Не удалось открыть фрагмент. Обновите страницу и попробуйте снова.</p>');
      return;
    }
    // A user-opened information popup contains exactly one selected fragment.
    const eager = this.hasAttribute('data-eager');
    const deferStatic = !eager && globalThis.window?.schoolViewerApi?.isStaticDelivery && staticAutoOwner?.isConnected && staticAutoOwner !== this;
    if ((this.spec.mode !== 'school' || eager) && !deferStatic && globalThis.window?.schoolViewerApi?.isStaticDelivery) staticAutoOwner = this;
    if ((this.spec.mode === "school" && !eager) || deferStatic) {
      this.innerHTML = '<button type="button" class="text-button" data-load-evidence>Показать фрагмент документа</button>';
      this.querySelector("[data-load-evidence]").addEventListener("click",()=>this.prepare(this.ticket));
      return;
    }
    this.prepare(this.ticket);
  }
  disconnectedCallback() {
    if (staticAutoOwner === this) staticAutoOwner = null;
    this.ticket = (this.ticket || 0) + 1;
    this.controller?.abort();
    this.staticView?.dispose(); this.staticView = null;
    this.dialog?.removeEventListener('close', this.onDialogClose);
  }
  showMessage(html) {
    if (!this.dialog) { this.innerHTML = html; return this; }
    this.dialog.innerHTML = `<header class="source-dialog-head"><h2 id="sourceDocumentTitle">${escape(this.spec.title || 'Документ')}</h2><button class="icon-button" type="button" data-close-source aria-label="Закрыть документ">×</button></header><div class="source-dialog-canvas">${html}</div>`;
    this.dialog.querySelector('[data-close-source]').addEventListener('click', () => this.dialog.close());
    return this.dialog;
  }
  async prepare(ticket) {
    try {
      this.spec = JSON.parse(this.getAttribute("data-source") || "{}");
      if (!this.spec || typeof this.spec !== 'object' || Array.isArray(this.spec)) throw new Error('Invalid source');
    }
    catch {
      this.spec = {};
      this.showMessage('<p class="evidence-note" role="alert">Не удалось открыть фрагмент. Обновите страницу и попробуйте снова.</p>');
      return;
    }
    const spec = this.spec;
    this.staticView?.dispose(); this.staticView = null;
    const href = localPdfHref(spec.rawFile, Number(spec.page));
    if (!href) { this.showMessage('<p class="evidence-note">Источник документа не указан.</p>'); return; }
    this.innerHTML = '<p class="evidence-note" role="status">Загружаем страницу документа…</p>';
    try {
      this.controller?.abort();
      this.controller = new AbortController();
      let document, plan;
      if (globalThis.window?.schoolViewerApi) {
        if (!/^[a-f0-9]{32}$/.test(spec.regionId || "")) throw new Error("No registered source region");
        const endpoint = new URL(`../../api/document-regions/${spec.regionId}`, import.meta.url);
        const region = await globalThis.window.schoolViewerApi.documentRegion(spec.regionId, { signal: this.controller.signal });
        if (!this.isConnected || ticket !== this.ticket) return;
        if (region.id === spec.regionId && region.source_raw_file === spec.rawFile && region.available === false) {
          this.showMessage(`<p class="evidence-note">В записи нет привязки к физической странице PDF. ${originalDocumentLink(spec, Number(spec.page))}</p>`);
          return;
        }
        if (region.id !== spec.regionId || region.source_raw_file !== spec.rawFile
            || Number(spec.page) !== region.page?.number || spec.sha256 && spec.sha256 !== region.sha256
            || !/^[a-f0-9]{64}$/.test(region.sha256 || "") || !/^[a-f0-9]{64}$/.test(region.version || "")) throw new Error("Source region changed");
        document = region;
        plan = region;
        this.region = region;
        if (globalThis.window.schoolViewerApi.isStaticDelivery) {
          this.plan = bindSourceDisplay(plan, {...spec, sha256:region.sha256});
          const { StaticSourceEvidence } = await import('./static-source-evidence.mjs?v=20261106-rule-scope');
          if (!this.isConnected || ticket !== this.ticket) return;
          this.staticView = new StaticSourceEvidence(this, spec, this.plan,
            { svg, escape, localPdfHref, originalDocumentLink, schoolLabel, sourceViewPoint, sourceViewGeometry, sourceZoomWidth,
              inlineSourceFragment, bindSourcePageAction }, globalThis.window.schoolViewerApi);
          if (this.dialog) this.staticView.open(this.plan, 'fragment', this.trigger);
          else await this.staticView.load();
          return;
        }
        this.imageUrl = (kind) => {
          const url = new URL(endpoint.href + "/image");
          url.searchParams.set("view", kind);
          url.searchParams.set("version", region.version);
          return url.href;
        };
      } else {
        document = await loadDocument(spec);
        plan = document && planEvidence(spec,document);
      }
      if (!this.isConnected || ticket !== this.ticket) return;
      if (!plan) {
        this.showMessage(`<p class="evidence-note">${Number.isInteger(Number(spec.page)) && Number(spec.page) > 0 ? "Вырезка пока недоступна." : "В записи не указана страница PDF."} ${originalDocumentLink(spec, Number(spec.page))}</p>`);
        return;
      }
      plan = bindSourceDisplay(plan,{...spec,sha256:document.sha256});
      this.plan = plan;
      if (this.region && !plan.crop) {
        this.image = this.imageUrl("page");
        if (this.dialog) { this.open('page', this.trigger); return; }
        this.innerHTML = '<p class="evidence-note">Для этой записи пока не размечен фрагмент строки.</p><button type="button" class="text-button" data-open-page>Открыть страницу документа</button>';
        this.querySelector("[data-open-page]").addEventListener("click",(event)=>this.open("page",event.currentTarget));
        return;
      }
      this.image = this.region ? this.imageUrl("address") : new URL(`${document.sha256}/${plan.page.image}`,assetRoot).href;
      if (!this.region && !/^page-\d+\.webp$/.test(plan.page.image)) throw new Error("Invalid image path");
      await new Promise((resolve,reject)=>{
        const image = new Image();
        image.onload = resolve;
        image.onerror = reject;
        image.src = this.image;
      });
      if (!this.isConnected || ticket !== this.ticket) return;
      if (this.dialog) { this.open('fragment', this.trigger); return; }
      const schoolCrop = this.region ? plan.school_crop : plan.school ? [plan.school[0]-5,plan.school[1]-5,plan.school[2]-plan.school[0]+10,plan.school[3]-plan.school[1]+10] : null;
      const view = plan.crop || [0,0,plan.page.width,plan.page.height];
      const schoolImage = this.region && schoolCrop ? this.imageUrl("school") : this.image;
      const fragmentLabel = spec.label || spec.street || 'строка закрепления';
      this.innerHTML = `<div class="source-snippet">
        ${schoolCrop ? `<span class="snippet-caption school-caption">Школа в документе</span>${svg(plan,schoolImage,schoolCrop,`${schoolLabel(spec.school)} в исходном PDF`,true,this.region ? schoolCrop : null)}` : ""}
        <span class="snippet-caption address-caption">${!plan.crop ? "Страница документа" : spec.mode === "school" ? "Пример строки закрепления" : spec.rule ? "Правило закрепления" : "Адрес в документе"}</span>
        ${inlineSourceFragment(svg(plan,this.image,view,"Настоящий фрагмент PDF с отмеченным текстом источника",true,this.region ? view : null), fragmentLabel)}
        ${(plan.contexts || []).map((context,index) => `<div class="source-continuation"><span class="snippet-caption">${escape(String(context.label || "Продолжение строки документа").replace(/[\u2013\u2014]/gu,'-'))}</span>${svg(context,this.imageUrl(`context:${index}`),context.crop,context.label || "Контекст привязки на другой странице",true,context.crop)}<a href="${escape(localPdfHref(spec.rawFile,context.page.number))}" target="_blank" rel="noopener">Страница ${context.page.number} исходного PDF ↗</a></div>`).join("")}
        ${spec.mode === "school" && spec.label ? `<p class="evidence-note">${escape(spec.label)}</p>` : ""}
        ${spec.parallel ? '<p class="evidence-note">Фрагмент параллельного официального PDF. Исходная таблица доступна в ссылках на источник.</p>' : ""}
        ${spec.fromFifthGrade ? '<p class="evidence-note">Список относится к приёму с 5-го класса.</p>' : spec.rule ? '<p class="evidence-note">В документе указано общее правило; отдельный дом может не перечисляться.</p>' : ""}
        ${!plan.exact && spec.mode !== "school" ? '<p class="evidence-note">Показан контекст строки. Номер дома отдельно не выделен.</p>' : ""}
      </div><div class="evidence-actions"><button type="button" class="text-button" data-evidence-view="page">Вся страница ↗</button></div>`;
      bindSourcePageAction(this, fragmentLabel, trigger => this.open('page', trigger),
        () => svg(plan, this.region ? this.imageUrl('page') : this.image, [0, 0, plan.page.width, plan.page.height], 'Страница исходного PDF'));
    } catch {
      if (!this.isConnected || ticket !== this.ticket) return;
      const surface = this.showMessage(`<p class="evidence-note">Не удалось загрузить вырезку. ${originalDocumentLink(spec, Number(spec.page))} <button class="evidence-retry" type="button">Повторить</button></p>`);
      surface.querySelector(".evidence-retry")?.addEventListener("click",()=>this.prepare(++this.ticket));
    }
  }
  open(view, trigger) {
    const dialog = document.getElementById("sourceDocumentDialog");
    if (!dialog) return;
    const spec = this.spec, plan = this.plan;
    let showMarks = true;
    let zoom = view === 'fragment' ? 'readable' : 'fit';
    const file = spec.rawFile.split("/").at(-1);
    dialog.innerHTML = `<header class="source-dialog-head"><div><p class="snippet-caption">Исходный документ</p><h2 id="sourceDocumentTitle">${escape(spec.title || "Документ закрепления")}</h2><p class="source-document-meta"><span class="source-filename" title="${escape(file)}">${escape(file)}</span><span>Страница ${plan.page.number}</span></p></div><button class="icon-button" type="button" data-close-source aria-label="Закрыть документ">×</button></header>
      <div class="source-dialog-tools"><div class="evidence-view-switch"><button type="button" data-modal-view="fragment">Фрагмент</button><button type="button" data-modal-view="page">Вся страница</button></div><label><input type="checkbox" data-mark-toggle checked> Подсветка</label><label>Масштаб <select data-source-zoom><option value="readable">Для чтения</option><option value="fit">По ширине</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></label></div><p class="source-pan-hint" hidden>Прокрутите фрагмент влево или вправо, чтобы увидеть всю строку.</p>
      <div class="source-dialog-canvas" tabindex="0" aria-label="Страница PDF. Увеличенный фрагмент можно прокручивать."></div><footer class="source-dialog-foot"><span>${plan.school || plan.address.length ? "Школа выделена зелёным, адрес жёлтым." : "Исходная страница без подсветки."}</span><a href="${escape(localPdfHref(spec.rawFile,plan.page.number))}" target="_blank" rel="noopener">Открыть исходный PDF ↗</a></footer>`;
    const draw = () => {
      const crop = view === "page" ? [0,0,plan.page.width,plan.page.height] : this.region ? (plan.crop || [0,0,plan.page.width,plan.page.height]) : plan.crop ? [Math.max(0,Math.min(plan.crop[0],plan.school?.[0] ?? plan.crop[0])-8),Math.max(0,Math.min(plan.crop[1],plan.school?.[1] ?? plan.crop[1])-18),0,0] : [0,0,plan.page.width,plan.page.height];
      if (!crop[2]) { crop[2] = plan.page.width-crop[0]-12; crop[3] = Math.min(plan.page.height-crop[1],Math.max(160,plan.crop[1]+plan.crop[3]-crop[1]+24)); }
      const canvas = dialog.querySelector(".source-dialog-canvas");
      canvas.dataset.view = view;
      canvas.dataset.fit = String(zoom === "fit");
      const image = this.region ? this.imageUrl(view === "page" ? "page" : "address") : this.image;
      canvas.innerHTML = `<div class="source-zoom-surface" style="width:${sourceZoomWidth(crop,plan.display_rotation || 0,zoom)}">${svg(plan,image,crop,`Страница ${plan.page.number}: ${spec.label || schoolLabel(spec.school)}`,showMarks,this.region ? crop : null)}</div>`;
      dialog.querySelector('[data-source-zoom]').value = String(zoom);
      canvas.scrollTop = 0;
      const focus = plan.address.at(-1) || plan.school;
      const surface = canvas.querySelector(".source-zoom-surface");
      dialog.querySelector('.source-pan-hint').hidden = surface.clientWidth <= canvas.clientWidth;
      canvas.scrollLeft = view === "fragment" && plan.exact && focus
        ? Math.max(0, sourceViewPoint([(focus[0]+focus[2])/2,(focus[1]+focus[3])/2],crop,plan.display_rotation || 0)[0]
          *surface.clientWidth/sourceViewGeometry(crop,plan.display_rotation || 0).viewBox[2]-canvas.clientWidth/2) : 0;
      dialog.querySelectorAll("[data-modal-view]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.modalView===view)));
    };
    dialog.querySelector("[data-close-source]").addEventListener("click",()=>dialog.close());
    dialog.querySelectorAll("[data-modal-view]").forEach(button=>button.addEventListener("click",()=>{view=button.dataset.modalView; zoom=view === 'page' ? 'fit' : 'readable'; draw();}));
    dialog.querySelector("[data-mark-toggle]").addEventListener("change",event=>{showMarks=event.target.checked; draw();});
    dialog.querySelector("[data-source-zoom]").addEventListener("change",event=>{zoom=['fit','readable'].includes(event.target.value) ? event.target.value : Number(event.target.value); draw();});
    dialog.addEventListener("close",()=>{dialog.innerHTML=""; if (trigger.isConnected) trigger.focus();},{once:true});
    dialog.showModal();
    draw();
  }
}

if (globalThis.customElements && !customElements.get("source-evidence")) customElements.define("source-evidence",SourceEvidence);

if (globalThis.document) {
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-source-preview]');
    if (!trigger) return;
    modalEvidenceHost?.remove();
    const host = document.createElement('source-evidence');
    host.hidden = true;
    host.setAttribute('data-modal-only', '');
    host.setAttribute('data-source', trigger.dataset.sourcePreview || '');
    host.trigger = trigger;
    modalEvidenceHost = host;
    document.body.append(host);
  });
}
