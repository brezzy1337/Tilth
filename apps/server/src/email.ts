/**
 * SendGrid email client — server-only, plain `fetch` (no SendGrid SDK, mirrors
 * `mux.ts`'s fetch-based Mux integration exactly — see that file's header for
 * the rationale).
 *
 * This file is the ONLY place in the router tree's dependency graph that
 * talks to the SendGrid HTTP API. Routers interact with email through the
 * `EmailClient` interface defined in `context.ts`, so they stay
 * fetch/Buffer-free and mobile-typecheck-safe.
 *
 * F-054 — account-restore verification codes are the only caller today.
 *
 * Never log the API key. Never log the recipient address (PII) — only status
 * + response body on a failed send.
 */

import type { EmailClient } from "./context";

const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

/**
 * Pure predicate — true when a SendGrid API key is configured. Takes the key
 * as an argument (no `process.env` read here) so it stays testable without
 * env setup, matching `geocode.ts`/`auth.ts`'s "no process.env reads" idiom.
 * `index.ts` calls this with `env.SENDGRID_API_KEY` to decide whether to
 * construct a concrete `EmailClient` (see that file) or leave `ctx.email`
 * null — the env-gated rollout switch for F-054's code-verification flow.
 */
export function emailEnabled(apiKey: string | undefined): apiKey is string {
  return typeof apiKey === "string" && apiKey.length > 0;
}

/**
 * Build a redacted summary of a failed SendGrid response body, safe to log.
 *
 * SendGrid's v3 error shape is `{ errors: [{ message, field, help }] }`. On a
 * validation error (e.g. an invalid `to` address) `message` frequently echoes
 * the offending input value back — logging it raw would leak the recipient
 * address (PII) into logs, contradicting this file's own "never log the
 * recipient" rule. This only ever surfaces `field`/`help` (never `message`,
 * never the raw body) — falling back to a fixed placeholder if the body
 * isn't SendGrid's known JSON error shape.
 */
async function redactedErrorSummary(response: Response): Promise<string> {
  const body = await response.text().catch(() => null);
  if (!body) return "<no body>";

  try {
    const parsed: unknown = JSON.parse(body);
    const errors =
      typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { errors?: unknown }).errors)
        ? (parsed as { errors: unknown[] }).errors
        : null;
    if (!errors) return "<unrecognized error body shape — redacted>";

    const redacted = errors.map((e) => {
      const field = typeof e === "object" && e !== null ? (e as Record<string, unknown>)["field"] : undefined;
      const help = typeof e === "object" && e !== null ? (e as Record<string, unknown>)["help"] : undefined;
      return {
        field: typeof field === "string" ? field : null,
        help: typeof help === "string" ? help : null,
      };
    });
    return JSON.stringify(redacted);
  } catch {
    return "<unparseable error body — redacted>";
  }
}

/**
 * Build a concrete `EmailClient` authenticated with a SendGrid API key
 * (Bearer auth, matching SendGrid's v3 REST API convention).
 *
 * @param apiKey    - SendGrid API key (from env, never hardcoded, never logged).
 * @param fromEmail - Verified sender address; display name is fixed to "Tilth".
 */
export function createSendGridEmailClient(apiKey: string, fromEmail: string): EmailClient {
  return {
    async sendEmail(input) {
      const response = await fetch(SENDGRID_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: input.to }] }],
          from: { email: fromEmail, name: "Tilth" },
          subject: input.subject,
          content: [{ type: "text/plain", value: input.text }],
        }),
      });

      if (!response.ok) {
        // Never log the recipient address (PII) or the API key. SendGrid's
        // error body can echo back the offending input on validation errors
        // (e.g. `personalizations.0.to.0.email`) — logging it raw would leak
        // the recipient address into logs, contradicting the "no PII" rule
        // above. Log only status + a redacted subset of SendGrid's
        // `errors[]` shape (`field`/`help` — never `message`, which is the
        // field most likely to echo the input value back).
        console.error(`SendGrid send failed with status ${response.status}: ${await redactedErrorSummary(response)}`);
        throw new Error(`SendGrid send failed with status ${response.status}`);
      }
    },
  };
}
