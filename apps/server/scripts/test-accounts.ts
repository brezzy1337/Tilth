/**
 * Test-account CLI — seeds and drives clearly-marked (🧪) test accounts so the
 * full app UX (especially F-037 messaging: inbound messages, real pushes,
 * unread badges, block/report targets) can be exercised from a real device.
 *
 * HOW IT TALKS TO THE SERVER — public tRPC API over HTTP only. No direct DB
 * access, no server credentials. It exercises the exact code paths the mobile
 * app uses: `auth.register`/`auth.login` (Bearer JWT), `stores.create`,
 * `geo.setStoreLocation`, `listings.create`, and `chat.*`. The wire format
 * mirrors the mobile httpBatchLink conventions (`${api}/trpc/<procedure>`,
 * `Authorization: Bearer <jwt>`; no transformer — plain JSON).
 *
 * USAGE (run from apps/server, or via `pnpm --filter @homegrown/server test-accounts …`):
 *
 *   pnpm test-accounts seed --lat=33.749 --lng=-84.388 [--api=<url>]
 *       [--address=… --city=… --state=… --zip=…]   (skip reverse geocoding)
 *       [--password=…]                              (re-adopt accounts when the
 *                                                    state file was lost)
 *   pnpm test-accounts reply --message="Yes, still available!" [--conversation=<id>]
 *   pnpm test-accounts status
 *   pnpm test-accounts cleanup
 *
 *   NOTE: negative numbers must use the `=` form (--lng=-84.388) — Node's
 *   parseArgs treats a bare `-84.388` after `--lng` as ambiguous.
 *
 * STATE — credentials + ids are written to `scripts/.test-accounts.json`
 * (gitignored, mode 600). Passwords are generated randomly at seed time and
 * exist ONLY in that file. Never commit it; never hardcode a password here.
 *
 * SAFETY — `--api` defaults to production (https://api.tilth.market) because
 * the whole point is a live counterpart for on-device testing, and pre-launch
 * test data in prod is acceptable per the pilot plan. Everything the tool
 * creates is 🧪-marked. `reply`/`status`/`cleanup` reuse the API URL captured
 * at seed time so a locally-seeded state file never accidentally drives prod.
 */

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AuthResponse,
  ConversationsListOutput,
  ConversationSummary,
  ChatMessage,
  CreateListingInput,
  Listing,
  Location,
  MessagesListOutput,
  NearbyInput,
  SetStoreLocationInput,
  Store,
} from "@homegrown/shared";

// ---------------------------------------------------------------------------
// Constants — everything the tool creates is unmistakably test data.
// ---------------------------------------------------------------------------

const DEFAULT_API = "https://api.tilth.market";

/** Usernames must match /^[a-zA-Z0-9_]+$/ (registerInput) — no emoji there. */
const BUYER = { email: "test-buyer@tilth.market", username: "tilth_test_buyer" };
const SELLER = { email: "test-stand@tilth.market", username: "tilth_test_stand" };

const STORE_NAME = "🧪 Tilth Test Stand";
const STORE_ABOUT =
  "🧪 TEST ACCOUNT — not a real farm stand. Used by the Tilth team to exercise " +
  "messaging and marketplace flows during the pilot. Safe to ignore.";

const TEST_LISTINGS: CreateListingInput[] = [
  { name: "🧪 Test Tomatoes", category: "vegetable", priceCents: 100, quantity: 10, unit: "lb" },
  { name: "🧪 Test Basil", category: "herb", priceCents: 50, quantity: 10, unit: "bunch" },
  { name: "🧪 Test Eggs", category: "egg", priceCents: 200, quantity: 10, unit: "dozen" },
];

const OPENING_MESSAGE =
  "🧪 Hi! This is the Tilth test buyer's seeded opening message — the conversation is live.";

/** Cleanup renames listings with this prefix (there is no delete endpoint). */
const REMOVED_PREFIX = "🧪 [removed] ";

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), ".test-accounts.json");

