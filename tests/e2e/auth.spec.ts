import { test, expect } from '@playwright/test';
import { PASSWORD, createFamily, createFamilyViaUi, newMemberContext } from './helpers';

test.describe('creating and joining', () => {
  test('create gates on the recovery code and never shows the password again', async ({ browser }) => {
    const ctx = await newMemberContext(browser);
    const page = await ctx.newPage();
    await page.goto('/create');
    await page.getByLabel('Family or calendar name').fill('Gate Family');
    await page.getByLabel('Your name').fill('Oybek');
    await page.getByLabel('Calendar password').fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create calendar' }).click();
    await expect(page.getByRole('heading', { name: 'Gate Family is ready' })).toBeVisible();
    await expect(page.locator('.big-code').first()).toHaveText(/^[A-Z]{4}-\d{4}$/);
    const open = page.getByRole('button', { name: 'Open calendar' });
    await expect(open).toBeDisabled();
    await expect(page.locator('body')).not.toContainText(PASSWORD);
    await page.getByLabel(/I saved my recovery code/).check();
    await expect(open).toBeEnabled();
    await open.click();
    await expect(page).toHaveURL(/\/calendar/);
    await expect(page.getByText('Gate Family').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText(PASSWORD);
    await ctx.close();
  });

  test('create form validates before talking to the server', async ({ browser }) => {
    const ctx = await newMemberContext(browser);
    const page = await ctx.newPage();
    await page.goto('/create');
    await page.getByRole('button', { name: 'Create calendar' }).click();
    await expect(page.getByText('Enter a name for your family calendar')).toBeVisible();
    await expect(page.getByText('Use at least 8 characters')).toBeVisible();
    await page.getByLabel('Calendar password').fill(PASSWORD);
    await page.getByLabel('Confirm password').fill('something else');
    await page.getByRole('button', { name: 'Create calendar' }).click();
    await expect(page.getByText('The passwords do not match')).toBeVisible();
    await ctx.close();
  });

  test('a second person joins; wrong password is rejected; same name asks "Is this you?"', async ({ browser }) => {
    const owner = await newMemberContext(browser);
    const ownerPage = await owner.newPage();
    const code = await createFamilyViaUi(ownerPage, { family: 'Join Family', name: 'Oybek' });

    const mom = await newMemberContext(browser);
    const page = await mom.newPage();
    await page.goto('/join');
    await page.getByLabel('Calendar ID').fill(code);
    await page.getByLabel('Your name').fill('Mom');
    await page.getByLabel('Calendar password').fill('definitely wrong');
    await page.getByRole('button', { name: 'Join calendar' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Invalid calendar ID or password' })).toBeVisible();

    await page.getByLabel('Calendar password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Join calendar' }).click();
    await expect(page).toHaveURL(/\/calendar/);
    await expect(page.getByText('Join Family').first()).toBeVisible();

    // another device, same name -> confirmation
    const phone = await newMemberContext(browser);
    const p2 = await phone.newPage();
    await p2.goto(`/join?code=${code}`);
    await p2.getByLabel('Your name').fill('mom');
    await p2.getByLabel('Calendar password').fill(PASSWORD);
    await p2.getByRole('button', { name: 'Join calendar' }).click();
    const confirm = p2.getByRole('dialog', { name: 'Is this you?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: /Yes, that/ }).click();
    await expect(p2).toHaveURL(/\/calendar/);
    await expect(p2.getByText('Mom').first()).toBeVisible();
    for (const c of [owner, mom, phone]) await c.close();
  });

  test('repeated wrong passwords lock the calendar for a while', async ({ browser }) => {
    const owner = await newMemberContext(browser);
    const { code } = await createFamily(owner, 'Lock Family');
    const ctx = await newMemberContext(browser);
    const page = await ctx.newPage();
    await page.goto('/join');
    await page.getByLabel('Calendar ID').fill(code);
    await page.getByLabel('Your name').fill('Intruder');
    for (let i = 0; i < 5; i++) {
      await page.getByLabel('Calendar password').fill(`wrong-guess-${i}`);
      await page.getByRole('button', { name: 'Join calendar' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Invalid calendar ID or password' })).toBeVisible();
    }
    await page.getByLabel('Calendar password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Join calendar' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Too many attempts' })).toBeVisible();
    await expect(page).toHaveURL(/\/join/);
    await owner.close();
    await ctx.close();
  });

  test('an invite link fills in the calendar and still needs the password', async ({ browser }) => {
    const owner = await newMemberContext(browser);
    const ownerPage = await owner.newPage();
    await createFamilyViaUi(ownerPage, { family: 'Invite Family', name: 'Oybek' });
    await ownerPage.getByRole('button', { name: 'Invite' }).click();
    const dlg = ownerPage.getByRole('dialog', { name: 'Invite family' });
    await dlg.getByRole('button', { name: 'Create invite link' }).click();
    const text = await dlg.getByRole('textbox').inputValue();
    expect(text).toContain('Join the Invite Family Family Calendar');
    expect(text).not.toContain(PASSWORD);
    const url = text.split('\n').find((l) => l.startsWith('http'))!;

    const guest = await newMemberContext(browser);
    const page = await guest.newPage();
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Join the Invite Family calendar' })).toBeVisible();
    await expect(page.getByLabel('Calendar ID')).toHaveValue(/^[A-Z]{4}-\d{4}$/);
    await page.getByLabel('Your name').fill('Guest');
    await page.getByLabel('Calendar password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Join calendar' }).click();
    await expect(page).toHaveURL(/\/calendar/);
    await owner.close();
    await guest.close();
  });

  test('signing in as the owner on a new device needs the recovery code', async ({ browser }) => {
    const owner = await newMemberContext(browser);
    const op = await owner.newPage();
    await op.goto('/create');
    await op.getByLabel('Family or calendar name').fill('Owner Proof Family');
    await op.getByLabel('Your name').fill('Oybek');
    await op.getByLabel('Calendar password').fill(PASSWORD);
    await op.getByLabel('Confirm password').fill(PASSWORD);
    await op.getByRole('button', { name: 'Create calendar' }).click();
    await expect(op.getByRole('heading', { name: /is ready/ })).toBeVisible();
    const code = (await op.locator('.big-code').first().innerText()).trim();
    const recovery = (await op.locator('.recovery code').innerText()).trim();

    const phone = await newMemberContext(browser);
    const p = await phone.newPage();
    await p.goto(`/join?code=${code}`);
    await p.getByLabel('Your name').fill('Oybek');
    await p.getByLabel('Calendar password').fill(PASSWORD);
    await p.getByRole('button', { name: 'Join calendar' }).click();
    await p.getByRole('dialog', { name: 'Is this you?' }).getByRole('button', { name: /Yes, that/ }).click();
    const proof = p.getByRole('dialog', { name: 'Sign in as the owner' });
    await expect(proof).toBeVisible();
    await proof.getByLabel('Recovery code').fill('AAAA-BBBB-CCCC');
    await proof.getByRole('button', { name: 'Sign in as owner' }).click();
    await expect(p.getByRole('alert').filter({ hasText: 'Invalid calendar ID or recovery code' })).toBeVisible();
    await expect(p).toHaveURL(/\/join/);

    await p.getByRole('button', { name: 'Join calendar' }).click();
    await p.getByRole('dialog', { name: 'Is this you?' }).getByRole('button', { name: /Yes, that/ }).click();
    await p.getByRole('dialog', { name: 'Sign in as the owner' }).getByLabel('Recovery code').fill(recovery);
    await p.getByRole('button', { name: 'Sign in as owner' }).click();
    await expect(p).toHaveURL(/\/calendar/);
    await p.getByRole('button', { name: 'Settings' }).click();
    await expect(p.getByRole('button', { name: 'Delete calendar…' })).toBeVisible(); // owner tools available
    await owner.close();
    await phone.close();
  });
});
