# HomeHub V5 — Phase 5.3.2 Hotfix: "Add selected cleaning tasks" fails in production

**Version:** 5.7.2 (hotfix on 5.7.1) • **NOT DEPLOYED.** Deploy only after your normal and strict emulator runs pass **109/109**.

## Symptom (production)
Pressing **Add selected tasks** makes tasks start to appear. The process then stops with «قام شخص آخر بإعداد هذه للتو…» ("someone else just set these up"), although nobody else did.

## Root cause (confirmed in the shipped 5.7.1 source)

1. **The whole setup was ONE batched write.**
   - `applySetup()` committed up to 200 creates per batch, so a realistic household's setup (**97 tasks** for 10 rooms + 7 devices) was a single request.
   - Firestore evaluates its security-rule limits **per request, over the whole batch**: at most 20 document reads, plus the expression budget. Each generated create reads the caller's membership, the role, and its room or device.
   - So the batch was rejected **as a whole**: one rejected create rejects all of them.

2. **The visible tasks were optimistic, never saved.**
   - The Firebase SDK shows a batch's documents in live listeners immediately (latency compensation), before the server answers.
   - When the server rejected the batch, the SDK **rolled them all back**.
   - So "tasks start to appear, then it stops" was optimistic UI. Nothing was stored, and nothing partial was left behind.

3. **The error was mislabelled.** `applySetup()` turned **every** permission denial into `setupConflict` ("someone else set this up"), hiding the real cause.

4. **A latent payload defect (English UI).** The stove template title "Visual check of external parts — technical servicing by a qualified technician only" is **83 characters**, over the 80-character title rule, so it alone would reject an English setup. All Arabic payloads were valid (longest 61), so this was not your failure, but it is fixed too.

**Why 106/106 emulator tests and the browser tests passed:**
- Emulator tests G1–G5 created **one hand-written task per request**. They never used the real payload builder or a multi-task batch.
- The browser tests use a Firebase stand-in that neither evaluates rules nor shows optimistic writes.

**Ruled out (verified):**
- the device `active` field (real device documents have it);
- title characters (`isName` has no character restrictions);
- every Arabic payload field, key, id pattern and room link against `cleanGeneratedOk`.

**What remains for your emulator:** the exact limit message (document reads vs expression budget) for the old single batch. Run `npm run diagnose:setup` (included) to see it verbatim. The fix does not depend on which limit it is: every write is now a single small request (≤ 6 document reads, well under the limits).

## Fix

| Requirement | Implementation |
|---|---|
| No batch-limit failures | **One task per write** (deterministic id). A pool of 4 keeps it fast; each request reads ≤ 6 documents. |
| Progress = confirmed saves | Progress ("Saving… X of N saved") increments only after a write **resolves**, i.e. after the server accepted it. |
| A failure never removes saved tasks | Each task is independent. Saved tasks are never undone; the remaining tasks continue. |
| Honest partial result | Returns total / saved / already added / failed (with task and reason: `denied`, `invalid`, `network`) / not attempted. Shown in a notice that stays until the next complete setup. |
| Real conflicts vs errors | A rejected create is classified by a **server read**: exists → "already added (possibly by someone else)"; absent → a genuine failure. A network error stops new attempts and reports what was not attempted. |
| Retry never duplicates | Deterministic ids + create-only rules; the review is recomputed from the live task list and offers only what is missing. |
| Review refreshes accurately | After completion or failure the page re-renders from the confirmed task list; the banner shows exactly the remaining count. |
| Invalid payloads never sent | `generatedPayloadProblems()` mirrors `cleanGeneratedOk` and is checked before any write. |
| Long library titles | Rules: generated titles ≤ **120** (create and later edits); manual titles stay ≤ 80. The client uses the same limits. |
| Misleading message | `setupConflict` removed entirely. |

**Data safety:** existing tasks, declined tombstones, occurrences, the audit history, rooms, devices and all finance, savings and Zakat data are untouched. Nothing is written without your review.

## Rules change (2 lines)
- **`cleanGeneratedOk`:** `isName(d.title, 80)` → `isName(d.title, 120)`.
- **`cleanTaskContentOk`:** `isName(d.title, d.get('source', null) == null ? 80 : 120)`.

No `allow` statement, path or permission changed. Worst-case cost: task create 644 (was 636), update 685 (was 677).

## Tests

| Suite | Result in the build environment |
|---|---|
| `npm test` | **272/272** (+7 hotfix regressions, using a Firestore-like fake: one write per task even with a 1-operation request limit; confirmed-only, monotonic progress; a failure keeps the saved tasks; "already added" classification; network stop + retry without duplicates; invalid payloads never sent) |
| Browser E2E | **110/110** (+ **H-UI**, your exact screen: optimistic writes with rollback, a per-request limit and one rejected task → "Saved 21 of 22 … 1 could not be saved"; saved tasks never disappear; the review offers only the missing one; the retry adds exactly 1, no duplicates) |
| Real emulator | **109 tests** (+**H1–H3**: the REAL builder on a realistic household, Arabic and English, every task accepted one per write; titles ≤ 120 generated / ≤ 80 manual; long-title edits). **UNVERIFIED** here. |
| Offline rules-file check | No JavaScript-level failures |
