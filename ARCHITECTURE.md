# HomeHub V5 — Architecture

## Stack

- **Static web app, no build step.** Native ES modules, plain CSS, no framework, no npm runtime dependencies.
- **Firebase JS SDK v10.12.2 (modular)** loaded from `www.gstatic.com`, pinned in one file.
- **Firebase Hosting** serves the files. Hash routing (`#/dashboard`) means no rewrites are needed.

Why no framework: Phase 1 needs a small amount of UI plus a strict lifecycle. Plain modules keep it auditable and dependency-free. If a module later needs a framework, it can be introduced deliberately; the core services don't depend on the view layer.

## Layers

```
index.html ─► src/boot-prefs.js     (sync: language/theme before first paint; start-up watchdog)
          └─► src/main.js           (wiring + rendering per lifecycle state)

src/
  config/                firebase-config.js (public web config), app-config.js (defaults, limits)
  core/
    firebase/            sdk.js (ONLY SDK import), firebase.js (ONLY init), paths.js (ALL paths)
    data/                firestore.js — readDoc/readCollection/watchDoc/patchDoc/atomicWrite
    auth/                auth-service.js — observe/signIn/signOut/password reset
    errors/              app-error.js — one error vocabulary + Firebase code mapping
    home/                home-repository (reads), context-resolver (pure), setup-plan (pure),
                         setup-service (atomic batch)
    permissions/         permission-format, core-permissions, roles (seed templates), resolver
    lifecycle/           session-controller.js — THE auth/context lifecycle
                         context-scope.js — per-(uid, homeId) resource scope (Phase 2)
    state/               app-machine.js (states + transitions), store.js (observable store)
    settings/            settings-service.js (writes), preferences.js (apply/cache lang+theme)
    i18n/                i18n.js + locales/ar.js, en.js
    router/              router.js (hash routes)
    utils/               dom.js (safe element builder), logger.js, validate.js
  modules/
    registry.js          defineModule / standardPermissions / createRegistry
    index.js             the list of modules → registry, permission catalog, default roles
    <id>/module.js       metadata (8 planned modules)
    rooms/               Phase 2 — the first implemented module:
      module.js          registration (enabled, permissions, page, dashboardWidget)
      room-model.js      PURE: types, icons, validation, ordering, summary, write builders
      rooms-store.js     PURE: live store bound to ONE home (injected repository)
      room-repository.js Firestore: homes/{homeId}/rooms via shared paths + data layer
      rooms-service.js   getRoomsStore(ctx) — scope-bound accessor; fails safely
      page.js, room-form.js, room-detail.js, room-labels.js, widget.js — UI
    expenses/            Phase 4 — Finance (module id kept as 'expenses'):
      money.js, calendar.js, recurrence.js, finance-model.js, ledger.js, import-model.js,
      collections.js (PURE), finance-store.js (PURE, live), finance-repository.js,
      finance-service.js (getFinanceStore(ctx)), page.js + tab-*.js, expense-form.js,
      dialogs.js, import-dialog.js, finance-ui.js, widget.js
    devices/             Phase 3 — same layering as rooms:
      module.js, device-model.js (PURE taxonomy/validation/selectors/write shapes),
      devices-store.js (PURE, live, consumes the rooms store), device-repository.js,
      devices-service.js (getDevicesStore(ctx)), page.js, device-form.js,
      device-detail.js, device-labels.js, widget.js
  ui/
    components/          icons, toast, common (fields, banners, toggles, roleLabel),
                         dialog (native <dialog>: modal, confirm) — Phase 2
    screens/             boot, login, setup, error (pre-dashboard states)
    shell/               app-shell.js (sidebar rail, top bar, user menu, bottom dock)
    pages/               dashboard, settings, module (placeholder / lazy module page)
```

Dependency direction: `ui → core (pure) ← core services → core/data → core/firebase`.
Static tests enforce these rules:
- Only `core/firebase`, `core/data` and `core/auth` touch the SDK.
- `ui/` never imports data access or Firebase.
- `initializeApp` exists once, and the SDK URL appears in one file.

`main.js` loads every Firebase-dependent module with dynamic `import()`. If the SDK can't load (offline, blocked CDN), the app still renders the "HomeHub can't connect" screen instead of a blank page.

## Application lifecycle (state machine)

