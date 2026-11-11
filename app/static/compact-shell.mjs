/* Context notes stay outside the compact panel so they do not add page height. */
export function installAnnotations() {
  const note = document.createElement('aside');
  note.id = 'context-annotation';
  note.className = 'context-annotation';
  note.setAttribute('role', 'note');
  note.hidden = true;
  document.body.append(note);
  let active = null, pinned = false, openTimer, closeTimer;
  const cancelTimers = () => { clearTimeout(openTimer); clearTimeout(closeTimer); };
  function hide() {
    cancelTimers();
    if (active) {
      active.setAttribute('aria-expanded', 'false');
      active.removeAttribute('aria-describedby');
    }
    active = null; pinned = false; note.hidden = true;
  }
  function position() {
    if (!active || !active.isConnected || active.closest('[hidden]')) { hide(); return; }
    const box = active.getBoundingClientRect();
    const width = Math.min(380, Math.max(0, window.innerWidth - 16));
    const height = window.visualViewport?.height || window.innerHeight;
    note.style.width = `${width}px`;
    const noteHeight = note.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
    const below = box.bottom + 8;
    const top = below + noteHeight <= height - 8 ? below : Math.max(8, box.top - noteHeight - 8);
    note.style.left = `${left}px`;
    note.style.top = `${top}px`;
  }
  function show(trigger, pin) {
    const content = trigger.closest('[data-annotation], .map-accuracy-info')?.querySelector('.annotation-source');
    if (!content || !trigger.isConnected) return;
    if (active && active !== trigger) hide();
    cancelTimers();
    active = trigger; pinned = pin;
    note.innerHTML = content.innerHTML;
    (trigger.closest('dialog[open]') || document.body).append(note);
    note.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-describedby', note.id);
    position();
  }
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-annotation-trigger]');
    if (trigger) {
      if (active === trigger && pinned) hide();
      else show(trigger, true);
    } else if (!note.contains(event.target)) hide();
  });
  document.addEventListener('pointerover', event => {
    if (event.pointerType !== 'mouse') return;
    if (note.contains(event.target)) { clearTimeout(closeTimer); return; }
    const trigger = event.target.closest?.('[data-annotation-trigger]');
    if (!trigger || pinned) return;
    if (trigger === active) { clearTimeout(closeTimer); return; }
    cancelTimers();
    openTimer = setTimeout(() => show(trigger, false), 500);
  });
  document.addEventListener('pointerout', event => {
    if (event.pointerType !== 'mouse' || pinned) return;
    const trigger = event.target.closest?.('[data-annotation-trigger]');
    if (!trigger && !note.contains(event.target)) return;
    if (trigger?.contains(event.relatedTarget) || note.contains(event.relatedTarget)) return;
    cancelTimers();
    closeTimer = setTimeout(hide, 160);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) { hide(); event.preventDefault(); event.stopPropagation(); }
  });
  document.addEventListener('close', event => { if (event.target.contains(active)) hide(); }, true);
  document.addEventListener('scroll', () => { if (active) position(); }, true);
  window.addEventListener('resize', () => { if (active) position(); });
  return { closeWithin: element => { if (active && (!active.isConnected || element.contains(active))) hide(); } };
}

// One document renderer for the sidebar and address information. Only the
// selected fragment is loaded, and only after the user opens it.
function gardenBoundaryButtonLabel(territoryId) {
  const feature = window.schoolMapState?.gardenById?.get?.(territoryId);
  return feature?.properties?.status === 'source_only_unlocated' ? 'Информация о СНТ' : 'Показать границу СНТ';
}

