# HomeHub V5 — Phase 5.4c Report: Custom Cleaning Templates and AI Routine Import

**Version:** 5.8.2 • **Baseline:** v5.8.1. The v5.8.1 ZIP was not re-attached; the delivered v5.8.1 package was used (the only v5.8.1 build): 290/290 unit + static, 112/112 browser, 119 emulator tests.

**Confirmation:**
- no production data was changed, no migration was run, nothing was deployed;
- no `hr_*` data was touched; no AI service is called by the app;
- Phase 5.4d was not started.

The design (schema, permissions, JSON contract, privacy model, idempotency) is in **PHASE-5.4c-DESIGN.md**.

## 1. Implemented

**Templates tab** (Advanced Cleaning):
- **Household custom templates:** create, edit, archive, reactivate, duplicate. No delete.
- Templates are grouped in **packs** and clearly marked **Custom**; built-in suggestions are shown read-only and can be **duplicated as custom**.
- **"When" options** cover exactly what the model and rules support: every N days/months after done, weekly, monthly, after each device use, in season every N days, season start, season end.
  - Condition-based and manual triggers are marked **unsupported** (shown on built-ins), never approximated.
- **Apply pack** (Preview → Confirm Apply): choose a room, device or the whole home. Each item is *create* / *already added (or declined)* / *duplicate title* / *invalid (reason)*, with per-item checkboxes.
  - **Saving a template creates no task.**
  - Applying creates ordinary `cleaningTasks` (id `c_<template>_<target>`, immutable `templateRef`), visible in Basic and Advanced with all existing actions.
  - **Archiving a template never changes tasks already created.**

**AI import tab:**
- The **privacy notice** comes first.
- The **prompt** is built only from ticked room types (room names optional, off by default), device types, minutes per day, problems and the language. It is copied by the user.
- **Paste JSON** or open a local `.json` file (read on the device; ≤ 100 KB), or load the sample.
- The **dry-run preview** shows each item's status and precise reasons, the target room/device (changeable) and a checkbox. **Cancel writes nothing.**
- **Confirm** writes one document per request, with confirmed progress and honest totals. Retry offers only what is still missing; deselected items stay deselected.
- Imported tasks appear in Basic and Advanced; imported templates go into the library and create no tasks.

**Writes everywhere:** deterministic ids, one confirmed write each, saved items never undone; retries and a second member get "already added".

## 2. Schema changes (documented in FIRESTORE-SCHEMA.md)

| Path | Change |
|---|---|
| **`cleaningCustomTemplates/{templateId}`** (new) | `pack`, `title`, `titleEn`, `instructions`, `minutes`, `priority`, `target`, `recurrence`, `trigger`, `active`, `archivedAt`, `archivedBy`, `rev`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt`, `schemaVersion` |
| `cleaningTasks` | + optional immutable `templateRef {templateId, rev}` (id must be `c_<templateId>_<target>`); + optional `estimatedMinutes` on manual tasks (1–600) |

**No migration.** Existing documents are unchanged and valid. **No indexes.** Raw prompts and pasted JSON are **not stored**.

## 3. Security

- **Rules diff** (generated: `npm run rules:compare`, 5.8.1 → 5.8.2):
## Functions
- Added (4): cleanTemplatePath, cleanTemplateRefOk, cleanTemplatedOk, cleanTemplateContentOk
- Removed (0): —
- Changed (1): cleanTaskContentOk

## Match paths
- Added (1): `/databases/{database}/documents/homes/{h}/cleaningCustomTemplates/{templateId}`
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/cleaningTasks/{taskId}`: changed create/update


- **Templates:**
  - `cleaning.edit` for writes, `cleaning.view` for reads;
  - exact keys, bounded text, no `once`, device ⇔ trigger and phase/recurrence consistency;
  - rev exactly +1 (a concurrent edit is refused, not lost);
  - archive and reactivate are separate dispatched transitions; no content edits while archived; **no delete**.
- **Template-derived tasks** have their **own dispatched branch** (fixed shared shape, no dates, no `once`):
  - the template must be active **in this Home**;
  - the deterministic id is verified;
  - `templateRef` is immutable.
- **AI-imported tasks** are ordinary manual tasks validated by the **unchanged** manual rules (titles ≤ 80); only optional `estimatedMinutes` was added. Malformed AI output is rejected **client-side and by the rules**; the rules were not weakened to accept it.
- **Protected rules, verified byte-for-byte against v5.8.1:** all 20 Finance, Savings, Zakat, membership, roles, invites, users, devices, rooms and settings blocks are **identical**. The only other differences are the two enclosing blocks, which contain the new collection.
- **Worst-case cost (exhaustive estimate):**
  - task create **802** (template-derived tasks dispatched separately; the first draft reached 890 and was restructured);
  - template create 509 / update 496.

  Everything is below the 1,100 tripwire. The heaviest rule overall is unchanged (expenses update 969). **The emulator runs remain the authority.**