// ---------------------------------------------------------------------------
// State file — the only place generated passwords live. Gitignored.
// ---------------------------------------------------------------------------

interface AccountState {
  userId: string;
  email: string;
  username: string;
  /** Randomly generated at seed time. NEVER hardcoded, NEVER committed. */
  password: string;
}

interface CliState {
  apiUrl: string;
  seededAt: string;
  coords: { lat: number; lng: number };
  buyer: AccountState;
  seller: AccountState & { storeId: string };
  /** The seeded buyer<->test-stand conversation. */
  conversationId: string;
  listingIds: string[];
}

function loadState(): CliState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as CliState;
}

function saveState(state: CliState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function requireState(): CliState {
  const state = loadState();
  if (!state) {
    fail(
      `No state file at ${STATE_FILE}.\n` +
        "Run `pnpm test-accounts seed --lat=<n> --lng=<n>` first.",
    );
  }
  return state;
}

// ---------------------------------------------------------------------------
// Minimal tRPC-over-HTTP client — raw fetch, zero dependencies.
// Matches the server's standalone adapter (request-listener.ts strips /trpc):
//   query    → GET  ${api}/trpc/<proc>?input=<url-encoded JSON>
//   mutation → POST ${api}/trpc/<proc> with a JSON body
// No transformer is configured server-side, so responses are plain JSON:
//   { result: { data: … } }  or  { error: { message, data: { code, … } } }
// ---------------------------------------------------------------------------

class RpcError extends Error {
  constructor(
    readonly procedure: string,
    readonly code: string,
    message: string,
  ) {
    super(`${procedure} → ${code}: ${message}`);
  }
}

interface TrpcResponseShape {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string } };
}

async function rpc<T>(
  api: string,
  procedure: string,
  kind: "query" | "mutation",
  input?: unknown,
  token?: string,
): Promise<T> {
  const base = `${api.replace(/\/$/, "")}/trpc/${procedure}`;
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;

  let response: Response;
  if (kind === "query") {
    const qs = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    response = await fetch(`${base}${qs}`, { headers });
  } else {
    headers["content-type"] = "application/json";
    response = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify(input ?? {}),
    });
  }

  let payload: TrpcResponseShape;
  try {
    payload = (await response.json()) as TrpcResponseShape;
  } catch {
    throw new RpcError(procedure, "BAD_RESPONSE", `non-JSON response (HTTP ${response.status})`);
  }

  if (payload.error) {
    throw new RpcError(
      procedure,
      payload.error.data?.code ?? "UNKNOWN",
      payload.error.message ?? `HTTP ${response.status}`,
    );
  }

  return payload.result?.data as T;
}

const query = <T>(api: string, proc: string, input?: unknown, token?: string) =>
  rpc<T>(api, proc, "query", input, token);
const mutate = <T>(api: string, proc: string, input?: unknown, token?: string) =>
  rpc<T>(api, proc, "mutation", input, token);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function generatePassword(): string {
  // 24 url-safe chars ≈ 144 bits of entropy; within registerInput's 8–100 bounds.
  return randomBytes(18).toString("base64url");
}

/**
 * Register the account, or log into it when it already exists (idempotent
 * seed). The password tried on login is, in order: the one in the state file,
 * then --password. A pre-existing account with an unknown password is a hard
 * error — this tool never guesses and there is no reset endpoint.
 */
async function ensureAccount(
  api: string,
  who: { email: string; username: string },
  knownPassword: string | undefined,
): Promise<{ token: string; userId: string; password: string; created: boolean }> {
  const password = knownPassword ?? generatePassword();
  try {
    const res = await mutate<AuthResponse>(api, "auth.register", { ...who, password });
    return { token: res.token, userId: res.user.id, password, created: true };
  } catch (err) {
    if (!(err instanceof RpcError) || err.code !== "CONFLICT") throw err;
  }

  // Account exists — log in with the password we have on file.
  try {
    const res = await mutate<AuthResponse>(api, "auth.login", {
      usernameOrEmail: who.email,
      password,
    });
    return { token: res.token, userId: res.user.id, password, created: false };
  } catch (err) {
    if (err instanceof RpcError && err.code === "UNAUTHORIZED") {
      fail(
        `${who.email} already exists but the password on file doesn't match.\n` +
          `If you know its password, re-run with --password=<pw>. Otherwise the\n` +
          `account must be removed manually (no account-delete endpoint exists).`,
      );
    }
    throw err;
  }
}