function documentViewer(info, {inline = false, id = 'source-choice'} = {}) {
  const section = document.createElement('section'); section.className = 'inline-documents';
  const documents = info?.documents || [];
  if (!documents.length) {
    section.textContent = 'Документ пока недоступен.';
    return section;
  }
  const line = document.createElement('div'); line.className = 'document-choice-line';
  const label = document.createElement('label'); label.className = 'sr-only'; label.htmlFor = id; label.textContent = 'Документ и фрагмент';
  const choice = document.createElement('select'); choice.id = id;
  for (const [index, doc] of documents.entries()) {
    const option = document.createElement('option'); option.value = index; option.textContent = doc.label;
    choice.append(option);
  }
  if (documents.length === 1) {
    choice.hidden = true;
    label.hidden = true;
    line.classList.add('document-choice-line--single');
  }
  line.append(label, choice);
  const action = document.createElement('button'); action.type = 'button';
  const openLabel = 'Фрагмент';
  action.textContent = openLabel;
  action.setAttribute('aria-expanded', String(!inline)); action.setAttribute('aria-controls', id + '-evidence');
  const evidence = document.createElement('div'); evidence.id = id + '-evidence'; evidence.className = 'address-information-evidence'; evidence.hidden = inline;
  line.append(action);
  function draw() {
    evidence.replaceChildren();
    const doc = documents[Number(choice.value)];
    if (!doc) return;
    const meta = document.createElement('div'); meta.innerHTML = doc.html; evidence.append(meta);
    if (doc.spec) {
      const source = document.createElement('source-evidence'); source.setAttribute('data-eager', '');
      source.setAttribute('data-source', JSON.stringify(doc.spec)); evidence.append(source);
    }
  }
  function show(open) {
    evidence.hidden = !open; action.setAttribute('aria-expanded', String(open));
    action.textContent = open ? 'Скрыть' : openLabel;
    if (open && !evidence.childElementCount) draw();
  }
  action.addEventListener('click', () => show(evidence.hidden));
  choice.addEventListener('change', () => { evidence.replaceChildren(); if (!evidence.hidden) draw(); });
  section.append(line);
  section.append(evidence);
  if (!inline) show(true);
  return section;
}

function mountAddressDocuments(slot, info) {
  const actions = slot.querySelector('.address-action-bar');
  const documents = info?.documents || [];
  if (info?.change || !documents.length) {
    const note = document.createElement('p');
    note.className = 'address-assignment-change';
    note.textContent = info?.change || 'Документ пока недоступен.';
    actions.before(note);
  }
  if (!documents.length) return;

  const panel = document.createElement('section');
  panel.id = 'address-document-evidence';
  panel.className = 'address-document-evidence';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Просмотр документа');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.dataset.openAddressDocument = '';
  trigger.textContent = 'Фрагмент документа';
  trigger.setAttribute('aria-controls', panel.id);
  trigger.setAttribute('aria-expanded', 'false');
  actions.prepend(trigger);
  slot.append(panel);

  const content = document.createElement('div');
  const initial = documents[0];
  let selected;
  const choices = [];
  function show(doc) {
    if (doc === selected) return;
    selected = doc;
    choices.forEach(([entry, button]) => button.setAttribute('aria-pressed', String(entry === doc)));
    content.innerHTML = doc.html;
    if (doc.spec) {
      const source = document.createElement('source-evidence');
      source.setAttribute('data-eager', '');
      source.setAttribute('data-source', JSON.stringify(doc.spec));
      content.append(source);
    }
  }
  if (documents.length > 1) {
    const versions = document.createElement('div');
    versions.className = 'address-document-choices';
    versions.setAttribute('role', 'group');
    versions.setAttribute('aria-label', 'Версии документа');
    for (const doc of documents) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = doc.compactLabel;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => show(doc));
      choices.push([doc, button]);
      versions.append(button);
    }
    panel.append(versions);
  } else {
    const title = document.createElement('p');
    title.className = 'address-document-title';
    title.textContent = initial.compactLabel;
    panel.append(title);
  }
  panel.append(content);
  trigger.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    trigger.textContent = open ? 'Скрыть фрагмент' : 'Фрагмент документа';
    trigger.setAttribute('aria-expanded', String(open));
    if (open && !selected) show(initial);
  });
}

function historyCellDocuments(source, documents) {
  const choices = document.createElement('nav'); choices.className = 'history-source-choices'; choices.setAttribute('aria-label', 'Документы выбранной ячейки');
  const schools = document.createElement('nav'); schools.className = 'history-source-choices'; schools.setAttribute('aria-label', 'Школы в выбранном документе');
  const content = document.createElement('div');
  source.append(choices, schools, content);
  function showDocument(index) {
    const doc = documents[index];
    choices.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    schools.replaceChildren(); content.replaceChildren();
    function showFragment(selected) {
      // Disconnect the previous owner before requesting a different PDF page.
      content.replaceChildren();
      schools.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-pressed', String(i === selected)));
      const fragment = doc.fragments[selected]; if (!fragment) return;
      const links = document.createElement('div'); links.innerHTML = fragment.html; content.append(links);
      if (fragment.spec) { const evidence = document.createElement('source-evidence'); evidence.setAttribute('data-eager', ''); evidence.setAttribute('data-source', JSON.stringify(fragment.spec)); content.append(evidence); }
    }
    if (doc.fragments.length > 1) doc.fragments.forEach((fragment, i) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = fragment.label;
      button.setAttribute('aria-label', 'Фрагмент школы '+fragment.label); button.addEventListener('click', () => showFragment(i)); schools.append(button);
    });
    showFragment(0);
  }
  if (documents.length > 1) documents.forEach((doc, i) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = doc.title;
    button.addEventListener('click', () => showDocument(i)); choices.append(button);
  });
  else {
    const title = document.createElement('p'); title.className = 'school-history-fragment-label'; title.textContent = documents[0].title;
    choices.append(title);
  }
  showDocument(0);
}

