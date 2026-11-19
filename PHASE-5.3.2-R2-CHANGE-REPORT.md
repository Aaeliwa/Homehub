# HomeHub V5 — v5.7.2 (r2): emulator test H2 correction — precise change report

**Your report:** `npm run test:rules` → 108 passed, 1 failed (`H2 realistic household, English…`); `PERMISSION_DENIED` for generated cleaning tasks; evaluation at `firestore.rules` line 1534.

## Root cause: a defect in the H2 TEST, not in the app or the rules

**1. Title length is not the cause.**
- In the v5.7.2 rules the generated-task title limit is **120**: `cleanGeneratedOk` (line 687) uses `isName(d.title, 120)`, and the edit check (line 617) uses `isName(d.title, d.get('source', null) == null ? 80 : 120)`.
- Line **1534** exists only in the v5.7.2 rules, so your run used them. The `isName(d.title, 80)` you saw belongs to the v5.7.1 file.
- **H3** creates the same 83-character title and passed in your run, which confirms the 120 limit is in effect.

**2. The real cause is authorship.**
- The H1–H3 helper `realWrites(lang)` built every payload **in the owner's name** (`createdBy = updatedBy = OWNER_A`).
- H1 and H3 save as the owner and pass. **H2 saved those owner-authored payloads as MEMBER_WIFE.**
- The create rule (line 1534, then 1535) requires `incoming().createdBy == request.auth.uid`, so the rules **correctly refused every task**: writing a document in someone else's name is forbidden.
- That is why all of H2's tasks were denied (not just the long title), while H1 and H3 passed.

**3. A second, latent flaw in H2.** Its "re-run is refused" check submitted the wife-authored payload as MEMBER_OTHER. That would be refused for the **wrong reason** (authorship), not because the task already exists, so the check passed vacuously.

**The app is not affected.** The review dialog builds payloads for the signed-in user (`planWrites({ uid: identity.uid })`, page.js line 133), so an authorised member's setup is written in their own name.

**Also checked, not a cause:**
- **Payload:** keys, the `r_`/`d_` id pattern, `source`, recurrence, minutes and instructions all valid for all 97 tasks (unit test `real payloads…`).
- **Room/device references:** active, same Home (H1 passes with the same household).
- **Permissions:** MEMBER_WIFE holds `cleaning.create` (C1 and G1 pass as the wife).

## Changes (tests only; app code and firestore.rules unchanged from v5.7.2)

| File | Change |
|---|---|
| `tests/rules/rules.test.mjs` | `realWrites(lang, author = OWNER_A)`: payloads are built for the user who saves them, as the app does. |
| `tests/rules/rules.test.mjs`, H2 | Builds the English setup for **MEMBER_WIFE**, then saves it as MEMBER_WIFE (all 97 must be accepted, incl. the 83-char title). |
| `tests/rules/rules.test.mjs`, H2 | **New security assertion:** owner-authored tasks submitted by MEMBER_WIFE are **denied** ("createdBy must be the caller"). The accidental finding is kept as a deliberate guard. |
| `tests/rules/rules.test.mjs`, H2 | The re-run check now uses a payload built for MEMBER_OTHER, so the only possible refusal is "already exists"; it also asserts the task exists. |

**Unchanged:**
- deterministic ids, tombstones, source immutability, permissions;
- manual-task rules (titles ≤ 80);
- every other test.

**Emulator test count:** still **109** (H2 gains assertions, not new tests).

## Verification
| Suite | Result in the build environment |
|---|---|
| `npm test` (unit + static) | **272/272 PASS** |
| Browser E2E | **110/110 PASS** (corrected tree, and again from the clean packages) |
| Offline rules-file check (NOT a rules result) | No JavaScript-level failures in 109 tests |
| **Real emulator, normal and strict** | **NOT EXECUTED HERE**: this environment has no network (cannot download `firebase-tools` / the Firestore emulator). Run on your machine: expected **109/109** in both modes. |
