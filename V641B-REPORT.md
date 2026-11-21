# HomeHub V6.4.1 — Stage B report: Upcoming, contact activities, Calendar / Bills reminders

**Version:** `6.4.1-b` (development). **Status:** NOT DEPLOYED, NOT MERGED. Production (`expensetracker-d7309`), its rules and its data were not touched.
**Branch:** `v6.4.1-b`.
**Baseline:** `origin/main` at `42c4ef2ad73680700824fa847df0ff2efa008077` (approved Stage A). It was fetched from GitHub and its ancestry checked (`01c12f07` v6.4.0 → `42c4ef2`). Its tree is byte-identical to the Stage A deliverable.
**Commit SHA:** see the delivery message and `V641B-SHA256SUMS.txt` (the report is part of the commit, so it cannot contain its own SHA).

## 1. Summary

| Spec item | Implementation |
|---|---|
| B1 Unified model | `src/core/upcoming/upcoming-model.js` (pure). Calendar events / tasks / contact activities, Finance commitments (next due date only), Cleaning and Maintenance (through the existing Reminders derivation, without prefs or state). Buckets: overdue / today / upcoming. Sorted by bucket → date → time → title. De-duplicated by key |
| Recurrence preserved | Commitments use Finance's own `nextDueDate` / `advance()`. Cleaning / Maintenance use `buildBoard` / `planStatus` / `nextDue`. Nothing re-implemented |
| Permissions / privacy / no leakage | Items come only from the CURRENT Home's scope-bound stores, which keep their rule-compatible queries. Sources are gated by `*.view`. Amounts only with `expenses.viewFinancialTotals`. Other members' private events never arrive. E2E checks the Home switch and sign-out leave no listener on the previous Home |
| Visibility ≠ notification | Upcoming ignores reminder prefs and read / dismissed / snoozed state. E2E: a dismissed or snoozed reminder stays in Upcoming |
| B2 Dashboard panel | `src/ui/upcoming/upcoming-panel.js`, lazy-loaded under the summaries. Rows ≥ 48 px with title, date / time, category, status pill and 🔒 for private items. Each row opens its module (read-once Home-scoped focus). Groups Overdue / Today / Next 7 days; "Show n more" after 6. Loading / error / empty states. EN / AR, light / dark, 320–1280 px. The old Reminders card is **not** restored |
| Contacts (original Stage B) | Optional Calendar fields `kind`, `contactId`, `status`, `reminderMinutes`. Contacts list panel "Upcoming activities" (hidden when there are none). Contact details have an **Activities** section: add (prefilled contact), mark done, open in Calendar. Calendar agenda: status buttons and 👤 back to the contact. No per-contact listener |
| B3 Reminders | New keys `e:{eventId}@{startDate}` and `m:{commitmentId}@{nextDueDate}`, with sourceKind `calendarEvent` / `commitment`. Calendar reminders appear **once due** (start − offset; all-day 09:00 Home time). Bills appear when due within the look-ahead. Read / dismiss / snooze unchanged. New prefs `calendar` / `commitments`. New filters Calendar / Bills. Bell audience = any of the 4 sources |
| No duplicate subscriptions / timers | `upcoming-hub.js`: ONE hub per Home scope and permission set, reference-counted. Store subscriptions, the single 60 s interval and the focus listener exist only while a consumer is subscribed (bell + page + panel share them). It recomputes at Home midnight and when the next reminder moment passes, not every minute |
| Rules | Calendar optional fields validated (`calLinkOk`). Reminder prefix ↔ kind binding for `e:` / `m:`. Prefs accept the old and the new shape. §4 |

## 2. Decisions that differ from `V641B-DESIGN.md` (please review)

1. **Children don't see bills.** The design proposed yes. Bills (in Upcoming and Reminders) are now gated on `expenses.view`, which children don't have. The reason: the finance store would otherwise open the child's personal finance listeners on the dashboard, which is new read cost and not something the Finance widget does today.
2. **Calendar reminders appear only once due**, not ahead of time as "upcoming" items. Showing them early would make `reminderMinutes` meaningless. Upcoming (the panel) still shows the event ahead of time.
3. **No extra `setTimeout`.** The existing 60 s tick recomputes when the next reminder moment passes. Latency is ≤ 60 s, there is exactly one timer, and nothing is left to clear.
4. **Calendar doesn't show contact names.** Reading Contacts from Calendar would add a listener. Calendar shows "Contact activity" and a 👤 button that opens the contact; the event title carries the name.
5. **Overdue look-back is 60 days** for open Calendar tasks and activities, so years-old unfinished imported tasks can't flood the panel.
6. **The Contacts list panel is hidden when empty.** The Activities section in details always shows, with an empty state.
7. **The reminders bell is now also live on Calendar and Finance pages**, where that data is already open.

