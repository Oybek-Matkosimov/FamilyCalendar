import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 defaults to argon2id.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (p: string): Promise<string> => hash(p, OPTS);

export async function verifyPassword(h: string, p: string): Promise<boolean> {
  try {
    return await verify(h, p);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** Burn the same CPU as a real verification so unknown calendar codes are not distinguishable by timing. */
export async function verifyDummy(p: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummy, p);
}
