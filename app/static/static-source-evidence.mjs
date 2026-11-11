/* One visible physical page. Crops only change SVG viewBox, never image coordinates. */
const dialogOwners = new WeakMap();
export class StaticSourceEvidence {
  constructor(host, spec, plan, helpers, api) {
    Object.assign(this, { host, spec, plan, helpers, api });
    this.ticket = 0; this.disposed = false;
    this.onPageHide = () => { this.modal?.(); this.deactivate(); };
    globalThis.addEventListener?.('pagehide', this.onPageHide);
  }

  current(ticket) { return !this.disposed && this.host.isConnected && ticket === this.ticket; }

  stop() {
    this.ticket++; this.controller?.abort(); this.controller = null;
    this.lease?.release(); this.lease = null;
  }

  deactivate() {
    this.stop();
    if (!this.disposed && this.host.isConnected) {
      this.host.innerHTML = '<button type="button" class="text-button" data-load-static-page>Показать фрагмент документа</button>';
      this.host.querySelector('[data-load-static-page]').addEventListener('click', () => this.load(this.plan, { reveal: true }));
    }
  }

  dispose() {
    this.disposed = true; this.stop(); this.modal?.(); this.modal = null;
    this.host.querySelectorAll('svg').forEach(node => node.remove());
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
  }

  source(plan) { return { sha256: this.plan.sha256, source_raw_file: this.spec.rawFile, page: plan.page }; }

  originalLink(plan) {
    if (this.helpers.originalDocumentLink) return this.helpers.originalDocumentLink({ ...this.spec, sha256: this.plan.sha256 }, plan.page.number);
    return `<a href="${this.helpers.escape(this.helpers.localPdfHref(this.spec.rawFile, plan.page.number))}" target="_blank" rel="noopener">Открыть исходный PDF ↗</a>`;
  }

  async load(plan = this.plan, { reveal = false } = {}) {
    this.stop(); const ticket = this.ticket;
    this.controller = new AbortController();
    this.host.innerHTML = '<p class="evidence-note" role="status">Загружаем страницу документа…</p>';
    try {
      const lease = await this.api.documentPage(this.source(plan), { owner: this, signal: this.controller.signal,
        onDeactivate: () => { if (this.current(ticket)) this.deactivate(); } });
      if (!this.current(ticket)) { lease.release(); return; }
      this.lease = lease; this.draw(plan, lease.url);
      if (reveal) {
        const fragment = this.host.querySelector('.source-crop-button');
        fragment?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
        fragment?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!this.current(ticket) || error?.name === 'AbortError') return;
      this.failure(plan);
    }
  }

  failure(plan) {
    this.host.innerHTML = `<p class="evidence-note">Не удалось загрузить страницу. ${this.originalLink(plan)} <button class="evidence-retry" type="button">Повторить</button></p>`;
    this.host.querySelector('.evidence-retry').addEventListener('click', () => this.load(plan, { reveal: true }));
  }

  draw(plan, image) {
    const { svg, escape, schoolLabel, inlineSourceFragment, bindSourcePageAction } = this.helpers;
    const spec = this.spec, view = plan.crop || [0, 0, plan.page.width, plan.page.height];
    const fragmentLabel = spec.label || spec.street || 'строка закрепления';
    const schoolCrop = plan.school_crop || (plan.school
      ? [plan.school[0] - 5, plan.school[1] - 5, plan.school[2] - plan.school[0] + 10, plan.school[3] - plan.school[1] + 10] : null);
    this.host.innerHTML = `<div class="source-snippet">
      ${schoolCrop ? `<span class="snippet-caption school-caption">Школа в документе</span>${svg(plan, image, schoolCrop, `${schoolLabel(spec.school)} в исходном PDF`)}` : ''}
      <span class="snippet-caption address-caption">${escape(plan.label || (!plan.crop ? 'Страница документа' : spec.mode === 'school' ? 'Пример строки закрепления' : spec.rule ? 'Правило закрепления' : 'Адрес в документе'))}</span>
      ${inlineSourceFragment(svg(plan, image, view, 'Настоящий фрагмент PDF с отмеченным текстом источника'), fragmentLabel)}
      ${spec.mode === 'school' && spec.label ? `<p class="evidence-note">${escape(spec.label)}</p>` : ''}
      ${spec.parallel ? '<p class="evidence-note">Фрагмент параллельного официального PDF. Исходная таблица доступна в ссылках на источник.</p>' : ''}
      ${spec.fromFifthGrade ? '<p class="evidence-note">Список относится к приёму с 5-го класса.</p>' : spec.rule ? '<p class="evidence-note">В документе указано общее правило; отдельный дом может не перечисляться.</p>' : ''}
      ${!plan.exact && spec.mode !== 'school' ? '<p class="evidence-note">Показан контекст строки. Номер дома отдельно не выделен.</p>' : ''}
      ${plan !== this.plan ? '<button type="button" class="text-button" data-main-fragment>Вернуться к строке адреса</button>' : ''}
      ${(this.plan.contexts || []).map((context, index) => `<div class="source-continuation"><span class="snippet-caption">${escape(context.label || 'Продолжение строки документа')}</span><div class="source-context-controls"><button type="button" class="text-button" data-context="${index}">Показать фрагмент страницы ${context.page.number}</button>${this.originalLink(context)}</div></div>`).join('')}
      </div><div class="evidence-actions"><button type="button" class="text-button" data-evidence-view="page">Вся страница ↗</button></div>`;
    bindSourcePageAction(this.host, fragmentLabel, trigger => this.open(plan, 'page', trigger),
      () => svg(plan, image, [0, 0, plan.page.width, plan.page.height], 'Страница исходного PDF'));
    this.host.querySelector('[data-main-fragment]')?.addEventListener('click', () => this.load(this.plan, { reveal: true }));
    this.host.querySelectorAll('[data-context]').forEach(button => button.addEventListener('click', () => this.load(this.plan.contexts[Number(button.dataset.context)], { reveal: true })));
  }

