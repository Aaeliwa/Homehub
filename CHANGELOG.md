# Changelog

## 6.4.0-b — V6.4 Batch B: Shared Contacts, Revision 2 (November 2026) — NOT DEPLOYED, awaiting review

- New **Contacts** module (mobile dock, desktop rail and Tools): one shared directory per Home.
- Add, edit and search contacts, in Arabic or English, by name, organization, category or number in any format.
- Each contact can have several categories and up to 10 labelled numbers (custom labels too).
- Favourites are shared by the household.
- **Call** opens the phone's dialer with a `tel:` link. **WhatsApp** opens `wa.me`; a national number asks for the country code and it is never guessed.
- **Import `.vcf`** (vCard 2.1 / 3.0 / 4.0, including quoted-printable, legacy charsets, folding and `tel:` URIs) opens a preview first.
  - Each row shows its status: new, duplicate, possible or ambiguous duplicate, repeated in file, or invalid.
  - Skip is the default for any duplicate. Merge fills empty fields and adds numbers, and never overwrites. Keep separate is also available.
  - Partial failures can be retried without duplicates. A merge into a contact that changed since the preview asks you to review it again.
- **Export `.vcf`** (vCard 3.0, UTF-8, CRLF, folded) for one contact, a category, favourites or all, after a personal-information warning.
- Delete is a soft delete, with a "Recently deleted" list and restore. There are 10 suggested categories, plus custom ones.
- Permissions: role template **v9** (additive). Export, import and delete are separate rights from viewing.
- New Firestore rules for `contacts` and `contactCategories`, which are strict, revisioned and isolated by household. No other rules, collections or data change. Batch A behaviour is unchanged.

- **Revision 2 (independent review):**
  - Soft-deleted contacts are readable only by holders of `contacts.delete`, for direct reads and queries alike.
  - Imports never create copies, restore deleted contacts or overwrite edited ones on their own:
    - an existing import result is verified and reported as already imported, kept, deleted or hidden;
    - records imported before show as "imported before";
    - copies are made only for an explicit Keep separate or Add as separate.
  - A retry after a lost response is recognised and adds nothing.
  - Capacity is always shown. A directory over 1,000 contacts is flagged as incomplete: search and export say so, and importing is paused. The Recently deleted list says when older deleted contacts are not shown.

## 6.4.0-a — V6.4 Batch A: existing application corrections (November 2026) — NOT DEPLOYED, awaiting review

- Cleaning: Today's routine no longer shows repeated "This task is no longer active" rows after a reset, restore or archive. Obsolete plan entries are excluded and counted once, and history is kept.
- Cleaning statistics: by member and by room are shown as wrapped, ranked rows.
- Family page spacing fixed; the stale "Inviting family members arrives in a later update" note was removed from Settings.
- Calendar: a compact settings gear replaces the settings button, and the Imported tag no longer overlaps the Remove button.
- Life Savings: price tags no longer overlap prices or buttons.
- Dashboard: the Finance tile shows the remaining monthly budget with a usage bar and percentage.
- Dashboard: Rooms and Devices tiles became active counts in the Your Home card.
- Dashboard: the Reminders tile was removed; Reminders now has a Tools entry, and the bell, page and notifications are unchanged.
- Mobile dock: one horizontally scrollable row (no "More" menu), with an auto-visible active item, keyboard support, RTL and safe areas.
- Review corrections: the routine counter, bar and empty state are now computed over exactly the shown items (plan + extras), and "settled" replaces "0 of 0".
- Review corrections: `firebase.json` hosting excludes docs, tools, reports, archives, logs, lockfiles, credentials and dot-folders, with a new static allowlist test.
- No rules, schema or data changes. `.gitignore` and `.github/` are not shipped (the repository versions stay authoritative).

## 5.9.1 — Phase 5.6: Smart Reminders (October 2026) — NOT DEPLOYED

