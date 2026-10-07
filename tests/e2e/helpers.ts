import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse';
const API_HEADERS = { origin: 'http://localhost:3100', 'x-requested-with': 'fetch', 'content-type': 'application/json' };

let ipCounter = Math.floor(Math.random() * 200) + 1;
/** Each test gets its own client IP so lockouts in one test never leak into another. */
export const uniqueIp = () => `10.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}.${Math.floor(Math.random() * 250) + 1}`;

export async function newMemberContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': uniqueIp() } });
}

/** `YYYY-MM-DD` for today + offset days in the machine timezone (calendars default to it). */
export function isoDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
export const monthCell = (page: Page, iso: string) => page.getByRole('button', { name: new RegExp(`^${dayLabel(iso)},`) });

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export interface Family {
  code: string;
  ownerId: string;
}

/** Fast API-level setup. The context's cookie jar ends up signed in as the owner. */
export async function createFamily(ctx: BrowserContext, familyName = 'Matkosimov', ownerName = 'Oybek'): Promise<Family> {
  const res = await ctx.request.post('/api/calendars', {
    headers: API_HEADERS,
    data: { familyName, memberName: ownerName, password: PASSWORD, timezone: tz() },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { code: body.calendar.code, ownerId: body.member.id };
}

export async function joinFamily(ctx: BrowserContext, code: string, name: string): Promise<string> {
  const res = await ctx.request.post('/api/auth/join', { headers: API_HEADERS, data: { code, memberName: name, password: PASSWORD } });
  expect(res.status()).toBe(200);
  return (await res.json()).member.id as string;
}

export async function addEventApi(
  ctx: BrowserContext,
  e: { title: string; memberId: string; date: string; start?: string; end?: string; recurrence?: unknown; description?: string },
) {
  const res = await ctx.request.post('/api/events', {
    headers: API_HEADERS,
    data: {
      title: e.title, memberId: e.memberId, allDay: false, description: e.description,
      start: `${e.date}T${e.start ?? '10:00'}`, end: `${e.date}T${e.end ?? '11:00'}`, recurrence: e.recurrence,
    },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

/** Create a calendar through the real UI and land on the dashboard. Returns the calendar ID. */
export async function createFamilyViaUi(page: Page, o: { family: string; name: string }): Promise<string> {
  await page.goto('/create');
  await page.getByLabel('Family or calendar name').fill(o.family);
  await page.getByLabel('Your name').fill(o.name);
  await page.getByLabel('Calendar password').fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create calendar' }).click();
  await expect(page.getByRole('heading', { name: /is ready/ })).toBeVisible();
  const code = (await page.locator('.big-code').first().innerText()).trim();
  await page.getByLabel(/I saved my recovery code/).check();
  await page.getByRole('button', { name: 'Open calendar' }).click();
  await expect(page).toHaveURL(/\/calendar/);
  return code;
}

export async function openMonthCell(page: Page, iso: string) {
  await monthCell(page, iso).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: dayLabel(iso) })).toBeVisible();
}

export async function addEventUi(
  page: Page,
  e: { title: string; /** exact option text, e.g. 'Dad' or 'Oybek (you)' */ who?: string; date: string; start: string; end: string; description?: string; repeat?: string },
) {
  await page.getByRole('button', { name: 'Add event' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add event' });
  await dlg.getByLabel('Title').fill(e.title);
  if (e.who) await dlg.getByLabel('Who is this for?').selectOption({ label: e.who });
  const starts = dlg.getByRole('group', { name: 'Starts' });
  const ends = dlg.getByRole('group', { name: 'Ends' });
  await starts.getByLabel('Date').fill(e.date);
  await starts.getByLabel('Time').fill(e.start);
  await ends.getByLabel('Time').fill(e.end);
  if (e.description) await dlg.getByLabel('Comment (optional)').fill(e.description);
  if (e.repeat) await dlg.getByLabel('Repeat').selectOption(e.repeat);
  await dlg.getByRole('button', { name: 'Add event' }).click();
  await expect(dlg).toBeHidden();
}
