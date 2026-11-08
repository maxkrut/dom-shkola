const escape = text => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dateText = value => validDate(value) ? value.split('-').reverse().join('.') : 'не указана';

export function documentSetsHtml(value, originalDocument) {
  if (value?.schema !== 1 || value.kind !== 'accepted_district_document_sets' || !Array.isArray(value.districts)
      || value.districts.length !== 18 || new Set(value.districts.map(d => d.district)).size !== 18) throw new Error('Нет подтверждённого набора районов');
  return value.districts.map(district => {
    if (!district.district || !Array.isArray(district.documents) || !district.documents.length
        || district.source_set_checked_at !== null && !validDate(district.source_set_checked_at)) throw new Error('Некорректные сведения района');
    return district.documents.map((doc, index) => {
      if (!validDate(doc.act_date) || !doc.act_number || !Array.isArray(doc.sources) || !doc.sources.length) throw new Error('Некорректная дата документа');
      const links = doc.sources.map(source => originalDocument(source.source_raw_file, source.sha256)).filter(link => link?.url);
      const unique = [...new Map(links.map(link => [link.url, link])).values()];
      const label = `№${escape(doc.act_number)}`;
      const document = unique.length ? unique.map((link, i) => `<a href="${escape(link.url)}" target="_blank" rel="noopener noreferrer" title="${escape([link.label, link.note].filter(Boolean).join(' · '))}">${i ? 'Ещё источник' : label} ↗</a>`).join(' · ') : `<span title="Официальная ссылка не подтверждена">${label} <span class="freshness-note">(без ссылки)</span></span>`;
      return `<tr>${index === 0 ? `<th scope="rowgroup" rowspan="${district.documents.length}">${escape(district.district)}</th>` : ''}<td>${document}</td><td class="date-cell">${dateText(doc.act_date)}</td>${index === 0 ? `<td class="date-cell" rowspan="${district.documents.length}">${dateText(district.source_set_checked_at)}</td>` : ''}</tr>`;
    }).join('');
  }).join('');
}

export function buildLabel(info) {
  if (info?.schema !== 1 || typeof info.version !== 'string' || !info.version || info.version.length > 100
      || !['frontend_sha256', 'package_json'].includes(info.version_basis)
      || !/^[a-f0-9]{64}$/.test(info.frontend_sha256 || '')
      || typeof info.built_at !== 'string' || !info.built_at.endsWith('Z') || !Number.isFinite(Date.parse(info.built_at))) throw new Error('Нет проверенных сведений сборки');
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(info.built_at));
  return `${info.version_basis === 'package_json' ? 'Версия' : 'Сборка'} ${info.version.replace(/^build-/, '')} · ${date}`;
}

export async function installDeliveryInfo(api) {
  const version = document.getElementById('buildVersion');
  const content = document.getElementById('dataFreshnessContent');
  if (!version || !content) return;
  try {
    const data = await api.bootstrap();
    if (!data.current_document_sets || !data.build_info) return;
    const rows = documentSetsHtml(data.current_document_sets, (...args) => api.originalDocument(...args));
    const sources = document.getElementById('licenseDocumentSources');
    if (sources) sources.innerHTML = data.current_document_sets.districts.map(district => {
      const documents = district.documents.map(doc => {
        const links = [...new Map(doc.sources.map(source => api.originalDocument(source.source_raw_file, source.sha256)).filter(link => link?.url).map(link => [link.url, link])).values()];
        const title = `№${escape(doc.act_number)} · ${dateText(doc.act_date)}`;
        return links.length ? links.map(link => `<a href="${escape(link.url)}" target="_blank" rel="noopener noreferrer">${title} ↗</a>`).join(' · ') : `${title} (официальная ссылка не подтверждена)`;
      });
      return `<div class="license-district"><span>${escape(district.district)}</span><div>${documents.join('<br>')}</div></div>`;
    }).join('');
    version.textContent = buildLabel(data.build_info); version.title = `Дата сборки (UTC): ${data.build_info.built_at}`; version.hidden = false;
    content.innerHTML = `<h3>Актуальность данных</h3><p class="freshness-intro">«Проверено» означает дату сверки набора источников. Дата документа указана отдельно.</p><div class="freshness-table-scroll" role="region" aria-label="Документы по районам" tabindex="0"><table class="freshness-table"><thead><tr><th scope="col">Район</th><th scope="col">Документ</th><th scope="col">Дата акта</th><th scope="col">Проверено</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch { version.textContent = 'Сведения о сборке недоступны'; version.hidden = false;
    content.textContent = 'Сведения об актуальности не загрузились. Обновите страницу.';
    const sources = document.getElementById('licenseDocumentSources');
    if (sources) sources.textContent = 'Список официальных источников не загрузился. Обновите страницу.';
  }
}