- **In-app Reminders center `#/reminders`**, with a top-bar bell (live count only on Dashboard / Reminders / Cleaning / Maintenance) and a dashboard card:
  - cleaning and maintenance work derived from the modules' own due logic (no copies, no source changes);
  - open faults shown without fabricated dates;
  - read / snooze / dismiss / restore stored per user (owner-only); look-ahead, type toggles and quiet hours;
  - deep links highlight the task / plan / fault.
- **Background / push notifications: not implemented** (no infrastructure; a separate approval is needed).
- **Rules:** 2 owner-only paths. All 30 protected blocks (Finance, Savings, Zakat, membership, Devices, Rooms, Cleaning, Maintenance, …) are byte-identical.
- **Data layer:** `atomicWrite` delete, restricted to reminder state by a static test.

## 5.9.0 — Phase 5.5: Device Maintenance Management (October 2026) — NOT DEPLOYED

- **New Maintenance module** (`#/m/maintenance`):
  - preventive plans (once / every N days, weeks, months after done);
  - idempotent completions with service history and costs (per currency; never posted to Finance);
  - fault reports with an audited open → in progress → resolved → closed lifecycle;
  - corrections as new records; dashboard card.
- **Device Details → Maintenance is live:** plans, open faults, recent service, add / report / view, professional-only suggestions.
- **No "coming later" placeholders remain** (Device and Room Details).
- **Rules:** 4 new append-only / revision-checked collections. All 26 protected blocks (Finance, Savings, Zakat, membership, Devices, Rooms, Cleaning, …) are byte-identical.
- **Fixed:** per-field form errors were dropped by `AppError`.

## 5.8.3 — Phase 5.4d: Device–Cleaning integration (P0) (October 2026) — NOT DEPLOYED

- **Device Details → Cleaning is live:**
  - linked tasks with status;
  - view, filtered by the device;
  - add with the device preselected;
  - category suggestions with safety caveats.
- **Maintenance** stays a truthful "coming later" notice; Room Details no longer claims Cleaning is coming.
- **Optional Device / الجهاز selector** in New/Edit (shared form for Basic and Advanced):
  - a plain `deviceId` link for ordinary tasks;
  - the room can follow the device;
  - trigger tasks are shown read-only (fixes their broken edit).
- **Advanced:** New task, Edit, Add cleaning task per device. **Basic:** device filter.
- **Templates / AI:** periodic device templates and items become device links (household devices only).
- **Rules:** `cleaningTasks.deviceId` validation (active device of this Home on create / change). Finance, Savings, Zakat and Devices rules are unchanged.

## 5.8.2 — Phase 5.4c: Custom templates and AI routine import (October 2026) — NOT DEPLOYED

- **Advanced → Templates:**
  - household custom templates (create, edit, archive, reactivate, duplicate; no delete), grouped in packs;
  - built-ins read-only, with "duplicate as custom";
  - Preview → Confirm Apply to a room, device or the whole home (deterministic `c_<template>_<target>`; one confirmed write each).
- **Advanced → AI import:**
  - a privacy-first copy-prompt builder (only ticked context; no AI call);
  - paste or open JSON (contract v1; strict, safe parser);
  - dry-run preview with reasons; confirm with idempotent `ai_<hash>` ids; safe retry.
- **Rules:** `cleaningCustomTemplates`; template-derived task branch; optional `estimatedMinutes` on manual tasks. Finance, Savings and Zakat are unchanged.
- **Fixed during the phase:** pasted JSON and preview deselections were lost or re-ticked on re-render.

## 5.8.1 — Phase 5.4b: Device usage and seasonal cleaning (October 2026) — NOT DEPLOYED

- **Advanced → Devices tab:**
  - log uses (idempotent, confirmed), with recent uses and corrections (void);
  - season start/end, with season history;
  - add after-use tasks.
