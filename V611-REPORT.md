# HomeHub V6.1.1 — Report

No deployment or data changes. Rules: only `recipes` changed (+ `timerOk` status); 36 other blocks identical.

## Changes

- **Alarm:** due = ringing (persisted) until **Stop alarm** (dashboard + cooking; `completed → dismissed`, idempotent). One coordinator per store repeats a short beep every ~4 s; **Enable sound** if audio is blocked. A closed browser can't ring; the alarm shows on return.
- **Spacing:** root cause = sections in an ungapped `#ck-body`; now a scoped grid.
- **Video:** YouTube keeps the player; other safe https pages = "Open video source" link only (`videoUrl`; no iframe or thumbnail; CSP unchanged).
- **Filters:** search on top; collapsed disclosure (count, Clear); typing keeps focus.
- **⋯ menu:** Edit / Duplicate / Delete, permission-filtered, keyboard, confirm. **Soft delete** (`chef.delete`): hidden, immutable, readable by id.
- **Start cooking;** dashboard widget hidden when no active timers.
- **Harness fix:** the fake SDK's delete allow-list lacked `cookingTimers`, so the timer Delete button failed in browser tests.

## Tests

| Command | Result |
|---|---|
| `npm test` | **347/347** |
| `npm run test:e2e` | **120/120**, incl. measured layout gaps + AR mobile screenshot |
| `npm run test:rules:smoke` | 148, JavaScript-clean |
| `npm run test:rules` / `:strict` | **NOT RUN** (no emulator). Expected 148/148 |
| `rules:limits` | **NOT RUN**. Estimator max 1,026 |

## Blocker

Normal + Strict emulator + `rules:limits` before deployment.