```
            ┌──────────── sign-out (from any state) ────────────┐
            ▼                                                    │
BOOTING ─► AUTH_REQUIRED ─► AUTHENTICATING ─┐                    │
   │            ▲                ▲ failure  │ onAuthStateChanged │
   └────────────┼────────────────┘          ▼                    │
                └─────────────────── RESOLVING_CONTEXT ──────────┤
                                       │      │       │          │
                          no profile   │      │ ok    │ failure  │
                                       ▼      ▼       ▼          │
                              SETUP_REQUIRED  READY   ERROR ─────┘
                                │      ▲        │       │ retry → RESOLVING_CONTEXT
                                ▼      │fail    │       └ "create new home" → SETUP_REQUIRED
                              SETTING_UP ───────┘ (→ RESOLVING_CONTEXT on success)
```

- `READY` is reachable **only** from `RESOLVING_CONTEXT` (unit-tested). The dashboard is never rendered before auth, profile, home, membership, role and permissions have all resolved.
- **One** `onAuthStateChanged` subscription (`session-controller.start`).
- **Races:** each auth event increments a generation number, and async results from an older generation are discarded. Sign-out increments it immediately.
- **Live context:** while `READY`, the membership, role and home documents are watched. A role change updates permissions in place; a suspended or removed membership moves to `ERROR`.
- **Sign-out:** watchers stop, the store resets to `EMPTY_SESSION` (identity, profile, home, membership, role, permissions, errors), and the route resets to `#/dashboard`.

## Home context resolution

```
users/{uid} ── missing ──────────────► SETUP_REQUIRED
   │ defaultHomeId missing ──────────► ERROR DEFAULT_HOME_MISSING
homes/{h}/members/{uid} ── missing ──► ERROR MEMBERSHIP_MISSING
   │ status != active ───────────────► ERROR MEMBERSHIP_INACTIVE
homes/{h} ── missing ────────────────► ERROR HOME_NOT_FOUND
roles/{roleId} ── missing ───────────► ERROR ROLE_MISSING
resolvePermissions ── empty ─────────► ERROR PERMISSION_DENIED
settings/general ────────────────────► READY
```

Membership is read **before** the home on purpose. Rules let users read their own membership unconditionally, but reading the home needs an active membership. This order gives precise errors instead of a generic "permission denied".

## Context scope and module services (Phase 2)

```
main.js syncScope(state):
  READY(uid, homeId) ──► createContextScope({ uid, homeId })   (one at a time)
  anything else, or a different (uid, homeId) ──► scope.dispose()
```

Pages and widgets receive `ctx.scope`. A module keeps its live service in the scope:

```js
getRoomsStore(ctx) = ctx.scope.resource('rooms', (s) => createRoomsStore({ homeId: s.homeId, uid: s.uid, repo }))
```

- **One listener per Home.** The first consumer starts the listener, and every other consumer shares it. It lives until the scope is disposed, so moving between Dashboard and Rooms never re-reads the collection.
- **Fail safe.** A disposed store rejects every action with `CONTEXT_UNAVAILABLE`, and `getRoomsStore` refuses to work if the scope's homeId isn't the current Home.
- **Tenant isolation.** The homeId is fixed when the store is created and is never accepted from a caller. Every path is `homes/{scope.homeId}/rooms/{roomId}`.

## Cross-module consumption (Phase 3)

```
scope ── 'rooms'   → rooms store    (1 listener: homes/{h}/rooms)
      └─ 'devices' → devices store  (1 listener: homes/{h}/devices)
                         └── consumes the rooms store: labels, assignment checks
Rooms page ───────► rooms store
Devices page ─────► devices store + rooms store
Room detail ──────► devices store (count + "View devices")   ← Rooms consumes the Devices INTERFACE
Dashboard widgets ► each module's summary()
```

- Two listeners per Home in total, however many screens are open. Both are disposed with the scope (sign-out, error, Home change).
- No N+1 room lookups: room names come from the in-memory rooms snapshot.
- A module reaches another module only through its service accessor (`getRoomsStore(ctx)`, `getDevicesStore(ctx)`), never through its repository. Static tests enforce this.
- Room detail → Devices uses a one-shot `setPendingFilter({ room })` hand-off on the devices store (in-memory, no URL or storage).

## Finance listeners (Phase 4)

`getFinanceStore(ctx)` → one store per scope with, per collection (wallets, expenses, walletMovements, spendingCycles, commitments):
- a **mine** listener: `readers array-contains uid`;
- a **household** listener: `audience` or `visibility == 'household'`, only while the member holds `expenses.view`.

That's at most 10 listeners for the whole module, shared by every tab and the Dashboard widget, with results merged by id. `ensure()` adds or removes the household listeners when permissions change. Everything is disposed with the scope.

The shared data layer gained `watchWhere(segments, [field, op, value])` for this, and the SDK wrapper exports `query`/`where`.

## Module ↔ Dashboard contract (Phase 2)