- **After-use tasks:** due on use; uses coalesce until done (`<task>_u<event>`).
- **Seasons:** in-season tasks only while active; start/end checklists per transition (`<task>_s<rev>`); off-season by default.
- **Suggested templates:** 66/70 device templates are now generatable (usage + AC seasonal), with their original keys.
- **Rules:** `cleaningDeviceEvents`, `cleaningDeviceState`, `cleaningDeviceSeasons`; task `trigger`; occurrence trigger ids. Finance, Savings and Zakat are unchanged.
- **Fixed:** the setup review crashed for suggestions without a frequency.

## 5.8.0 — Phase 5.4a: Advanced Cleaning (October 2026) — NOT DEPLOYED

- **New screen `#/m/cleaning/advanced`**, sharing one data model with Basic:
  - daily routine saved once per day (create-only), with live statuses;
  - skip / postpone / resume (audited, never completion; completion basis unchanged);
  - actual minutes; statistics from the audit log; quick routine; whole-room Done all (confirmed per task); settings (catch-up, day start).
- **Reset and delete:** disabled.
- **Rules:** occurrence and log extensions (backward compatible), plus `cleaningRoutines` and `cleaningSettings`. See PHASE-5.4a-REPORT.md.

## 5.7.2 — Phase 5.3.2 hotfix: cleaning setup "someone else set this up" (October 2026) — NOT DEPLOYED

- **Root cause:**
  - the whole setup was one batched write (97 tasks for a typical home), rejected as a whole by Firestore's per-request rule limits;
  - the visible tasks were the SDK's optimistic copies, rolled back on rejection;
  - every denial was mislabelled as a concurrent setup.
- **Fix:**
  - one task per write (confirmed saves only);
  - honest partial results (saved / already added / failed with reason / not attempted);
  - saved tasks are never undone;
  - retry adds only what is missing;
  - payloads are pre-checked against the rules;
  - generated titles may be ≤ 120 (the 83-char stove title).
- **Added:** `npm run diagnose:setup` (emulator diagnostic); regression tests in unit (7), browser (H-UI) and emulator (H1–H3).

## 5.7.1 — Phase 5.3.1: Cleaning widget & Rooms/Devices integration (October 2026) — NOT APPROVED FOR DEPLOYMENT until the real emulator passes

- **Dashboard:** the Cleaning card now uses the shared `summary-card` component; its classes previously had no CSS.
- **Template libraries** extracted verbatim from the standalone app (homeCleaning.html):
  - 6 room types / 35 tasks;
  - 7 device types / 70 tasks (38 generated now; seasonal and usage-triggered tasks deferred with keys kept).
- **Existing rooms/devices recognised**, with a one-tap review showing tasks and frequencies:
  - deterministic ids make setup duplicate-free and idempotent;
  - declined tasks become archived tombstones and are never recreated;
  - same-title tasks count as covered;
  - first dates are staggered as in the standalone app.
- **Last-completion scheduling** (`'after'`) for template tasks; manual tasks keep fixed-calendar scheduling.
- **Lifecycle:** an archived room/device hides its tasks; restore shows them; renames are live; device tasks follow the device's room.
- **Rules:** `cleaningTasks` create/update dispatch (generated vs manual) and the `'after'` recurrence shape. See PHASE-5.3.1-SECURITY-IMPACT.md.

## 5.7.0 — Phase 5.3: Home Routine & Cleaning + Edit Active Budget (October 2026) — NOT APPROVED FOR DEPLOYMENT until the real emulator passes

- **Edit active budget** (amount only, audited):
  - before/after preview and below-spent warning;
  - atomic cycle update + append-only `budgetAdjustments` with revision checks (stale and concurrent edits refused);
  - no wallet, expense or balance change;
  - the old unused amount / date / duration path is removed (narrowing).
- **Home Routine & Cleaning:**
  - tasks with rooms, priority, assignment (named or shared), and recurrence (once, every N days, weekdays every N weeks, monthly with last-day clamp);
  - Today / My tasks / Shared available / Upcoming / Overdue / Done / Manage;
  - claim (first wins), complete, release, reopen with reason, and audit history;
  - children only on tasks that list them; guardian corrections; dashboard card.
