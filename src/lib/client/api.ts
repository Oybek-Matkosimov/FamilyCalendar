export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const NETWORK_MESSAGE = 'Cannot reach the server. Check your connection and try again.';

function statusToCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UNAVAILABLE';
  return 'VALIDATION';
}

/** fetch wrapper for our own API: CSRF header, JSON in/out, typed errors, one retry for idempotent GETs. */
export async function apiFetch<T = unknown>(path: string, opts: FetchOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { 'x-requested-with': 'fetch' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const init: RequestInit = {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  };

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (method !== 'GET') throw new ApiError('NETWORK', 0, NETWORK_MESSAGE);
    try {
      res = await fetch(path, init);
    } catch {
      throw new ApiError('NETWORK', 0, NETWORK_MESSAGE);
    }
  }

  const text = await res.text().catch(() => '');
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(
      err?.code ?? statusToCode(res.status),
      res.status,
      err?.message ?? (res.status >= 500 ? 'The service is temporarily unavailable. Please try again.' : 'Request failed'),
    );
  }
  return data as T;
}
