import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_COLORS } from "../../../src/shared/constants/colors.ts";
import {
  DEFAULT_MODEL_USAGE_TOP_N,
  OTHER_SERIES_COLOR,
  OTHER_SERIES_KEY,
  assignStableModelColors,
  buildModelUsageSeries,
  isNonInferenceModel,
  parseModelUsageTopN,
} from "../../../src/shared/components/analytics/modelUsageSeries.ts";

function makeRows(columns: Record<string, Array<number | undefined>>, days = 3) {
  return Array.from({ length: days }, (_, index) => {
    const row: Record<string, unknown> = { date: `2026-10-0${index + 1}` };
    for (const [key, values] of Object.entries(columns)) row[key] = values[index];
    return row;
  });
}

test("top-N ranks by the range total, not by a single day", () => {
  // "spiky" wins day 1 only; "steady" wins on the range total.
  const rows = makeRows({ spiky: [100, 0, 0], steady: [40, 40, 40], small: [1, 1, 1] });
  const result = buildModelUsageSeries(rows, ["spiky", "steady", "small"], 1);
  assert.deepEqual(
    result.series.map((s) => s.key),
    ["steady", OTHER_SERIES_KEY]
  );
  assert.equal(result.series[0].total, 120);
  assert.equal(result.hiddenModelCount, 2);
});

test("Other equals the per-row and total sums of the hidden models", () => {
  const rows = makeRows({ a: [50, 50, 50], b: [10, 20, 30], c: [1, 2, 3] });
  const result = buildModelUsageSeries(rows, ["a", "b", "c"], 1);
  assert.deepEqual(
    result.rows.map((row) => row[OTHER_SERIES_KEY]),
    [11, 22, 33]
  );
  const other = result.series.find((s) => s.isOther);
  assert.ok(other);
  assert.equal(other.total, 66);
  assert.equal(other.color, OTHER_SERIES_COLOR);
  assert.equal(other.name, "Other");
  assert.deepEqual(result.rows[0], {
    date: "2026-10-01",
    dateLabel: "10/01",
    a: 50,
    [OTHER_SERIES_KEY]: 11,
  });
});

test("non-inference ids are excluded from both the series and Other", () => {
  const excluded = [
    "connection-test",
    "Model-Sync",
    "health-check",
    "healthprobe",
    "codestral-embed",
    "text-embedding-3-small",
  ];
  const columns: Record<string, number[]> = { real: [5, 5, 5], tail: [1, 1, 1] };
  for (const id of excluded) columns[id] = [1000, 1000, 1000];
  const result = buildModelUsageSeries(makeRows(columns), Object.keys(columns), 1);
  assert.deepEqual(
    result.series.map((s) => s.key),
    ["real", OTHER_SERIES_KEY]
  );
  assert.equal(result.series[1].total, 3);
  for (const row of result.rows) {
    for (const id of excluded) assert.equal(id in row, false);
  }
  for (const id of excluded) assert.equal(isNonInferenceModel(id), true, id);
  for (const id of ["gpt-5.6-sol", "healthy-model", "claude-sonnet"]) {
    assert.equal(isNonInferenceModel(id), false, id);
  }
});

test("zero, NaN and undefined values are dropped", () => {
  const rows = makeRows({
    real: [1, Number.NaN, undefined],
    zero: [0, 0, 0],
    nan: [Number.NaN, Number.NaN, Number.NaN],
    missing: [undefined, undefined, undefined],
  });
  const result = buildModelUsageSeries(rows, ["real", "zero", "nan", "missing", "absent"], 8);
  assert.deepEqual(
    result.series.map((s) => s.key),
    ["real"]
  );
  assert.deepEqual(
    result.rows.map((row) => row.real),
    [1, 0, 0]
  );
});

