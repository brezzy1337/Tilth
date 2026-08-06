/**
 * Email masking — pure, dependency-free (no node:crypto, no Buffer, no env).
 *
 * Split out of `routers/auth.ts` / `scripts/purge-deleted-accounts.ts`, which
 * used to each carry a byte-identical copy of this function (F-054 review
 * finding). Lives in its own tiny module — NOT `auth.ts` — because
 * `routers/auth.ts` must never import `auth.ts` (that would pull node:crypto
 * into the router import tree and break mobile's typecheck; see that file's
 * header comment). `scripts/purge-deleted-accounts.ts` already imports from
 * `../src/*.js` for its other helpers, so importing this module from both
 * sides is the established `scripts/` -> `src/` direction.
 */

/**
 * Mask an email for display: keeps the first char of the local part and the
 * first char of the domain, replaces the rest with `*`s (e.g.
 * "jane@example.com" -> "j***@e***.com" — the TLD is kept as-is since it
 * carries no PII on its own). Never throws on a malformed (no "@") value —
 * returns a fixed redacted placeholder instead.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***"; // malformed — never print/return it verbatim
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const domainHead = dot > 0 ? domain.slice(0, dot) : domain;
  const domainTail = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${domainHead[0] ?? "*"}***${domainTail}`;
}