The module owns its data, the module exposes a summary, and the Dashboard consumes it.
The Dashboard mounts each enabled module's `dashboardWidget` in the summaries row under the hero. The widget (module code) reads the module's summary from its scope-bound store; Rooms exposes `summary() → { activeCount, archivedCount }`; Devices exposes `summary() → { activeCount, needsAttentionCount, outOfServiceCount, archivedCount }`; Finance exposes `summary(today) → { month, monthTotalMinor, monthFixedMinor, monthVariableMinor, currency, activeCycles[], nextCommitment }`. The Dashboard itself never imports module data code (enforced by a static test).

## Rooms module layering

```
page / form / detail / widget  (UI: DOM only, permission-aware)
        │  getRoomsStore(ctx)
rooms-store  (live snapshot, actions: create, update, archive, restore, move)
        │  repo.watchRooms / create / patch / patchMany
room-repository  (paths.homeCollection(homeId,'rooms') + core/data)
        │
core/data/firestore.js  (watchCollection, createDoc, patchDoc, atomicWrite — shared)
```

- **Concurrency.** Edits send only the fields the user changed relative to what the form showed, so a concurrent edit to another field survives. Reorders are one atomic batch that renumbers 1..n, which also repairs duplicate sortOrders.
- **Real time.** All screens render from the live snapshot, so create, edit, archive and restore appear without reloads.

## Module registry contract

```js
defineModule({
  id: 'expenses',                      // camelCase; also the permission namespace
  nameKey, descriptionKey,             // i18n keys
  icon: '💰', accent: 'emerald',       // tile identity
  route: '/m/expenses',
  order: 10,
  enabled: false,                      // true once implemented (then page() is required)
  viewPermission: 'expenses.view',
  permissions: standardPermissions('expenses', { extra: ['complete'], childCan: ['view'] }),
  page: () => import('./page.js'),     // { mount(outlet, ctx) -> unmount? }
  dashboardWidget: { order, size: 'sm'|'md'|'lg', load: () => import('./widget.js') },
});
```

What derives from the registry:
- **Navigation** (sidebar and dock): enabled modules the user can view.
- **Dashboard tool tiles:** visible modules; planned ones show "Coming soon".
- **Dashboard widgets:** enabled modules with `dashboardWidget` (Rooms in Phase 2).
- **Default role permissions:** each permission's `defaultRoles`.

The `ctx` passed to pages and widgets is `{ getState, registry, session, prefs, navigate, services }`. Modules read the Home, membership and permissions from `getState()` and must use the shared data layer (`core/data/firestore.js` + `paths.homeCollection/homeDoc`), never their own Firebase.

## UI / design conventions

- Visual identity carried over from the previous HomeHub:
  - slate neutrals with a blue-600 → indigo-600 brand gradient;
  - the 🏠 brand tile, and 2rem-radius cards;
  - Inter (LTR) and Cairo (RTL);
  - an 80px desktop sidebar, a sticky glass top bar, and a mobile/tablet bottom dock (below 1024px);
  - emoji module identities on tinted tiles.
- The dashboard hero (gradient card carrying the Home name) is the one bold element.
- Tokens live in `assets/css/tokens.css`. Dark mode is `[data-theme='dark']`, and module accents are `.accent-<name>`.
- RTL uses CSS logical properties only (`inset-inline-start`, `margin-inline-*`, `border-inline-end`). No left/right-specific layout.
- Accessibility:
  - skip link, `:focus-visible` outlines, and 44px touch targets;
  - `aria-live` status and toasts, and labelled fields with error text;
  - the menu supports keyboard and Escape;
  - `prefers-reduced-motion` is respected.
- Copy: sentence case, plain verbs, and errors that say what happened and what to do. No raw Firebase messages are shown.

## Coding conventions

- ES modules, `const`/arrow functions, 2-space indentation, single quotes.
- Pure logic (resolver, registry, state machine, setup plan, context resolver) has **no** Firebase or DOM imports and is unit-tested in Node.
- Services throw `AppError(code)`. UI maps `code` → `error.<CODE>.title/.body`.
- Every user-visible string goes through `t()`, with keys in both `ar.js` and `en.js` (parity is tested). Counts use `tp(base, n)`, which picks the CLDR plural form; Arabic needs zero/one/two/few/many/other.
- DOM is built with `h()`; never `innerHTML`. User-entered text gets `dir="auto"`.
- Modals use `ui/components/dialog.js` (native `<dialog>`). Destructive actions use `confirmDialog` with text labels, and focus defaults to Cancel.
- No `window.*` globals, no `console.log` (use `log`), and no `localStorage` outside the preference cache and debug flag.
- Writes always set `updatedAt: serverTimestamp()` (and `updatedBy` where the schema has it).

