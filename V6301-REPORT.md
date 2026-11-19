# HomeHub V6.3.0.1 — Targeted hotfix

Baseline: V6.3.0. **Not deployed.** No migration: documents without the new fields read as generation 0 and stay valid.

## Audit findings (checked against the V6.3.0 source)

| # | Finding | Confirmed? | Fix |
|---|---|---|---|
| 1 | Reset vs completion across devices | **Yes.** Reset undid progress *before* restarting the schedule. A tab or device holding a pre-reset snapshot (or a Mark All selection captured before the reset) could still write afterwards, and the rules had no notion of a "reset generation". An edit form opened before a reset could also write the old `startDate` back. | Reset generation, enforced by the rules (below) |
| 2 | Recipe duplicates across devices | **Yes.** Import IDs hashed a per-preview random nonce, so two devices importing the same recipe produced different IDs and both were created. | Deterministic, session-independent IDs |
| 3 | Service worker cache deletion | **Yes.** On activate it deleted *every* cache on the origin. | Deletes only `homehub-*` caches |
| 4 | Example JSON video URL | **Yes.** It used an unrelated YouTube video. | `videoUrl: null` (the schema allows null) |

## 1. Cleaning reset generation

**Data**
- A task gets an optional `resetGen` integer (absent = 0).
- An occurrence gets an optional `taskGen` integer: the generation the write was decided under. Generation 0 is written as "absent", so older documents and clients are unchanged.

**Reset task progress**
1. Every task in scope first moves to `resetGen + 1`, one write each. `startDate` still moves only for recurring, non-trigger tasks that started before today.
2. Only then is today's and later progress undone, with the existing audited inverse actions, under the new generation.
3. If a task's bump fails, its undo is not attempted. Both go into the retry plan.
4. Retry steps that were already applied (same generation and data) count as success and are not applied twice.
5. When two devices reset at the same time and both undo the same occurrence, the second one counts as success, not failure.

**Restore default tasks:** each restored default gets its definition and its generation bump in **one** write, then the undo runs under the new generation. The definition plan stays idempotent.

**Mark All Done:** the selection records each task's generation when the user confirms.
- If a reset happened since, those items are dropped on the client before writing.
- The captured generation is the one sent, so the server refuses the write even if the client check is bypassed or the snapshot lags.

**Individual Done / Reopen / Skip:** each write carries the task's generation, so a stale tab is refused (shown as the existing "someone else changed this" conflict).

**Edit form:** `updateTask(..., { baseGen })` refuses to save a form opened before a reset. This check is client-side; see Limitations.

**Rules (`firestore.rules`)**
- `cleaningTasks` update, edit branch: `resetGen` may change only to `resource.resetGen + 1`. It still needs `cleaning.edit` and full content validation.
- `cleaningOccurrences` create and update: `incoming().get('taskGen', 0) == task.get('resetGen', 0)`. `taskGen` was added to the allowed key lists.
- **Nothing was relaxed.** Every existing condition is unchanged.
- Cost estimate: `cleaningTasks` update 801 → 831, occurrence create 700 → 728, update 548 → 574. All are under the 1100 tripwire; the static tripwire test passes.

## 2. Recipe import IDs

- **ID format:** `ai_<fnv64(stableIdentityKey + '#' + copyNumber)>`, where the key is the normalised titles plus the video. It no longer depends on the session, device or user.
- **Same new recipe on two devices at once:** both get the same ID. The create-only write keeps one recipe, and the other device reports it as "already".
- **Intentional separate copies** (a ticked duplicate, or two copies in one file) get the next copy number, so a separate deterministic ID. No overwrite is ever possible.
- **Deleted recipes:** an ID of a deleted recipe is never reused; the importer skips to the next copy number (`takenIds`).
- Existing recipes and previously imported IDs are unchanged.

## 3. Service worker

- `OWN_CACHE_PREFIX = 'homehub-'`; the activate step deletes only caches with that prefix.
- Install and update behaviour is unchanged: `skipWaiting`, `clients.claim`, network-only, standalone manifest. `SW_VERSION` is now `6.3.0.1`.

## 4. Example JSON

`EXAMPLE.items[0].videoUrl = null`. It still round-trips through the importer as "ready". Real YouTube links are still embedded (tested separately).

## Files changed

- **App:** `src/modules/cleaning/cleaning-model.js`, `cleaning-ops.js`, `cleaning-store.js`, `task-form.js`; `src/modules/chef/recipe-import.js`, `page.js`; `sw.js`
- **Rules:** `firestore.rules`
- **Version:** `package.json`, `src/config/app-config.js` → 6.3.0.1
- **Tests**
  - new: `tests/unit/v6301-cleaning.test.mjs` (7 concurrency tests on a fake server with the same generation rules)
  - extended: `tests/unit/v630-recipes.test.mjs` (+1 cross-device test; example, ID and nonce assertions updated to the new required behaviour), `tests/unit/v630-cleaning.test.mjs` (the reset-plan expectation now includes generations), `tests/static/pwa-static.test.mjs` (cache-prefix checks), `tests/rules/rules.test.mjs` (+V6301-R)
- No other modules were touched.

## Test results

| Check | Result |
|---|---|
| `npm test` (unit + static) | **410/410 pass** (+8 new: 7 cleaning concurrency, 1 recipe cross-device; static PWA and rules-cost tripwires pass) |
| `npm run test:e2e` | **124/124 pass** |
| `npm run test:rules:smoke` | 157 tests (+1: V6301-R), no JavaScript-level failures; the 1 failure is the same expected stub result as V6.2.2.1 and V6.3.0 |
| `npm run rules:cost` | pass (see cost estimates above) |
| `npm run test:rules` (Normal) / `:strict` | **NOT RUN** (no Firestore emulator here) |
| `npm run rules:limits` | **NOT RUN** (needs the emulator logs) |
| Real Android | **NOT RUN: user verification pending** |
| `npm run build` | not applicable (no build script) |

**E2E time-of-day dependency (test fixture only).** Between 00:00 and 03:00 Cairo time, T-UI and G-UI failed on **both V6.3.0 and V6.3.0.1** (122/124 each). That window is the routine's night window: the routine day starts at `startHour`, default 3.
- **Fix:** both fixtures now pin `startHour: 0`, the same fix as the existing B0 test. No assertion was changed.
- **Result:** 124/124, run at 00:18 Cairo time, inside the night window. The night-window behaviour itself stays covered by ADV-NIGHT.

## Limitations

- **Edit-form protection is client-side.** Cleaning tasks have no revision field, so the rules cannot tell a stale form from a fresh one. Adding one would mean a schema change beyond a hotfix. The server still enforces generations on every occurrence write.
- **The emulator was not available here**, so rule behaviour is verified statically and with a fake server that applies the same conditions. Please run the emulator commands below.
- **Real-Android PWA verification** is still pending, as in V6.3.0.

## Windows verification

```cmd
npm test
npm run test:e2e
npm run test:rules:smoke
npm run test:rules > emulator-normal.txt 2>&1
npm run test:rules:strict > emulator-strict.txt 2>&1
npm run rules:limits -- emulator-normal.txt
npm run rules:limits -- emulator-strict.txt
npm run rules:cost
```

Deploy only after both emulator runs pass: `firebase deploy --only firestore:rules`, then `firebase deploy --only hosting`. Deploy rules **before** hosting: the new client writes `taskGen` / `resetGen`, which the old rules refuse. The old client keeps working under the new rules until a reset sets generation 1. After that, an old tab's writes to that task are refused until it reloads, which is the intended protection.
