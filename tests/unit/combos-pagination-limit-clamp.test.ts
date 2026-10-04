import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combos-limit-clamp-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "test-jwt-secret-for-combos-limit-clamp";
process.env.INITIAL_PASSWORD = "admin-secret";

const core = await import("../../src/lib/db/core.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const combosRoute = await import("../../src/app/api/combos/route.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedCombos(count: number) {
  for (let i = 0; i < count; i++) {
    await combosDb.createCombo({
      name: `Combo ${i}`,
      models: [{ provider: "openai", model: "gpt-4.1" }],
    });
  }
}

test.beforeEach(resetDb);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("GET /api/combos?limit=300 clamps to 200 instead of 400", async () => {
  await seedCombos(5);

  const response = await combosRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/combos?limit=300")
  );
  const body = (await response.json()) as { combos: unknown[]; total: number };

  assert.equal(response.status, 200);
  assert.equal(body.total, 5);
  assert.equal(body.combos.length, 5);
});

test("GET /api/combos?limit=1000 clamps to 200 instead of 400", async () => {
  await seedCombos(3);

  const response = await combosRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/combos?limit=1000")
  );
  const body = (await response.json()) as { combos: unknown[]; total: number };

  assert.equal(response.status, 200);
  assert.equal(body.total, 3);
  assert.equal(body.combos.length, 3);
});

test("GET /api/combos?limit=200 (boundary) still returns 200 unaffected", async () => {
  await seedCombos(2);

  const response = await combosRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/combos?limit=200")
  );
  const body = (await response.json()) as { combos: unknown[]; total: number };

  assert.equal(response.status, 200);
  assert.equal(body.combos.length, 2);
});

test("GET /api/combos?limit=0 still returns an empty page, not unbounded", async () => {
  await seedCombos(4);

  const response = await combosRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/combos?limit=0")
  );
  const body = (await response.json()) as { combos: unknown[]; total: number };

  assert.equal(response.status, 200);
  assert.equal(body.total, 4);
  assert.deepEqual(body.combos, []);
});

test("GET /api/combos silently drops a row with a non-string data column and logs a warning", async () => {
  await seedCombos(2);

  const db = core.getDbInstance();
  const now = new Date().toISOString();
  // Bypass createCombo's normal JSON-string write path to simulate a
  // malformed row (e.g. legacy data or a bad migration), matching the shape
  // getSerializedData() rejects (typeof row.data !== "string"). The `data`
  // column has TEXT affinity, so a numeric/string literal would be silently
  // coerced back to TEXT by SQLite on storage; a Buffer stores as BLOB and
  // survives the round trip as a non-string value.
  db.prepare(
    "INSERT INTO combos (id, name, data, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("combo-malformed", "Malformed Combo", Buffer.from("not-json"), 99, now, now);

  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };

  try {
    const response = await combosRoute.GET(
      await makeManagementSessionRequest("http://localhost/api/combos")
    );
    const body = (await response.json()) as { combos: Array<{ name: string }>; total: number };

    assert.equal(response.status, 200);
    // The malformed row is counted (count query doesn't parse `data`) but
    // omitted from the parsed results.
    assert.equal(body.total, 3);
    assert.equal(body.combos.length, 2);
    assert.ok(!body.combos.some((combo) => combo.name === "Malformed Combo"));
  } finally {
    console.warn = originalWarn;
  }

  const matched = warnCalls.some((args) =>
    args.some(
      (arg) =>
        typeof arg === "string" &&
        arg.includes("Skipping combo row with non-string/empty data column") &&
        arg.includes("combo-malformed")
    )
  );
  assert.ok(matched, "expected a console.warn call naming the skipped combo row");
});