test("shuffled modelNames give identical output, including ties", () => {
  const columns = { b: [5, 5, 5], a: [5, 5, 5], c: [5, 5, 5], d: [9, 9, 9], e: [1, 1, 1] };
  const first = buildModelUsageSeries(makeRows(columns), ["a", "b", "c", "d", "e"], 3);
  const second = buildModelUsageSeries(makeRows(columns), ["e", "c", "d", "b", "a"], 3);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.series.map((s) => s.key),
    ["d", "a", "b", OTHER_SERIES_KEY]
  );
});

test("'all' has no Other series", () => {
  const columns = Object.fromEntries(
    Array.from({ length: 14 }, (_, index) => [`m${index}`, [index + 1, 1, 1]])
  );
  const result = buildModelUsageSeries(makeRows(columns), Object.keys(columns), "all");
  assert.equal(result.series.length, 14);
  assert.equal(
    result.series.some((s) => s.isOther),
    false
  );
  assert.equal(result.hiddenModelCount, 0);
  for (const row of result.rows) assert.equal(OTHER_SERIES_KEY in row, false);
});

test("no Other when the hidden totals are 0", () => {
  const rows = makeRows({ a: [1, 1, 1], b: [2, 2, 2], idle: [0, 0, 0] });
  const result = buildModelUsageSeries(rows, ["a", "b", "idle"], 2);
  assert.deepEqual(
    result.series.map((s) => s.key),
    ["b", "a"]
  );
  for (const row of result.rows) assert.equal(OTHER_SERIES_KEY in row, false);
});

test("empty or missing input yields no rows and no series", () => {
  assert.deepEqual(buildModelUsageSeries(undefined, undefined, 8), {
    rows: [],
    series: [],
    hiddenModelCount: 0,
  });
});

test("parseModelUsageTopN handles valid, invalid and null input", () => {
  assert.equal(parseModelUsageTopN("5"), 5);
  assert.equal(parseModelUsageTopN("8"), 8);
  assert.equal(parseModelUsageTopN("12"), 12);
  assert.equal(parseModelUsageTopN("all"), "all");
  assert.equal(parseModelUsageTopN("garbage"), DEFAULT_MODEL_USAGE_TOP_N);
  assert.equal(parseModelUsageTopN("7"), DEFAULT_MODEL_USAGE_TOP_N);
  assert.equal(parseModelUsageTopN(null), DEFAULT_MODEL_USAGE_TOP_N);
  assert.equal(parseModelUsageTopN(undefined), DEFAULT_MODEL_USAGE_TOP_N);
  assert.equal(DEFAULT_MODEL_USAGE_TOP_N, 8);
});

test("assignStableModelColors is deterministic with no duplicates up to 15 keys", () => {
  const keys = Array.from({ length: MODEL_COLORS.length }, (_, index) => `model-${index}`);
  const first = assignStableModelColors(keys);
  assert.deepEqual(first, assignStableModelColors(keys));
  const values = Object.values(first);
  assert.equal(values.length, 15);
  assert.equal(new Set(values).size, 15);
  for (const color of values) assert.ok(MODEL_COLORS.includes(color));
});

test("assignStableModelColors keeps a model's color when unrelated models change", () => {
  const solo = assignStableModelColors(["gpt-5.6-sol"]);
  // Any key ranked ahead of gpt-5.6-sol that does not hash to its slot leaves it untouched.
  const candidates = Array.from({ length: 50 }, (_, index) => `other-${index}`);
  const unrelated = candidates.find(
    (key) => assignStableModelColors([key])[key] !== solo["gpt-5.6-sol"]
  );
  assert.ok(unrelated);
  const withExtra = assignStableModelColors([unrelated, "gpt-5.6-sol"]);
  assert.equal(withExtra["gpt-5.6-sol"], solo["gpt-5.6-sol"]);
  const removedAgain = assignStableModelColors(["gpt-5.6-sol"]);
  assert.equal(removedAgain["gpt-5.6-sol"], solo["gpt-5.6-sol"]);
  // Adding a model ranked after it never moves it either.
  const withTrailing = assignStableModelColors(["gpt-5.6-sol", ...candidates.slice(0, 10)]);
  assert.equal(withTrailing["gpt-5.6-sol"], solo["gpt-5.6-sol"]);
});
