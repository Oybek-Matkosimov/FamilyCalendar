export function timezones(extra?: string): { all: string[]; current: string } {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    all = [];
  }
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const set = new Set([...all, current, 'UTC', ...(extra ? [extra] : [])]);
  return { all: [...set].sort(), current };
}
