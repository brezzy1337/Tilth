/**
 * Pure, side-effect-free helper to parse a DATABASE_URL into the form
 * that postgres.js accepts.
 *
 * postgres.js parses connection strings with `new URL()`, which throws on the
 * Cloud SQL unix-socket form `postgres://USER:PASS@/DBNAME?host=SOCKETPATH`
 * (empty host authority).  When that form is detected we return a structured
 * options object instead; postgres.js happily accepts either.
 *
 * This module MUST NOT import anything with side effects (no env, no db).
 */

export interface SocketConnectionOptions {
  host: string;
  database: string;
  username: string;
  password: string;
}

/**
 * Matches the Cloud SQL unix-socket DSN form:
 *   postgres://USER:PASS@/DBNAME?host=SOCKETPATH
 *   postgresql://USER:PASS@/DBNAME?host=SOCKETPATH
 *
 * Groups: 1=username 2=password 3=database 4=socket-path
 */
const SOCKET_DSN_RE =
  /^postgres(?:ql)?:\/\/([^:/?#]+):([^@]+)@\/([^?]+)\?host=(.+)$/i;

/**
 * Given a raw DATABASE_URL string, returns either:
 * - A `SocketConnectionOptions` object when the URL is the unix-socket form
 *   (so postgres.js never calls `new URL()` on it), or
 * - The original string unchanged for TCP / standard URL forms.
 */
export function dbConnection(url: string): string | SocketConnectionOptions {
  const match = SOCKET_DSN_RE.exec(url);
  if (!match) {
    // Standard TCP URL — postgres.js parses it fine with new URL().
    return url;
  }

  // Groups are guaranteed non-null by the regex structure above.
  const rawUsername = match[1] as string;
  const rawPassword = match[2] as string;
  const rawDatabase = match[3] as string;
  const rawSocketPath = match[4] as string;

  return {
    host: decodeURIComponent(rawSocketPath),
    database: decodeURIComponent(rawDatabase),
    username: decodeURIComponent(rawUsername),
    password: decodeURIComponent(rawPassword),
  };
}