- **Mobile dock:** "More" when there are more than 4 destinations (Rooms and Devices had dropped off).
- **Fixes:**
  - interval 0 silently became daily;
  - recurrence ranges were silently truncated;
  - a "former member" label flashed while names loaded;
  - a widget could render "null";
  - a stale note showed on reopened tasks.
- **Rules:** +4 collections (`budgetAdjustments`, `cleaningTasks`, `cleaningOccurrences`, `cleaningLog`); `spendingCycles` update rewritten as a 3-way dispatch. See PHASE-5.3-SECURITY-IMPACT.md.

## 5.6.1 — Phase 5.2.1: rule-evaluation repair (October 2026) — DO NOT DEPLOY until normal + strict emulator runs pass

- **Root cause:** denied requests evaluate every alternative of `A || B || C` and every helper in full. Reordering could not help, so multi-path rules now **dispatch** with ternaries (branch texts reused verbatim; overlapping paths kept together). Rules changed: `zakatRecords` create, `walletMovements` create/update, `members` create/update, `expenses` create/update, `commitments` update, `savingsAssets` and `wallets` create/update, `devices` update.
- **Cheaper helpers with the same truth table:** `can()` builds the role path once, `grants()` uses `hasAny`, the Zakat permission is checked once, and wallets / calculations are bound once.
- **Worst-case estimate examples:**
  - `zakatRecords` create 957 → 557;
  - `walletMovements` create 1,618 → 709;
  - `members` create 882 → 376 and update 1,348 → 847;
  - `devices` update 808 → 478.
- **New:** `npm run rules:cost` (exhaustive cost estimator), `npm run test:rules:strict` (whole suite with `STRICT_DENIALS=1`), and cost tripwires in `npm test`.
- **No protection changed:** privacy reads, Zakat sharing/revocation, legacy adoption (L1–L20), roles, guardians, cross-Home isolation. See PHASE-5.2.1-SECURITY-IMPACT.md.

## 5.6.0 — Phase 5.2: Life Savings & Zakat completion (October 2026) — NO-GO until the emulator confirms

- **Zakat ledger:** estimate vs linked payments vs outstanding per saved Hawl calculation; unlinked payments listed separately.
- **Payments for a completed Hawl** link to its calculation (created in the same batch if missing); advance payments are labelled.
- **Explicit Zakat sharing / revocation** (private by default; guardians always remain); read-only view for sharees (saved records only).
- **Rules (zakatRecords only):**
  - readers-only update by the owner or a guardian;
  - `snapshotId` must reference the same owner's calculation.
- **Tests:** `assertDenied` / `STRICT_DENIALS` (denials must not come from the 1000-expression limit); emulator Z1–Z8; unit ledger/store; E2E Z-UI.

## 5.5.4 — Phase 5.1.3: final rules repair (October 2026) — NOT APPROVED FOR DEPLOYMENT

- **Fixed (rules):** `canReadFinance` / `canReadSavings` no longer require `readers is list`, which a query cannot prove. Members' own private finance and savings queries were denied (real emulator, L900).
- **Fixed (test fixture):** the "expired invitation" setup created an already-expired invite (correctly refused), aborting the test before its remaining subcases. It now creates a valid invite, then expires it; all subcases run.
- **Expression headroom:** adoption roles prove membership in the batch (`isLegacyAdoptionCompanion`) instead of five full re-proofs.
- **New tools:** `npm run rules:limits` maps 1000-expression hits in an emulator log to rule + test.
- **New tests:** "mine" queries across 8 collections; an expired-invite control; static guards.
- **Real emulator result: UNVERIFIED.** Production comparison: PENDING (file not received).

## 5.5.3 — Phase 5.1.2: emulator-driven rules & test repair (October 2026)

