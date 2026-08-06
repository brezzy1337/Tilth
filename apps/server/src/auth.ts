/**
 * Auth helpers — pure, env-free.
 *
 * All functions take their secret/key as a parameter; they never import env.
 * This keeps them fully testable without any process.env setup.
 *
 * Password storage format:
 *   `<hex-salt>:<hex-hash>`
 *   where salt is 32 random bytes and hash is the 64-byte scrypt output
 *   (N=16384, r=8, p=1 — OWASP minimum recommendation for interactive login).
 */

import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { RESTORE_CODE_LENGTH } from "@homegrown/shared";

const SALT_BYTES = 32;
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const TOKEN_TTL = "7d";
const ALG = "HS256";

/** Promise wrapper for node:crypto scrypt that forwards the options object. */
function scryptAsync(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password.
 * Returns `<hex-salt>:<hex-hash>` suitable for storing in `users.password_hash`.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(plain, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored `<hex-salt>:<hex-hash>` string.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const colonIndex = stored.indexOf(":");
  // colonIndex === -1 → no colon; colonIndex === 0 → empty salt (e.g. ":abc");
  // colonIndex === stored.length - 1 → empty hash (e.g. "abc:").
  if (colonIndex <= 0 || colonIndex >= stored.length - 1) return false;

  const salt = Buffer.from(stored.slice(0, colonIndex), "hex");
  const expectedHash = Buffer.from(stored.slice(colonIndex + 1), "hex");

  // Decoded salt must be exactly SALT_BYTES long; a zero-length or wrong-length
  // decoded value means the hex was empty or malformed.
  if (salt.length !== SALT_BYTES) return false;

  const actualHash = await scryptAsync(plain, salt, KEY_LENGTH);

  if (actualHash.length !== expectedHash.length) return false;
  return timingSafeEqual(actualHash, expectedHash);
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Sign a JWT for the given userId.
 * Returns a compact JWS string (HS256, 7-day expiry).
 */
export async function signToken(
  userId: string,
  secret: string,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey(secret));
}

/**
 * Verify a JWT and return its `sub` (user id) claim.
 * Returns `null` on any failure: invalid signature, expired, malformed.
 */
export async function verifyToken(
  token: string,
  secret: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      algorithms: [ALG],
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Restore codes (F-054) — email-verified account restore
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random `RESTORE_CODE_LENGTH`-digit code (e.g.
 * "042137"), zero-padded. Uses `crypto.randomInt` (uniformly distributed,
 * cryptographically secure) rather than `Math.random()`. Lives here (not
 * `routers/auth.ts`) because it needs `node:crypto` — the router tree stays
 * node-built-in-free for mobile-typecheck compatibility; routers call this
 * via `ctx.auth.generateRestoreCode()` (see `AuthHelpers` in `context.ts`).
 */
export function generateRestoreCode(): string {
  const max = 10 ** RESTORE_CODE_LENGTH;
  const value = randomInt(0, max);
  return value.toString().padStart(RESTORE_CODE_LENGTH, "0");
}
