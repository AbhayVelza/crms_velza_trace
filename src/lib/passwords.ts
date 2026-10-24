// Password hashing (scrypt, built into Node) and session tokens. No plain password is ever stored.

import { createHash, randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEY_LEN = 64;
const PARAMS: ScryptOptions = { N: 16384, r: 8, p: 1 };

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, KEY_LEN, PARAMS, (err, key) => (err ? reject(err) : resolve(key))));
}

/** "scrypt$<salt b64>$<hash b64>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await scrypt(password, salt)).toString("base64")}`;
}

/** Synchronous variant for the seed builder. */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, KEY_LEN, PARAMS).toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) {
    // Same work as a real check, so a missing account can't be told apart by timing.
    await scrypt(password, Buffer.alloc(16));
    return false;
  }
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sessions are stored by token hash, so the data file alone can't be used to sign in. */
export function sessionIdOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