## 4. Tests

| Suite | Command | Result in the build environment |
|---|---|---|
| Unit + static | `npm test` | **298/298 PASS** (+8) |
| Browser E2E | `npm run test:e2e` | **113/113 PASS** (+ TPL-UI; repeated from the clean unzip) |
| Offline rules-file check (NOT a rules result) | `npm run test:rules:smoke` | No JavaScript-level failures (122 tests) |
| **REAL emulator, Normal** | §6 | **NOT EXECUTED** (no network for the emulator). **Expected 122/122** (119 + T1–T3). |
| **REAL emulator, Strict** | §6 | **NOT EXECUTED. Expected 122/122.** |

**New tests:**

*Unit (8):*
- template validation (every valid / invalid combination; every "When" option round-trips; every generatable built-in duplicates validly);
- revisions; the apply plan (ids, tombstones, duplicates, archived / mismatched / inactive targets, device binding);
- the parser (size, JSON, fences, depth, a real `__proto__` key with **no prototype pollution**, top-level contract, standalone package accepted);
- items (forged fields, URLs, control characters, targets, unsupported triggers, frequency bounds);
- the preview (realistic household, **identical ids across runs**, saved → duplicates, overrides, permissions; FNV-1a reference value);
- prompt privacy;
- store (listener on demand, revision conflict, archive, bulk-create classification).

*Emulator (3):*
- **T1:** templates: viewer / child / once / device without trigger / trigger on a room / length / id / forged author / unknown key / stale rev / immutable author / edit while archived / delete / cross-Home.
- **T2:** template-derived tasks: id mismatch, missing or archived template, viewer, shape, once, applied once, `templateRef` immutable, device-bound, archived device.
- **T3:** AI-imported tasks: idempotent id, minutes bounds, manual title limit unchanged, backward compatibility.

*Browser (TPL-UI):*
- template create (no task) → preview → apply → Basic;
- idempotent re-apply and the second member's "already added";
- archive keeps tasks;
- prompt privacy (no room or member names, no emails);
- invalid JSON; **paste survives a background re-render**; cancel writes nothing;
- **unticked item stays unticked across a re-render and after the import**; safe retry of just that item;
- re-preview shows duplicates; reload persistence; Arabic mobile.

**Defects found by the new tests and fixed:**
- **pasted JSON was lost**, and **unticked preview items were silently re-ticked**, whenever live data re-rendered the screen (the view state is now kept);
- the prompt did not refresh when ticking a type;
- a first draft of the rules put the template branch inside the manual branch (cost 890), which was restructured to dispatch.

## 5. Known limitations

- **Emulator results are pending** your runs.
- **A device-targeted template needs an after-use or season trigger.** Plain periodic device maintenance uses a room- or home-targeted template (HomeHub tasks have no non-trigger device link).
- **Editing a template does not change tasks already created from it.**
- **Imported titles over 80 characters are rejected** for tasks (the manual rule is unchanged); they can be imported as templates (≤ 120).
- **The AI import's type checkboxes show contract codes** (`kitchen`, `airfryer`), the exact values the AI must return.
- **Clipboard copy** may be blocked by some browsers; the prompt is then selected for manual copying.

## 6. Windows CMD commands

```cmd
cd HomeHub-V5
npm test
npm run test:rules > emulator-5.8.2-normal.txt 2>&1
npm run test:rules:strict > emulator-5.8.2-strict.txt 2>&1
npm run rules:limits -- emulator-5.8.2-normal.txt
npm run rules:limits -- emulator-5.8.2-strict.txt
npm run test:e2e
```

**Expected:** 122/122 in each mode, and no expression-limit hit inside a failing test.

## 7. Deployment and rollback (plan only; for later approval)

**Deploy:**
1. Optional Firestore export.
2. `firebase deploy --only firestore:rules` after 122/122 Normal and Strict.
3. `firebase deploy --only hosting`.
4. A short live check: create a template, apply it, confirm it appears in Basic, then import the sample.

**Rollback to v5.8.1:**
- **Template documents** become **unreachable** under the old rules (no match) but remain stored; delete nothing.
- **Template-derived tasks** (`templateRef`) and **AI-imported tasks with `estimatedMinutes`** stay **readable**, but v5.8.1 rules **refuse their updates** (unknown keys). Completing them still works, since completions are separate occurrence documents.
  - **Recommended:** before reverting, archive template-derived tasks while 5.8.2 is deployed (reversible).
- **Never revert rules blindly after new data is written:** older rules cannot edit newer documents.