- **Fixed (rules, production-relevant):** privacy reads are query-safe. `canReadFinance`, `canReadSavings` and the wallet / savings-asset reads now use `.get('audience' | 'visibility', '')`. Previously the "mine" (`readers`) query was denied with "Property audience is undefined".
- **Headroom (1000-expression limit):** cheap discriminators first in `members` create/update and `devices` update (conjunct reordering only; nothing widened).
- **Fixed (rules tests):** `context.firestore()` called twice per callback; values read from `withSecurityRulesDisabled()` (which resolves to undefined).
- **New:** `npm run rules:compare` (structural rules diff); a more faithful offline stand-in; static guards for these pitfalls.
- **Production comparison pending:** the production rules file was not received. See PHASE-5.1.2-RULES-REPORT.md.

## 5.5.2 — Phase 5.1.1: rules & rules-test repair (October 2026)

- **Fixed (production rules):** list addition with `+`, which the rules engine does not support, in `access2`, wallet create/update and savings-asset create/update. It denied every legitimate personal wallet (incl. child allowance), private transfer and personal savings write. Now `.concat()`, with identical semantics.
- **Fixed (rules tests):** the missing `assert` import; write batches mixing Firestore instances (`db()` now returns one instance per account).
- **Expression-limit headroom:** `can`, wallet access, savings-event create and invitation join now evaluate each document once (bound parameters; conditions unchanged).
- **New:** `npm run test:rules:smoke`, an offline JavaScript check of the rules test file (does not evaluate rules); static guards against list `+` and for bound-once hot paths.
- **Emulator rerun required** (not runnable in the build environment). See PHASE-5.1.1-CHANGE-REPORT.md.

## 5.5.1 — Phase 5.1: Legacy Home adoption (October 2026)

- **New:** one-time, atomic adoption of the creator's own pre-membership Home. It creates the creator's Owner membership plus the missing v6 system roles; same Home, same `defaultHomeId`; no business data touched.
- **New context results:** `LEGACY_HOME_ADOPTION_REQUIRED` (upgrade screen, EN/AR, "Upgrade Home" / «ترقية المنزل») and `LEGACY_HOME_ADOPTION_BLOCKED` (unsafe partial state; nothing written). Everything else still ends in the unchanged `MEMBERSHIP_MISSING`.
- **Rules:**
  - narrow creator-only per-doc reads while not a member;
  - adoption paths for member create and role create;
  - `isBootstrap` unchanged.
- **Older Home docs** missing currency, time zone or language get in-memory defaults (never written).
- **Fixes during the build:**
  - an ERROR → ERROR transition would have hidden adoption failures (it now goes via RESOLVING_CONTEXT);
  - the adoption service is now pure (Firebase injected);
  - the upgrade screen's list is RTL-correct and styled as informational.

## 5.5.0 — Phase 5: Life Savings & Zakat (October 2026)

- **New module "Life Savings / مدخراتي":**
  - Asset types: cash, bank, gold, silver, foreign currency, investment, other.
  - Personal or household ownership; private / shared / household privacy enforced by rules.
  - Append-only event ledger; transfers with linked legs (including cash → gold); wallet ↔ savings integration with Finance.
  - Manual audited prices with a replaceable provider interface (unconfigured by default).
  - Freshness labels; archive.
- **Zakat al-Mal assistant:**
  - Configurable Nisab (gold 85 g 21K default / silver 595 g / manual) and rate (2.5% default).
  - Hijri (Umm al-Qura) or Gregorian Hawl, reconstructed from history, with a reset / continue below-Nisab policy.
  - Per-owner calculation with explicit household allocations; children separate.
  - Transparent breakdown and exclusions.
  - Append-only settings history, snapshots and payments; optional single linked Finance expense.
- **Permissions:** `savings.*`; role template **v6** (non-destructive).
- **Finance (minimal, additive):** expense category `zakat`; wallet-movement type `savings` (must pair with its savings event). No other Finance, Family, Rooms or Devices rule changed.
- **Dashboard:** a Life Savings card showing only the member's visible wealth.
- **Fixed during the build:**
  - Opening-balance event rule used `exists` instead of `existsAfter`.
  - Manual-Nisab parsing used floats.
  - A tautological unit test.
  - The Arabic dark-mode Zakat screenshot step re-opens the tab after a theme change.
  - An E2E theme-toggle loop that could hang on a race is now bounded (`ensureTheme`).

