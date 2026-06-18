# Stripe Connect — Accounts v2 migration

Working docs for evaluating a move from the current **v1 Express** Connect setup
to **Accounts v2**. Status: **proposed, not started** — pending a TEST spike.

## Contents

- [`migration-plan.md`](./migration-plan.md) — decision memo + per-layer change map + rollout.
- [`spike-runbook.md`](./spike-runbook.md) — how to run the TEST probe and what to capture.
- [`accounts-v2-probe.mjs`](./accounts-v2-probe.mjs) — throwaway probe script (no app code; run by hand against Stripe TEST).

## TL;DR

Migrate **mainly to shift negative-balance/fraud liability from the platform to
Stripe** (`losses_collector: 'stripe'`). PaymentIntents (the charge path) do not
change. Two things must be verified in the spike first: the `stripe@22.2.0` SDK
uses `defaults.responsibilities` + `dashboard` (not the docs' `controller.*`), and
`charges_enabled` / `payouts_enabled` / `details_submitted` don't exist on v2
accounts (must be derived from capabilities + requirements).

## Related

- Notion: *Stripe Connect: v1 (Express) vs v2 (Accounts v2) — Comparison & Migration*
- PR #14 — Stripe best-practices hardening (closed #7)
- PR #16 — prod-image hardening
- Issue #15 — post-MVP order-level idempotency