/**
 * Reverse-geocode lat/lng into a structured address via OSM Nominatim (keyless,
 * dependency-free). Needed because `geo.setStoreLocation` — the only way to
 * place a store — takes an ADDRESS and geocodes it server-side (Google); there
 * is no procedure that accepts raw coordinates. The address→point round trip
 * can drift a little from the requested coords; seed prints the final point.
 */
async function reverseGeocode(lat: number, lng: number): Promise<SetStoreLocationInput | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1` +
    `&lat=${lat}&lon=${lng}`;
  const response = await fetch(url, {
    // Nominatim's usage policy requires an identifying User-Agent.
    headers: { "user-agent": "tilth-test-accounts-cli/1.0 (dev tooling; one-shot)" },
  });
  if (!response.ok) return null;

  let body: { address?: Record<string, string | undefined> };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return null; // malformed response — caller falls back like the !ok case
  }
  const a = body.address;
  if (!a) return null;

  const street = [a["house_number"], a["road"]].filter(Boolean).join(" ");
  const address = street || a["neighbourhood"] || a["suburb"] || "";
  const city = a["city"] ?? a["town"] ?? a["village"] ?? a["county"] ?? "";
  const state = a["state"] ?? a["region"] ?? "";
  const zip = a["postcode"] ?? "";

  // setStoreLocationInput minimums: address ≥1, city ≥1, state ≥2, zip ≥3.
  if (!address || !city || state.length < 2 || zip.length < 3) return null;
  return { address, city, state, zip };
}

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function seed(args: {
  api: string;
  lat: number;
  lng: number;
  password?: string;
  address?: SetStoreLocationInput;
}): Promise<void> {
  const { api, lat, lng } = args;
  const previous = loadState();
  console.log(`Seeding 🧪 test accounts against ${api}\n`);

  // 1. Accounts — register or re-login (idempotent).
  const buyer = await ensureAccount(api, BUYER, previous?.buyer.password ?? args.password);
  console.log(`  buyer   ${BUYER.email}  (${buyer.created ? "registered" : "already existed — logged in"})`);
  const seller = await ensureAccount(api, SELLER, previous?.seller.password ?? args.password);
  console.log(`  seller  ${SELLER.email}  (${seller.created ? "registered" : "already existed — logged in"})`);

  // 2. Store — one per user; reuse if it exists.
  let store = await query<Store | null>(api, "stores.getMine", undefined, seller.token);
  if (!store) {
    store = await mutate<Store>(
      api,
      "stores.create",
      { name: STORE_NAME, about: STORE_ABOUT },
      seller.token,
    );
    console.log(`  store   "${store.name}" created (${store.id})`);
  } else {
    console.log(`  store   "${store.name}" already exists (${store.id})`);
  }

  // 3. Location — geo.setStoreLocation takes an address (server geocodes it);
  // reverse-geocode the requested coords unless an address was supplied.
  const address = args.address ?? (await reverseGeocode(lat, lng));
  if (address) {
    try {
      const loc = await mutate<Location>(api, "geo.setStoreLocation", address, seller.token);
      console.log(
        `  location "${address.address}, ${address.city}" → placed at ` +
          `(${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}) — requested (${lat}, ${lng})`,
      );
    } catch (err) {
      console.warn(
        `  ⚠ location skipped — geo.setStoreLocation failed ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          `The store won't appear on the map, but messaging still works.`,
      );
    }
  } else {
    console.warn(
      `  ⚠ location skipped — could not reverse-geocode (${lat}, ${lng}) into a full ` +
        `address. Re-run with --address/--city/--state/--zip to place the store.`,
    );
  }

  // 4. Listings — create the ones that don't exist yet (matched by name).
  const existing = await query<Listing[]>(api, "listings.listByStore", { storeId: store.id });
  const existingNames = new Set(existing.map((l) => l.name));
  const listingIds = existing.map((l) => l.id);
  for (const item of TEST_LISTINGS) {
    if (existingNames.has(item.name)) {
      console.log(`  listing "${item.name}" already exists`);
      continue;
    }
    const created = await mutate<Listing>(api, "listings.create", item, seller.token);
    listingIds.push(created.id);
    console.log(`  listing "${created.name}" created ($${(created.priceCents / 100).toFixed(2)}/${created.unit})`);
  }

  // 5. Conversation — buyer opens it (chat.start is buyer-initiated and
  // idempotent per (buyer, store)); send the opener only once.
  const { conversationId } = await mutate<{ conversationId: string }>(
    api,
    "chat.start",
    { storeId: store.id },
    buyer.token,
  );
  const thread = await query<MessagesListOutput>(
    api,
    "chat.messages",
    { conversationId, limit: 1 },
    buyer.token,
  );
  if (thread.items.length === 0) {
    await mutate<ChatMessage>(
      api,
      "chat.send",
      { conversationId, body: OPENING_MESSAGE },
      buyer.token,
    );
    console.log(`  conversation ${conversationId} opened; buyer sent the opening message`);
  } else {
    console.log(`  conversation ${conversationId} already has messages — opener skipped`);
  }

  // 6. Sanity check — do the test listings show up in a nearby search?
  const nearbyInput: NearbyInput = { lat, lng, radiusKm: 25 };
  const nearby = await query<Array<{ storeId: string }>>(api, "listings.nearby", nearbyInput);
  const visible = nearby.filter((n) => n.storeId === store.id).length;
  console.log(
    visible > 0
      ? `  ✓ ${visible} test listing(s) visible via listings.nearby within 25 km of (${lat}, ${lng})`
      : `  ⚠ test listings NOT visible via listings.nearby — the store likely has no location (see above)`,
  );

  saveState({
    apiUrl: api,
    seededAt: new Date().toISOString(),
    coords: { lat, lng },
    buyer: { userId: buyer.userId, ...BUYER, password: buyer.password },
    seller: { userId: seller.userId, ...SELLER, password: seller.password, storeId: store.id },
    conversationId,
    listingIds,
  });

  console.log(`\nCredentials + ids written to ${STATE_FILE} (gitignored — keep it local).`);
  console.log(
    `\nNext steps on your device:\n` +
      `  1. In the app (as YOUR account), find "${STORE_NAME}" and message it.\n` +
      `  2. Run: pnpm test-accounts reply --message="Howdy!"  → real push to your device.\n` +
      `  3. Run: pnpm test-accounts status  → see your message land in the stand's inbox.\n` +
      `  Or log in AS the test buyer (${BUYER.email}) to see the buyer side.`,
  );
}

