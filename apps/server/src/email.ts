/**
 * Resend email client — server-only, plain `fetch` (no Resend SDK, mirrors
 * `mux.ts`'s fetch-based Mux integration exactly — see that file's header for
 * the rationale).
 *
 * This file is the ONLY place in the router tree's dependency graph that
 * talks to the Resend HTTP API. Routers interact with email through the
 * `EmailClient` interface defined in `context.ts`, so they stay
 * fetch/Buffer-free and mobile-typecheck-safe.
 *
 * F-054 — account-restore verification codes are the only caller today.
 *
 * Never log the API key. Never log the recipient address (PII) — only status
 * + a redacted error summary on a failed send.
 */

import type { EmailClient } from "./context";

const RESEND_SEND_URL = "https://api.resend.com/emails";

/**
 * Pure predicate — true when a Resend API key is configured. Takes the key
 * as an argument (no `process.env` read here) so it stays testable without
 * env setup, matching `geocode.ts`/`auth.ts`'s "no process.env reads" idiom.
 * `index.ts` calls this with `env.RESEND_API_KEY` to decide whether to
 * construct a concrete `EmailClient` (see that file) or leave `ctx.email`
 * null — the env-gated rollout switch for F-054's code-verification flow.
 */
export function emailEnabled(apiKey: string | undefined): apiKey is string {
  return typeof apiKey === "string" && apiKey.length > 0;
}

/**
 * Build a redacted summary of a failed Resend response body, safe to log.
 *
 * Resend's error shape is `{ statusCode, name, message }`. On a validation
 * error (e.g. an invalid `to` address) `message` can echo the offending input
 * value back — logging it raw would leak the recipient address (PII) into
 * logs, contradicting this file's own "never log the recipient" rule. This
 * only ever surfaces the error `name` (never `message`, never the raw body)
 * — falling back to a fixed placeholder if the body isn't Resend's known
 * JSON error shape.
 */
async function redactedErrorSummary(response: Response): Promise<string> {
  const body = await response.text().catch(() => null);
  if (!body) return "<no body>";

  try {
    const parsed: unknown = JSON.parse(body);
    const name =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["name"]
        : undefined;
    if (typeof name !== "string") return "<unrecognized error body shape — redacted>";
    return JSON.stringify({ name });
  } catch {
    return "<unparseable error body — redacted>";
  }
}

/**
 * Build a concrete `EmailClient` authenticated with a Resend API key
 * (Bearer auth, matching Resend's REST API convention).
 *
 * @param apiKey      - Resend API key (from env, never hardcoded, never logged).
 * @param fromAddress - Verified sender address; display name is fixed to "Tilth".
 */
export function createResendEmailClient(apiKey: string, fromAddress: string): EmailClient {
  return {
    async sendEmail(input) {
      const response = await fetch(RESEND_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `Tilth <${fromAddress}>`,
          to: [input.to],
          subject: input.subject,
          text: input.text,
        }),
      });

      if (!response.ok) {
        // Never log the recipient address (PII) or the API key. Resend's
        // error body (`{ statusCode, name, message }`) can echo back the
        // offending input in `message` on validation errors — logging it raw
        // would leak the recipient address into logs, contradicting the "no
        // PII" rule above. Log only status + the error `name` (never
        // `message`, which is the field most likely to echo the input value
        // back).
        console.error(`Resend send failed with status ${response.status}: ${await redactedErrorSummary(response)}`);
        throw new Error(`Resend send failed with status ${response.status}`);
      }
    },
  };
}
