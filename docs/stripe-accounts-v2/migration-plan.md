# Stripe Connect: v1 (Express) → v2 (Accounts v2) — Migration Plan & Decision Memo

> Status: **proposed, not started.** Grounded in the live integration + the
> installed `stripe@22.2.0` SDK type definitions (generated 2026-06-17).
> Companion Notion page: *Stripe Connect: v1 (Express) vs v2 (Accounts v2) — Comparison & Migration*.
> Before implementing, run the [spike](./spike-runbook.md) to resolve the §6 unknowns.

## 0. Scope & the one big caveat

This plan changes **how connected accounts are created and onboarded**, not how
charges are created. PaymentIntents (destination charge + `application_fee_amount`)
stay on the V1 API and are untouched.

**Caveat that must survive the handoff:** `stripe@22.2.0` does **not** expose the
`controller.*` shape from Stripe's public docs. It flattens those concepts into
`defaults.responsibilities.*` + `dashboard`, and moves requirement-collection
timing onto the **account link**. Map *intent → SDK fields*; do not copy the docs
verbatim. The call surface is `stripe.v2.core.accounts.create(...)` and
`stripe.v2.core.accountLinks.create(...)`.

## 1. Decision points (recommendation per item)

Context: marketplace of neighbors + small farms, US single-region pilot,
destination charges with a 10% platform fee, TEST mode, sellers are individuals.

| Intent (docs term) | SDK 22.2.0 field | Recommended | Why |
|---|---|---|---|
| `controller.losses.payments` | `defaults.responsibilities.losses_collector` | `stripe` | Express today puts negative-balance/fraud liability on the **platform**. Shifting to Stripe removes unbounded risk from small/unknown sellers — the primary reason to migrate. |
| `controller.fees.payer` | `defaults.responsibilities.fees_collector` | `application` | Platform sets + collects the 10% application fee on each destination charge. |
| `controller.stripe_dashboard.type` | `dashboard` | `express` | Preserves the current seller UX; minimal build. (`full` = Standard-like, even less liability but different onboarding/branding; `none` = build our own UI — out of scope.) |
| `controller.requirement_collection` | account link `use_case.account_onboarding.collection_options.fields` | `currently_due` | Lowest-friction Stripe-hosted onboarding; no platform-built compliance UI. |
| Merchant of record | `on_behalf_of` on the PaymentIntent | **omit** | Platform stays MoR — simplest, consistent with `losses_collector: 'stripe'`. Revisit only if tax / statement-descriptor needs demand the seller be MoR. |

**Liability callout:** the existing `type: "express"` makes the **platform** the
loss-bearer. v2 is the moment to flip this to `stripe`. Note Stripe enforces
valid tuples — `stripe` losses likely *requires* a Stripe-managed dashboard
(`express`/`full`) and Stripe requirement collection. Verify the chosen tuple in
the spike.

## 2. API mapping (v1 → v2 in `stripe@22.2.0`)

SDK support confirmed: `stripe.v2.core.{accounts, accountLinks, accountTokens, events, eventDestinations}` exist; V1 `stripe.accounts` / `stripe.accountLinks` remain side-by-side (legacy accounts stay retrievable).

**Account create** — `stripe.accounts.create({ type: "express", email? })` becomes:

```ts
stripe.v2.core.accounts.create({
  contact_email: input.email,
  dashboard: "express",
  defaults: { responsibilities: { losses_collector: "stripe", fees_collector: "application" } },
  configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
  // identity.country: "us" likely required — VERIFY in spike
}, { idempotencyKey })
```

**Onboarding link** — `accountLinks.create({ type: "account_onboarding" })` becomes:

```ts
stripe.v2.core.accountLinks.create({
  account: accountId,
  use_case: {
    type: "account_onboarding",
    account_onboarding: {
      configurations: ["merchant"],
      refresh_url: connect.refreshUrl,   // server-side baked URLs (issue #7 invariant)
      return_url: connect.returnUrl,
      collection_options: { fields: "currently_due" },
    },
  },
})
```

**Status retrieval — the biggest semantic change.** The three booleans don't exist on a v2 account. Derive them:

- `charges_enabled` ← `configuration.merchant.capabilities.card_payments.status === 'active'`
- `payouts_enabled` ← a payout-related capability/status — **VERIFY which**
- `details_submitted` ← no direct field; closest is `requirements.currently_due` being empty — **VERIFY**

