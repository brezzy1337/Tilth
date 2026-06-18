/*
 * Stripe Connect Accounts v2 — TEST-mode probe (THROWAWAY SPIKE)
 * ============================================================================
 * Purpose: turn the Accounts-v2 migration UNKNOWNS into verified facts before
 * we write any migration code. This script touches NO app code and is never
 * imported by the server. It exists only to be run by hand against Stripe TEST
 * mode, have its output captured into the findings template, and then ideally
 * deleted (or kept here for the next person).
 *
 * It answers, empirically:
 *   1. Does v2 account create succeed, and what fields does it actually require?
 *   2. What does the returned account id look like (acct_… or new prefix)?
 *   3. What is the shape of capabilities + requirements on a v2 account?
 *      (charges_enabled / payouts_enabled / details_submitted do NOT exist on
 *       v2 — we must DERIVE them; this shows us from what.)
 *   4. Which events fire on onboarding completion (run `stripe listen` alongside).
 *   5. Is the chosen liability tuple accepted by Stripe?
 *
 * ---------------------------------------------------------------------------
 * PREREQUISITES
 *   - A Stripe TEST secret key. Either your project's sk_test_… OR, with the
 *     Stripe CLI: `stripe sandbox create` (no registration needed).
 *   - Connect enabled on the test account (Dashboard → Connect → Get started).
 *
 * RUN (from the repo root — resolves the Stripe SDK from apps/server):
 *   STRIPE_SECRET_KEY=sk_test_xxx node docs/stripe-accounts-v2/accounts-v2-probe.mjs
 *
 * To also capture the webhook events (Probe 4), in a SECOND real terminal:
 *   stripe listen --print-json
 *   # then open the onboarding URL this script prints, complete it with test
 *   # data, and watch which event types arrive.
 * ---------------------------------------------------------------------------
 * NOTE: This is intentionally NOT type-checked or linted (it lives under docs/,
 * outside every workspace package). It uses best-guess v2 params; where a guess
 * is wrong, Stripe returns a descriptive error which IS the finding — each probe
 * is isolated so one failure does not abort the others.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// --- Resolve the Stripe SDK from the server workspace (pnpm keeps it there) --
const here = path.dirname(fileURLToPath(import.meta.url));
const serverPkgJson = path.resolve(here, "../../apps/server/package.json");
const require = createRequire(serverPkgJson);
const Stripe = require("stripe");

// --- Config -----------------------------------------------------------------
const API_VERSION = "2026-05-27.dahlia"; // pinned, matches apps/server/src/stripe.ts
const KEY = process.env.STRIPE_SECRET_KEY;

if (!KEY) {
  console.error("✗ STRIPE_SECRET_KEY is not set. Run:");
  console.error("  STRIPE_SECRET_KEY=sk_test_xxx node docs/stripe-accounts-v2/accounts-v2-probe.mjs");
  process.exit(1);
}
if (!KEY.startsWith("sk_test_") && !KEY.startsWith("rk_test_")) {
  console.error("✗ Refusing to run: key is not a TEST key (expected sk_test_ / rk_test_).");
  console.error("  This probe creates real Connect accounts — only run it in TEST mode.");
  process.exit(1);
}

const stripe = new Stripe(KEY, { apiVersion: API_VERSION, maxNetworkRetries: 2 });

const line = (s) => console.log(`\n${"=".repeat(78)}\n${s}\n${"=".repeat(78)}`);
const dump = (label, obj) => console.log(`\n--- ${label} ---\n${JSON.stringify(obj, null, 2)}`);

// Run a probe in isolation: log success or the full error, never throw.
async function probe(name, fn) {
  line(name);
  try {
    return await fn();
  } catch (err) {
    console.error(`✗ ${name} FAILED — this error is itself a finding:`);
    console.error(`  type:    ${err?.type ?? "(none)"}`);
    console.error(`  code:    ${err?.code ?? "(none)"}`);
    console.error(`  param:   ${err?.param ?? "(none)"}`);
    console.error(`  message: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function main() {
  console.log(`Stripe Accounts v2 probe — apiVersion=${API_VERSION}, key=${KEY.slice(0, 11)}…`);

  // -- PROBE 1 + 5: create a v2 account with the recommended config ----------
  const account = await probe("PROBE 1/5 — v2.core.accounts.create (recommended liability tuple)", async () => {
    const acct = await stripe.v2.core.accounts.create({
      contact_email: "spike-seller@example.com",
      // dashboard = 'express' preserves today's seller UX
      dashboard: "express",
      // THE liability decision — shift negative-balance losses to Stripe:
      defaults: {
        responsibilities: {
          losses_collector: "stripe",
          fees_collector: "application",
        },
      },
      // destination charges to this account need the merchant config + card_payments
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true } } },
      },
      // PROBE: is identity.country required at create? If create fails without
      // it, that's a finding; if it fails WITH it, remove this and note it.
      identity: { country: "us" },
      // PROBE: is `include` needed to get capabilities/requirements back on create?
      include: ["configuration.merchant", "requirements"],
    });
    console.log(`✓ created account id: ${acct.id}`);
    console.log(`  → FINDING (Q2): id prefix = "${String(acct.id).split("_")[0]}_" (is it acct_ ?)`);
    dump("full create response", acct);
    return acct;
  });

  if (!account) {
    console.log("\nAccount create failed — fix the payload per the error above and re-run.");
    console.log("Skipping the remaining probes that depend on an account id.");
    printFindingsTemplate();
    return;
  }

  // -- PROBE 2: onboarding account link --------------------------------------
  await probe("PROBE 2 — v2.core.accountLinks.create (hosted onboarding)", async () => {
    const link = await stripe.v2.core.accountLinks.create({
      account: account.id,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["merchant"],
          // server-side URLs (issue #7 invariant — never client-supplied)
          refresh_url: "https://homegrown.app/connect/refresh",
          return_url: "https://homegrown.app/connect/return",
          collection_options: { fields: "currently_due" },
        },
      },
    });
    console.log(`✓ onboarding URL (open this to complete onboarding for Probe 4):`);
    console.log(`  ${link.url}`);
    return link;
  });

  // -- PROBE 3: retrieve → the status-derivation signals ---------------------
  await probe("PROBE 3 — v2.core.accounts.retrieve (capabilities + requirements)", async () => {
    const acct = await stripe.v2.core.accounts.retrieve(account.id, {
      include: ["configuration.merchant", "requirements"],
    });
    console.log("→ FINDING (Q3): map these to our 3 booleans:");
    console.log("   charges_enabled   ?= configuration.merchant.capabilities.card_payments.status === 'active'");
    console.log("   payouts_enabled   ?= (which capability/status?) — inspect below");
    console.log("   details_submitted ?= (no direct field) — derive from requirements.currently_due empty?");
    dump("configuration.merchant", acct?.configuration?.merchant ?? "(absent — does `include` work?)");
    dump("requirements", acct?.requirements ?? "(absent — does `include` work?)");
    dump("full retrieve response", acct);
    return acct;
  });

  // -- PROBE 4: webhook story (manual) ---------------------------------------
  line("PROBE 4 — webhook events on onboarding completion (MANUAL)");
  console.log("In a second terminal run:  stripe listen --print-json");
  console.log("Then open the onboarding URL from Probe 2 and finish it with Stripe test data.");
  console.log("CAPTURE: which event types arrive? Specifically —");
  console.log("  • Does the V1 `account.updated` still fire for this v2 account?");
  console.log("    → if YES: webhook.ts keeps its handler, only the object shape/derivation changes.");
  console.log("  • Or do you only see v2 events (e.g. v2.core.account[...]) requiring an");
  console.log("    event destination + stripe.parseEventNotification()?");
  console.log("    → if YES: webhook.ts needs a new v2 ingestion path.");

  printFindingsTemplate();
}

function printFindingsTemplate() {
  line("FINDINGS — paste answers into docs/stripe-accounts-v2/spike-runbook.md");
  console.log(`
Q1 create payload: required fields = __________ ; identity.country required? __
Q1 liability tuple (stripe losses + application fees + express dashboard) accepted? __
Q2 account id format/prefix: __________
Q3 charges_enabled  ← __________________________________________
Q3 payouts_enabled  ← __________________________________________
Q3 details_submitted ← _________________________________________
Q3 was \`include\` required to get capabilities/requirements? __
Q4 webhook: V1 account.updated fires? __  | v2 event destination required? __
`);
}

main().catch((err) => {
  console.error("\n✗ Unexpected top-level error:");
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
