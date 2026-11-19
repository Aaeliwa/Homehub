# HomeHub V5.9.1 — B0 Test-Only Correction Report

**Scope (approved):** `tests/rules/rules.test.mjs` only.

**No application code, `firestore.rules`, Firestore data or deployed resources were changed.**

## 1. Root cause (from `HOMEHUB-V5.9.1-BASELINE-FAILURE-ANALYSIS.md`)

The six failures in your Normal and Strict runs (127/133 each) were **test defects:**
- **Fixture bug** (T3, E1, E3, RM3): `taskDoc(uid)` received a **user object**, so `createdBy` / `updatedBy` weren't the caller, and the rules **correctly** denied the write as a forged author.
- **Stale assertions** (G4, T1): they contradicted deliberate Phase 5.4c / 5.4d rule changes.

## 2. Changes (68 diff lines; see `B0-testfix.patch`)

| Change | Lines (v5.9.1) |
|---|---|
| Guards `asUid(uid, fn)` / `asUser(u, fn)` (throw a `TypeError` on the wrong convention) | inserted before `db` (`:37`) |
| `asUid` on the uid-string helpers: `roomData`, `edit`, `deviceData`, `audit`, `householdWallet`, `personalWallet`, `expense`, `cycleDoc`, `taskDoc`, `genDoc` | their definitions |
| `asUser` on the user-object helpers: `useDoc`, `trigTask`, `tplDoc`, `tplTask`, `linked`, `planDoc`, `recDoc`, `faultDoc`, `evDoc`, `stDoc`, `sid` | their definitions |
| Fixture fixes: `taskDoc(X)` → `taskDoc(X.uid)` | `:1810`, `:1812`, `:1816`, `:1821` (`linked`), `:1838`, `:2061` |
| **G4:** "estimatedMinutes denied" (stale) → **"unknown field denied"** + "estimatedMinutes allowed" | `:1485` |
| **T1:** "device template without a trigger denied" (stale) → **allowed** (periodic) + **`onUse` / `onSeason` without a trigger denied** | `:1766` |

**Security assertions:** `assertDenied` 293 → **294**; `assertSucceeds` 247 → **249**; tests 133 → 133. **None removed or weakened.** No `taskDoc(<user object>)` call remains.

## 3. Results

| Check | Where | Result |
|---|---|---|
| `npm test` | here | **322/322 PASS** (`B0-npm-test.txt`) |
| `npm run test:rules:smoke` | here | 132/133. The single failure is **L14**, which the harness itself whitelists as needing real rules (`tests/rules-smoke/run.mjs`, `NEEDS_REAL_RULES`); it's identical on the unmodified v5.9.1. **No guard threw**, so all 132 other tests' fixtures use the correct convention. **Not a rules result.** |
| `npm run test:e2e` | here | **116/116 PASS** (`B0-e2e.txt`) |
| `rules:limits` | here, on **your pre-fix** logs | 0 expression-limit hits in failing tests (Normal and Strict). **Must be re-run on the new logs.** |
| **`npm run test:rules` (Normal)** | — | **NOT EXECUTED here:** no `firebase-tools`, no network |
| **`npm run test:rules:strict`** | — | **NOT EXECUTED here** |

## 4. Newly exposed failures

**Not observable without the emulator.** The previously failing tests stopped at their first failed assertion, so **their later assertions run for the first time** with this correction. For example:
- E1's archived-device, cross-Home and later-archived-link checks;
- T3's minutes bounds;
- RM3's no-escalation reads.

**If any of them fails, it may be a genuine rules defect.** Per your instruction I'll stop and ask for approval rather than change the rules.

## 5. B0 status

**NOT PASSED.** It needs your emulator Normal + Strict runs on this corrected tree, with both 133/133 and no limit hits.

```cmd
cd HomeHub-V5
npm test
npm run test:rules > emulator-normal.txt 2>&1
npm run test:rules:strict > emulator-strict.txt 2>&1
npm run rules:limits -- emulator-normal.txt
npm run rules:limits -- emulator-strict.txt
npm run test:e2e > baseline-e2e.txt 2>&1
```

**V6 Phase 2 remains unauthorized.**