Keep `retrieveAccountStatus` **returning the same 3 booleans** so downstream is undisturbed; only the derivation changes.

**Webhooks — significant fork.** V1 `account.updated` uses `webhooks.constructEvent` (what we do today). The v2 world has a separate path: event destinations + `stripe.parseEventNotification(...)`. **Open question:** does a v2 account still emit V1 `account.updated`, or must we subscribe to v2 events? This decides whether `webhook.ts` gets a small change or a new ingestion branch. **Do not assume — verify.**

## 3. Per-layer change map

| File | Change |
|---|---|
| `packages/shared/src/index.ts` | Likely **none** — keep `connectStatus` shape stable (lowest blast radius). Optional later: `requirementsDue?` / `disabledReason?`. |
| `apps/server/src/context.ts` | `StripeClient` interface **unchanged** if `retrieveAccountStatus` keeps returning the 3 derived booleans. Update the "Express" doc comment. |
| `apps/server/src/stripe.ts` | **The work** — rewrite create + accountLink + the status derivation. Factor a single `v2Account → {chargesEnabled, payoutsEnabled, detailsSubmitted}` helper. |
| `apps/server/src/routers/connect.ts` | Comment-only (logic unchanged if the interface holds). |
| `apps/server/src/webhook.ts` | `account.updated` rewrite (reuse the derivation helper) **or** a new v2 event-ingestion path — depends on the spike. |
| `apps/server/src/db/schema.ts` | **No migration** if the 3 boolean columns are preserved (recommended). Optional `connectApiVersion` only if coexistence is needed (see §4). |

## 4. Data migration / backward-compat

Existing rows hold V1 Express `acct_…` ids; V1 `accounts.retrieve` still works, but
you **cannot convert** a V1 account to v2 in place. For **TEST mode** (current
state) these accounts are disposable — **re-onboard via the v2 flow** rather than
build coexistence machinery (over-engineering for the pilot).

If any **live** accounts exist before cutover: do *not* wipe. Add a
`connectApiVersion` column, branch `retrieveAccountStatus`/webhook on it (V1 reads
booleans directly; v2 derives), onboard new sellers via v2. **Flag to a human
before assuming TEST-only.**

## 5. Rollout (dependency chain)

- **Phase 0 — Spike (before any code):** resolve the §6 unknowns in Stripe TEST. See [spike-runbook.md](./spike-runbook.md).
- **Phase 1 — shared:** likely a no-op (comment updates); confirm `connectStatus` stays stable.
- **Phase 2 — server:** rewrite `stripe.ts` (create/link/derivation helper) → `webhook.ts` (reuse helper, or add v2 ingestion) → `connect.ts`/`context.ts` comments. Add unit tests for the derivation helper + a webhook fixture. `pnpm -r typecheck` + tests.
- **Phase 3 — mobile:** no change expected (status shape preserved); smoke-test the onboarding round-trip.
- **Phase 4 — infra:** only if a new v2 event destination/endpoint is required (then register endpoint + secret in Secret Manager, after server passes locally).

**Verification:** unit (capability/requirements → 3 booleans table; webhook dispatcher with a captured v2 fixture); integration in TEST (onboard a test seller → confirm the booleans flip → `orders.create` → `payment_intent.succeeded` still settles the destination charge + 10% fee).

## 6. Risks / unknowns to verify before committing

1. **SDK shape ≠ docs** — use `defaults.responsibilities` + `dashboard`, not `controller.*`. (High confidence — read from the .d.ts.)
2. **Exact create payload** for `2026-05-27.dahlia` — required fields (`identity.country`?), accepted liability tuple. (Medium-high.)
3. **Status mapping** — `payouts_enabled` and especially `details_submitted` have no clean v2 equivalent. (Highest functional risk.)
4. **Webhook story** — V1 `account.updated` vs v2 event destinations + `parseEventNotification`. (High; branches `webhook.ts` + infra.)
5. **Account id format** — may not be `acct_…`; don't hardcode the prefix. (Low.)
6. **`include` on create/retrieve** — capabilities/requirements may not return unless explicitly included. (Medium.)

## 7. Recommendation

Migrate to Accounts v2 **primarily to move loss liability to Stripe** — but treat
it as a **decision + a short TEST spike first**, then a **server-only** `/code-todo`
scoped to `stripe.ts` + `webhook.ts`. PaymentIntents do not change. TEST-mode
Express accounts are disposable. Defer any requirements/restriction UI surfacing
to a later iteration.
