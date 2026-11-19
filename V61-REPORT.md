# HomeHub V6.1.0 — Report

No deployment or production data changes. The 18 Finance / Savings / Zakat / membership rule blocks are byte-identical to RC1.

## Implemented

- **Cleaning:**
  - one-tap Done / Reopen (notes optional; an audit entry is always written);
  - Advanced keeps an optional "Done + time";
  - **current-room** Complete all / Reset all. Reset = the existing inverse action (reopen / unclaim / resume), so history and recurrence are unchanged. Sequential, one write per task, partial-failure report; re-run = retry.
  - **Rule change:** the reopen note is no longer required (the audit entry still is).
- **Life Savings dashboard tile removed;** navigation, data and permissions unchanged.
- **Recipes** (`chef.*`, no role change):
  - library (search, category, favorites, archived);
  - editor, duplicate (new ids), archive (no delete);
  - integer-thousandth amounts with a drift-free scaler;
  - cooking mode;
  - YouTube with a strict parser, thumbnail → click-to-load `youtube-nocookie` iframe, "Open on YouTube" fallback;
  - CSP `frame-src` limited to YouTube.
- **Timers:** owner-only per Home; derived from `endsAtMs`; only transitions persisted; one shared panel (cooking mode + dashboard); cross-tab completion written once, rung once per tab.
- **Meal Planner:** contract only (`docs/MEAL-PLANNER-CONTRACT.md`).

## Limitations

- No photo uploads (no Storage); thumbnail / placeholder only.
- Embed restrictions are not detectable without the API (the fallback link is always shown).
- Alarms need an open tab; notifications are opt-in.
- Lean Roadmap 62 source unavailable: no reuse.

## Files

- **Added:** `src/modules/chef/` (repository, service, store, page, recipe-model, timer-model, timers-panel, widget), `assets/css/modules/chef.css`, `docs/MEAL-PLANNER-CONTRACT.md`, `tests/unit/chef.test.mjs`.
- **Modified:** `firestore.rules`, `index.html`, `package.json`, `app-config.js`, i18n, `chef/module.js`, `savings/module.js`, 4 cleaning files, 6 test files.

## Tests

| Command | Result |
|---|---|
| `npm test` | **344/344 PASS** |
| `npm run test:e2e` | **120/120 PASS** |
| `npm run test:rules:smoke` | 146 tests, JavaScript-clean |
| `npm run test:rules` / `:strict` | **NOT RUN** (no emulator). Expected 146/146 |
| `npm run rules:limits` | **NOT RUN**. Estimator max 1,026 |

**Tests updated (intended):** reopen without a note, one-tap steps, the Life Savings tile, Recipes enabled.

## Blockers

Run Normal + Strict emulator and `rules:limits` on both logs before deployment approval.
