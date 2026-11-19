# HomeHub V6.2.2.1 — Emulator regression fix (test fixture only)

No deployment, no data change, no rules change, no app code change.

## Root cause (from the attached `emulator-normal.txt`)

- **Only one write was refused inside V622-3**, at log line 1516:
  `false for 'create' @ L2386, evaluation error at L2396:26 for 'update' @ L2396, false for 'create' @ L2386`.
  It was evaluated as **create or update**, so it came from a `setDoc` on a new document, not from the `updateDoc` of the older event.
  The update error is a side effect: `resource` is null for a document that doesn't exist yet, so the update rule can't be evaluated.
  - The actual refusal is **`false for 'create' @ L2386`**.
  - So the very first assertion failed: line 2369, `setDoc(calPath(db(W), 'evS1'), …)`.
- **Exact failing condition:** `eventId.matches('^[A-Za-z0-9_-]{6,40}$')` at L2386, the first condition of the calendar create rule (in place since V6.2). The fixture IDs `evS1`–`evS5` are **4 characters**, so they fail the 6-character minimum.
- **Masked assertions:** the `assertDenied` checks for `evS3` and `evS4` would have been refused because of their IDs, not because of the shift validation they are meant to test.
- **Rules unaffected:** `calContentOk()` and the update rule were never the cause. The older-event update (line 2375) never ran, because the test stopped at line 2369.

## Fix (1 file)

`tests/rules/rules.test.mjs`, test V622-3 only: the fixture IDs become valid document IDs.

- `evS1`…`evS5` → `evShift1`…`evShift5`
- `old1` → `evLegacy1`: same pattern; update requests don't check IDs, but this keeps the fixture realistic.

**No assertion was removed or loosened.** The two `assertDenied` checks now exercise the intended rule ("a shift is never Vacation", "unknown subtype") instead of the ID check. Firestore rules and app code are byte-identical to V6.2.2.

## Verification

| Check | Result |
|---|---|
| Fixture IDs vs `^[A-Za-z0-9_-]{6,40}$` | all valid; no `calPath` ID in the suite is shorter than 6 characters |
| `npm test` | **384/384** |
| `npm run test:rules:smoke` | 154 tests, no JavaScript errors (same 1 expected stub result as V6.2.2) |
| `npm run test:rules` / `:strict` | **NOT RUN** here (no emulator) — please re-run |
| `npm run rules:limits` | **NOT RUN** |

The older-event update now runs for the first time against the emulator. Statically, every condition on its rule path is satisfied: rev 1 → 2, stamped by the member, a household event the member may edit, only `shift`/`rev`/`updatedAt` changed, and the content is valid. The emulator run is the confirmation.

## Re-run (Windows)

```cmd
npm run test:rules > emulator-normal.txt 2>&1
npm run test:rules:strict > emulator-strict.txt 2>&1
npm run rules:limits -- emulator-normal.txt
npm run rules:limits -- emulator-strict.txt
```

Deploy (only after both pass): `firebase deploy --only firestore:rules`, then `firebase deploy --only hosting`.
