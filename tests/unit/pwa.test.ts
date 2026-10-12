import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from '@/app/manifest';

const pngSize = (file: string) => {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG signature
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

describe('web app manifest', () => {
  const m = manifest();
  it('names the app Oybek\'s Calendar and opens it like an app', () => {
    expect(m.name).toBe("Oybek's Calendar");
    expect(m.short_name!.length).toBeLessThanOrEqual(12);
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('lists real PNG icons at the sizes browsers need, including a maskable one', () => {
    const icons = m.icons ?? [];
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of icons) {
      const file = path.join('public', icon.src);
      expect(existsSync(file), `${icon.src} is missing`).toBe(true);
      const { w, h } = pngSize(file);
      expect(`${w}x${h}`).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
  });
  it('has an Apple touch icon and an offline page for the service worker', () => {
    expect(pngSize('public/icons/apple-touch-icon.png')).toEqual({ w: 180, h: 180 });
    expect(readFileSync('public/offline.html', 'utf8')).toContain("Oybek's Calendar");
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain('/offline.html');
    expect(sw).not.toMatch(/\/api\//); // never touch API or live-update traffic
  });
});
