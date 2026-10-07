import { test, expect, type Browser } from '@playwright/test';
import {
  PASSWORD, addEventApi, addEventUi, createFamily, dayLabel, isoDay, joinFamily, monthCell, newMemberContext, openMonthCell,
} from './helpers';

/** An owner (with a page already on the dashboard) plus Dad and Mom in their own browser contexts. */
async function family(browser: Browser, name = 'Matkosimov') {
  const owner = await newMemberContext(browser);
  const fam = await createFamily(owner, name);
  const dadCtx = await newMemberContext(browser);
  const momCtx = await newMemberContext(browser);
  const dadId = await joinFamily(dadCtx, fam.code, 'Dad');
  const momId = await joinFamily(momCtx, fam.code, 'Mom');
  const page = await owner.newPage();
  return { owner, dadCtx, momCtx, page, fam, dadId, momId, close: () => Promise.all([owner.close(), dadCtx.close(), momCtx.close()]) };
}

const header = { origin: 'http://localhost:3100', 'x-requested-with': 'fetch', 'content-type': 'application/json' };

test.describe('dashboard', () => {
  test('a scheduled day is marked, and edits by someone else show up live with their name', async ({ browser }) => {
    const f = await family(browser);
    const day = isoDay(2);
    const ev = await addEventApi(f.owner, { title: 'Gym', memberId: f.fam.ownerId, date: day, start: '18:00', end: '19:30', description: 'Leg day' });
    await f.page.goto('/calendar');
    await expect(monthCell(f.page, day)).toHaveAttribute('aria-label', /1 event, scheduled/);
    await expect(monthCell(f.page, day)).toContainText('✓');

    // Mom edits from her phone; the owner's open page updates without a reload.
    const res = await f.momCtx.request.patch(`/api/events/${ev.eventId}`, { headers: header, data: { title: 'Gym (legs)', version: 1 } });
    expect(res.status()).toBe(200);
    await expect(monthCell(f.page, day)).toContainText('Gym (legs)');

    await openMonthCell(f.page, day);
    const dlg = f.page.getByRole('dialog');
    await expect(dlg.getByText('Last edited by Mom')).toBeVisible();
    await expect(dlg.getByText('Comment: Leg day')).toBeVisible();
    await dlg.getByRole('button', { name: 'History' }).click();
    await expect(dlg.getByText(/Created by Oybek —/)).toBeVisible();
    await expect(dlg.getByText(/Edited by Mom —/)).toBeVisible();
    await f.close();
  });

  test('overlapping schedules show a conflict with a readable explanation; touching ones do not', async ({ browser }) => {
    const f = await family(browser);
    const clash = isoDay(3);
    const touch = isoDay(4);
    await addEventApi(f.owner, { title: 'Work', memberId: f.dadId, date: clash, start: '10:00', end: '12:00' });
    await addEventApi(f.owner, { title: 'University', memberId: f.momId, date: clash, start: '11:30', end: '13:00' });
    await addEventApi(f.owner, { title: 'A', memberId: f.dadId, date: touch, start: '10:00', end: '11:00' });
    await addEventApi(f.owner, { title: 'B', memberId: f.momId, date: touch, start: '11:00', end: '12:00' });
    await f.page.goto('/calendar');

    await expect(monthCell(f.page, clash)).toHaveAttribute('aria-label', /schedule conflict/);
    await expect(monthCell(f.page, clash)).toContainText('⚠');
    await expect(monthCell(f.page, touch)).toHaveAttribute('aria-label', /, scheduled$/);
    await expect(f.page.getByRole('button', { name: /1 scheduling conflict/ })).toBeVisible();

    await openMonthCell(f.page, clash);
    const dlg = f.page.getByRole('dialog');
    await expect(dlg.getByText('Schedule conflict')).toBeVisible();
    await expect(dlg.getByText('Dad and Mom have overlapping schedules from 11:30 AM to 12:00 PM.')).toBeVisible();
    await f.close();
  });

  test('add an event through the form; it survives a reload', async ({ browser }) => {
    const f = await family(browser);
    const day = isoDay(5);
    await f.page.goto('/calendar');
    await addEventUi(f.page, { title: 'Dentist appointment', who: 'Oybek (you)', date: day, start: '14:00', end: '15:00', description: 'Bring forms' });
    await expect(monthCell(f.page, day)).toContainText('Dentist appointment');
    await f.page.reload();
    await expect(monthCell(f.page, day)).toContainText('Dentist appointment');
    await openMonthCell(f.page, day);
    await expect(f.page.getByRole('dialog').getByText('2:00 PM – 3:00 PM')).toBeVisible();
    await f.close();
  });

  test('the form rejects an end before the start without calling the server', async ({ browser }) => {
    const f = await family(browser);
    await f.page.goto('/calendar');
    await f.page.getByRole('button', { name: 'Add event' }).first().click();
    const dlg = f.page.getByRole('dialog', { name: 'Add event' });
    await dlg.getByLabel('Title').fill('Backwards');
    const starts = dlg.getByRole('group', { name: 'Starts' });
    const ends = dlg.getByRole('group', { name: 'Ends' });
    await starts.getByLabel('Date').fill(isoDay(1));
    await starts.getByLabel('Time').fill('10:00');
    await ends.getByLabel('Date').fill(isoDay(1));
    await ends.getByLabel('Time').fill('09:00');
    await dlg.getByRole('button', { name: 'Add event' }).click();
    await expect(dlg.getByText('The end must be after the start')).toBeVisible();
    await f.close();
  });

  test('deleting asks for confirmation first', async ({ browser }) => {
    const f = await family(browser);
    const day = isoDay(2);
    await addEventApi(f.owner, { title: 'Throwaway', memberId: f.fam.ownerId, date: day });
    await f.page.goto('/calendar');
    await openMonthCell(f.page, day);
    await f.page.getByRole('button', { name: 'Delete Throwaway' }).click();
    const confirm = f.page.getByRole('dialog', { name: 'Delete this event?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Keep it' }).click();
    await expect(monthCell(f.page, day)).toContainText('Throwaway');
    // the day sheet is still open underneath; delete again from it
    await f.page.getByRole('button', { name: 'Delete Throwaway' }).click();
    await f.page.getByRole('dialog', { name: 'Delete this event?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(monthCell(f.page, day)).not.toContainText('Throwaway');
    await f.close();
  });

  test('filter by person and search by title or comment', async ({ browser }) => {
    const f = await family(browser);
    const day = isoDay(2);
    await addEventApi(f.owner, { title: 'Work', memberId: f.dadId, date: day, start: '08:00', end: '09:00' });
    await addEventApi(f.owner, { title: 'Piano', memberId: f.momId, date: day, start: '16:00', end: '17:00', description: 'recital practice' });
    await f.page.goto('/calendar');
    await expect(monthCell(f.page, day)).toContainText('Work');
    await expect(monthCell(f.page, day)).toContainText('Piano');
    await f.page.getByRole('button', { name: 'Dad', exact: true }).click();
    await expect(monthCell(f.page, day)).toContainText('Work');
    await expect(monthCell(f.page, day)).not.toContainText('Piano');
    await f.page.getByRole('button', { name: 'Everyone' }).click();
    await f.page.getByRole('searchbox', { name: 'Search events' }).fill('recital');
    await expect(monthCell(f.page, day)).toContainText('Piano');
    await expect(monthCell(f.page, day)).not.toContainText('Work');
    await f.close();
  });

  test('month, week and day views with previous, next and today', async ({ browser }) => {
    const f = await family(browser);
    await f.page.goto('/calendar');
    const title = f.page.getByRole('heading', { level: 1 });
    const monthName = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    await expect(title).toHaveText(monthName);
    await f.page.getByRole('button', { name: 'Next month' }).click();
    await expect(title).not.toHaveText(monthName);
    await f.page.getByRole('button', { name: 'Today' }).click();
    await expect(title).toHaveText(monthName);
    await expect(f.page.locator('[aria-current="date"]').first()).toBeVisible();

    await f.page.getByRole('tab', { name: 'Week' }).click();
    await expect(f.page.getByLabel('Week calendar')).toBeVisible();
    await f.page.getByRole('tab', { name: 'Day' }).click();
    await expect(title).toHaveText(dayLabel(isoDay(0)));
    await f.page.getByRole('button', { name: 'Next day' }).click();
    await expect(title).toHaveText(dayLabel(isoDay(1)));
    await f.close();
  });

  test('a weekday series appears Monday to Friday only', async ({ browser }) => {
    const f = await family(browser);
    await addEventApi(f.owner, { title: 'School', memberId: f.momId, date: isoDay(-14), start: '08:30', end: '15:30', recurrence: { freq: 'weekdays' } });
    await f.page.goto('/calendar');
    await f.page.getByRole('tab', { name: 'Week' }).click();
    await expect(f.page.locator('.week-day').filter({ hasText: 'School' })).toHaveCount(5);
    await expect(f.page.locator('.week-day').filter({ hasText: 'Nothing planned' })).toHaveCount(2);
    await f.close();
  });

  test('saving over someone else’s change asks you to review first', async ({ browser }) => {
    const f = await family(browser);
    const day = isoDay(2);
    const ev = await addEventApi(f.owner, { title: 'Dinner', memberId: f.fam.ownerId, date: day, start: '18:00', end: '19:00' });
    await f.page.goto('/calendar');
    await openMonthCell(f.page, day);
    await f.page.getByRole('button', { name: 'Edit Dinner' }).click();
    const form = f.page.getByRole('dialog', { name: 'Edit event' });
    await expect(form).toBeVisible();

    const res = await f.momCtx.request.patch(`/api/events/${ev.eventId}`, { headers: header, data: { title: 'Dinner at Nonna’s', version: 1 } });
    expect(res.status()).toBe(200);

    await form.getByLabel('Title').fill('Dinner at home');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form.getByRole('alert').filter({ hasText: 'Mom changed this event' })).toBeVisible();
    await expect(form.getByLabel('Title')).toHaveValue('Dinner at home'); // user input kept
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    await expect(monthCell(f.page, day)).toContainText('Dinner at home');
    await f.close();
  });

  test('owner can remove a member; the removed member is signed out', async ({ browser }) => {
    const f = await family(browser);
    const momPage = await f.momCtx.newPage();
    await momPage.goto('/calendar');
    await expect(momPage.getByText('Matkosimov').first()).toBeVisible();
    await f.page.goto('/calendar');
    await f.page.getByRole('button', { name: 'Members' }).click();
    await f.page.getByRole('button', { name: 'Remove Mom' }).click();
    await f.page.getByRole('button', { name: 'Remove member' }).click();
    await expect(f.page.getByText('Mom was removed')).toBeVisible();
    await momPage.reload();
    await expect(momPage).toHaveURL(/localhost:3100\/$/);
    await expect(momPage.getByRole('link', { name: 'Join Family Calendar' })).toBeVisible();
    await f.close();
  });

  test('settings: members cannot change them, owner can; password never shown', async ({ browser }) => {
    const f = await family(browser);
    const dadPage = await f.dadCtx.newPage();
    await dadPage.goto('/calendar');
    await dadPage.getByRole('button', { name: 'Settings' }).click();
    await expect(dadPage.getByText('Only the calendar owner can change calendar settings.')).toBeVisible();
    await expect(dadPage.getByRole('button', { name: 'Delete calendar…' })).toHaveCount(0);
    await f.page.goto('/calendar');
    await f.page.getByRole('button', { name: 'Settings' }).click();
    const dlg = f.page.getByRole('dialog', { name: 'Settings' });
    await expect(dlg.getByRole('button', { name: 'Delete calendar…' })).toBeVisible();
    await expect(dlg).not.toContainText(PASSWORD);
    await f.close();
  });
});
