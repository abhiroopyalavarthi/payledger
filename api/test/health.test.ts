import { describe, expect, it } from 'vitest';

describe('health and errors', () => {
  it('GET /health', async () => {
    const res = await globalThis.testApp.api().get('/health');
    expect(res.body).toEqual({ ok: true });
  });

  it('unknown routes use the standard error shape', async () => {
    const res = await globalThis.testApp.api().get('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'No such route' } });
  });
});
