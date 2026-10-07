import { randomBytes, randomInt, createHash } from 'node:crypto';

export const newToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const newCalendarCode = (): string =>
  Array.from({ length: 4 }, () => LETTERS[randomInt(LETTERS.length)]).join('') + '-' + String(randomInt(10000)).padStart(4, '0');

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const newRecoveryCode = (): string =>
  [0, 1, 2].map(() => Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('')).join('-');