function schoolHistoryViewer(actions, {signal} = {}) {
  const section = document.createElement('section'); section.className = 'school-history';
  let sequence = 0, pageController = null;
  signal.addEventListener('abort', () => pageController?.abort(), {once:true});
  async function load(page = 0) {
    const version = ++sequence;
    pageController?.abort(); pageController = new AbortController();
    section.setAttribute('aria-busy', 'true');
    section.querySelectorAll('.school-history-pager button').forEach(button => { button.disabled = true; });
    if (!section.childElementCount) section.textContent = 'Загружаем историю адресов…';
    try {
      const model = await actions.schoolHistory(page, {signal:pageController.signal, pageSize:window.innerWidth <= 600 ? 4 : 8});
      if (signal.aborted || version !== sequence || !model) return;
      section.replaceChildren();
      if (!model.rows.length) {
        const note = document.createElement('p'); note.textContent = 'История привязок по отдельным домам пока недоступна.';
        section.append(note);
        return;
      }
      const caption = document.createElement('p'); caption.className = 'school-history-caption';
      caption.textContent = 'Нажмите адрес, чтобы увидеть актуальный фрагмент документа.';
      const scroll = document.createElement('div'); scroll.className = 'school-history-scroll'; scroll.tabIndex = 0;
      scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'История адресов, прокрутка документов по горизонтали');
      const table = document.createElement('table'), head = document.createElement('thead'), header = document.createElement('tr');
      const corner = document.createElement('th'); corner.scope = 'col'; corner.className = 'history-address'; corner.textContent = 'Адрес'; header.append(corner);
      for (const doc of model.columns) {
        const th = document.createElement('th'); th.scope = 'col';
        const label = document.createElement('span'); label.className = 'history-document-heading'; label.textContent = doc.title; th.append(label); header.append(th);
      }
      head.append(header); table.append(head);
      const rows = document.createElement('tbody');
      const source = document.createElement('section'); source.className = 'school-history-source'; source.hidden = true;
      source.setAttribute('aria-label', 'Фрагменты документов');
      let activeCell = null;
      const showDocuments = (row, documents, trigger) => {
        activeCell?.setAttribute('aria-pressed', 'false'); activeCell = trigger; trigger.setAttribute('aria-pressed', 'true');
        source.replaceChildren(); source.hidden = false;
        const line = document.createElement('div'); line.className = 'school-history-source-heading';
        const title = document.createElement('strong'); title.textContent = row.title;
        const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.textContent = '×'; close.setAttribute('aria-label', 'Скрыть фрагменты');
        close.addEventListener('click', () => { source.hidden = true; source.replaceChildren(); activeCell?.setAttribute('aria-pressed', 'false'); trigger.focus({preventScroll:true}); });
        line.append(title, close); source.append(line);
        if (documents.length) historyCellDocuments(source, documents);
        else {
          const message = document.createElement('p'); message.textContent = 'Актуальный документ для этого адреса недоступен.';
          source.append(message);
        }
        source.scrollIntoView({block:'nearest'});
      };
      const visibleGroups = model.rows.map(() => []);
      let previousGroups = new Map();
      model.rows.forEach((row, index) => {
        const currentGroups = new Map();
        for (const group of row.groups) {
          const key = JSON.stringify([group.start, group.end, group.schools, group.changed]);
          let visible = previousGroups.get(key);
          if (visible) visible.rowSpan += 1;
          else { visible = {group, rowSpan:1}; visibleGroups[index].push(visible); }
          currentGroups.set(key, visible);
        }
        previousGroups = currentGroups;
      });
      for (const [index, row] of model.rows.entries()) {
        const tr = document.createElement('tr'), address = document.createElement('th'); address.scope = 'row'; address.className = 'history-address';
        const documents = row.groups.flatMap(group => group.documents).filter(doc => doc.current && doc.fragments.length);
        const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'history-address-button';
        trigger.textContent = row.title; trigger.setAttribute('aria-pressed', 'false');
        trigger.setAttribute('aria-label', `${row.title}. Показать актуальный документ`);
        trigger.addEventListener('click', () => showDocuments(row, documents, trigger)); address.append(trigger);
        if (!row.current) { const badge = document.createElement('small'); badge.textContent = 'Только в истории'; address.append(badge); }
        tr.append(address);
        for (const visible of visibleGroups[index]) {
          const {group, rowSpan} = visible;
          const td = document.createElement('td'); td.colSpan = group.end - group.start + 1; td.rowSpan = rowSpan;
          if (!group.schools.length) { td.className = 'history-unmentioned'; td.textContent = 'не указан'; }
          else {
            const cell = document.createElement('div');
            cell.className = 'history-cell' + (group.changed ? ' is-changed' : '');
            for (const number of group.schools) { const label = document.createElement('span'); label.textContent = `№${number}`; cell.append(label); }
            td.append(cell);
          }
          tr.append(td);
        }
        rows.append(tr);
      }
      table.append(rows); scroll.append(table);
      const pager = document.createElement('nav'); pager.className = 'school-history-pager'; pager.setAttribute('aria-label', 'Страницы истории адресов');
      const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '←'; previous.setAttribute('aria-label', 'Предыдущие адреса'); previous.disabled = model.page === 0;
      const next = document.createElement('button'); next.type = 'button'; next.textContent = '→'; next.setAttribute('aria-label', 'Следующие адреса'); next.disabled = (model.page + 1) * model.pageSize >= model.total;
      const range = document.createElement('span'); range.textContent = `${model.page * model.pageSize + 1}-${Math.min((model.page + 1) * model.pageSize, model.total)} из ${model.total}`;
      previous.addEventListener('click', () => load(model.page - 1)); next.addEventListener('click', () => load(model.page + 1));
      pager.append(previous, range, next);
      const matrix = document.createElement('div'); matrix.className = 'school-history-matrix'; matrix.append(scroll, pager);
      section.append(caption, matrix, source);
      const panel = section.closest('.panel'), panelScroll = section.closest('.panel-scroll');
      if (panel && panelScroll) {
        const padding = getComputedStyle(panelScroll);
        const extra = parseFloat(padding.paddingLeft) + parseFloat(padding.paddingRight) + 24;
        panel.style.setProperty('--school-history-width', `${Math.ceil(table.offsetWidth + extra)}px`);
      }
    } catch (error) {
      if (signal.aborted || version !== sequence) return;
      section.replaceChildren();
      section.dataset.loadError = String(error.message || error);
      const message = document.createElement('p'); message.textContent = 'Не удалось загрузить историю адресов.';
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Повторить загрузку'; retry.addEventListener('click', () => load(page));
      section.append(message, retry);
    } finally { if (version === sequence) section.setAttribute('aria-busy', 'false'); }
  }
  return {element:section, load};
}

