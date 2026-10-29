import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { checkLedger } from '../src/ledger/ledger.js';
import { resetDb, startTestApp, type TestApp } from './helpers.js';

// One app per test file, shared through globalThis so test files can grab it.
declare global {
  var testApp: TestApp;
}

beforeAll(async () => {
  globalThis.testApp = await startTestApp();
});

beforeEach(async () => {
  await resetDb(globalThis.testApp.sql);
});

// The ledger invariant is checked after every single test, not just in the ledger tests.
afterEach(async () => {
  const report = await checkLedger(globalThis.testApp.db);
  expect(report, 'ledger invariant broken after this test').toMatchObject({ ok: true });
});

afterAll(async () => {
  await globalThis.testApp.close();
});
