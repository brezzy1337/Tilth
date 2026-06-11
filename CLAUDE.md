# HomeGrown — Claude Code Project Guide

Local food marketplace (neighbors + small farms, equally). Pilot: one region.
Stack: Expo (mobile) · tRPC monolith (server) · Postgres + PostGIS · Stripe Connect Express ·
managed chat provider (TBD) · GCP Cloud Run + Cloud SQL.

pnpm workspaces: `apps/mobile`, `apps/server`, `packages/shared`, plus `infra/` for GCP config.
Commands: `pnpm dev:server`, `pnpm dev:mobile`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`.

Hard rules:
- **No secrets in git, ever.** The legacy repo leaked Braintree/PayPal/JWT/DB credentials. Use `.env` (gitignored) locally and GCP Secret Manager in deploys. If you find a credential in code, stop and flag it.
- **Contracts live in `packages/shared`.** Server and mobile both import from it; never duplicate a type or zod schema across apps.
- Geo queries go through PostGIS (geography types + GiST indexes), not app-side haversine math.
- Stripe: sellers onboard via Connect Express; buyers pay via PaymentSheet; webhooks are the source of truth for payment state.

## Sub-Agent Orchestration

This project treats the main Claude Code session as an orchestrator. It does little work
directly — it routes tasks to sub-agents and assembles their results. Output quality depends on
routing the work correctly and briefing each sub-agent completely. The rules below are how this
session decides.

### Routing: parallel, sequential, or background

Default to the safest pattern that fits. When unsure, run sequentially — a wrong parallel split
causes merge conflicts and inconsistent state, while a wrong sequential choice only costs time.

**Dispatch in parallel** only when ALL of these hold:
- The work splits into 3+ tasks in independent domains
- No task needs another task's output
- File boundaries are clean — no two agents touch the same file

**Dispatch sequentially** when ANY of these holds:
- One task depends on another's output (B needs A)
- Tasks share files or state (merge-conflict risk)
- Scope is unclear and must be understood before acting

**Dispatch in the background** when:
- The task is research or analysis, not file edits
- The result isn't blocking the current work
(Monitor background work from the agent view; press Ctrl+B to background a running task.)

### Domain boundaries (parallel splits)

When a change spans these domains, give each its own agent and keep their files from
overlapping. A parallel split is only safe when the globs below do not intersect; if two
domains share a file, that work is sequential.

- **Mobile** — `apps/mobile/**` (Expo screens, navigation, client state, PaymentSheet UI)
- **Server** — `apps/server/**` (tRPC routers, Stripe webhooks, DB access, auth)
- **Infra** — `infra/**` (Dockerfile, Cloud Run/Cloud SQL config, CI/CD)

⚠️ `packages/shared/**` is intentionally **not** a parallel domain: both apps depend on it, so
any change there is sequential — update shared first, then fan out to consumers.

### Dependency chains (sequential order)

Some work must be serialized because each step consumes the previous step's output. Sub-agents
cannot spawn sub-agents, so this session owns the chain: it runs each step, then hands the
relevant output to the next.

- **Schema/migration → shared types → server router → mobile screen** — the data shape must
  exist before the API that serves it, before the UI that renders it.
- **Server route working locally → infra deploy config** — don't containerize/deploy an
  endpoint that hasn't passed local typecheck + tests.
- **Stripe webhook handler → any payment UI** — payment state truth comes from webhooks; the
  client flow is built against it, not the reverse.
- **Implement → typecheck/test → review** — `pnpm -r typecheck` and tests run before the
  code-reviewer agent is invoked, so review time isn't spent on what the compiler catches.

### Background by default

Run these in the background so the main work continues uninterrupted:
- Docs research (Expo SDK, Stripe Connect, PostGIS, Cloud Run)
- Codebase exploration and analysis
- Dependency audits (delegate to `dependency-auditor`)

### Invocation protocol (every dispatch)

A sub-agent starts with a fresh context window and cannot ask follow-up questions. A thin brief
— not the agent's ability — is the most common cause of a bad result. Every dispatch carries all
four of these:

1. **Context** — what's going on and why, plus any constraint that must survive the handoff
   (e.g. "secrets never go in code; read config from env").
2. **Instructions** — the specific change or output, scoped narrowly.
3. **File references** — exact paths to read or modify (e.g. `apps/server/src/routers/geo.ts`).
4. **Success criteria** — what "done" looks like, concretely.

Weak: "Add the listings feature."

Strong: "Add a `listings.nearby` tRPC procedure in `apps/server/src/routers/listings.ts` that
takes `{lat, lng, radiusKm}` (zod schema exported from `packages/shared`), queries listings via
PostGIS `ST_DWithin` ordered by distance, and returns at most 50 results. Done = `pnpm -r
typecheck` passes and a vitest integration test hits the procedure against the local Postgres
container and asserts distance ordering."

### Specialist agents (`.claude/agents/`)

Named, least-privilege sub-agents exist for the recurring roles. Route to these by name; brief
each with the four-part protocol above (their definitions hold the standing context, not the task).

- **`shared-contracts`** — owns `packages/shared/**`. Head of every dependency chain; runs first
  and sequentially. (Edit scoped to shared.)
- **`server-engineer`** — `apps/server/**`: tRPC routers, webhooks, DB, auth, PostGIS. Reads shared.
- **`mobile-engineer`** — `apps/mobile/**`: Expo screens, navigation, PaymentSheet. Reads shared.
- **`infra-engineer`** — `infra/**`: Dockerfile, Cloud Run/SQL, CI/CD, Secret Manager. Runs after
  the server route passes local typecheck + tests.
- **`dependency-auditor`** — read-only supply-chain gate; verify every new/upgraded package before
  it lands (existence, typosquat, cooldown). Run in the background.
- **`code-reviewer`** — read-only final gate, after typecheck + tests pass.

The three engineers + infra are the parallel-split domains; `shared-contracts` is always sequential.
Sub-agents inherit `model: sonnet` (override per file); the auditor and reviewer are read-only by tools.

### Guardrails

- **Don't over-parallelize.** Splitting eight micro-tasks across eight agents costs more in
  coordination and tokens than it saves. Group related small tasks into one agent.
- **Don't under-parallelize.** Four genuinely independent analyses run one-by-one waste
  wall-clock time. Look for domain independence.
- **Match the model to the task.** Set `CLAUDE_CODE_SUBAGENT_MODEL` (for example, `sonnet`) so
  focused sub-agent work runs on a lighter, cheaper model while this session reasons on a
  stronger one. A per-agent `model` field in `.claude/agents/` overrides it.

### Dependency safety

Before adding or upgrading any package — and before delegating that work to a sub-agent — follow
these rules. The tooling listed below is the real enforcement; these rules cover the moments the
agent acts outside it.

**Verify before you add.** Never add a package just because the name sounds right. An agent can
hallucinate a plausible name that an attacker has already registered (slopsquatting). For any new
dependency, confirm it actually exists, that it's the canonical package (repo link resolves,
adoption/history look real, name isn't a near-miss typo of a popular package), and that it isn't
an internal name a public registry could shadow. Delegate non-trivial checks to the
`dependency-auditor` agent.

**Respect the cooldown — adopt versions that are at least 7 days old.** Enforced in tooling:
`minimumReleaseAge: 10080` (minutes) in `pnpm-workspace.yaml`. The one exception is a genuine
security patch — evaluate it explicitly rather than auto-waiting.

**Other guards (already configured; honor them in agent work):**
- `pnpm-lock.yaml` is committed; CI installs with `pnpm install --frozen-lockfile`. Don't let an
  install silently rewrite it.
- Install/lifecycle scripts are disabled by default (`.npmrc: ignore-scripts=true`); packages
  that genuinely need builds go through pnpm's `allowBuilds` allowlist, with a human sign-off.
- Cooldown applies to transitive deps too. Never disable a guard to ship faster — escalate to
  the human instead.