  open(plan, initialView, trigger) {
    const dialog = document.getElementById('sourceDocumentDialog');
    if (!dialog || this.disposed) return;
    dialogOwners.get(dialog)?.();
    this.modal?.();
    const { svg, escape, schoolLabel, sourceViewPoint, sourceViewGeometry, sourceZoomWidth } = this.helpers, spec = this.spec;
    let view = initialView, zoom = initialView === 'fragment' ? 'readable' : 'fit', marks = true, ticket = 0, controller, lease, closed = false, image = null, profile = null;
    const owner = {};
    const release = () => { ticket++; controller?.abort(); controller = null; lease?.release(); lease = null; image = null; };
    const cleanup = () => {
      if (closed) return;
      closed = true; release(); dialog.removeEventListener('close', onClosed);
      if (dialogOwners.get(dialog) === cleanup) {
        dialogOwners.delete(dialog);
        if (dialog.open) dialog.close();
        dialog.innerHTML = '';
        if (trigger.isConnected) trigger.focus();
        else if (this.host.isConnected) this.host.querySelector('[data-load-static-page]')?.focus();
      }
      if (this.modal === cleanup) this.modal = null;
    };
    // Native close events are queued; a close from the previous owner can arrive
    // after the next owner has already reopened this shared dialog.
    const onClosed = () => { if (!dialog.open) cleanup(); };
    dialogOwners.set(dialog, cleanup);
    this.modal = cleanup;
    dialog.innerHTML = `<header class="source-dialog-head"><div><p class="snippet-caption">Исходный документ</p><h2 id="sourceDocumentTitle">${escape(spec.title || 'Документ закрепления')}</h2><p class="source-document-meta"><span class="source-filename" title="${escape(spec.rawFile.split('/').at(-1))}">${escape(spec.rawFile.split('/').at(-1))}</span><span>Страница ${plan.page.number}</span></p></div><button class="icon-button" type="button" data-close-source aria-label="Закрыть документ">×</button></header>
      <div class="source-dialog-tools"><div class="evidence-view-switch"><button type="button" data-modal-view="fragment">Фрагмент</button><button type="button" data-modal-view="page">Вся страница</button></div><label><input type="checkbox" data-mark-toggle checked> Подсветка</label><label>Масштаб <select data-source-zoom><option value="readable">Для чтения</option><option value="fit">По ширине</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></label></div><p class="source-pan-hint" hidden>Прокрутите фрагмент влево или вправо, чтобы увидеть всю строку.</p>
      ${(this.plan.contexts || []).length ? `<nav class="source-context-tabs" aria-label="Части строки документа"><button type="button" data-modal-context="main" aria-pressed="${plan === this.plan}">Строка адреса</button>${this.plan.contexts.map((context, index) => `<button type="button" data-modal-context="${index}" aria-pressed="${plan === context}">${escape(String(context.label || `Продолжение · стр. ${context.page.number}`).replace(/[\u2013\u2014]/gu,'-'))}</button>`).join('')}</nav>` : ''}
      <div class="source-dialog-canvas" tabindex="0" aria-label="Страница PDF. Увеличенный фрагмент можно прокручивать."></div><footer class="source-dialog-foot"><span>${plan.school ? plan.address?.length ? 'Школа выделена зелёным, адрес жёлтым.' : 'Школа выделена зелёным.' : plan.address?.length ? 'Адрес выделен жёлтым.' : 'Исходная страница без подсветки.'}${spec.rule ? ' В документе указано общее правило.' : !plan.exact && spec.mode !== 'school' ? ' Номер дома отдельно не выделен.' : ''}</span>${this.originalLink(plan)}</footer>`;
    const canvas = dialog.querySelector('.source-dialog-canvas');
    const draw = () => {
      dialog.querySelectorAll('[data-modal-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.modalView === view)));
      if (!image || closed) return;
      const crop = view === 'page' ? [0, 0, plan.page.width, plan.page.height] : plan.crop || [0, 0, plan.page.width, plan.page.height];
      canvas.dataset.view = view;
      canvas.dataset.fit = String(zoom === 'fit');
      canvas.innerHTML = `<div class="source-zoom-surface" style="width:${sourceZoomWidth(crop, plan.display_rotation || 0, zoom)}">${svg(plan, image, crop, `Страница ${plan.page.number}: ${spec.label || schoolLabel(spec.school)}`, marks)}</div>`;
      dialog.querySelector('[data-source-zoom]').value = String(zoom);
      const focus = plan.address?.at(-1) || plan.school;
      const focusBox = focus || (view === 'fragment' && plan.crop
        ? [plan.crop[0], plan.crop[1], plan.crop[0] + plan.crop[2], plan.crop[1] + plan.crop[3]]
        : null);
      const surface = canvas.querySelector('.source-zoom-surface');
      dialog.querySelector('.source-pan-hint').hidden = surface.clientWidth <= canvas.clientWidth;
      canvas.scrollTop = 0;
      canvas.scrollLeft = 0;
      if (view === 'fragment' && focusBox) {
        const focusPoint = sourceViewPoint(
          [(focusBox[0] + focusBox[2]) / 2, (focusBox[1] + focusBox[3]) / 2],
          crop, plan.display_rotation || 0
        );
        const viewBox = sourceViewGeometry(crop, plan.display_rotation || 0).viewBox;
        const scaleX = surface.clientWidth / viewBox[2];
        const scaleY = surface.clientHeight / viewBox[3];
        if (plan.exact || spec.rule) {
          canvas.scrollLeft = Math.max(0, focusPoint[0] * scaleX - canvas.clientWidth / 2);
        }
        canvas.scrollTop = Math.max(0, focusPoint[1] * scaleY - canvas.clientHeight / 3);
      }
    };
    const load = async () => {
      const requested = zoom > 1 ? 'detail' : 'preview';
      if (profile === requested && image) { draw(); return; }
      release(); const current = ticket; controller = new AbortController();
      canvas.innerHTML = '<p class="evidence-note" role="status">Загружаем страницу документа…</p>';
      try {
        const next = await this.api.documentPage(this.source(plan), { profile: requested, owner, signal: controller.signal,
          onDeactivate: () => { if (!closed && current === ticket) cleanup(); } });
        if (closed || current !== ticket) { next.release(); return; }
        lease = next; image = next.url; profile = requested; draw();
      } catch (error) {
        if (closed || current !== ticket || error?.name === 'AbortError') return;
        canvas.innerHTML = '<p class="evidence-note">Не удалось загрузить страницу. <button type="button" data-retry-page>Повторить</button></p>';
        canvas.querySelector('[data-retry-page]').addEventListener('click', load);
      }
    };
    dialog.querySelector('[data-close-source]').addEventListener('click', cleanup);
    dialog.querySelectorAll('[data-modal-context]').forEach(button => button.addEventListener('click', () => {
      const next = button.dataset.modalContext === 'main' ? this.plan : this.plan.contexts[Number(button.dataset.modalContext)];
      if (next) this.open(next, view, trigger);
    }));
    dialog.querySelectorAll('[data-modal-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.modalView; zoom = view === 'page' ? 'fit' : 'readable'; load(); }));
    dialog.querySelector('[data-mark-toggle]').addEventListener('change', event => { marks = event.target.checked; draw(); });
    dialog.querySelector('[data-source-zoom]').addEventListener('change', event => { zoom = ['fit', 'readable'].includes(event.target.value) ? event.target.value : Number(event.target.value); load(); });
    dialog.addEventListener('close', onClosed);
    dialog.showModal(); draw(); load();
  }
}