async function status(api: string): Promise<void> {
  const state = requireState();
  const seller = await mutate<AuthResponse>(api, "auth.login", {
    usernameOrEmail: state.seller.email,
    password: state.seller.password,
  });

  const inbox = await query<ConversationsListOutput>(
    api,
    "chat.list",
    { limit: 50 },
    seller.token,
  );

  console.log(`${STORE_NAME} — inbox on ${api} (${inbox.items.length} conversation(s))\n`);
  if (inbox.items.length === 0) {
    console.log("  (empty — message the test stand from the app, then re-run)");
    return;
  }
  for (const c of inbox.items) {
    const marker = c.buyerId === state.buyer.userId ? " (seeded test buyer)" : "";
    console.log(`  ${c.id}`);
    console.log(`    from:    ${c.buyerName}${marker}`);
    console.log(`    unread:  ${c.unreadCount}`);
    console.log(`    last:    ${formatWhen(c.lastMessageAt)} — ${c.lastMessageBody ?? "(no messages)"}`);
  }
}

async function reply(
  api: string,
  message: string,
  conversationArg?: string,
  confirmed = false,
): Promise<void> {
  const state = requireState();
  const seller = await mutate<AuthResponse>(api, "auth.login", {
    usernameOrEmail: state.seller.email,
    password: state.seller.password,
  });

  const inbox = await query<ConversationsListOutput>(
    api,
    "chat.list",
    { limit: 50 },
    seller.token,
  );
  if (inbox.items.length === 0) {
    fail("The test stand has no conversations yet — message it from the app first.");
  }

  let target: ConversationSummary | undefined;
  if (conversationArg) {
    target = inbox.items.find((c) => c.id === conversationArg);
    if (!target) fail(`Conversation ${conversationArg} not found in the test stand's inbox.`);
  } else {
    // Most recent conversation with a non-seeded buyer. NOTE: the test stand
    // is publicly discoverable, so this is NOT guaranteed to be the operator's
    // own account — any nearby pilot user may have messaged it. Auto-selection
    // is therefore a dry-run unless --yes is passed: we show who was resolved
    // and refuse to send, so a canned reply can never reach a stranger
    // unconfirmed.
    target = inbox.items.find((c) => c.buyerId !== state.buyer.userId) ?? inbox.items[0];
    if (target && !confirmed) {
      console.log(`Auto-selected the most recent conversation:`);
      console.log(`  buyer:        ${target.buyerName} (${target.buyerId})`);
      console.log(`  conversation: ${target.id}`);
      console.log(`  last message: ${target.lastMessageBody ?? "(none)"}`);
      console.log(
        `\nNothing sent. Verify this buyer is YOU, then re-run with --yes` +
          `\n(or target explicitly with --conversation=${target.id}).`,
      );
      return;
    }
  }
  if (!target) fail("No conversation to reply to.");

  const sent = await mutate<ChatMessage>(
    api,
    "chat.send",
    { conversationId: target.id, body: message },
    seller.token,
  );

  console.log(`✓ Replied as "${STORE_NAME}" to ${target.buyerName} (conversation ${target.id})`);
  console.log(`  message ${sent.id} @ ${formatWhen(sent.createdAt)}: ${sent.body}`);
  console.log(
    `  A push notification was dispatched to ${target.buyerName}'s registered devices\n` +
      `  (chat.send pushes to the other party — no token registered means no push).`,
  );
}

