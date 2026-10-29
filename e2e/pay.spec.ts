import { expect, test, type Frame, type Page } from '@playwright/test';

async function findFrameWith(page: Page, selector: string, timeoutMs = 20_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if ((await frame.locator(selector).count().catch(() => 0)) > 0) return frame;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`no frame contains ${selector}`);
}

// The Payment Element lists several methods (Card, Bank, Cash App Pay, ...)
// as an accordion with none open, so open "Card" before looking for fields.
async function openCardOption(page: Page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const option = frame.getByText('Card', { exact: true });
      if ((await option.count().catch(() => 0)) > 0) {
        await option.first().click();
        return;
      }
    }
    await page.waitForTimeout(250);
  }
}

// Full browser run of the customer pay page with Stripe's 4242 test card.
// Needs the API, the web app and `stripe listen` all running locally with
// sandbox keys (see README, "End-to-end test"). Skipped otherwise.
const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

test.skip(!process.env.RUN_E2E, 'set RUN_E2E=1 with the API, web app and stripe listen running');

test('customer pays a $25 link with 4242 and the merchant sees it succeed', async ({ page, request }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const signup = await request.post(`${API}/v1/merchants`, {
    data: { name: 'E2E Shop', email, password: 'e2e-password-123' },
  });
  expect(signup.ok()).toBeTruthy();
  const { token } = await signup.json();
  const auth = { authorization: `Bearer ${token}` };

  const link = await request.post(`${API}/v1/pay-links`, {
    headers: { ...auth, 'idempotency-key': crypto.randomUUID() },
    data: { amountCents: 2500, description: 'E2E test' },
  });
  const { payLink } = await link.json();

  await page.goto(`/pay/${payLink.token}`);
  await expect(page.getByText('$25.00').first()).toBeVisible();

  // Stripe renders more than one iframe with this title (one is a hidden
  // helper), so find the frame that actually holds the card number field.
  await openCardOption(page);
  const card = await findFrameWith(page, '[name="number"]');
  await card.locator('[name="number"]').fill('4242424242424242');
  await card.locator('[name="expiry"]').fill('12 / 34');
  await card.locator('[name="cvc"]').fill('123');
  const zip = card.locator('[name="postalCode"]');
  if (await zip.isVisible().catch(() => false)) await zip.fill('11794');

  await page.getByRole('button', { name: /Pay \$25\.00/ }).click();
  // Shown only after the webhook reached the API and the ledger was written.
  await expect(page.getByText('Payment received')).toBeVisible({ timeout: 60_000 });

  const list = await (await request.get(`${API}/v1/payments`, { headers: auth })).json();
  expect(list.payments[0]).toMatchObject({ amountCents: 2500, status: 'succeeded' });
  const balance = await (await request.get(`${API}/v1/balance`, { headers: auth })).json();
  expect(balance.balance.availableCents).toBe(2500);

  if (ADMIN_TOKEN) {
    const check = await (await request.get(`${API}/v1/admin/ledger-check`, { headers: { 'x-admin-token': ADMIN_TOKEN } })).json();
    expect(check.ok).toBe(true);
  }
});
