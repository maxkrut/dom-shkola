/* External locations do not change the identity of an accepted document. */
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const rawPath = value => typeof value === 'string' && /^raw\/.+\.(pdf|xlsx?)$/i.test(value)
  && !/[\\?#\x00-\x1f]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
function externalUrl(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.hash || /[\x00-\x20\\]/.test(value)) throw new Error('Некорректная внешняя ссылка документа');
  return url.href;
}

export function createOriginalSourceIndex(value) {
  if (value?.schema !== 1 || value.kind !== 'external_original_sources' || !Array.isArray(value.documents)
      || !value.documents.length || value.documents.length > 1000) throw new Error('Некорректный реестр оригиналов');
  const entries = new Map();
  for (const item of value.documents) {
    if (!rawPath(item?.source_raw_file) || !digest(item.sha256) || entries.has(item.source_raw_file)
        || !['document_registered', 'district_page_only', 'unavailable'].includes(item.status)
        || item.availability !== 'not_rechecked') throw new Error('Некорректная идентичность оригинала');
    const documentUrl = externalUrl(item.document_url), pageUrl = externalUrl(item.page_url);
    if ((item.status === 'document_registered') !== Boolean(documentUrl)
        || (item.status === 'district_page_only' && !pageUrl)
        || (item.status === 'unavailable' && (pageUrl || documentUrl))) throw new Error('Статус оригинала не совпадает со ссылкой');
    entries.set(item.source_raw_file, { ...item, document_url: documentUrl, page_url: pageUrl });
  }
  return (rawFile, sha256 = '', page = 0) => {
    const entry = entries.get(rawFile);
    if (!entry || sha256 && entry.sha256 !== sha256) return { status: 'unavailable', url: '', pageUrl: '', label: 'Официальная ссылка на оригинал не подтверждена' };
    if (entry.document_url) {
      const url = new URL(entry.document_url);
      if (/\.pdf$/i.test(url.pathname) && Number.isInteger(page) && page > 0) url.hash = `page=${page}`;
      return { status: entry.status, url: url.href, pageUrl: entry.page_url, label: 'Оригинал документа',
        note: 'Внешняя копия может отличаться от сохранённых страниц.' };
    }
    if (entry.page_url) return { status: entry.status, url: entry.page_url, pageUrl: entry.page_url, label: 'Страница администрации',
      note: 'Прямая ссылка на этот оригинал не подтверждена.' };
    return { status: 'unavailable', url: '', pageUrl: '', label: 'Официальная ссылка на оригинал не подтверждена' };
  };
}