## 5.4.0 — Phase 4A: Finance + Family & Members (2026-10-05)

- **Accounts:** "Create account" on the login screen (each person has their own Firebase Auth identity; still one auth lifecycle).
- **Invitations** (`invites/{code}`): secure 24-symbol codes, 1–14 day expiry, copy link/code, pending list with cancel. Acceptance is single-use, atomic, and bound to the caller. Works for new and existing users; invite links survive sign-in.
- **Family & Members page:**
  - members with role, relationship, status and join date;
  - change role, suspend/reactivate, remove, leave;
  - guardians for children;
  - an honest empty state;
  - a Settings card.
- **Child accounts** and an explicit guardian model (`guardianUids`).
- **Removal keeps history and attribution**; private wallets never move to the owner.
- **Finance:** "Added by / Paid by" from a shared member directory, Added-by and Paid-by filters, imported history labelled honestly, guardians pre-selected for allowance wallets.
- **Permissions:** `members.manageChildren`; `ROLE_TEMPLATE_VERSION` 4 → 5 (non-destructive).
- **Rules:** new `invites` block. Membership rules extended (join / remove / guardians / leave / re-join) with one tightening. Rooms and Devices rules unchanged. One Finance rule **tightened**: a child cannot re-share, edit or archive an allowance wallet created by a guardian.
- **Hardening:** the invite-code generator fails loudly if the random source is unusable instead of looping.
- **Fixes found by testing:**
  - Quick add had no default wallet for a child, so a child's expense was silently not recorded. It now defaults to the member's own personal wallet.
  - A child could un-share a guardian-created allowance wallet (rules + UI fixed).
  - Family/Join pages were statically imported from `main.js`, breaking the offline "can't connect" screen. They are now lazy, and a static guard test was added.
  - "Child Child" duplicate badge removed.
  - Arabic digits in the Family summary.

## 5.3.0 — Phase 4: Finance (2026-10-05)

- **Finance module** (`/m/expenses`): Overview, History, 10-day budget, Fixed & recurring, Wallets; Home / Mine scope.
- **Expenses:**
  - integer minor-unit money and `YYYY-MM-DD` dates;
  - newest-first grouped history with search and filters;
  - Quick add plus a full form; creator and payer recorded separately;
  - void/un-void instead of delete.
- **Wallets:**
  - household and personal (private / shared with ≤5 members / child allowance);
  - **privacy enforced by Firestore rules** via `audience` + `readers` labels; the owner has no implicit access to private adult wallets;
  - computed balances.
- **Movements:** funding, transfer and adjustment, never counted as spending. Same-currency only.
- **10-day budgets:**
  - any start date or length, funded by transfer;
  - remaining, safe/day and pace;
  - cash reconciliation via adjustment;
  - close with carry / return / keep.
- **Commitments:** generic recurrence (day/week/month/year × 1–36) with an anchor day; annual subscriptions; upcoming list; monthly-reserve hint. Mark paid = one deterministic expense + advance in one batch.
- **CSV history import** (owner): mapping, preview with exact total, idempotent ids, original columns preserved.
- Dashboard Finance card (totals only with `viewFinancialTotals`).
- Permissions: `expenses.*` finalised (11 permissions); `ROLE_TEMPLATE_VERSION` 3 → 4 (non-destructive upgrade).
- Core: `watchWhere()` single-constraint listener; SDK wrapper exports `query`/`where`.
- Rules: helpers + 5 finance blocks. **No existing rule changed.**
- Tests: npm test 132 → 166, browser E2E 55 → 70, emulator suite 44 → 55 (written; to be run).

## 5.2.0 — Phase 3: Devices & household assets (2026-10-05)

