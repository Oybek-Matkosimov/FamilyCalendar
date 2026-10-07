import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiFetch, ApiError } from '@/lib/client/api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch', () => {
  it('sends the CSRF header, JSON body and idempotency key', async () => {
    const f = vi.fn().mockResolvedValue(json(200, { ok: true }));
    vi.stubGlobal('fetch', f);
    await apiFetch('/api/events', { method: 'POST', body: { a: 1 }, idempotencyKey: 'k1' });
    const [path, init] = f.mock.calls[0]!;
    expect(path).toBe('/api/events');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers['x-requested-with']).toBe('fetch');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['idempotency-key']).toBe('k1');
    expect(init.body).toBe('{"a":1}');
  });

  it('turns an error body into an ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(409, { error: { code: 'CONFLICT', message: 'changed' } })));
    await expect(apiFetch('/api/x')).rejects.toMatchObject({ code: 'CONFLICT', status: 409, message: 'changed' });
    await expect(apiFetch('/api/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('handles non-JSON error responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 })));
    await expect(apiFetch('/api/x')).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 502 });
  });

  it('maps a rejected fetch to NETWORK and retries GET once', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('fail')).mockResolvedValueOnce(json(200, { n: 1 }));
    vi.stubGlobal('fetch', f);
    await expect(apiFetch('/api/x')).resolves.toEqual({ n: 1 });
    expect(f).toHaveBeenCalledTimes(2);

    const g = vi.fn().mockRejectedValue(new TypeError('fail'));
    vi.stubGlobal('fetch', g);
    await expect(apiFetch('/api/x')).rejects.toMatchObject({ code: 'NETWORK', message: 'Cannot reach the server. Check your connection and try again.' });
    expect(g).toHaveBeenCalledTimes(2);
  });

  it('never retries a POST', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('fail'));
    vi.stubGlobal('fetch', f);
    await expect(apiFetch('/api/x', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for empty bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await expect(apiFetch('/api/x')).resolves.toBeUndefined();
  });
});
