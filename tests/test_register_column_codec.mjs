import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeAssignmentColumns } from "../app/static/register-column-codec.mjs";

test("native Python encoder/decoder golden preserves every string and selected-row multiplicity", () => {
  const bytes = readFileSync(new URL("./fixtures/column-codec-fixture.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "3f3a5702b2bf228124937d67cf37c316bb076b67e9e972f7957c8589dbf849da");
  const fixture = JSON.parse(bytes);
  assert.deepEqual(decodeAssignmentColumns(fixture.block), fixture.expected_rows);
  assert.deepEqual(decodeAssignmentColumns(fixture.block, fixture.positions), fixture.expected_selected);
});

test("ambiguous, truncated, non-string and invalid dictionary data fails before returning rows", () => {
  const base = { schema: 1, kind: "school_register_assignment_columns", fields: ["lat"], row_count: 2, columns: [{ dictionary: ["", "59.001"], indices: [1, 0] }] };
  for (const damage of [
    value => value.columns[0].indices.pop(), value => value.columns[0].indices[0] = -1,
    value => value.columns[0].indices[0] = true, value => value.columns[0].values = ["x", "y"],
    value => value.columns[0].dictionary[0] = null, value => value.row_count = true,
    value => value.fields.push("lat"), value => value.extra = "unexpected"
  ]) {
    const value = structuredClone(base); damage(value);
    assert.throws(() => decodeAssignmentColumns(value), /Некорректный/);
  }
  assert.throws(() => decodeAssignmentColumns(base, [2]), /Некорректный/);
  assert.deepEqual(decodeAssignmentColumns(base), [{ lat: "59.001" }, { lat: "" }]);
});

test("encoded and expanded budgets also reject duplicate-position amplification", () => {
  const base = { schema: 1, kind: "school_register_assignment_columns", fields: ["note"], row_count: 1, columns: [{ constant: "а".repeat(1025) }] };
  assert.throws(() => decodeAssignmentColumns({ ...base, row_count: 4097 }), /объём/);
  assert.throws(() => decodeAssignmentColumns({ ...base, row_count: 4096 }), /объём/);
  assert.throws(() => decodeAssignmentColumns(base, Array(4096).fill(0)), /объём/);
  assert.throws(() => decodeAssignmentColumns(base, undefined, { encodedBytes: 512 * 1024 + 1 }), /объём/);
  const names = { ...base, fields: ["__proto__"], columns: [{ constant: "literal" }] };
  const [row] = decodeAssignmentColumns(names);
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(row, "__proto__").value, "literal");
});

test('verified logical sizes are available before row allocation and include repeated selected positions', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/column-codec-fixture.json', import.meta.url)));
  let actual;
  const rows = decodeAssignmentColumns(fixture.block, fixture.positions, { onStats: value => { actual = value; } });
  const expectedBytes = rows.reduce((total, row) => total + Object.values(row).reduce((sum, value) => sum + Buffer.byteLength(value), 0), 0);
  assert.deepEqual(actual, { rows: rows.length, cells: rows.length * fixture.block.fields.length, logicalUtf8Bytes: expectedBytes });
  const sentinel = new Error('Aggregate budget refused');
  assert.throws(() => decodeAssignmentColumns(fixture.block, undefined, { onStats: () => { throw sentinel; } }), error => error === sentinel);
  assert.throws(() => decodeAssignmentColumns(fixture.block, undefined, { onStats: true }), /Некорректный/);
});