- **Devices module**, a Home-level entity at `homes/{homeId}/devices/{deviceId}`:
  - 19 categories / 67 subtypes, 4 statuses, 29 icons;
  - optional brand, model, serial, purchase and installation dates, price + currency, warranty end, notes;
  - date-only values stored as `YYYY-MM-DD`.
- Room assignment or Unassigned; move between rooms (only `roomId` changes).
- **Archived rooms**: devices keep their `roomId`, show "(Archived)", and stay editable; new assignments to archived rooms are blocked (client + rules).
- Soft archive / Archived view / restore; no hard delete.
- Client-side search (name, brand, model, serial), filters (room incl. Unassigned and archived rooms, category, status, active/archived), sort (name, room, category, status).
- Progressive-disclosure add/edit form; quick templates (prefill only); detail view with honest Cleaning/Maintenance placeholders.
- Dashboard Devices card (active + needs attention + archived). Room detail shows its device count via the Devices interface.
- One devices listener + the shared rooms listener per Home; both disposed with the context scope.
- Permissions: owner all; admin view/create/edit/delete/restore; member/viewer/child view. `ROLE_TEMPLATE_VERSION` 2 → 3.
- **Update default roles is now non-destructive**: it re-templates only namespaces changed since the role's version (v2: rooms, v3: devices) and preserves every other grant, including customised ones. Previously it replaced the whole list.
- Rules: new `devices` block (room-reference checks, taxonomy map, dates, price/currency). **No existing rule changed.**
- Tests: npm test 98 → 132, browser E2E 38 → 55, emulator suite 34 → 44 (written; to be run).

## 5.1.0 — Phase 2: Rooms (2026-10-04)

- **Rooms module** (first real module):
  - `homes/{homeId}/rooms/{roomId}` with 16 types and 19 icons;
  - optional floor/area and notes;
  - create, edit (field-level patch), soft archive with confirmation, archived view, restore;
  - Move earlier/later ordering (atomic batch renumber);
  - empty state with optional templates, room detail with honest future placeholders.
- Real-time updates from one shared listener per Home; Dashboard Rooms summary widget; Rooms in navigation.
- Permissions: owner all; admin view/create/edit/delete/restore; member/viewer/child view. `ROLE_TEMPLATE_VERSION` 1 → 2 (owner applies via *Update default roles*).
- Rules: new `rooms` block (separate create/edit/archive/restore paths, no delete). **No existing rule changed.**
- Core extensions:
  - context scope (per uid + home);
  - shared data layer gains `watchCollection` and `createDoc`; SDK wrapper exports `setDoc`;
  - new error `CONTEXT_UNAVAILABLE`;
  - accessible `dialog` component;
  - `tp()` plural helper;
  - shared button, empty-state and summary-card styles.
- **Fix (Phase 1 defect):** signing in after signing out from a non-dashboard page reopened that page. The router now keeps its current route in sync (`router.replace`).
- Tests: npm test 65 → 98, browser E2E 23 → 38, rules emulator suite 24 → 34 (written; to be run).

## 5.0.0 — Phase 1: Foundation (2026-10-04)

A clean rebuild. No code carried forward from V4; V4 was used only as a visual and UX reference.

- Firebase: single initialization, single SDK import (10.12.2 modular), shared data layer, central paths.
- Auth: one lifecycle (`onAuthStateChanged`), email/password login, session restore, logout, password reset, friendly errors.
- Lifecycle state machine with race protection and live membership/role/home watching.
- First-time setup: atomic 9-document batch (home, owner membership, 5 roles, settings, profile).
- Roles and permissions: owner/admin/member/viewer/child; `*`, `ns.*` and `ns.action` grants; `can()` resolver mirrored in rules.
- New Firestore rules with a secure bootstrap, rank-based management and default deny.
- Module registry (10 planned modules, metadata only) driving nav, tiles, widgets and role seeding.
- Dashboard shell, core settings, Arabic/English (RTL/LTR), light/dark/system themes, responsive layout.
- Tests: unit (50), static architecture (15), browser E2E with a fake SDK (23), emulator rules suite (written; to be run).
