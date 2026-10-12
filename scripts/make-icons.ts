/**
 * Regenerates the app icons in public/icons from one SVG design.   npx tsx scripts/make-icons.ts
 * Uses Playwright to rasterise (locally the installed Microsoft Edge; set PW_CHANNEL=chrome to use Chrome).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BLUE = '#2450d8';
const DEEP = '#1b3fb0';

/** `bleed`: full-square background (maskable / Apple icons, the OS applies its own rounding). */
function svg(bleed: boolean): string {
  const bg = bleed ? `<rect width="512" height="512" fill="${BLUE}"/>` : `<rect width="512" height="512" rx="112" fill="${BLUE}"/>`;
  const cell = (x: number, y: number, fill: string, opacity = 1) =>
    `<rect x="${x}" y="${y}" width="52" height="46" rx="12" fill="${fill}" opacity="${opacity}"/>`;
  const xs = [150, 230, 310];
  const ys = [248, 314];
  const grid = ys
    .flatMap((y, r) =>
      xs.map((x, c) => (r === 0 && c === 1 ? cell(x, y, '#0b7a57') : r === 1 && c === 2 ? cell(x, y, '#c42b3a') : cell(x, y, DEEP, 0.18))),
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    ${bg}
    <rect x="106" y="122" width="300" height="290" rx="42" fill="#ffffff"/>
    <path d="M106 164a42 42 0 0 1 42-42h216a42 42 0 0 1 42 42v52H106z" fill="${DEEP}"/>
    <rect x="178" y="92" width="26" height="62" rx="13" fill="#ffffff"/>
    <rect x="308" y="92" width="26" height="62" rx="13" fill="#ffffff"/>
    ${grid}
  </svg>`;
}

async function render(page: import('@playwright/test').Page, markup: string, size: number, file: string) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${markup.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</div></body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(file, png);
  console.log('wrote', file, png.length, 'bytes');
}

async function main() {
  mkdirSync('public/icons', { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await render(page, svg(false), 192, 'public/icons/icon-192.png');
  await render(page, svg(false), 512, 'public/icons/icon-512.png');
  await render(page, svg(true), 512, 'public/icons/icon-maskable-512.png');
  await render(page, svg(true), 180, 'public/icons/apple-touch-icon.png');
  await render(page, svg(false), 64, 'public/icons/favicon-64.png');
  writeFileSync('public/icons/icon.svg', svg(false));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
