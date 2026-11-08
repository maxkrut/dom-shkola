/* Exact CSV strings, including empty cells and coordinate spelling, are preserved. */
const MAX_ROWS = 4096, MAX_FIELDS = 256, MAX_CELLS = 512 * 1024;
const MAX_OBJECT_BYTES = 512 * 1024, MAX_STRING_BYTES = 8 * 1024 * 1024;
const utf8 = new TextEncoder();
const valid = condition => { if (!condition) throw new Error("Некорректный пакет назначений"); };
const keys = (value, expected) => value && !Array.isArray(value) && typeof value === "object"
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const budget = (rows, fields, bytes = 0) => {
  if (rows > MAX_ROWS || rows * fields > MAX_CELLS || bytes > MAX_STRING_BYTES) throw new Error("Пакет назначений превышает допустимый объём");
};
const bytes = value => { valid(typeof value === "string"); return utf8.encode(value).byteLength; };

export function decodeAssignmentColumns(payload, positions, { encodedBytes, onStats } = {}) {
  valid(onStats === undefined || typeof onStats === 'function');
  valid(keys(payload, ["schema", "kind", "fields", "row_count", "columns"]) && payload.schema === 1 && payload.kind === "school_register_assignment_columns");
  const { fields, row_count: count, columns } = payload;
  valid(Array.isArray(fields) && fields.length > 0 && fields.length <= MAX_FIELDS
    && fields.every(field => typeof field === "string" && field) && new Set(fields).size === fields.length
    && Number.isSafeInteger(count) && count > 0 && Array.isArray(columns) && columns.length === fields.length);
  budget(count, fields.length);
  const size = encodedBytes ?? utf8.encode(JSON.stringify(payload)).byteLength;
  valid(Number.isSafeInteger(size) && size > 0);
  if (size > MAX_OBJECT_BYTES) throw new Error("Пакет назначений превышает допустимый объём");
  const plan = [];
  let expanded = 0;
  for (const column of columns) {
    if (keys(column, ["constant"])) {
      const length = bytes(column.constant);
      expanded += length * count;
      plan.push({ at: () => column.constant, size: () => length });
    } else if (keys(column, ["values"])) {
      valid(Array.isArray(column.values) && column.values.length === count);
      const sizes = column.values.map(bytes);
      expanded += sizes.reduce((total, value) => total + value, 0);
      plan.push({ at: position => column.values[position], size: position => sizes[position] });
    } else if (keys(column, ["dictionary", "indices"])) {
      valid(Array.isArray(column.dictionary) && column.dictionary.length > 0
        && column.dictionary.every(value => typeof value === "string") && new Set(column.dictionary).size === column.dictionary.length
        && Array.isArray(column.indices) && column.indices.length === count
        && column.indices.every(index => Number.isSafeInteger(index) && index >= 0 && index < column.dictionary.length));
      const sizes = column.dictionary.map(bytes);
      expanded += column.indices.reduce((total, index) => total + sizes[index], 0);
      plan.push({ at: position => column.dictionary[column.indices[position]], size: position => sizes[column.indices[position]] });
    } else throw new Error("Некорректный режим колонки назначений");
    budget(count, fields.length, expanded);
  }
  const selected = positions === undefined ? Array.from({ length: count }, (_, i) => i) : positions;
  valid(Array.isArray(selected) && selected.every(position => Number.isSafeInteger(position) && position >= 0 && position < count));
  budget(selected.length, fields.length);
  let selectedBytes = 0;
  for (const position of selected) {
    for (const column of plan) selectedBytes += column.size(position);
    budget(selected.length, fields.length, selectedBytes);
  }
  onStats?.({ rows: selected.length, cells: selected.length * fields.length, logicalUtf8Bytes: selectedBytes });
  return selected.map(position => Object.fromEntries(fields.map((field, i) => [field, plan[i].at(position)])));
}
