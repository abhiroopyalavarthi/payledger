import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  use: { baseURL: process.env.WEB_URL ?? 'http://localhost:5173', trace: 'retain-on-failure' },
});
