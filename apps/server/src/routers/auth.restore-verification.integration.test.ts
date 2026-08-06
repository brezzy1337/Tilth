/**
 * Postgres integration tests for F-054 — email-verified account restore.
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
 * auth.account-settings.integration.test.ts / sourcing.integration.test.ts).
 * To run locally:
 *
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/routers/auth.restore-verification.integration.test.ts
 *
 * Covers:
 *   - env-gated fallback: `ctx.email === null` -> `auth.login` on a
 *     deactivated-in-grace account silently self-restores, exactly as
 *     F-051 did before this feature existed (the existing
 *     auth.account-settings.integration.test.ts suite already covers this
 *     path in depth; this file adds one direct check for a self-contained
 *     read).
 *   - `ctx.email` configured (stubbed — NEVER hits resend.com):
 *     `auth.login` on a deactivated-in-grace account throws FORBIDDEN with
 *     message === RESTORE_VERIFICATION_REQUIRED and creates a restore_codes
 *     row (never the account itself, which stays deactivated until
 *     `verifyRestore` succeeds).
 *   - `auth.requestRestoreCode`: resend cooldown (TOO_MANY_REQUESTS),
 *     hourly cap (TOO_MANY_REQUESTS), and oracle-freeness — wrong password,
 *     an ACTIVE (non-deactivated) account, and a past-grace account all
 *     produce the SAME generic UNAUTHORIZED `auth.login` produces for a
 *     wrong password.
 *   - `auth.verifyRestore`: correct code restores the account and returns a
 *     working JWT + marks the code consumed; wrong code increments
 *     `attempts` and is rejected; the 6th attempt is rejected even with the
 *     correct code (RESTORE_CODE_MAX_ATTEMPTS = 5); an expired code is
 *     rejected; a consumed code cannot be reused.
 *   - migration 0018 (`restore_codes`) applies cleanly — implicit in every
 *     test here, all of which run through `migrateForTest` against the
 *     shared `drizzle/` migrations folder.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import {
  RESTORE_CODE_MAX_ATTEMPTS,
  RESTORE_CODE_MAX_PER_HOUR,
  RESTORE_CODE_TTL_MINUTES,
  RESTORE_VERIFICATION_REQUIRED,
} from "@homegrown/shared";
import { migrateForTest } from "../db/migrate-for-test";
import * as schema from "../db/schema";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context, EmailClient, PushClient } from "../context";
import * as authHelpers from "../auth";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("F-054 restore verification — Postgres integration", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const seededUserIds: string[] = [];

  const TEST_SECRET = "integration-test-jwt-secret-32chars-ok";
  const stubAuth: Context["auth"] = {
    hashPassword: authHelpers.hashPassword,
    verifyPassword: authHelpers.verifyPassword,
    signToken: authHelpers.signToken,
    verifyToken: authHelpers.verifyToken,
    generateRestoreCode: authHelpers.generateRestoreCode,
  };

  const stubStripe: Context["stripe"] = {
    createConnectedAccount: async () => {
      throw new Error("stub: not implemented");
    },
    createAccountLink: async () => {
      throw new Error("stub: not implemented");
    },
    retrieveAccountStatus: async () => {
      throw new Error("stub: not implemented");
    },
    createPaymentIntent: async () => {
      throw new Error("stub: not implemented");
    },
    retrievePaymentIntent: async () => {
      throw new Error("stub: not implemented");
    },
    cancelPaymentIntent: async () => {
      throw new Error("stub: not implemented");
    },
    capturePaymentIntent: async () => {
      throw new Error("stub: not implemented");
    },
    refundPayment: async () => {
      throw new Error("stub: not implemented");
    },
    createDashboardLink: async () => {
      throw new Error("stub: not implemented");
    },
  };

  const createCaller = createCallerFactory(appRouter);
  const capturingPush: PushClient = { async send() {} };

  interface CapturedEmail {
    to: string;
    subject: string;
    text: string;
  }

  /** Fresh capturing `EmailClient` stub — NEVER makes a real network call. */
  function makeCapturingEmail(): { client: EmailClient; sent: CapturedEmail[] } {
    const sent: CapturedEmail[] = [];
    return {
      sent,
      client: {
        async sendEmail(input) {
          sent.push(input);
        },
      },
    };
  }

  /** Pull the 6-digit code out of a captured email's body. */
  function extractCode(text: string): string {
    const match = /\d{6}/.exec(text);
    if (!match) throw new Error(`No 6-digit code found in email body: ${text}`);
    return match[0];
  }

  function ctxFor(userId: string | null, email: EmailClient | null = null): Context {
    return {
      db: db as Context["db"],
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      media: null,
      mux: null,
      email,
      push: capturingPush,
      user: userId ? { id: userId } : null,
    };
  }

  async function seedUser(email: string, username: string, password: string): Promise<string> {
    const reg = await createCaller(ctxFor(null)).auth.register({ email, username, password });
    seededUserIds.push(reg.user.id);
    return reg.user.id;
  }

  async function deactivateInGrace(userId: string): Promise<void> {
    await db
      .update(schema.users)
      .set({
        deactivatedAt: new Date(),
        deleteAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .where(eq(schema.users.id, userId));
  }

  async function restore(userId: string): Promise<void> {
    await db
      .update(schema.users)
      .set({ deactivatedAt: null, deleteAfter: null })
      .where(eq(schema.users.id, userId));
  }

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);
  });

  afterAll(async () => {
    for (const id of seededUserIds) {
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, id));
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await client.end();
  });

  // ---------------------------------------------------------------------------
  // Env-gated fallback — Resend not configured
  // ---------------------------------------------------------------------------

  describe("auth.login — email disabled (ctx.email === null)", () => {
    it("silently self-restores a deactivated-in-grace account (pre-F-054 behavior, unchanged)", async () => {
      const userId = await seedUser(
        "restore-dark@test.invalid",
        "restoredark",
        "RestoreDark123!",
      );
      await deactivateInGrace(userId);

      const anon = createCaller(ctxFor(null, null));
      const result = await anon.auth.login({
        usernameOrEmail: "restoredark",
        password: "RestoreDark123!",
      });
      expect(result.user.id).toBe(userId);

      const [row] = await db
        .select({ deactivatedAt: schema.users.deactivatedAt })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      expect(row?.deactivatedAt).toBeNull();

      const codes = await db
        .select()
        .from(schema.restoreCodes)
        .where(eq(schema.restoreCodes.userId, userId));
      expect(codes).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // ctx.email configured — login issues the challenge instead of restoring
  // ---------------------------------------------------------------------------

  describe("auth.login — email enabled (ctx.email configured)", () => {
    it("throws FORBIDDEN RESTORE_VERIFICATION_REQUIRED, does NOT restore the account, and creates a code row", async () => {
      const userId = await seedUser(
        "restore-challenge@test.invalid",
        "restorechallenge",
        "RestoreChallenge123!",
      );
      await deactivateInGrace(userId);

      const { client: emailClient, sent } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      const err = await anon.auth
        .login({ usernameOrEmail: "restorechallenge", password: "RestoreChallenge123!" })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "FORBIDDEN",
        message: RESTORE_VERIFICATION_REQUIRED,
      });

      const [userRow] = await db
        .select({ deactivatedAt: schema.users.deactivatedAt })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      expect(userRow?.deactivatedAt).not.toBeNull();

      const codes = await db
        .select()
        .from(schema.restoreCodes)
        .where(eq(schema.restoreCodes.userId, userId));
      expect(codes).toHaveLength(1);
      expect(codes[0]?.consumedAt).toBeNull();
      expect(codes[0]?.codeHash).not.toMatch(/^\d{6}$/); // never plaintext

      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe("restore-challenge@test.invalid");
      expect(sent[0]?.text).not.toContain("undefined");

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });

    it("does not send a second code (still throws the challenge) when a fresh unconsumed code exists inside the resend cooldown", async () => {
      const userId = await seedUser(
        "restore-cooldown-login@test.invalid",
        "restorecooldownlogin",
        "RestoreCooldown123!",
      );
      await deactivateInGrace(userId);

      const { client: emailClient, sent } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      await anon.auth
        .login({ usernameOrEmail: "restorecooldownlogin", password: "RestoreCooldown123!" })
        .catch(() => {});
      expect(sent).toHaveLength(1);

      const err = await anon.auth
        .login({ usernameOrEmail: "restorecooldownlogin", password: "RestoreCooldown123!" })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "FORBIDDEN", message: RESTORE_VERIFICATION_REQUIRED });

      // No second email sent, and still just one code row.
      expect(sent).toHaveLength(1);
      const codes = await db
        .select()
        .from(schema.restoreCodes)
        .where(eq(schema.restoreCodes.userId, userId));
      expect(codes).toHaveLength(1);

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });

    // -------------------------------------------------------------------
    // Fix #3 — login's hourly-cap edge: challenge-without-send only when a
    // currently-valid code actually exists to submit; otherwise
    // TOO_MANY_REQUESTS (a challenge would be a dead end).
    // -------------------------------------------------------------------

    it("cap reached AND every existing code has expired: throws TOO_MANY_REQUESTS (not the challenge), sends nothing, and does not restore the account", async () => {
      const userId = await seedUser(
        "restore-cap-expired@test.invalid",
        "restorecapexpired",
        "RestoreCap123!",
      );
      await deactivateInGrace(userId);

      // RESTORE_CODE_MAX_PER_HOUR codes, all created well past the resend
      // cooldown (so the cooldown check doesn't short-circuit first) AND
      // already expired (createdAt + TTL is in the past) — cap is reached,
      // but nothing is left to submit.
      const createdAt = new Date(Date.now() - 15 * 60 * 1000);
      const expiresAt = new Date(createdAt.getTime() + RESTORE_CODE_TTL_MINUTES * 60_000);
      for (let i = 0; i < RESTORE_CODE_MAX_PER_HOUR; i++) {
        await db.insert(schema.restoreCodes).values({
          userId,
          purpose: "account_restore",
          codeHash: await authHelpers.hashPassword("000000"),
          createdAt,
          expiresAt,
        });
      }

      const { client: emailClient, sent } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      const err = await anon.auth
        .login({ usernameOrEmail: "restorecapexpired", password: "RestoreCap123!" })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: "Too many restore attempts. Try again later.",
      });

      // No email sent, no new code row, and the account is still deactivated.
      expect(sent).toHaveLength(0);
      const codes = await db
        .select()
        .from(schema.restoreCodes)
        .where(eq(schema.restoreCodes.userId, userId));
      expect(codes).toHaveLength(RESTORE_CODE_MAX_PER_HOUR);

      const [userRow] = await db
        .select({ deactivatedAt: schema.users.deactivatedAt })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      expect(userRow?.deactivatedAt).not.toBeNull();

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });

    it("cap reached but a currently-valid code still exists: throws the SAME challenge (no send)", async () => {
      const userId = await seedUser(
        "restore-cap-valid@test.invalid",
        "restorecapvalid",
        "RestoreCap123!",
      );
      await deactivateInGrace(userId);

      // RESTORE_CODE_MAX_PER_HOUR codes, created past the resend cooldown but
      // still UNEXPIRED (createdAt + TTL is still in the future) — cap is
      // reached, and every one of them is still submittable.
      const createdAt = new Date(Date.now() - 5 * 60 * 1000);
      const expiresAt = new Date(createdAt.getTime() + RESTORE_CODE_TTL_MINUTES * 60_000);
      for (let i = 0; i < RESTORE_CODE_MAX_PER_HOUR; i++) {
        await db.insert(schema.restoreCodes).values({
          userId,
          purpose: "account_restore",
          codeHash: await authHelpers.hashPassword("000000"),
          createdAt,
          expiresAt,
        });
      }

      const { client: emailClient, sent } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      const err = await anon.auth
        .login({ usernameOrEmail: "restorecapvalid", password: "RestoreCap123!" })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "FORBIDDEN", message: RESTORE_VERIFICATION_REQUIRED });

      // No email sent (nothing new issued) and no new code row — the cap
      // still blocked issuance; the challenge is only "there IS a code you
      // can submit", not "here's a new one".
      expect(sent).toHaveLength(0);
      const codes = await db
        .select()
        .from(schema.restoreCodes)
        .where(eq(schema.restoreCodes.userId, userId));
      expect(codes).toHaveLength(RESTORE_CODE_MAX_PER_HOUR);

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });
  });

  // ---------------------------------------------------------------------------
  // auth.requestRestoreCode
  // ---------------------------------------------------------------------------

  describe("auth.requestRestoreCode", () => {
    it("oracle-freeness: wrong password produces the SAME generic UNAUTHORIZED auth.login produces", async () => {
      const userId = await seedUser(
        "restore-oracle-wrongpw@test.invalid",
        "restoreoraclewrongpw",
        "RestoreOracle123!",
      );
      await deactivateInGrace(userId);

      const { client: emailClient } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      const loginErr = await anon.auth
        .login({ usernameOrEmail: "some-unrelated-user", password: "TotallyWrong1!" })
        .catch((e: unknown) => e);
      const requestErr = await anon.auth
        .requestRestoreCode({
          usernameOrEmail: "restoreoraclewrongpw",
          password: "TotallyWrong1!",
        })
        .catch((e: unknown) => e);

      expect((requestErr as { message?: string }).message).toBe(
        (loginErr as { message?: string }).message,
      );
      expect(requestErr).toMatchObject({ code: "UNAUTHORIZED" });

      await restore(userId);
    });

    it("oracle-freeness: an ACTIVE (non-deactivated) account gets the same generic UNAUTHORIZED — a live account never needs this endpoint", async () => {
      await seedUser(
        "restore-oracle-active@test.invalid",
        "restoreoracleactive",
        "RestoreOracle123!",
      );

      const { client: emailClient } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      const err = await anon.auth
        .requestRestoreCode({
          usernameOrEmail: "restoreoracleactive",
          password: "RestoreOracle123!",
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "UNAUTHORIZED", message: "Invalid credentials" });
    });

    it("oracle-freeness: a PAST-GRACE account gets the same generic UNAUTHORIZED", async () => {
      const userId = await seedUser(
        "restore-oracle-pastgrace@test.invalid",
        "restoreoraclepastgrace",
        "RestoreOracle123!",
      );
      await db
        .update(schema.users)
        .set({
          deactivatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          deleteAfter: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        })
        .where(eq(schema.users.id, userId));

      const { client: emailClient } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      const err = await anon.auth
        .requestRestoreCode({
          usernameOrEmail: "restoreoraclepastgrace",
          password: "RestoreOracle123!",
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "UNAUTHORIZED", message: "Invalid credentials" });
    });

    it("happy path: sends a code and returns a masked email", async () => {
      const userId = await seedUser(
        "restore-request-happy@test.invalid",
        "restorerequesthappy",
        "RestoreRequest123!",
      );
      await deactivateInGrace(userId);

      const { client: emailClient, sent } = makeCapturingEmail();
      const caller = createCaller(ctxFor(null, emailClient));

      const result = await caller.auth.requestRestoreCode({
        usernameOrEmail: "restorerequesthappy",
        password: "RestoreRequest123!",
      });
      expect(result).toEqual({ sent: true, maskedEmail: "r***@t***.invalid" });
      expect(sent).toHaveLength(1);

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });

    it("enforces the resend cooldown — TOO_MANY_REQUESTS on an immediate second request", async () => {
      const userId = await seedUser(
        "restore-cooldown@test.invalid",
        "restorecooldown",
        "RestoreCooldown123!",
      );
      await deactivateInGrace(userId);

      const { client: emailClient } = makeCapturingEmail();
      const caller = createCaller(ctxFor(null, emailClient));

      await caller.auth.requestRestoreCode({
        usernameOrEmail: "restorecooldown",
        password: "RestoreCooldown123!",
      });

      await expect(
        caller.auth.requestRestoreCode({
          usernameOrEmail: "restorecooldown",
          password: "RestoreCooldown123!",
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "TOO_MANY_REQUESTS" }));

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });

    it("enforces the per-hour cap — TOO_MANY_REQUESTS once RESTORE_CODE_MAX_PER_HOUR codes already exist this hour", async () => {
      const userId = await seedUser(
        "restore-hourly-cap@test.invalid",
        "restorehourlycap",
        "RestoreHourly123!",
      );
      await deactivateInGrace(userId);

      // Seed RESTORE_CODE_MAX_PER_HOUR codes directly, backdated well past the
      // resend cooldown (10 min ago) but still within the rolling hour window
      // — isolates the hourly-cap check from the cooldown check.
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      for (let i = 0; i < RESTORE_CODE_MAX_PER_HOUR; i++) {
        await db.insert(schema.restoreCodes).values({
          userId,
          purpose: "account_restore",
          codeHash: await authHelpers.hashPassword("000000"),
          expiresAt: new Date(tenMinutesAgo.getTime() + 10 * 60 * 1000),
          createdAt: tenMinutesAgo,
        });
      }

      const { client: emailClient } = makeCapturingEmail();
      const caller = createCaller(ctxFor(null, emailClient));

      await expect(
        caller.auth.requestRestoreCode({
          usernameOrEmail: "restorehourlycap",
          password: "RestoreHourly123!",
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "TOO_MANY_REQUESTS" }));

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });

    // -------------------------------------------------------------------
    // Fix #2 — rate-limit TOCTOU: the cooldown/count check and the insert
    // now run atomically (per-user `pg_advisory_xact_lock`). This asserts
    // the deterministic half of that fix: once the hourly cap is already
    // met, the guarded issue path refuses WITHOUT ever inserting a new row
    // — i.e. the refusal and the non-insert are the same atomic outcome,
    // not a separate check that a race could slip past.
    // -------------------------------------------------------------------
    it("refuses cleanly at the hourly cap without inserting a new code row (guarded issue path)", async () => {
      const userId = await seedUser(
        "restore-guarded-cap@test.invalid",
        "restoreguardedcap",
        "RestoreGuarded123!",
      );
      await deactivateInGrace(userId);

      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      for (let i = 0; i < RESTORE_CODE_MAX_PER_HOUR; i++) {
        await db.insert(schema.restoreCodes).values({
          userId,
          purpose: "account_restore",
          codeHash: await authHelpers.hashPassword("000000"),
          createdAt: tenMinutesAgo,
          expiresAt: new Date(tenMinutesAgo.getTime() + RESTORE_CODE_TTL_MINUTES * 60_000),
        });
      }

      const { client: emailClient, sent } = makeCapturingEmail();
      const caller = createCaller(ctxFor(null, emailClient));

      await expect(
        caller.auth.requestRestoreCode({
          usernameOrEmail: "restoreguardedcap",
          password: "RestoreGuarded123!",
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "TOO_MANY_REQUESTS" }));

      // The refusal happened INSIDE the guarded transaction before any
      // insert — row count is unchanged, and nothing was ever emailed.
      expect(sent).toHaveLength(0);
      const codes = await db
        .select()
        .from(schema.restoreCodes)
        .where(eq(schema.restoreCodes.userId, userId));
      expect(codes).toHaveLength(RESTORE_CODE_MAX_PER_HOUR);

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });
  });

  // ---------------------------------------------------------------------------
  // auth.verifyRestore
  // ---------------------------------------------------------------------------

  describe("auth.verifyRestore", () => {
    it("happy path: correct code restores the account, marks the code consumed, and returns a working JWT", async () => {
      const userId = await seedUser(
        "restore-verify-happy@test.invalid",
        "restoreverifyhappy",
        "RestoreVerify123!",
      );
      await deactivateInGrace(userId);

      const { client: emailClient, sent } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      await anon.auth
        .login({ usernameOrEmail: "restoreverifyhappy", password: "RestoreVerify123!" })
        .catch(() => {});
      expect(sent).toHaveLength(1);
      const code = extractCode(sent[0]!.text);

      const result = await anon.auth.verifyRestore({
        usernameOrEmail: "restoreverifyhappy",
        password: "RestoreVerify123!",
        code,
      });
      expect(result.user.id).toBe(userId);

      // Working JWT — verifies back to the same user id.
      const verified = await authHelpers.verifyToken(result.token, TEST_SECRET);
      expect(verified).toBe(userId);

      const [userRow] = await db
        .select({ deactivatedAt: schema.users.deactivatedAt, deleteAfter: schema.users.deleteAfter })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      expect(userRow?.deactivatedAt).toBeNull();
      expect(userRow?.deleteAfter).toBeNull();

      const codes = await db
        .select()
        .from(schema.restoreCodes)
        .where(eq(schema.restoreCodes.userId, userId));
      expect(codes).toHaveLength(1);
      expect(codes[0]?.consumedAt).not.toBeNull();
    });

    it("wrong code: increments attempts and is rejected with a generic UNAUTHORIZED", async () => {
      const userId = await seedUser(
        "restore-verify-wrongcode@test.invalid",
        "restoreverifywrongcode",
        "RestoreVerify123!",
      );
      await deactivateInGrace(userId);

      const { client: emailClient, sent } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      await anon.auth
        .login({ usernameOrEmail: "restoreverifywrongcode", password: "RestoreVerify123!" })
        .catch(() => {});
      const correctCode = extractCode(sent[0]!.text);
      const wrongCode = correctCode === "000000" ? "111111" : "000000";

      await expect(
        anon.auth.verifyRestore({
          usernameOrEmail: "restoreverifywrongcode",
          password: "RestoreVerify123!",
          code: wrongCode,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));

      const [row] = await db
        .select({ attempts: schema.restoreCodes.attempts })
        .from(schema.restoreCodes)
        .where(eq(schema.restoreCodes.userId, userId));
      expect(row?.attempts).toBe(1);

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });

    it("locks out after RESTORE_CODE_MAX_ATTEMPTS wrong attempts — the 6th attempt is rejected even with the correct code", async () => {
      const userId = await seedUser(
        "restore-verify-lockout@test.invalid",
        "restoreverifylockout",
        "RestoreVerify123!",
      );
      await deactivateInGrace(userId);

      const { client: emailClient, sent } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      await anon.auth
        .login({ usernameOrEmail: "restoreverifylockout", password: "RestoreVerify123!" })
        .catch(() => {});
      const correctCode = extractCode(sent[0]!.text);
      const wrongCode = correctCode === "000000" ? "111111" : "000000";

      for (let i = 0; i < RESTORE_CODE_MAX_ATTEMPTS; i++) {
        await expect(
          anon.auth.verifyRestore({
            usernameOrEmail: "restoreverifylockout",
            password: "RestoreVerify123!",
            code: wrongCode,
          }),
        ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
      }

      // The 6th attempt — with the CORRECT code — is still rejected.
      await expect(
        anon.auth.verifyRestore({
          usernameOrEmail: "restoreverifylockout",
          password: "RestoreVerify123!",
          code: correctCode,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));

      const [userRow] = await db
        .select({ deactivatedAt: schema.users.deactivatedAt })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      expect(userRow?.deactivatedAt).not.toBeNull(); // never restored

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });

    it("expired code is rejected", async () => {
      const userId = await seedUser(
        "restore-verify-expired@test.invalid",
        "restoreverifyexpired",
        "RestoreVerify123!",
      );
      await deactivateInGrace(userId);

      const code = "042137";
      await db.insert(schema.restoreCodes).values({
        userId,
        purpose: "account_restore",
        codeHash: await authHelpers.hashPassword(code),
        expiresAt: new Date(Date.now() - 60 * 1000), // already expired
      });

      const { client: emailClient } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      await expect(
        anon.auth.verifyRestore({
          usernameOrEmail: "restoreverifyexpired",
          password: "RestoreVerify123!",
          code,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });

    it("a consumed code cannot be reused", async () => {
      const userId = await seedUser(
        "restore-verify-consumed@test.invalid",
        "restoreverifyconsumed",
        "RestoreVerify123!",
      );
      await deactivateInGrace(userId);

      const { client: emailClient, sent } = makeCapturingEmail();
      const anon = createCaller(ctxFor(null, emailClient));

      await anon.auth
        .login({ usernameOrEmail: "restoreverifyconsumed", password: "RestoreVerify123!" })
        .catch(() => {});
      const code = extractCode(sent[0]!.text);

      // First use succeeds and restores the account.
      await anon.auth.verifyRestore({
        usernameOrEmail: "restoreverifyconsumed",
        password: "RestoreVerify123!",
        code,
      });

      // Deactivate again (simulating a second delete->restore cycle) so the
      // credential + deactivated-in-grace preconditions are met again, then
      // try to reuse the SAME (now-consumed) code.
      await deactivateInGrace(userId);

      await expect(
        anon.auth.verifyRestore({
          usernameOrEmail: "restoreverifyconsumed",
          password: "RestoreVerify123!",
          code,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));

      await restore(userId);
      await db.delete(schema.restoreCodes).where(eq(schema.restoreCodes.userId, userId));
    });
  });
});
