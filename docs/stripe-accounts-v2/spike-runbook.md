# Accounts v2 — TEST spike runbook

A time-boxed, throwaway investigation to turn the [migration plan](./migration-plan.md)
§6 unknowns into verified facts **before** writing migration code. It touches no
app code and is not shipped.

Script: [`accounts-v2-probe.mjs`](./accounts-v2-probe.mjs)

## Why a spike

The SDK type surface tells us what *compiles*, not what Stripe *requires/returns*
at API version `2026-05-27.dahlia`. Each answer below unblocks a specific decision:

| Q | Question | Unblocks |
|---|---|---|
| 1 | Does `v2.core.accounts.create({…recommended})` succeed? Is `identity.country` (or anything) required? Is the liability tuple accepted? | The create payload in `stripe.ts` + the liability decision |
| 2 | Account **id** format (`acct_…` or new prefix)? | Whether any `acct_` assumptions hold |
| 3 | How do `charges_enabled` / `payouts_enabled` / `details_submitted` map to v2 capability `status` + `requirements`? | The **status-derivation** helper (the hard part) |
| 4 | On onboarding completion, does V1 `account.updated` fire, or only v2 events? | Whether `webhook.ts` gets a 1-line change or a new ingestion path |
| 5 | Is `include` required on create/retrieve to get capabilities/requirements back? | The retrieve call shape |

## Prerequisites

- A Stripe **TEST** secret key — either the project's `sk_test_…`, or run
  `stripe sandbox create` (Stripe CLI, no registration) to mint one.
- Connect enabled on the test account (Dashboard → Connect → Get started).
- Run it in a **real terminal** (the onboarding completion + `stripe listen` are
  interactive and can't be driven through Claude's `!` runner).

## Run

From the repo root (the script resolves the Stripe SDK from `apps/server`):

```bash
STRIPE_SECRET_KEY=sk_test_xxx node docs/stripe-accounts-v2/accounts-v2-probe.mjs
```

For Probe 4 (webhooks), in a **second** terminal before completing onboarding:

```bash
stripe listen --print-json
# then open the onboarding URL the script prints, finish it with Stripe test
# data, and note which event types arrive.
```

The script isolates each probe, so a wrong-guess parameter logs a descriptive
Stripe error (which is itself the finding) without aborting the rest.

## Findings (fill in, then this becomes the brief for the server `/code-todo`)

- **Q1 create payload** — required fields: `____`; `identity.country` required? `__`
- **Q1 liability tuple** (`stripe` losses + `application` fees + `express` dashboard) accepted? `__`
- **Q2 account id** format/prefix: `____`
- **Q3 `charges_enabled`** ← `____`
- **Q3 `payouts_enabled`** ← `____`
- **Q3 `details_submitted`** ← `____`
- **Q3 `include` required** to get capabilities/requirements? `__`
- **Q4 webhook** — V1 `account.updated` fires? `__` | v2 event destination required? `__`

## After the spike

1. Record the findings above.
2. If a **live** account exists, re-read §4 (coexistence) before proceeding.
3. Scope the server-only `/code-todo`: rewrite `stripe.ts` (create/link + a shared
   `v2Account → 3 booleans` derivation helper) and `webhook.ts` per the Q4 verdict.
4. Delete this probe (or keep it for the next person — it imports no app code).