## 3. Changed files (relative to `42c4ef2`)

| File | Change |
|---|---|
| `src/core/upcoming/upcoming-model.js` | **new**: pure Upcoming and Calendar / Bills reminder derivation, time helpers |
| `src/core/upcoming/upcoming-hub.js` | **new**: reference-counted hub (stores injected; testable) |
| `src/core/upcoming/upcoming-sources.js` | **new**: hub wiring to the existing module stores |
| `src/core/upcoming/access.js` | **new**: dependency-free audience check (shell / dashboard load no stores) |
| `src/ui/upcoming/upcoming-panel.js` | **new**: Dashboard panel |
| `src/modules/calendar/calendar-focus.js`, `src/modules/expenses/finance-focus.js` | **new**: read-once navigation intents |
| `src/modules/calendar/calendar-model.js` | optional fields, helpers; CSV revive uses the V6.2.1 field set |
| `src/modules/calendar/calendar-store.js` | `setStatus`; edit keeps the contact link |
| `src/modules/calendar/calendar-ui.js` | reminder select, activity form (contact, status), agenda status / contact actions |
| `src/modules/calendar/page.js`, `widget.js` | focus intent; open-contact callback |
| `src/modules/contacts/contacts-nav.js` | contacts focus intent |
| `src/modules/contacts/page.js` | list panel, Activities section, focus consumption |
| `src/modules/expenses/page.js` | Bills tab via focus intent |
| `src/core/reminders/reminders-model.js`, `-store.js`, `-service.js` | Calendar / Bills sources, prefs, keys; the feed now built on the hub |
| `src/ui/pages/reminders-page.js` | filters, labels, navigation, settings toggles |
| `src/ui/pages/dashboard-page.js`, `src/ui/shell/app-shell.js`, `src/main.js` | panel slot; bell / Tools audience; bell live on Calendar / Finance |
| `firestore.rules` | §4 |
| `assets/css/components.css`, `assets/css/modules/contacts.css` | Upcoming rows, activities |
| `src/core/i18n/locales/en.js`, `ar.js` | 52 keys each |
| `package.json`, `package-lock.json` (version lines), `src/config/app-config.js`, `sw.js` | `6.4.1-b` |
| `tests/unit/v641-b.test.mjs` | **new**: 16 tests |
| `tests/rules/rules.test.mjs` | `V641B-1`, `V641B-2` (emulator) |
| `tests/e2e/run-e2e.mjs` | 3 new V641-B checks; Stage A 44 px check tolerates sub-pixel rounding (43.99 px) |
| `tests/e2e/fake-sdk/*` | fake mirrors the rules for Calendar queries (`calendar.view`, previously checked as `expenses.view`); `failOn()` fault injection for error states |
| `tests/static/static.test.mjs`, `tests/unit/reminders.test.mjs` | two **contract updates** (bell routes now include Calendar / Finance; the prefs document gains the two toggles). Both stay exact-match; nothing was loosened |
| `CHANGELOG.md`, `FIRESTORE-SCHEMA.md`, `SECURITY.md`, this report | docs |

## 4. Rules delta and cost

```
calendarEvents create: keys hasAll(V6.2 set) && hasOnly(V6.2 set + kind, contactId, status, reminderMinutes)
calendarEvents update: changed().hasOnly(... + kind, contactId, status, reminderMinutes)
calContentOk(d) && calLinkOk(d):
  reminderMinutes ∈ {null, 0, 15, 60, 1440}
  kind == null → contactId == null && status == null
  kind == 'contactActivity' → contactId matches ^[A-Za-z0-9_-]{6,40}$ && status ∈ {planned, done, cancelled}
reminderStates: key ^[cpfem]:… ; e: ↔ calendarEvent, m: ↔ commitment (c/p/f unchanged)
reminderPrefs: hasAll(old keys) && hasOnly(old keys + calendar, commitments); toggles bool when present
```

