# HomeHub — PROJECT STATE (authoritative handoff)

> **Future Claude sessions: read this file first.** Then read ARCHITECTURE.md, FIRESTORE-SCHEMA.md, SECURITY.md and TESTING.md as needed. Do not reconstruct the architecture from the code or from older HomeHub versions.

| | |
|---|---|
| Version | **5.4.0** |
| Phase 1 | **Foundation — COMPLETE / LIVE VERIFIED** (owner's live smoke test passed) |
| Phase 2 | **Rooms — COMPLETE** |
| Phase 3 | **Devices & household assets — COMPLETE** |
| Phase 4 | **Finance — IMPLEMENTED** (expenses, wallets + privacy, transfers, 10-day budgets, recurring commitments, CSV history import). Automated tests pass; emulator + live smoke test pending |
| Phase 4A | **Finance + Family & Members — IMPLEMENTED** (automated tests pass; emulator + live smoke tests pending; see TESTING.md) |
| Next phase | **Phase 5 — Life Savings & Zakat** (not started). Provided separately by the owner |
| Firebase project | `expensetracker-d7309` (default Firestore database) |
| Firestore | V5-only. Live data: the owner's user, Home, membership, roles and settings (Phase 1). Rooms, devices and finance records are added by users. The 330-record expense history (207,464.90 EGP) is **not** in V5 yet: it lives in the owner's CSV backup and is brought in with the Finance → Wallets → *Import from CSV* tool (TESTING.md). **Never reset, reseed or migrate Firestore** |
| Owner account | An existing Firebase Auth email/password user. Never hard-code its UID |

## 1. Objective

HomeHub is a household app (Arabic-first, bilingual) that will integrate many tools:
- Expenses, Chef/Recipes, Meal planner, Cleaning, Maintenance, Contacts, Inventory, Shopping, Rooms, Devices;
- plus household management and dashboard summaries.

V5 is a clean rebuild. Phase 1 delivers only the foundation that every tool plugs into. Tools are built and validated **one at a time** in this order of steps: UI, then business logic, Firestore model, security rules, permissions, dashboard integration, cross-module links, and finally testing.

V4 was used only as a visual/UX reference. **No V4 code, migration logic, legacy paths, compatibility layers or hard-coded IDs exist in V5.**

## 2. Current architecture (summary; details in ARCHITECTURE.md)

- Static app with native ES modules and no build step. Firebase modular SDK 10.12.2 from gstatic.
- `src/core/firebase/sdk.js` is the only SDK import, and `firebase.js` is the only `initializeApp`.
- `src/core/data/firestore.js` is the shared data-access layer.
- `src/core/firebase/paths.js` holds every Firestore path.
- `src/core/lifecycle/session-controller.js` is the single auth + Home-context lifecycle.
- `src/core/state/app-machine.js` defines the states: `BOOTING, AUTH_REQUIRED, AUTHENTICATING, RESOLVING_CONTEXT, SETUP_REQUIRED, SETTING_UP, READY, ERROR`.
- `src/core/permissions/*` holds the permission grammar, seeded roles and resolver (`can('ns.action')`).
- `src/modules/registry.js` + `src/modules/index.js` form the module registry. Nav, tiles, widgets and default roles derive from it.
- `src/core/lifecycle/context-scope.js` (Phase 2): one scope per READY (uid, homeId). Modules keep their live listeners in it, so a module's page and dashboard widget share one listener, and everything is disposed on sign-out, context error or Home change.
- `src/ui/*` contains screens, shell, pages and shared components (Phase 2 added an accessible `dialog.js`). The UI never touches Firestore directly.
- `src/modules/expenses/*` (Phase 4, UI name *Finance*): pure money/calendar/recurrence/model/ledger/import + a scope-bound store with privacy-safe listeners (see ARCHITECTURE.md).
- `src/modules/devices/*` (Phase 3) follows the same layering. Its store **consumes the shared rooms store**, so there is no second rooms listener.
- `src/modules/rooms/*` (Phase 2) is the first real module. Its layers are model (pure), store (pure, live, scope-bound), repository (Firestore), service (scope accessor), and UI (page, form, detail, widget).

## 3. Firebase / Firestore (details in FIRESTORE-SCHEMA.md)

Implemented paths:
```
users/{uid}                       identity + preferences (language, theme, defaultHomeId pointer)
homes/{homeId}                    name, createdBy, currency EGP, timezone Africa/Cairo, language ar
homes/{homeId}/members/{uid}      roleId, status   ← AUTHORIZATION SOURCE
homes/{homeId}/roles/{roleId}     rank, permissions[], system, templateVersion
homes/{homeId}/settings/general   weekStartsOn
homes/{homeId}/rooms/{roomId}     Phase 2 — name, type, icon, floor, notes, sortOrder, active (+ audit)
homes/{homeId}/devices/{deviceId} Phase 3 — name, category, subtype, roomId|null, status, icon, asset metadata, active (+ audit)
homes/{homeId}/wallets | expenses | walletMovements | spendingCycles | commitments   Phase 4 — finance (FIRESTORE-SCHEMA.md)
```
Future module data goes under `homes/{homeId}/<collection>`, and module settings in `homes/{homeId}/settings/<moduleId>`.

## 4. Authentication lifecycle

There is one `onAuthStateChanged` subscription. The SDK restores the session on refresh. Login is email/password; there is also a password reset and logout.
On sign-out the session generation is bumped, watchers stop, the store resets to `EMPTY_SESSION`, the route resets to `#/dashboard`, and the login screen shows.
No sign-up screen exists (accounts are created in the Firebase console for now).

## 5. Home context lifecycle

Order: `users/{uid}` → `defaultHomeId` → `members/{uid}` (active?) → `homes/{h}` → `roles/{roleId}` → permissions → `settings/general` → `READY`.
- A missing profile → `SETUP_REQUIRED`. This is normal for a new database.
- Every other failure → `ERROR` with a specific code and recovery actions (Try again, Create a new home, Sign out).
- While `READY`, the member, role and home documents are watched live.

First-time setup is one atomic batch of 9 documents: home, owner membership, 5 roles, settings/general, and users. The `homeId` comes from Firestore.

## 6. Roles & permissions

- Permission id: `<namespace>.<action>`, e.g. `expenses.create`.
- A grant is `"*"`, `"<namespace>.*"` or an exact id.
- Core namespaces: `home`, `members`, `roles`. Module namespaces are the module ids.

| Role | Rank | Default capability |
|---|---|---|
| owner | 100 | `["*"]`, locked |
| admin | 80 | Manage home and members, everything in every module. Not `roles.edit` |
| member | 50 | View/create/edit (+complete) in all modules. No delete, no home/member management |
| viewer | 20 | View only |
| child | 10 | home.view; chef, mealPlanner, contacts, rooms view; cleaning & shopping view + complete |

Rooms (final, Phase 2): owner = all (`*`), admin = `rooms.view/create/edit/delete/restore`, member/viewer/child = `rooms.view` only. Rooms are shared household structure, so only admins change them. This intentionally differs from the provisional Phase 1 `standardPermissions`.

Devices (final, Phase 3): same shape as Rooms. `devices.delete` = archive.

Finance (final, Phase 4), as `expenses.*` because module permissions must use the module id:
- `view`, `viewFinancialTotals`, `create`, `edit`, `delete` (void);
- `personal` (use your own or shared personal wallets);
- `manageWallets`, `transfer`, `manageBudgets`, `manageCommitments`;
- `import` (owner only).

Defaults: admin everything except import; member view/totals/create/edit/personal/transfer/manageBudgets; viewer view; child personal.

`ROLE_TEMPLATE_VERSION = 4` (v1 Phase 1, v2 rooms, v3 devices, v4 expenses). `TEMPLATE_CHANGES` records which namespaces each version re-defined. (in `src/core/permissions/roles.js`). When a module adds or changes default permissions, bump it. The owner then sees "Update default roles" in Settings, which upgrades the system roles. **Since Phase 3 the upgrade is non-destructive:** only namespaces changed since the role's `templateVersion` are re-templated (v1 role → rooms + devices; v2 role → devices); every other grant, including customised ones, is preserved. Custom roles are never touched. **There is no automatic or silent migration.**
**Live Home after Phase 4:** the owner (`*`) can use Rooms, Devices and Finance immediately. Until the owner presses *Update default roles*, the other seeded roles keep their stored lists (v1 or v2; for example, member would still hold `devices.create`/`devices.edit`). This matters only once other people join.

## 7. Security model (details in SECURITY.md)

Auth + active membership + role permissions = authorization. Rules are authoritative and deny by default.
- **Bootstrap:** a brand-new home may be created only in a batch that also creates the caller's own active owner membership. The home must not already exist.
- Nobody changes their own role. Managers act only on members ranked below them. The owner role can't be granted or removed.
- Server timestamps and exact field sets are required.
- Membership create (except bootstrap), member delete, role create (except bootstrap) and home delete are **denied in Phase 1**.
- Rooms (Phase 2) are gated by `can(h,'rooms',…)`. There are separate update paths for edit (active rooms only), archive and restore. `createdBy == auth.uid` on create; `createdBy`, `createdAt` and `schemaVersion` are immutable. Hard delete is denied for everyone.
- Devices (Phase 3) follow the same pattern. A new or changed `roomId` must be an existing **active** room of the same home (`isActiveRoom`); an unchanged reference to a room archived later stays valid. Taxonomy, dates and price/currency are validated.

## 8. Module registry contract

```js
defineModule({ id, nameKey, descriptionKey, icon, accent, route: '/m/<id>', order,
               enabled, viewPermission, permissions: [{ id, defaultRoles }],
               page: () => import('./page.js'), dashboardWidget: { order, size, load } })
```
**Finance (expenses), Rooms and Devices are the enabled modules** (page + dashboard widget each). The other 7 are `enabled: false` and their folders contain only `module.js`.

Module ↔ Dashboard principle (established in Phase 2): **the module owns its data, the module exposes a summary/interface, and the Dashboard consumes that interface.** The Dashboard mounts `dashboardWidget`; the widget reads the module's summary (Rooms: `{ activeCount, archivedCount }`) from the module's scope-bound store. The Dashboard never reads module collections.

Module services hold their live state in the context scope: `ctx.scope.resource('<id>', factory)`. See `src/modules/rooms/rooms-service.js` for the pattern.

## 9. Coding conventions

- Pure logic stays free of Firebase and DOM, and is unit-tested.
- Errors are `AppError(code)`. All strings go through `t()` with ar/en parity.
- DOM is built with `h()` (never `innerHTML`).
- No globals, no direct SDK use outside `core/firebase|data|auth`.
- Every write sets `serverTimestamp()`.

Static tests enforce most of this. Run `npm test` before delivering anything.

## 10. UI / design conventions

- Previous HomeHub identity: slate neutrals, blue→indigo gradient, 🏠 brand tile, 2rem cards, Inter/Cairo.
- Desktop sidebar (≥1024px), glass top bar, bottom dock on phones and tablets.
- Arabic default (RTL) and English (LTR). Light/dark/system themes.
- Logical CSS properties only.
- Modules get an emoji + accent colour (`.accent-<name>` in `tokens.css`).
- Planned tools show "Coming soon". **Never show fake data.**

## 11. Implemented features

- Email/password login, session restore, logout, password reset, and friendly errors.
- First-time setup wizard (display name + home name) with an atomic batch.
- Home context resolution, plus explicit error screens for every failure, including "Firebase can't connect".
- Live membership, role and home updates.
- Seeded roles, permission resolver, module registry.
- Dashboard shell: hero banner, real home facts and member count, tool tiles, widget slot mechanism.
- Settings:
  - display name (synced to the membership copy);
  - language and theme (persisted per user, cached per device for the login screen);
  - home name, currency, time zone, home language and week start (needs `home.edit`), otherwise read-only;
  - read-only members and roles lists, plus the owner's "Update default roles" action.
- Responsive (phone, tablet, desktop), accessible basics, development logging (`[HomeHub] …`).

**Phase 2 — Rooms**
- Room CRUD at `homes/{homeId}/rooms/{roomId}`: create, view, edit (field-level patch), soft archive with confirmation, archived view, restore.
- 16 room types (stored ids, translated labels), 19 icons (stored ids; unknown ids fall back), optional free-text floor/area with suggestions, and notes.
- Ordering by `sortOrder` with Move earlier / Move later. Each move renumbers the active rooms in one atomic batch.
- Empty state with optional quick templates. Templates only open the form; nothing is written without Save.
- Real-time updates from one shared listener per Home, cleaned up on sign-out or context change.
- Dashboard Rooms summary widget, and Rooms in navigation.
- Room detail with honest "coming in a future update" placeholders for Devices, Cleaning and Maintenance.
- Rules, emulator tests, unit, static and browser E2E tests, plus Arabic plural forms (`tp()`).

**Phase 3 — Devices & household assets**
- Device CRUD at `homes/{homeId}/devices/{deviceId}`, with Firestore-generated permanent ids.
- 19 categories / 67 subtypes, 4 descriptive statuses, 29 icons.
- Optional brand, model, serial (not unique), purchase and installation dates, price + currency (asset metadata, not an expense), warranty end, notes. Dates are stored as `YYYY-MM-DD` strings.
- Room assignment or **Unassigned**; move between rooms changes only `roomId`.
- Archived-room handling: devices untouched and labelled "(Archived)"; still editable; no new assignment to archived rooms.
- Soft archive with confirmation, Archived view, restore.
- Client-side search (name, brand, model, serial), filters (room incl. Unassigned and archived rooms, category, status, active/archived), and sort (name, room, category, status).
- Progressive-disclosure form, quick templates (prefill only), and detail view with honest Cleaning/Maintenance placeholders.
- Dashboard Devices card `{ activeCount, needsAttentionCount, outOfServiceCount, archivedCount }`.
- Room detail shows "N devices in this room" and "View devices" (opens Devices filtered to that room) via the Devices interface.
- Non-destructive role upgrade (v3).

**Phase 4 — Finance**
- Expenses (newest first, grouped Today / Yesterday / date; search; filters by date range, category, wallet, payment method, fixed/variable). Field-level edit; void/un-void instead of delete.
- Quick add: amount, category, note. It defaults visibly to the wallet with a running 10-day budget; "More details" opens the full form.
- Wallets:
  - household, and personal (private / shared with selected members / child allowance), with **privacy enforced by the rules**;
  - computed balances, opening balance, money in (funding), transfers;
  - archive / restore.
- Rolling 10-day budgets on a wallet:
  - any start date and length (1–31 days), funded by transfer or money in (never an expense);
  - remaining, safe/day, calm pace indicator;
  - cash count recorded as an explicit adjustment;
  - close with carry forward / return to another wallet / keep.
- Fixed & recurring commitments: generic recurrence engine (weekly through every 2 years, plus custom), annual subscriptions first-class, upcoming list, monthly-reserve hint.
- **Mark paid** creates exactly one deterministic expense and advances the due date atomically.
- Overview: month total, fixed vs variable, categories, current budget, upcoming. Totals are hidden without `viewFinancialTotals`. Home / Mine scope switch.
- Dashboard Finance card (privacy-aware).
- Owner-only **CSV history import**: preview with exact total, idempotent, original ids and columns preserved, `isVisa` → `visa`.


## Phase 4A — Family & Members (IMPLEMENTED)

**Identity → membership → role → permission → resource ownership → privacy → audit.**

- **Identity:** every person has their own Firebase Auth account (email + password, created from the login screen's "Create account"). Passwords are never stored or seen by anyone else. There is still ONE auth observer (`session-controller`).
- **Membership (authoritative):** `homes/{homeId}/members/{uid}`. Phase 4A adds the optional fields `relationship` ('adult'|'child'), `guardianUids` (children), `inviteCode`, and the statuses `removed` / `left`. Older documents read with safe defaults. `users/{uid}.defaultHomeId` stays a convenience pointer. A user may hold memberships in several homes; joining another home never silently changes the default ("Switch now" is explicit).
- **Invitations:** `invites/{code}` (top-level, because the invitee is not a member yet).
  - The code is 24 symbols from a 30-symbol alphabet, about 117 bits, from `crypto.getRandomValues`.
  - Fields: `homeId, homeName, roleId, relationship, guardianUids, status (pending|accepted|cancelled), createdBy, createdAt, expiresAtMillis, acceptedBy, acceptedAt, cancelledBy, cancelledAt, schemaVersion`.
  - Lifecycle: create (inviter, 1–14 days) → accept (single-use, unexpired, bound to the caller) or cancel. Accepted and cancelled invites are kept for audit; nothing is deleted.
  - Acceptance is ONE batch: invite → accepted, plus the membership created (or re-activated after removed/left), plus `users/{uid}` for new accounts. Each rule checks the other half with `getAfter`, so an "accepted invite without membership" cannot exist.
  - Invite links (`#/join/CODE`) survive sign-in, account creation, reloads and sign-out.
- **Roles / permissions:** unchanged Home-scoped roles. New permission `members.manageChildren` (admin). `ROLE_TEMPLATE_VERSION` 4 → **5** (`TEMPLATE_CHANGES[5] = ['members']`), applied by the existing non-destructive "Update default roles"; custom grants and other namespaces survive (tested).
  - Inviting a role needs `members.invite` and a role below your own rank (the owner may invite any non-owner role).
  - Role changes need `members.edit`, removal needs `members.remove`, guardians need `members.manageChildren`. All are limited to members ranked below you; nobody acts on themselves except "leave".
- **Owner:** single owner. The owner can never be demoted, removed, suspended, or leave, so a home is never ownerless. **Ownership transfer is NOT implemented** (documented limitation). Owning the home is administration, not access to other adults' private wallets.
- **Guardians:** explicit `guardianUids` on the child's membership (1–5 active adults). Never inferred from Owner/Admin. Guardianship grants no admin rights. Guardians see a child's allowance wallet because the wallet is shared with them (the UI pre-selects the guardians when creating the wallet).
- **Child:** a real member with their own login. A child needs their own email for Firebase Auth; there are no shared or invented identities. The default `child` role has no `expenses.view`, so the child cannot read household finance records at all (data-level, not UI hiding).
- **Removal / leaving:** a status change (`removed` / `left`); the member document and everything they created remain, and history still shows their name ("Added by Sara").
  - They immediately lose all home access, because every rule requires an active membership.
  - Their private wallets are NOT handed to anyone and stay unreadable to the owner. A wallet they had explicitly shared remains readable by those it was shared with.
  - Re-joining requires a new invitation.
- **Finance integration:**
  - `createdBy` = who entered the record (always `request.auth.uid`, enforced by rules); `paidBy` = who paid (attribution, chosen from members).
  - History shows "Added by …" and "Paid by …" from the shared member directory, with filters by Added by and Paid by. Default order is still newest first.
  - Imported CSV history shows "Imported history", never "Added by Owner"; on imported records `createdBy` means "imported by".
- **Member directory:** one shared, scope-bound family store (members listener + invites listener, each only when permitted) used by the Family page, Settings, and Finance. No per-row lookups.
- **Listeners per signed-in Home (maximum):** rooms 1 + devices 1 + finance 10 + family 2 = **14** (Phase 4: 12). All are disposed on sign-out or Home change (tested).

- **Fixes during 4A testing:**
  - Child Quick-add default wallet.
  - A child can no longer un-share or archive a guardian-created allowance wallet (rules tightened).
  - Family/Join pages are lazy-loaded so the offline screen keeps working.
  - See TESTING.md.
- **Results:** `npm test` 191/191, browser E2E 87/87 (repeated + clean unzip), emulator suite 65 tests written. **REQUIRES FIREBASE EMULATOR TEST** and the live smoke test.

## 12. Intentionally NOT implemented (later phases)

- The seven remaining tool modules, plus Life Savings and Zakat. **Phase 5 (Life Savings & Zakat) is next.**
- Finance: multi-currency conversion, income totals, sinking-fund engine, notifications or reminders, receipts/attachments, member invitations (a later Family & Members phase).
- Device photos, manuals, receipts and warranty documents (need Firebase Storage); warranty reminders; maintenance schedules.
- Invitations and member management (add, remove, change role through the UI).
- Custom roles, home deletion, multiple-home switcher, account sign-up.
- Notifications, App Check, offline persistence, PWA install.
- Restoring the historical Expenses CSV / Recipes JSON (each waits for its module).

## 13. Known limitations

- The rules emulator suite (now 44 tests: Phase 1, Rooms, Devices) has **not** been run by a build session (no Java or network). Phase 1 was verified live by the owner; the Phase 2 and Phase 3 live smoke tests are pending.
- Rules check the date *format* (`YYYY-MM-DD`, 1900–2100) but not calendar validity (e.g. Feb 30). The client rejects such dates.
- Devices with price but a currency outside the dropdown list must be entered via a supported code; the rules accept any ISO-style code.
- Finance totals are computed client-side over all permitted records (no pagination), which suits household scale.
- `viewFinancialTotals` is a presentation gate. Record secrecy comes from `expenses.view` / wallet readers (SECURITY.md).
- No currency conversion: transfers across currencies are refused.
- Wallet sharing is limited to 5 members, and re-labelling is capped at about 450 records per sharing change.
- One active 10-day budget per wallet.
- Member names for "Paid by" and sharing come from the members list, which needs `members.view`.
- The Room → Devices filter hand-off is in-memory; there is no deep-link URL for a filtered Devices view.
- Room reordering is Move earlier/later only (no drag-and-drop).
- Rooms are read as one whole collection. That's fine for a household (tens of rooms); revisit if a Home ever has hundreds.
- The floor/area is free text in the user's language. It is not translated and not a separate entity.
- A user can create any number of homes for themselves (harmless; can be capped later).
- Fonts load from Google Fonts. Offline, the system fallbacks are used.
- On phones the quick language/theme toggles live in Settings (the top bar shows them from 640px up).

## 14. Decisions that MUST NOT be reversed casually

1. Membership (`homes/{h}/members/{uid}`) is the only authorization source. `defaultHomeId` is never trusted.
2. One Firebase init, one SDK import file, one data-access layer, one session lifecycle.
3. Firestore rules are authoritative and deny by default. Every new collection ships with its rules and emulator tests **in the same phase**.
4. The permission grammar (`*`, `ns.*`, `ns.action`) is shared by rules and client. Change both or neither.
5. Bootstrap rule semantics (the home must not pre-exist, and creator = owner = `request.auth.uid`).
6. Owner role = `["*"]`, rank 100, immutable. Ranks gate member and role management.
7. User preferences (`users/{uid}`) and Home settings (`homes/{h}`, `settings/*`) stay separate.
8. Each kind of data has one authoritative owner. Modules reference each other by id (`sourceType/sourceId`, `linkedEntityType/linkedEntityId`, `<entity>Id`); no competing copies without a written reason.
9. No legacy or migration code. Historical data is re-imported by its own module, after that module is tested.
10. No fake business data. Empty states are honest.
11. Server timestamps for every `createdAt`/`updatedAt`.
12. **Room ids are permanent.** Rooms are never hard-deleted; "delete" = `active: false`. Archived rooms stay readable, so devices, cleaning and maintenance records can always resolve their `roomId`.
13. **No child arrays in parents.** Rooms never embed `devices: [...]`; children point to parents (`devices/{id}.roomId`).
14. **Module owns data → exposes summary → Dashboard consumes.** The Dashboard never reads module collections.
15. Module live listeners live in the context scope (one per Home, disposed with it), never in module-level globals.
16. **Device ids are permanent; devices are never hard-deleted.** Moving rooms changes only `roomId`.
17. **Archiving a room never modifies its devices.** A changed `roomId` must target an active room; an unchanged one may point to an archived room.
18. **Device owns asset identity and metadata only.** Cleaning, maintenance and financial data live in their own modules and reference `deviceId`.
19. **Modules consume each other only through service accessors** (`getRoomsStore(ctx)`, `getDevicesStore(ctx)`), never through another module's repository; one listener per collection per Home.
20. **Role template upgrades are namespace-scoped and non-destructive** (`TEMPLATE_CHANGES`). Each phase that changes defaults bumps the version and lists its namespaces.
21. **Four money concepts never mix:** expense (spent) ≠ funding (in) ≠ transfer (between wallets) ≠ commitment (scheduled). Only expenses count as spending.
22. **Money is integer minor units.** Financial dates are `YYYY-MM-DD` strings.
23. **Finance privacy lives on each record** (`audience` + `readers`, derived from wallets and verified by the rules). The app must only use rules-provable queries. The owner role never implies access to another adult's private wallet.
24. **No hard deletes of financial history.** Void, archive or close instead.
25. **Commitment payments use deterministic expense ids** (`cm_{id}_{due}`), paired with the due-date advance in one batch.

## Phase 5 — Life Savings & Zakat (IMPLEMENTED, v5.5.0)

Module `savings` (#/m/savings, "Life Savings / مدخراتي") answers three separate questions:
1. **What do I own?** Assets and an append-only event ledger.
2. **What is it worth now?** Valuation from append-only price quotes.
3. **Based on my selected methodology, what may be Zakatable, and when?** The Zakat engine.

- **Asset types:** cash, bank, gold, silver, foreign currency (`fx`), investment, other.
  - Quantities are integers: money in minor units of its own currency; metals in **milligrams** with a karat (24/22/21/18) or fineness (999/925/900/800).
  - A balance is the deterministic sum of events. Metadata edits never move money.
- **Ownership & privacy (same model as Finance):**
  - Personal assets (`ownerUid`) are private, or shared with up to 5 chosen members. Household assets need `savings.view`.
  - **The Home owner has no implicit access** to another adult's private assets, events or Zakat.
  - A child's savings are created by an explicit guardian, readable by the child plus guardians, and the child cannot un-share them.
  - When a member's guardians change, existing child assets are **not** silently re-shared. The creator updates sharing explicitly, which re-labels the asset's events in the same batch.
- **Transfers:** one transferId, two linked legs, written atomically.
  - Cash → gold records the money out as cost; the grams in are the quantity.
  - Wallet ↔ savings writes ONE Finance `walletMovements` doc (type `savings`) plus ONE linked savings event. It is never an expense or income.
- **Valuation:** `priceQuotes` (manual from clients, audited and append-only).
  - A 21K/18K price can be derived from a 24K quote; it is labelled "derived".
  - Freshness labels: current / stale (>24 h) / manual / unavailable. "Live" only for a fresh non-manual provider quote. Unpriced assets are listed, never counted as 0.
  - **No valuation is written when the page opens.**
- **Providers:** a replaceable interface. `http` calls a server endpoint you deploy (`PRICE_ENDPOINT`, null by default → **REQUIRES PROVIDER CONFIGURATION**). It handles timeout, network, rate-limit and invalid payloads. No API keys in the client; no scraping; no LLM prices.
- **Zakat** (an estimate based on the owner's selected settings; never a ruling):
  - **Nisab:** gold (default 85 g of **21K**, labelled as the selected Egyptian-oriented default), silver (595 g), or manual.
  - **Rate:** in basis points (default 250 = 2.5%).
  - **Hawl:** Hijri Umm al-Qura (same Hijri date next year, ≈354–355 days) or Gregorian.
  - **Below-Nisab policy:** `reset` or `continue` (only start and end count).
  - **Reconstructed from history:** event dates and price dates, not today's balance.
  - **Per owner:** own included assets plus an explicit allocation share (must total 100%) of household assets. Unallocated household assets are excluded, with the reason shown. Children are separate owners.
  - **Records (`zakatRecords`, append-only):** settings versions (who/when), calculation snapshots, and payments. A payment may optionally create exactly ONE Finance expense (`zk_<paymentId>`, category `zakat`) in the same batch.
- **Permissions (namespace `savings`, role template v6):**
  - `view` / `viewTotals` / `personal` / `manageHousehold` / `transfer` / `prices` / `zakat`.
  - The child role gets `savings.personal` only.
  - Upgrade is non-destructive (namespace-scoped).
- **Listeners per Home (shared, disposed with the scope):** assets ×2, events ×2, quotes ×1, zakat ×1 = **6**, in addition to the Phase 4A listeners.
- **Deployment** (never automatic): `firebase deploy --only firestore:rules`, then `firebase deploy --only hosting`. No new indexes are needed (single-field queries only).

## Phase 5.1 — Legacy Home adoption (IMPLEMENTED, v5.5.1)

A one-time, security-sensitive compatibility repair: the ORIGINAL creator of a pre-membership Home gains the current Owner authorization on the SAME Home, with all data preserved.

**Legacy Home** (created by an older HomeHub, before memberships and roles):
- `homes/{h}` exists and its **stored** `createdBy` is the signed-in uid;
- `users/{uid}.defaultHomeId == h`;
- there is no `homes/{h}/members/{uid}` and **no `homes/{h}/roles/owner`**.

Under the current rules, every Home with any member also has `roles/owner`: bootstrap writes both atomically, and invitations require roles. So "no owner role" proves the Home was never initialised and that no Owner can be displaced.

**Lifecycle:**
1. **Detection.** Context resolution reaches a missing membership and runs `detectLegacyHome`. It uses narrow per-document gets that only the stored creator may make while not a member: the Home doc plus each system role id. There is no list and no broad read.
2. **Result:**
   - `LEGACY_HOME_ADOPTION_REQUIRED` → the upgrade screen;
   - `LEGACY_HOME_ADOPTION_BLOCKED` → no automatic repair;
   - otherwise the unchanged `MEMBERSHIP_MISSING`.
3. **"Upgrade Home".** `session.adoptLegacyHome()` moves ERROR → RESOLVING_CONTEXT. `adoptLegacyHome` re-detects FRESH state, then commits ONE batch.
4. **Automatic re-resolution:** users → defaultHomeId → members/{uid} → home → roles/owner → `["*"]` → READY. There is no logout, no manual edit, no second Home, and `defaultHomeId` is unchanged.

**Write set (atomic):**
- `members/{uid}` = `{uid, email, displayName, roleId:'owner', status:'active', addedBy:uid, joinedAt, createdAt, updatedAt, legacyAdoption:true}`;
- plus only the **missing** system roles from `defaultRoles()` (owner `["*"]`, rank 100, `system: true`, `templateVersion` = `ROLE_TEMPLATE_VERSION` = **6**).

Never written: the Home document, the profile, settings, and all business data. Older Home docs lacking currency, time zone or language get **in-memory** defaults only.

**Partial states:**

| State | Behaviour |
|---|---|
| A — no members, no roles | Full adoption (member + 5 roles) |
| B — creator membership missing, some non-owner roles exist | Adopt; only the missing roles are created; existing ones are kept verbatim |
| C — `roles/owner` exists but the creator has no membership | `LEGACY_HOME_ADOPTION_BLOCKED` (nothing written; manual review) |
| D — custom roles exist | Never touched (create-only; system ids only) |
| E — already initialised (membership exists) | Normal resolution, exactly as before |

**One-time:** a retry finds the membership and returns `alreadyMember`, writing nothing. The rules refuse any second adoption because a membership now exists and the owner role now exists.

**Limitation:** business documents written in an OLDER (pre-V5) field shape are preserved untouched. V5 screens show records in the V5 shape (for example, expenses need `audience`/`readers` for the privacy-proving queries). Making older-shape records visible would be a separate, explicit data-compatibility step that adoption deliberately does not perform.

## Future / Technical Debt

Noticed during Phases 2–4.
- Phase 4: the finance store had imported its collection names from the Firebase repository, which made the "pure" store load the SDK. They are now moved to `collections.js` (caught by unit tests).
- Phase 4: the history filters collapse behind a toggle on phones. A saved "default filter" preference could come later. Not fixed unless noted, to keep scope disciplined.
- **CHANGED in Phase 3 (required by its brief):** "Update default roles" previously replaced each system role's whole permission list. That would have destroyed customised grants. It is now namespace-scoped and non-destructive (`upgradeRolePermissions`), with unit tests.
- The Phase 2 rooms-path static scan matched the permission-namespace list `['rooms']` in `roles.js`. It is now scoped to exclude `src/core/permissions/` (namespaces, not paths).
- **FIXED (genuine defect):**
  - After signing out from any page other than the dashboard, signing back in reopened that page. The router's cached route went stale because `history.replaceState` doesn't fire `hashchange`.
  - Fix: `router.replace()`, used by `main.js` on sign-out.
  - Covered by E2E R15.
- Seeded roles in the live Home are at template v1 until the owner presses *Update default roles*.
- The E2E fake SDK doesn't evaluate security rules. Rules coverage relies on the emulator suite, which should be wired into CI.
- No App Check yet; recommended before inviting other members.
- Fonts come from Google Fonts. Consider self-hosting for offline/PWA later.
- Drag-and-drop room ordering could be added later without schema change (sortOrder already supports it).

## 16. Phase / version history

- **v5.9.1 — Phase 5.6:** in-app Smart Reminders (derived from Cleaning + Maintenance; owner-only read / snooze / dismiss; no background delivery). **NOT DEPLOYED.**

- **v5.9.0 — Phase 5.5:** Device Maintenance Management (plans, idempotent completions, faults with audit trail, costs per currency, Device Details section). **NOT DEPLOYED.**

- **v5.8.3 — Phase 5.4d:** device ↔ cleaning integration (Device Details cleaning live, device selector in Basic/Advanced, catalog suggestions for every device type). **NOT DEPLOYED.**

- **v5.8.2 — Phase 5.4c:** custom cleaning templates (packs, apply with preview) and AI routine import (privacy-first prompt, safe JSON, idempotent confirmed writes). **NOT DEPLOYED.**

- **v5.8.1 — Phase 5.4b:** device usage (after-use, coalesced, idempotent, void corrections) and seasonal cleaning (states, start/end checklists), one shared data model. **NOT DEPLOYED.**

- **v5.8.0 — Phase 5.4a:** Advanced Cleaning (routine, skip / postpone, time, stats, quick, whole room, settings), one shared data model. **NOT DEPLOYED.**

- **v5.7.2 — Phase 5.3.2 hotfix:** cleaning setup writes one task per request (was one rejected batch); honest partial results; generated titles ≤ 120. **NOT DEPLOYED.**

- **v5.7.1 — Phase 5.3.1:** Cleaning card on the shared summary-card; template-based cleaning for existing and new rooms/devices (one-tap review, idempotent, last-completion scheduling). **NOT APPROVED FOR DEPLOYMENT until the real emulator passes 106/106 (normal + strict).**


- **v5.7.0 — Phase 5.3:** Home Routine & Cleaning (module enabled) + Edit Active Budget (amount only, audited). **NOT APPROVED FOR DEPLOYMENT until the real emulator passes 101/101 (normal + strict).**

- **v5.6.0 — Phase 5.2:** Zakat ledger (estimate / paid / outstanding), Hawl-linked payments, explicit Zakat sharing with revocation. Rules changed (zakatRecords only). **NO-GO until the real emulator confirms 90/90.**

- **v5.5.3 — Phase 5.1.2:** emulator-driven repair (query-safe privacy reads, members/devices expression headroom, test fixtures). Emulator rerun and production comparison pending.

- **v5.5.2 — Phase 5.1.1:** rules & rules-test repair (list `.concat()`, `assert` import, one Firestore instance per test account, bound-once hot paths). **Emulator rerun required.**

- **v5.5.1 — Phase 5.1:** legacy Home adoption (authorization bootstrap fix for the creator's own pre-membership Home).

- **v5.5.0 — Phase 5:** Life Savings & Zakat. See above and CHANGELOG.md.

| Date | Version | Phase | Summary |
|---|---|---|---|
| 2026-10-04 | 5.0.0 | Phase 1 — Foundation | Clean rebuild: auth lifecycle, first-time setup, membership/roles/permissions, V5 rules, module registry, dashboard shell, core settings, ar/en, themes, responsive. Unit 50/50, static 15/15, browser E2E 23/23 (fake SDK). **Live smoke test passed (owner)** |
| 2026-10-04 | 5.1.0 | Phase 2 — Rooms | Rooms module (CRUD, soft archive/restore, ordering, live updates, dashboard widget), context scope, dialog component, plural i18n, Rooms rules, `ROLE_TEMPLATE_VERSION` 2, router stale-route fix. npm test 98/98, browser E2E 38/38. Rules emulator and live smoke test pending |
| 2026-10-05 | 5.2.0 | Phase 3 — Devices | Devices & household assets (CRUD, room assignment / Unassigned, archived-room handling, archive/restore, search, filters, sort, status), Dashboard card, Room → Devices link, non-destructive role upgrade (v3), Devices rules. npm test 132/132, browser E2E 55/55. Emulator and live smoke test pending |
| 2026-10-05 | 5.3.0 | Phase 4 — Finance | Expenses (newest-first history, void not delete), household/personal wallets with rules-enforced privacy, funding/transfers/adjustments (never spending), rolling 10-day budgets (carry, return, reconcile, pace, safe/day), generic recurring commitments with atomic mark-paid, owner CSV history import, Dashboard card, role template v4. npm test 166/166, browser E2E 70/70. Emulator (55) and live smoke test pending |
| 2026-10-05 | 5.4.0 | Phase 4A — Family & Members | Sign-up, invitations (single-use, expiring, atomic acceptance), member management (roles, suspend, remove, leave), guardians, child accounts, member directory, Finance attribution (Added by / Paid by) and member filters, role template v5. Emulator and live smoke tests pending |