async function cleanup(api: string): Promise<void> {
  const state = requireState();
  const seller = await mutate<AuthResponse>(api, "auth.login", {
    usernameOrEmail: state.seller.email,
    password: state.seller.password,
  });

  console.log(`Best-effort cleanup against ${api}\n`);

  // Listings: there is NO delete endpoint (listings router: create / update /
  // listByStore / nearby only). Closest available: zero the quantity (sold
  // out) and rename with a [removed] marker via listings.update.
  const listings = await query<Listing[]>(api, "listings.listByStore", {
    storeId: state.seller.storeId,
  });
  for (const l of listings) {
    const alreadyRemoved = l.name.startsWith(REMOVED_PREFIX) && l.quantity === 0;
    if (alreadyRemoved) {
      console.log(`  listing "${l.name}" already cleaned`);
      continue;
    }
    const name = l.name.startsWith(REMOVED_PREFIX)
      ? l.name
      : `${REMOVED_PREFIX}${l.name}`.slice(0, 120);
    await mutate<Listing>(
      api,
      "listings.update",
      { listingId: l.id, name, quantity: 0 },
      seller.token,
    );
    console.log(`  listing "${l.name}" → quantity 0, renamed "${name}"`);
  }

  console.log(
    `\nThat's everything the public API can undo. NOT deletable via API (no\n` +
      `server-side endpoints exist for these):\n` +
      `  - the user accounts   ${state.buyer.email} (${state.buyer.userId})\n` +
      `                        ${state.seller.email} (${state.seller.userId})\n` +
      `  - the store           "${STORE_NAME}" (${state.seller.storeId}) + its location\n` +
      `  - the listing rows    (zeroed + renamed, but still present; still appear in listings.nearby)\n` +
      `  - conversations/messages, blocks, reports, push tokens\n` +
      `Full removal needs manual SQL against the database (delete users by the two\n` +
      `ids above; FKs cascade per schema). The state file is kept so the same\n` +
      `accounts can be re-seeded — delete ${STATE_FILE} once the rows are gone.`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `🧪 Tilth test-account CLI — drives the public tRPC API (no DB access).

Commands:
  seed --lat=<n> --lng=<n>   Register 🧪 buyer + seller, create the test stand
                             (store at the coords via reverse-geocoded address),
                             listings, and a seeded conversation. Idempotent.
        [--address=… --city=… --state=… --zip=…]  use this address instead of
                                                  reverse geocoding the coords
        [--password=<pw>]    adopt pre-existing accounts when the state file is lost
  reply --message=<text>     Log in as the test stand and reply. With
        [--conversation=<id>] --conversation, targets that thread. Without it,
        [--yes]              auto-selects the most recent non-test-buyer thread
                             but only PRINTS the resolved buyer (dry run) —
                             pass --yes to actually send. The stand is publicly
                             discoverable, so the newest thread may belong to a
                             real user, not you; sending fires a real push.
  status                     Print the test stand's inbox (unread counts, previews).
  cleanup                    Best-effort teardown via API; prints what needs manual
                             removal. Note: a later re-seed re-creates listings
                             fresh — the old "🧪 [removed]" rows stay (no delete
                             endpoint exists), so expect leftovers until manual SQL.

Options:
  --api=<url>                API base URL. seed defaults to ${DEFAULT_API};
                             other commands default to the URL captured at seed time.
                             Use the = form for negative numbers: --lng=-84.388

State: ${STATE_FILE} (gitignored; generated passwords live only there).
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      api: { type: "string" },
      lat: { type: "string" },
      lng: { type: "string" },
      password: { type: "string" },
      address: { type: "string" },
      city: { type: "string" },
      state: { type: "string" },
      zip: { type: "string" },
      message: { type: "string" },
      conversation: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  // seed defaults to prod (that's its purpose); the other commands default to
  // wherever the seed ran, so a local seed never accidentally drives prod.
  const stateApi = loadState()?.apiUrl;

  switch (command) {
    case "seed": {
      const lat = Number(values.lat);
      const lng = Number(values.lng);
      if (values.lat === undefined || values.lng === undefined || isNaN(lat) || isNaN(lng)) {
        fail("seed requires numeric --lat and --lng (use --lng=-84.388 for negatives).");
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        fail("--lat must be within ±90 and --lng within ±180.");
      }
      let address: SetStoreLocationInput | undefined;
      if (values.address || values.city || values.state || values.zip) {
        if (!(values.address && values.city && values.state && values.zip)) {
          fail("--address, --city, --state, and --zip must be supplied together.");
        }
        address = {
          address: values.address,
          city: values.city,
          state: values.state,
          zip: values.zip,
        };
      }
      await seed({
        api: values.api ?? DEFAULT_API,
        lat,
        lng,
        password: values.password,
        address,
      });
      break;
    }
    case "reply": {
      if (!values.message) fail('reply requires --message="<text>".');
      await reply(
        values.api ?? stateApi ?? DEFAULT_API,
        values.message,
        values.conversation,
        values.yes === true,
      );
      break;
    }
    case "status":
      await status(values.api ?? stateApi ?? DEFAULT_API);
      break;
    case "cleanup":
      await cleanup(values.api ?? stateApi ?? DEFAULT_API);
      break;
    default:
      console.log(USAGE);
      fail(`Unknown command "${command}".`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