## Phase 4A — Family & Members

```
src/core/family/
  invite-model.js     PURE: secure code, expiry/state, member types, accept-batch builder
  member-model.js     PURE: normalisation, directory (uid → name, incl. former members), actions
  join-service.js     PURE orchestration: load invite + classify, commit the acceptance batch
  family-store.js     PURE live store (scope resource 'family'): directory, invites, member actions
  family-repository.js / family-service.js   Firestore access / scope-bound accessor
src/ui/pages/family-page.js, join-page.js   (lazy-loaded from main.js — see below)
src/ui/components/invite-card.js
```

- **One auth lifecycle.** Sign-up (`createAccount`) is a method of the existing auth service, and the single `onAuthStateChanged` observer continues the flow. `session.acceptInvite` / `session.switchHome` run inside the existing state machine.
- **Joining.** From first-time setup, acceptance creates the profile and membership, then the home resolves. From inside another home, the member joins **without** switching; "Switch now" is an explicit second step. Invite links (`#/join/CODE`) survive sign-out, sign-in and account creation.
- **Member directory.** `getFamilyStore(ctx).directory()` resolves uid → display name (including people who left), so "Added by Sara" never needs a per-row read. Finance consumes it; other modules can too.
- **Lazy pages.** `main.js` must never statically import anything that reaches the Firebase SDK, so the "can't connect" screen keeps working. The Family/Join pages load via dynamic `import()`, and a static test walks `main.js`'s import graph to enforce this.
- **Registry.** A module may declare `alsoVisibleWith` permissions. Finance lists `expenses.personal`, so a child (no `expenses.view`) can open Finance for their own allowance.

Listener counts per signed-in Home (shared by every screen; all disposed with the scope):

| Store | Phase 4 | Phase 4A |
|---|---|---|
| rooms | 1 | 1 |
| devices | 1 | 1 |
| finance (5 collections × household/mine) | ≤ 10 | ≤ 10 |
| family: members (needs `members.view`) | 0 (one-off `listMembers` read) | 1 |
| family: invites (needs `members.invite`) | — | 1 |
| context watchers (member, role, home) | 3 | 3 |

## Phase 5 — Life Savings & Zakat

```
src/modules/savings/
  quantity.js        PURE  precision: minor units, milligrams, BigInt mulDiv (half-up), basis points
  savings-model.js   PURE  asset/event model, privacy labels, allocations, balances
  valuation.js       PURE  quotes, derived purity, freshness, valueOf, visible portfolio
  hijri.js           PURE  Umm al-Qura via Intl (islamic-umalqura); Hawl end; 354-day fallback
  zakat-engine.js    PURE  profile, Nisab, per-owner holdings, Hawl reconstruction, assessment
  providers.js       provider interface; HTTP provider (server endpoint; unconfigured by default)
  savings-store.js   PURE  scope-bound live store (6 listeners) + all writes (atomic batches)
  savings-repository.js / savings-service.js / collections.js
  page.js, zakat-tab.js, savings-dialogs.js, savings-ui.js, widget.js
```

- The three questions stay separate: **events** answer what is owned, **quotes** answer what it is worth, and the **engine** answers the Zakat estimate. None of them writes the others' data.
- Valuation and Zakat are computed on demand from the store; opening a page writes nothing.
- Hawl is evaluated at change points (event dates, quote dates, today). Missing price history is reported (`historyIncomplete`), never assumed.
- Savings reads Family (member directory, guardians) and Finance (wallets) only through their services' shared stores, so it adds no extra listeners.

Listener counts per signed-in Home:

| Store | Phase 4A | Phase 5 |
|---|---|---|
| rooms / devices | 1 / 1 | 1 / 1 |
| finance | ≤ 10 | ≤ 10 |
| family | ≤ 2 | ≤ 2 |
| **savings** (assets×2, events×2, quotes, zakat) | — | **≤ 6** (4 without `savings.view`) |
| context watchers | 3 | 3 |

## Phase 5.1 — Legacy Home adoption

```
src/core/home/legacy-adoption.js          PURE  classify, write set (defaultRoles), in-memory Home defaults
src/core/home/legacy-adoption-service.js  PURE  re-detect fresh → one atomic batch (repo/writer/time injected)
src/core/home/context-resolver.js         detectLegacyHome() when membership is missing → specific error
src/core/lifecycle/session-controller.js  adoptLegacyHome(): ERROR → RESOLVING_CONTEXT → adopt → resolve
src/ui/screens/error-screen.js            upgrade screen (EN/AR); no "new home" option there
main.js                                   wires the Firestore writer/time lazily (SDK stays off the static graph)
```

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
