import { test, expect, type Page } from '@playwright/test';
import { addEventApi, addEventUi, createFamily, isoDay, joinFamily, monthCell, newMemberContext, openMonthCell } from './helpers';

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('phone layout', () => {
  test('no page scrolls sideways', async ({ browser }) => {
    const ctx = await newMemberContext(browser);
    await createFamily(ctx);
    const page = await ctx.newPage();
    for (const path of ['/', '/create', '/join']) {
      const guest = await newMemberContext(browser);
      const gp = await guest.newPage();
      await gp.goto(path);
      await expect(gp.locator('main')).toBeVisible();
      expect(await noHorizontalScroll(gp), `${path} overflows`).toBe(true);
      await guest.close();
    }
    await page.goto('/calendar');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.getByRole('tab', { name: 'Week' }).click();
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.getByRole('tab', { name: 'Day' }).click();
    expect(await noHorizontalScroll(page)).toBe(true);
    await ctx.close();
  });

  test('tapping a date opens a bottom sheet; adding an event works', async ({ browser }) => {
    const ctx = await newMemberContext(browser);
    const fam = await createFamily(ctx);
    const day = isoDay(2);
    await addEventApi(ctx, { title: 'Swim', memberId: fam.ownerId, date: day, start: '07:00', end: '08:00' });
    const page = await ctx.newPage();
    await page.goto('/calendar');
    await openMonthCell(page, day);
    const sheet = page.locator('dialog.dlg.sheet[open]');
    const box = await sheet.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 1);
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport.height - 2); // anchored to the bottom
    await expect(sheet.getByText('Swim')).toBeVisible();
    await sheet.getByRole('button', { name: 'Add event' }).click();
    const form = page.getByRole('dialog', { name: 'Add event' });
    await form.getByLabel('Title').fill('Soccer');
    await form.getByRole('group', { name: 'Starts' }).getByLabel('Time').fill('16:00');
    await form.getByRole('group', { name: 'Ends' }).getByLabel('Time').fill('17:00');
    await form.getByRole('button', { name: 'Add event' }).click();
    await expect(form).toBeHidden();
    await expect(page.locator('.toast', { hasText: 'Event added' })).toBeVisible();
    await ctx.close();
  });

  test('tap targets are at least 44px tall', async ({ browser }) => {
    const ctx = await newMemberContext(browser);
    await createFamily(ctx);
    const page = await ctx.newPage();
    await page.goto('/calendar');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, a[href], select, input:not([type=hidden]):not([type=checkbox]):not([type=radio])')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.height < 43.5 && !e.closest('dialog:not([open])');
        })
        .map((e) => `${e.tagName}.${e.className}:${Math.round(e.getBoundingClientRect().height)} "${(e.textContent ?? '').trim().slice(0, 20)}"`),
    );
    expect(small).toEqual([]);
    await ctx.close();
  });

  test('conflicts and scheduled days are readable without colour', async ({ browser }) => {
    const owner = await newMemberContext(browser);
    const fam = await createFamily(owner);
    const dad = await newMemberContext(browser);
    const dadId = await joinFamily(dad, fam.code, 'Dad');
    const clash = isoDay(3);
    const ok = isoDay(5);
    await addEventApi(owner, { title: 'A', memberId: fam.ownerId, date: clash, start: '09:00', end: '10:00' });
    await addEventApi(owner, { title: 'B', memberId: dadId, date: clash, start: '09:30', end: '10:30' });
    await addEventApi(owner, { title: 'C', memberId: fam.ownerId, date: ok });
    const page = await owner.newPage();
    await page.goto('/calendar');
    await expect(monthCell(page, clash)).toContainText('⚠');
    await expect(monthCell(page, clash)).toHaveAttribute('aria-label', /schedule conflict/);
    await expect(monthCell(page, ok)).toContainText('✓');
    await expect(monthCell(page, ok)).toHaveAttribute('aria-label', /, scheduled$/);
    await expect(page.getByLabel('What the day markers mean')).toContainText('Conflict');
    await owner.close();
    await dad.close();
  });
});
