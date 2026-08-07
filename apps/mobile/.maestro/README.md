# Mobile E2E — Maestro (F-055)

Maestro flows that automate the F-051 Settings verification checklist against
a release APK on an Android emulator in CI, run against **prod**
(`https://api.tilth.market`) with a dedicated 🧪 account:
`e2e-runner@tilth.market`. Credentials are never hardcoded — they're read from
`${MAESTRO_TEST_EMAIL}` / `${MAESTRO_TEST_PASSWORD}`, injected by the CI
workflow (`.github/workflows/mobile-e2e.yml`) as environment variables.

## Flows (explicit order — see below)

| File | Covers |
| --- | --- |
| `00-login.yaml` | Clean launch, Hero → Log In, sign in, land on Home (anchor: header "Settings"/"Tilth" — not the map, since the Google Maps key and tile rendering may be unavailable in CI). |
| `01-settings-legal.yaml` | Settings renders the signed-in profile email row; About → Terms of Service opens and shows real copy ("Welcome to Tilth"); About → Privacy Policy opens and shows real copy ("What this covers"). |
| `02-change-password.yaml` | Settings > Account > Change password end to end: change to `${MAESTRO_TEST_PASSWORD}-x`, sign out, log back in with the new password, change it back to `${MAESTRO_TEST_PASSWORD}`, sign out, log back in with the original. Idempotent — the GH secret stays valid across runs. |
| `03-blocked-users.yaml` | Settings > Privacy > Blocked users renders. The full block/message/unblock loop against the 🧪 test stand is a commented TODO in the file — see the gaps list below. |

## Known gaps (stay manual for v1)

- **Push notification toggle.** No flow drives `Settings > Notifications >
  Push notifications`. Real push delivery can't be asserted on an emulator
  without device-farm/FCM infra — verify manually on a physical device
  (see `pnpm test-accounts reply` in `apps/server/scripts/test-accounts.ts`
  for a real inbound push to trigger against).
- **Block/unblock against a real second account.** `03-blocked-users.yaml`
  only confirms the screen renders. Driving a fresh conversation with the 🧪
  test stand and blocking from it depends on device geolocation (Home/Search
  are both gated behind `useDeviceLocation`), which isn't pinned to a known
  coordinate in CI yet — see the TODO block in that file for exactly what's
  needed to turn it on.
- **Stripe dashboard / payouts.** Not part of the F-051 Settings checklist
  this harness targets; verify in the Stripe dashboard directly.
- **Real email delivery** (e.g. F-054 verification codes via SendGrid) is out
  of scope here — this harness only covers the F-051 Settings checklist.

## Running locally

Point at a dev build (not prod) when iterating so you're not burning real
requests against prod with a throwaway account, and use a device/emulator
already signed into (or able to sign into) a test account:

```bash
# from apps/mobile
MAESTRO_TEST_EMAIL="you@example.com" \
MAESTRO_TEST_PASSWORD="..." \
  # IMPORTANT: pass files explicitly, in this order. Maestro's directory mode
  # walks the filesystem UNSORTED, and 01-03 assume 00's login session exists.
  maestro test .maestro/00-login.yaml .maestro/01-settings-legal.yaml \
    .maestro/02-change-password.yaml .maestro/03-blocked-users.yaml

MAESTRO_TEST_EMAIL="you@example.com" \
MAESTRO_TEST_PASSWORD="..." \
  maestro test .maestro/00-login.yaml          # a single flow
```

To run against a dev/staging API instead of prod, install a dev-client build
with `EXPO_PUBLIC_API_URL` pointed at that environment (the API URL is baked
in at build time — see `App.tsx`) rather than passing it to Maestro, which
has no way to override an already-built app's config.

## testIDs added for this harness

A handful of `testID`s were added to disambiguate form inputs that share a
screen with a same-labeled button (e.g. LogInScreen's "Log In" submit button
vs. the Hero screen's "Log In" CTA) or with each other (ChangePasswordScreen's
three password fields):

- `login-username-input`, `login-password-input` — `src/screens/LogInScreen.tsx`
- `change-password-current-input`, `change-password-new-input`,
  `change-password-confirm-input` — `src/screens/ChangePasswordScreen.tsx`

Everything else is matched by real, already-shipped visible text or
`accessibilityLabel` (e.g. HomeScreen's gear icon, `accessibilityLabel=
"Settings"`) — no other component changes were made for this harness.

## Recovery: stale password after a mid-flow failure

`02-change-password.yaml` changes the live account password to
`${MAESTRO_TEST_PASSWORD}-x` and reverts it at the end. If the flow dies
between those two points (timeout, emulator flake), the account is left on
the `-x` password while the `E2E_TEST_PASSWORD` GitHub secret still holds
the original — every later run then fails at `00-login.yaml`.

To recover, try logging in via the API with the original secret, then with
`<original>-x`. Whichever works tells you the live state; if it's `-x`,
either change the password back through `auth.changePassword` with that
session, or update the GitHub secret to the `-x` value. Never leave the
secret and the live password out of sync.

## Security note (CI artifacts)

Maestro's `commands.json` debug files contain post-substitution command
values — i.e. the resolved password from `inputText` steps. The CI workflow
deletes `commands*.json` before uploading failure artifacts; keep that step
if you touch the upload. Screenshots are safe (password fields use
`secureTextEntry`).

## Finding: header icons sit under the status bar (needs a real-device check)

The run-31191892606 hierarchy dump showed the Home header's icon row
(Orders / Cart / Settings, y≈61–153) overlapping the system status-bar
window (y 1–128) on the pinned pixel_6 emulator. The buttons render and are
in the accessibility tree, but a tap at their centre is delivered to
SystemUI, not the app — i.e. **they are unreachable**.

On Devin's physical device the same header is reachable, so the top
safe-area inset resolves correctly there and this is emulator-specific.
Still worth a human check on a device with a small/no notch: if any real
device under-reports the top inset the same way, those three controls
become dead on that device. If confirmed, the fix belongs in HomeScreen's
header (respect `useSafeAreaInsets().top`), not in these flows.

Until then the flows tap the gear's lower half by point ("91%,6%"), which
is inside the button and below the status bar on the pinned profile.
