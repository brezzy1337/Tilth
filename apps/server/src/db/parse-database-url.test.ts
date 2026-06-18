/**
 * Unit tests for the pure dbConnection() helper.
 *
 * This file MUST NOT import db/index.ts or env.ts — both have import-time
 * side effects (env validation + DB connection setup).
 */

import { describe, expect, it } from "vitest";
import { dbConnection } from "./parse-database-url.js";

describe("dbConnection — unix-socket (Cloud SQL) form", () => {
  it("returns a structured object for the canonical socket DSN", () => {
    const result = dbConnection(
      "postgres://u:p@/homegrown?host=/cloudsql/proj:us-central1:inst",
    );

    expect(result).toEqual({
      host: "/cloudsql/proj:us-central1:inst",
      database: "homegrown",
      username: "u",
      password: "p",
    });
  });

  it("accepts the postgresql:// scheme variant", () => {
    const result = dbConnection(
      "postgresql://appuser:s3cr3t@/mydb?host=/cloudsql/my-proj:us-east1:my-inst",
    );

    expect(result).toEqual({
      host: "/cloudsql/my-proj:us-east1:my-inst",
      database: "mydb",
      username: "appuser",
      password: "s3cr3t",
    });
  });

  it("decodes a percent-encoded socket path", () => {
    const result = dbConnection(
      "postgres://u:p@/homegrown?host=%2Fcloudsql%2Fx",
    );

    expect(result).toEqual({
      host: "/cloudsql/x",
      database: "homegrown",
      username: "u",
      password: "p",
    });
  });

  it("decodes percent-encoded username and password", () => {
    const result = dbConnection(
      "postgres://my%40user:p%40ss@/db?host=/cloudsql/proj:us-central1:inst",
    );

    expect(result).toEqual({
      host: "/cloudsql/proj:us-central1:inst",
      database: "db",
      username: "my@user",
      password: "p@ss",
    });
  });
});

describe("dbConnection — TCP / standard URL form", () => {
  it("returns the string unchanged for a TCP URL", () => {
    const url = "postgres://u:p@127.0.0.1:5432/homegrown";
    expect(dbConnection(url)).toBe(url);
  });

  it("returns the string unchanged for a localhost URL without port", () => {
    const url = "postgresql://u:p@localhost/homegrown";
    expect(dbConnection(url)).toBe(url);
  });

  it("returns the string unchanged for a URL with a non-empty host", () => {
    const url = "postgres://user:pass@db.example.com:5432/mydb";
    expect(dbConnection(url)).toBe(url);
  });

  it("returns the string unchanged when there is no ?host= query param", () => {
    // empty-authority but no ?host= — treat as pass-through (env validation
    // would already have rejected a truly malformed URL in production)
    const url = "postgres://u:p@/homegrown";
    expect(dbConnection(url)).toBe(url);
  });
});