function renderStreetPages(directory, streets, renderStreet) {
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'street-more'; more.textContent = 'Показать ещё адреса';
  let index = 0, offset = 0, appendAddress = null;
  function appendPage() {
    let remaining = 60;
    while (index < streets.length && remaining > 0) {
      const street = streets[index];
      if (!appendAddress) {
        appendAddress = renderStreet(street);
        remaining--;
      }
      const end = Math.min(offset + remaining, street.items.length);
      while (offset < end) {
        appendAddress(street.items[offset++]);
        remaining--;
      }
      if (offset === street.items.length) {
        index++;
        offset = 0;
        appendAddress = null;
      }
    }
    more.hidden = index === streets.length;
  }
  more.addEventListener('click', appendPage);
  directory.append(more);
  appendPage();
}

/* The shell stays fixed; only the compact street directory scrolls. */
export function installCompactShell() {
  const panel = document.querySelector('aside.panel');
  const content = document.getElementById('sidebarContent');
  const toggle = document.getElementById('sidebarToggle');
  const card = document.getElementById('selectionCard');

  const annotations = installAnnotations();
  let openSchoolHistory = null;
  const houseCountPlural = new Intl.PluralRules('ru');
  const houseCountForms = {one: 'дом', few: 'дома', many: 'домов', other: 'дома'};
  let comparisonNode = null, comparisonKey = '';
  function comparisonDirectory(model) {
    if (comparisonKey !== model.contentKey || !comparisonNode) {
      comparisonKey = model.contentKey;
      const directory = document.createElement('section'); directory.className = 'street-directory comparison-directory'; directory.dataset.contentKey = model.contentKey;
      directory.setAttribute('aria-label','Сравнение закрепления адресов за школами');
      const table = document.createElement('table'), head = document.createElement('thead'), titles = document.createElement('tr');
      const check = '✓';
      const legend = document.createElement('p'); legend.className = 'comparison-legend';
      const legendMark = document.createElement('span'); legendMark.className = 'comparison-assignment-mark'; legendMark.textContent = check;
      legendMark.setAttribute('aria-hidden', 'true');
      legend.append('В строке улицы указано число домов. ', legendMark, ' Галочка означает, что адрес закреплён за школой.');
      directory.append(legend);
      const streetHeading = document.createElement('th'); streetHeading.scope = 'col'; streetHeading.textContent = 'Улица / дом'; titles.append(streetHeading);
      model.schools.forEach(school => {
        const th = document.createElement('th'); th.scope = 'col'; th.dataset.comparisonSchoolColumn = school.key;
        const button = document.createElement('button'); button.type = 'button'; button.dataset.comparisonColumn = school.key;
        button.textContent = /^\d+$/.test(school.number) ? '№'+school.number : /гимназ/iu.test(school.title) ? 'Гимн.' : school.title;
        button.title = school.title; button.setAttribute('aria-label', school.title); th.append(button); titles.append(th);
      });
      const infoHeading = document.createElement('th'); infoHeading.scope = 'col'; infoHeading.className = 'comparison-info-column';
      const infoLabel = document.createElement('span'); infoLabel.className = 'sr-only'; infoLabel.textContent = 'Документы и точность'; infoHeading.append(infoLabel); titles.append(infoHeading); head.append(titles); table.append(head);
      directory.append(table);
      renderStreetPages(directory, model.streets, street => {
        const body = document.createElement('tbody'), line = document.createElement('tr'); line.className = 'comparison-street';
        const nameCell = document.createElement('th'); nameCell.scope = 'row';
        const title = document.createElement('div'); title.className = 'comparison-street-title';
        const label = document.createElement('span'); label.textContent = street.name;
        const locality = document.createElement('small'); locality.textContent = street.locality || '';
        title.append(label); if (locality.textContent) title.append(locality); nameCell.append(title); line.append(nameCell);
        street.counts.forEach((count,index) => { const cell = document.createElement('td'); cell.dataset.comparisonSchoolColumn = model.schools[index].key;
          const assignedGarden = street.kind === 'garden' && count > 0;
          cell.classList.toggle('comparison-assignment-mark', assignedGarden);
          cell.textContent = street.kind === 'garden' ? (assignedGarden ? check : '') : String(count);
          if (assignedGarden) cell.setAttribute('aria-label', 'Закреплён');
          line.append(cell); });
        const sourceCell = document.createElement('td'); sourceCell.className = 'comparison-info-column';
        if (street.kind === 'garden') {
          const source = document.createElement('button'); source.type = 'button'; source.className = 'address-info-trigger'; source.textContent = 'i';
          source.title = 'Документ и граница СНТ'; source.setAttribute('aria-label','Документ и граница: '+street.name); source.addEventListener('click',()=>window.schoolCardActions?.selectGarden(street.territoryId)); sourceCell.append(source);
        }
        line.append(sourceCell); body.append(line); table.append(body);
        return item => {
            const tr = document.createElement('tr'); tr.className = 'comparison-house';
            const name = document.createElement('th'); name.scope = 'row';
            const house = document.createElement('button'); house.type = 'button'; house.textContent = item.label;
            house.addEventListener('click',()=>window.schoolCardActions?.openDirectoryAddress(item.key)); name.append(house); tr.append(name);
            model.schools.forEach(school => { const td = document.createElement('td'); td.dataset.comparisonSchoolColumn = school.key;
              const assigned = item.members.has(school.key);
              td.classList.toggle('comparison-selected-column', school.key === window.schoolMapState?.comparisonSchoolKey);
              td.classList.toggle('comparison-assignment-mark', assigned);
              td.textContent = assigned ? check : '';
              td.setAttribute('aria-label', assigned ? 'Закреплён' : 'Нет текущей привязки в реестре'); tr.append(td); });
            const infoCell = document.createElement('td'); infoCell.className = 'comparison-info-column';
            const info = addressDetailsTrigger(item, item.row.canonical_address);
            infoCell.append(info); tr.append(infoCell); body.append(tr);
        };
      });
      comparisonNode = directory;
    }
    const selected = window.schoolMapState?.comparisonSchoolKey || '';
    comparisonNode.querySelectorAll('[data-comparison-school-column]').forEach(cell=>{
      cell.classList.toggle('comparison-selected-column',cell.dataset.comparisonSchoolColumn===selected);
      cell.querySelector('button')?.setAttribute('aria-pressed',String(cell.dataset.comparisonSchoolColumn===selected));
    });
    return comparisonNode;
  }
  function addressDetailsTrigger(item, address) {
    const info = document.createElement('button');
    const warning = item.located ? '' : 'Точное местоположение дома не определено';
    info.type = 'button';
    info.className = `address-info-trigger${warning ? ' is-unlocated' : ''}`;
    info.textContent = warning ? '!' : 'i';
    info.title = warning ? `${warning}. Открыть документ` : 'Открыть документ';
    info.setAttribute('aria-label', `Открыть документ по адресу: ${address}${warning ? `. ${warning}` : ''}`);
    info.dataset.addressDocument = item.key;
    return info;
  }
  let directoryKey = '', directoryRows = null, directoryNode = null;
  function streetDirectory(model, showSchools = false) {
    const identity = model.contentKey || model.key;
    if (directoryKey === identity && (model.contentKey || directoryRows === model.rows) && directoryNode) return directoryNode;
    directoryKey = identity; directoryRows = model.rows;
    const directory = document.createElement('section'); directory.className = 'street-directory';
    if (model.contentKey) directory.dataset.contentKey = model.contentKey;
    directory.setAttribute('aria-label', showSchools ? 'Адреса и закреплённые школы' : 'Улицы и закреплённые дома');
    const schoolLabels = showSchools ? new Map(model.schools.map(school => [
      school.key, /^\d+$/.test(school.number) ? `№${school.number}` : school.title
    ])) : null;
    const namesFor = members => [...members].map(key => schoolLabels.get(key) || key.split('::').at(-1)).join(', ');
    if (!model.streets.length) {
      directory.textContent = 'Текущие привязки по отдельным домам не найдены.';
    }
    const groups = document.createElement('div');
    directory.append(groups);
    renderStreetPages(directory, model.streets, street => {
      const group = document.createElement('section');
      group.className = street.kind === 'garden' ? 'street-group street-group--garden' : 'street-group';
      const title = document.createElement('button'); title.type = 'button'; title.className = 'street-group-title';
      const name = document.createElement('span'); name.textContent = street.name;
      const count = document.createElement('span'); count.className = 'street-house-count';
      const total = street.items.length;
      if (street.kind === 'garden') {
        count.textContent = total ? `${total} ${street.whole ? 'искл.' : 'адр.'}` : 'территория';
        count.setAttribute('aria-label', `${total} адресов с отдельной привязкой`);
      } else {
        count.textContent = `${total} ${houseCountForms[houseCountPlural.select(total)]}`;
      }
      title.append(name, count);
      title.setAttribute('aria-expanded', 'true');
      title.setAttribute('aria-controls', '');
      const rows = document.createElement('div'); rows.className = 'street-houses';
      // SNT rows are a single territory action, not a long house list — keep them visible.
      const collapseByDefault = street.kind !== 'garden' && (model.streets.length > 8 || total > 6);
      if (collapseByDefault) {
        rows.hidden = true;
        title.setAttribute('aria-expanded', 'false');
      }
      if (street.kind === 'garden') {
        title.setAttribute('title', 'Территория СНТ: ниже информация и переход к карточке');
      }
      const groupId = `street-group-${street.name.replace(/\s+/g, '-').slice(0, 40)}-${Math.random().toString(36).slice(2, 7)}`;
      rows.id = groupId;
      title.setAttribute('aria-controls', groupId);
      title.addEventListener('click', () => {
        const open = rows.hidden;
        rows.hidden = !open;
        title.setAttribute('aria-expanded', String(open));
      });
      group.append(title);
      if (showSchools && street.locality) {
        const locality = document.createElement('p'); locality.className = 'street-list-locality';
        locality.textContent = street.locality;
        group.append(locality);
      }
      if(street.kind==='garden') {
        const boundary=document.createElement('button'); boundary.type='button';boundary.className='street-garden-map';boundary.textContent=gardenBoundaryButtonLabel(street.territoryId);
        boundary.addEventListener('click',()=>window.schoolCardActions?.selectGarden(street.territoryId)); rows.append(boundary);
        const note=document.createElement('p');note.className='shared-area-hint';
        const schools = showSchools ? namesFor(street.members) : (street.schoolNumbers || []).join(', ');
        note.textContent='Для СНТ целиком: '+schools+'.'+(street.items.length ? ' Ниже адреса с отличающимся набором школ.' : ' Адреса внутри не перечисляем.');rows.append(note);
      }
      group.append(rows); groups.append(group);
      return item => {
          const line = document.createElement('div'); line.className = 'street-house';
          const house = document.createElement('button'); house.type = 'button'; house.className = 'street-house-name';
          const address = item.title || item.row?.canonical_address || item.label;
          house.textContent = item.label; house.title = address;
          house.setAttribute('aria-label', `Открыть адрес: ${address}`);
          const info = addressDetailsTrigger(item, address);
          house.addEventListener('click', () => window.schoolCardActions?.openDirectoryAddress(item.key));
          line.append(house);
          if (showSchools) {
            const schools = document.createElement('span'); schools.className = 'street-house-schools';
            schools.textContent = namesFor(item.members);
            line.append(schools);
          }
          line.append(info); rows.append(line);
      };
    });
    directoryNode = directory; return directory;
  }
  let page = 0, lastKey = '', frame, renderedCard = null;
  const button = (label, action) => {
    const node = document.createElement('button'); node.type = 'button';
    node.textContent = label; node.addEventListener('click', action); return node;
  };
  const setCollapsed = collapsed => {
    if (collapsed) annotations.closeWithin(panel);
    panel.dataset.collapsed = String(collapsed);
    content.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Развернуть панель поиска' : 'Свернуть панель');
    toggle.firstElementChild.textContent = collapsed ? '›' : '‹';
    document.getElementById('addressSearch').dispatchEvent(new Event('blur'));
    try { sessionStorage.setItem('dom-shkola:sidebar-collapsed', String(collapsed)); } catch { /* Private mode. */ }
  };
  toggle.addEventListener('click', () => setCollapsed(panel.dataset.collapsed !== 'true'));
  try { if (sessionStorage.getItem('dom-shkola:sidebar-collapsed') === 'true') setCollapsed(true); } catch { /* Storage optional. */ }
  const revealSelection = () => {
    if (panel.dataset.collapsed === 'true') setCollapsed(false);
    if (document.body.dataset.mobileView === 'map') {
      document.body.dataset.mobileView = 'result';
      const mapToggle = document.getElementById('mobileMapToggle');
      if (mapToggle) {
        mapToggle.setAttribute('aria-pressed', 'false');
        mapToggle.textContent = 'Карта';
        mapToggle.setAttribute('aria-label', 'Показывать карту');
      }
    }
  };
  function closeSchoolHistory() {
    openSchoolHistory?.controller.abort();
    openSchoolHistory?.viewer.element.remove();
    openSchoolHistory = null;
    panel.style.removeProperty('--school-history-width');
  }
  function syncSchoolHistory() {
    const trigger = card.querySelector('[data-school-history-toggle]');
    const slot = card.querySelector('#school-history-panel');
    if (openSchoolHistory && openSchoolHistory.key !== trigger?.dataset.schoolHistoryToggle) closeSchoolHistory();
    const open = Boolean(openSchoolHistory && slot);
    panel.dataset.schoolHistory = String(open);
    if (trigger) {
      trigger.setAttribute('aria-expanded', String(open));
      trigger.textContent = open ? 'Скрыть историю' : 'История адресов';
    }
    if (slot) {
      slot.hidden = !open;
      if (open && openSchoolHistory.viewer.element.parentElement !== slot) slot.append(openSchoolHistory.viewer.element);
    }
    card.querySelectorAll(':scope > [data-street-directory], :scope > [data-inline-documents="school"], :scope > .school-rule-list')
      .forEach(node => { node.hidden = open; });
  }
  card.addEventListener('click', event => {
    const school = event.target.closest('[data-school-history-toggle]');
    const address = event.target.closest('[data-address-document], [data-directory-address]');
    if (school) {
      if (openSchoolHistory) {
        closeSchoolHistory();
        syncSchoolHistory();
      } else {
        const controller = new AbortController();
        const viewer = schoolHistoryViewer(window.schoolCardActions, {signal: controller.signal});
        openSchoolHistory = {key: school.dataset.schoolHistoryToggle, controller, viewer};
        syncSchoolHistory();
        void viewer.load();
      }
    }
    if (address) window.schoolCardActions?.openDirectoryAddress(
      address.dataset.addressDocument || address.dataset.directoryAddress, address.hasAttribute('data-address-document')
    );
    if (event.target.closest('[data-retry-shared-comparison]')) window.schoolCardActions?.retryComparison();
  });
  function render() {
    frame = null;
    const height = window.visualViewport?.height || window.innerHeight;
    document.body.dataset.sidebarDensity = height < 520 ? 'tiny' : height < 650 ? 'short' : 'normal';
    document.body.dataset.sidebarVeryShort = String(height < 360);
    const state = window.schoolMapState || {};
    panel.dataset.comparison = String(Boolean(state.sharedAreaSelection && !state.selectedAddressId && !state.selectedGardenId));
    // Keep one last matrix so returning preserves its loaded rows and scroll.
    const key = [state.selectedAddressId, state.selectedGardenId, state.selectedSchoolKey, state.sharedAreaSelection?.key, state.searchMode,
      state.addressSearchResults?.length, state.schoolSearchResults?.length].join('|');
    if (key !== lastKey) { page = 0; lastKey = key; closeSchoolHistory(); }
    // app.js owns the one visible result. Enhance only newly rendered slots;
    // resizing must not replace inputs, focus, directory rows or evidence.
    if (renderedCard !== card.firstElementChild) {
      annotations.closeWithin(card);
      renderedCard = card.firstElementChild;
      const directorySlot = card.querySelector('[data-street-directory]');
      if (directorySlot) {
        const comparing = directorySlot.hasAttribute('data-shared-comparison');
        const model = comparing ? window.schoolCardActions?.comparison() : window.schoolCardActions?.directory();
        if (model) {
          const showSchools = directorySlot.dataset.sharedComparison === 'list';
          const node = comparing && !showSchools ? comparisonDirectory(model) : streetDirectory(model, showSchools);
          if (node.parentElement !== directorySlot) directorySlot.append(node);
          const count = card.querySelector('[data-street-count]');
          const streets=model.streetCount ?? model.streets.length;
          if (count) count.textContent = streets + ' ' + (streets % 100 >= 11 && streets % 100 <= 14 ? 'улиц' : streets % 10 === 1 ? 'улица' : [2,3,4].includes(streets % 10) ? 'улицы' : 'улиц');
        }
      }
      const documentSlot = card.querySelector('[data-inline-documents]');
      if (documentSlot?.dataset.inlineDocuments === 'school') {
        const info = window.schoolCardActions?.schoolDocuments();
        documentSlot.append(documentViewer(info, {inline: true, id: 'selection-document-choice'}));
      } else if (documentSlot) {
        mountAddressDocuments(documentSlot, window.schoolCardActions?.addressDocuments());
      }
      syncSchoolHistory();
    }
    const selected = state.selectedAddressId || state.selectedGardenId || state.selectedSchoolKey;
    if (!selected) {
      const candidates = [...card.querySelectorAll('.candidate-list > button')];
      card.querySelector('.compact-pager')?.remove();
      const size = height < 620 ? 2 : 3;
      page = Math.max(0, Math.min(page, Math.ceil(candidates.length / size) - 1));
      candidates.forEach((node, index) => { node.hidden = index < page * size || index >= (page + 1) * size; });
      if (candidates.length > size) {
        const pager = document.createElement('nav'); pager.className = 'compact-pager'; pager.setAttribute('aria-label', 'Страницы результатов');
        const previous = button('←', () => { page--; render(); card.querySelector('.compact-pager button')?.focus(); }); previous.disabled = page === 0; previous.setAttribute('aria-label', 'Предыдущие результаты');
        const next = button('→', () => { page++; render(); card.querySelector('.compact-pager button:last-child')?.focus(); }); next.disabled = (page + 1) * size >= candidates.length; next.setAttribute('aria-label', 'Следующие результаты');
        pager.append(previous, document.createTextNode(`${page + 1} / ${Math.ceil(candidates.length / size)}`), next); card.append(pager);
      }
    }
  }
  const update = () => { if (!frame) frame = requestAnimationFrame(render); };
  new MutationObserver(() => {
    if (renderedCard !== card.firstElementChild) update();
  }).observe(card, {childList: true});
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--visible-height', `${window.visualViewport.height}px`);
    update();
  });
  function flush() {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    render();
  }
  window.schoolCompactShell = { expand: () => setCollapsed(false), revealSelection, flush,
    openAddressDocument() {
      revealSelection();
      flush();
      const trigger = card.querySelector('[data-open-address-document]');
      if (trigger?.getAttribute('aria-expanded') === 'false') trigger.click();
      (trigger || card.querySelector('#selectionHeading'))?.focus();
    } };
  render();
}