| Rule | Stage A | Stage B |
|---|---|---|
| calendarEvents create | 617 | **691** |
| calendarEvents update | 507 | **554** |
| highest rule (contacts create) | 1053 | 1053 |
| rules above 1100 | 0 | **0** |

## 5. Test results (run in this workspace)

| Suite | Result |
|---|---|
| `npm test` (unit + static) | **481 / 481** (Stage A 465 + 16 new) |
| `npm run test:rules:smoke` | **173 / 174**. The single failure is the known L14 emulator-only case (+2 new tests) |
| `npm run rules:cost` | max 1053, 0 above 1100 |
| `npm run test:e2e` (Playwright, fake SDK, Chromium) | **137 / 137** (134 + 3 new) |
| Firestore emulator (`npm run test:rules`, incl. V641B-1/2) | **NOT RUN**: firebase-tools / Java unavailable, no network here. CI must run it |
| Isolated test-project deployment | **NOT DONE**: no firebase-tools or credentials here. No test URL |
| Real Android device | **NOT RUN** |

**Coverage of the B4 list:**
1. Calendar + Finance integration: unit B-upcoming *, E2E Dashboard / Reminders.
2. Permissions and private events: unit hub permissions, rules V641B-1/2, E2E (other member's private event, viewer read-only, child without bills).
3. Recurring commitments: unit B-upcoming finance (next due only, anchor-day clamp, new key after payment).
4. Overdue / upcoming dates: unit buckets, horizon, multi-day, 00:00-ending events, look-back.
5. Time zones and midnight: unit B-tz (Cairo, UTC+14, UTC−11) and the hub clock rollover. E2E runs in a Home zone where it is ~12:00.
6. Dismiss / snooze: unit B-rem feed / store, E2E Reminders (stored per user with their own kind).
7. Home switch / cleanup: unit hub reference counting and dispose, E2E listener counts after the Home change and logout.
8. Arabic / English: E2E RTL + dark, unit i18n (dynamic keys in both locales).
9. Existing Cleaning / Maintenance reminders: all pre-existing reminder unit and E2E tests unchanged and passing.
10. Rules + cost: V641B-1/2 (emulator, not run here), smoke, cost table.

**Bugs found by the new tests and fixed:** a hub created before its first consumer started with a stale date and clock (could miss a reminder or midnight); `null` passed to `replaceChildren`; a rules helper written in a form the static parser rejects; a test-fake inaccuracy (Calendar queries were checked against `expenses.view`).

## 6. Known limitations and risks

- **Emulator, test-project deployment and Android are pending** (§5).
- The bell on Cleaning / Maintenance / Calendar / Finance pages now opens the Calendar and Finance stores if the user has those permissions and they aren't open yet. That is extra reads on the first visit only (stores are Home-scoped and shared). The dashboard already opens them through its widgets.
- The Calendar store is still unbounded: it listens to all events (pre-existing). Stage B adds no listener but derives over all of them.
- Reminders are in-app only, while the app is open. No push or OS notifications, by design.
- Reminder timing has ≤ 60 s latency (single tick).
- A Calendar activity whose contact was deleted stays in Calendar. Contacts shows "Contact removed" for it, and the event is never rewritten.
- In the panel, bills are labelled "Bill"; their Finance category isn't shown.

## 7. Rollback

Nothing is deployed. If Stage B is ever deployed and then rolled back to Stage A:
- Stage A rules refuse **new** events that carry the Stage B fields, and refuse `e:` / `m:` reminder states and the new prefs keys.
- Existing Stage B events stay readable and editable: the Stage A update rule only limits *changed* keys (`changed().hasOnly`) and its content check does not look at the new keys, so an edit that leaves them alone passes. Changing a status or reminder would be refused. Confirm in the emulator before relying on it.
- Stored `e:` / `m:` reminder states are ignored by the Stage A client and age out through the existing cleanup.

## 8. Termux commands (deploys nothing)

```bash
cd ~/HomeHub-V5 && git fetch origin
git checkout v6.4.1-b            # after the branch is on GitHub (or: git fetch ~/storage/downloads/V641B.bundle v6.4.1-b:v6.4.1-b)
npm ci && npm test               # 481/481
npm run test:rules:smoke         # 173/174 (L14 expected)
npm run rules:cost               # max 1053
# emulator + test project, when available (NOT production):
# npm run test:rules
# firebase deploy --only firestore:rules,hosting --project <isolated-test-project-id>
```
