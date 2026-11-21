# HomeHub V5 — Security Model

```
Firebase Authentication  +  ACTIVE Home membership  +  Role permissions  =  Authorization
```

Security rules (`firestore.rules`) are authoritative. Hiding things in the UI is a convenience, not security.

## Principles

1. **Identity = `request.auth.uid`.** No client-supplied field can stand in for it. No UID is hard-coded anywhere.
2. **Authorization = membership.** `homes/{h}/members/{uid}` with `status == 'active'`, whose `roleId` points to an existing role.
3. **`users/{uid}.defaultHomeId` grants nothing.** It is only a pointer. Every read re-checks membership.
4. **Default deny.** Anything not explicitly allowed is denied, including all future module collections until their phase adds rules.
5. **Server clocks only.** `createdAt` and `updatedAt` must equal `request.time` (`serverTimestamp()`).
6. **Exact shapes.** Creates use `hasAll` + `hasOnly` key sets, and updates restrict `affectedKeys()`. Protected fields (`createdBy`, `createdAt`, `rank`, `system`, `schemaVersion`) are immutable.

## The permission check

```
grants(perms, ns, action) = '*' in perms || (ns + '.*') in perms || (ns + '.' + action) in perms
can(h, ns, action)        = isActiveMember(h) && role exists && grants(role.permissions, ns, action)
```

`src/core/permissions/resolver.js` implements exactly the same grammar for the UI (`can('expenses.view')`).
`tests/static` asserts that the rules contain this expression.

## Bootstrap (first-time setup) — how a user creates a Home before any membership exists

Problem: normal writes require an active membership, but a new Home has none.

Solution: `isBootstrap(h)` is true only when **all** of the following hold in the same request (a write batch):

| Condition | Why |
|---|---|
| `!exists(homes/h)` | The home did not exist **before** this request. You cannot "bootstrap" into someone else's home. |
| `existsAfter(homes/h)` and `getAfter(homes/h).createdBy == request.auth.uid` | The same batch creates the home, and it's created by the caller. |
| `getAfter(members/{request.auth.uid}).roleId == 'owner'` and `status == 'active'` | The same batch creates the caller's **own** owner membership. |

What uses it:
- `homes/{h}` create: bootstrap, plus a shape check where `createdBy == auth.uid`.
- `members/{u}` create: `u == auth.uid`, plus bootstrap, plus a shape check (`roleId == 'owner'`, `status == 'active'`, email equals the token email). **This is the only way a membership can be created in Phase 1.**
- `roles/{r}` create: bootstrap, plus `r` is a system role id. The owner role must be exactly `["*"]` at rank 100, and all others rank below 100.
- `settings/general` create: bootstrap, plus a shape check.
- `users/{uid}` create/update: self only; `defaultHomeId` must be null or a home where the caller is (after the batch) an active member.

Why this is safe:
- **Another UID as creator or owner:** blocked by `createdBy == auth.uid` and `members/{u}` requiring `u == auth.uid`.
- **Joining or taking over an existing home:** blocked by `!exists(homes/h)`.
- **Adding other people during bootstrap:** non-self member creation has no allow path.
- **A batch missing the owner membership:** fails as a whole, because batches are atomic.
- **Creating unlimited homes for yourself:** possible and harmless (known limitation; can be capped later).

## After bootstrap

| Resource | Read | Write |
|---|---|---|
| `users/{uid}` | self | self, limited fields, server timestamps |
| `homes/{h}` | active member | `home.edit`: name/currency/timezone/language only; `updatedBy == auth.uid` |
| `members/{u}` | self always (even suspended, so the app can explain); others need `members.view` | self: `displayName` only. Others need `members.edit`, `roleId`/`status` only, target and new role must rank below the caller (owner exempt); nobody edits their own role/status; nobody grants or removes `owner`. No create (except bootstrap) and no delete in Phase 1 |
| `roles/{r}` | own role, or `roles.view` | `roles.edit` (owner by default): names/permissions only; rank and system immutable; owner role stays `["*"]`; only the owner may grant `"*"` or edit roles at or above their own rank. No create (except bootstrap) and no delete |
| `settings/general` | active member | `home.edit`, `weekStartsOn` only |
| `rooms/{roomId}` (Phase 2) | `rooms.view` (get and list) | See below |
| `devices/{deviceId}` (Phase 3) | `devices.view` (get and list) | See below |
| finance (Phase 4): wallets, expenses, walletMovements, spendingCycles, commitments | Household label + `expenses.view`, **or** listed reader | See below |
| anything else | denied | denied |

### Rooms (Phase 2)

Each kind of change has its own narrowly shaped path:

| Operation | Permission | Allowed fields | Extra conditions |
|---|---|---|---|
| create | `rooms.create` | exactly the 14 schema keys | content valid; `active == true`; archive fields null; `createdBy == auth.uid`; server timestamps; `schemaVersion == 1` |
| edit / reorder | `rooms.edit` | name, type, icon, floor, notes, sortOrder, updatedBy, updatedAt | room must be **active**; content re-validated on the merged document |
| archive | `rooms.delete` | active, archivedAt, archivedBy, updatedBy, updatedAt | was active; `active == false`; `archivedAt == request.time`; `archivedBy == auth.uid` |
| restore | `rooms.restore` | active, archivedAt, archivedBy, sortOrder, updatedBy, updatedAt | was archived; `active == true`; archive fields null; valid sortOrder |
| delete | none | — | **always denied** (ids must stay resolvable) |

- `createdBy`, `createdAt` and `schemaVersion` are in no update allow-list, so they can never change.
- `updatedBy` must always be the caller, with server time.
- Archive and edit can't be combined in one write.
- Content validation (`validRoomContent`) mirrors `src/modules/rooms/room-model.js`:
  - name 1–60 non-blank;
  - type in the 16 ids;
  - icon id pattern;
  - floor/notes null or 1–40 / 1–500 non-blank;
  - integer sortOrder 0–1e9.

  A static test asserts the rules and model agree.
- Tenant isolation: the rule sits under `match /homes/{h}` and every check uses `can(h, …)`. A member of one Home has no path to another Home's rooms. There is no root `rooms` collection and none under `users/`.
- Default role grants: owner `*`; admin `rooms.view/create/edit/delete/restore`; member, viewer, child `rooms.view`.

### Devices (Phase 3)

| Operation | Permission | Allowed fields | Extra conditions |
|---|---|---|---|
| create | `devices.create` | exactly the 23 schema keys | content valid; `roomId` null **or** an existing active room of this home; `active == true`; `createdBy == auth.uid`; server timestamps; `schemaVersion == 1` |
| edit (metadata, status, move) | `devices.edit` | the 15 editable fields + updatedBy/updatedAt | device active; content re-validated; **if `roomId` changed**, the new value must be null or an active room of this home |
| archive | `devices.delete` | active, archivedAt, archivedBy, updatedBy, updatedAt | was active; `archivedBy == auth.uid`; `archivedAt == request.time` |
| restore | `devices.restore` | same as archive | was archived; archive fields cleared; `roomId` untouched (it may point to an archived room) |
| delete | none | — | **always denied** |

- **Room reference safety.** `isActiveRoom(h, roomId)` reads `homes/$(h)/rooms/$(roomId)`; the path is built from the device's own home. A room id from another home can never match, and `roomId` must be a plain id (`^[A-Za-z0-9_-]{1,128}$`), so it can't inject a path.
- **Archived-room edits.** The rule checks `'roomId' in changed()` before requiring an active room. A device whose room was archived *later* can still have its brand, status or notes edited, and can be archived or restored. Moving any device *into* an archived room is denied.
- **Taxonomy.** Category → subtype map, statuses, field lengths, `YYYY-MM-DD` dates, price ≥ 0 with a required currency (null price ⇒ null currency). The rules map is generated from the model, and a static test fails if they differ.
- `createdBy`, `createdAt` and `schemaVersion` appear in no update allow-list. Archive and edit can't be mixed in one write.
- Defaults: owner `*`; admin `devices.view/create/edit/delete/restore`; member, viewer, child `devices.view`. `devices.delete` means **archive**.
- Cost: each device write does at most 3 document reads (membership, role, room), well within limits.

### Finance (Phase 4)

**Privacy model (enforced by rules, not by hiding UI):**
- Every finance record carries `audience` and `readers`, derived from its wallet(s). The rules verify the labels match the wallet (`access0/1/2`), so a client can't choose them.
- **Read** (`canReadFinance` in firestore.rules) requires an active membership **and** either (`audience == 'household'` and `expenses.view`) or (caller ∈ `readers`).
- **Household** wallets → household audience.
- **Private** personal wallet → readers = [owner].
- **Shared** personal wallet → readers = owner + selected members (≤5, each must be a member of this home).
- **Child allowance** → owned by the child, shared with the parents.
- **The Home owner/admin get no implicit access to another adult's private wallet.** `*` grants permissions, and permissions only reach household-labelled records.
- Transfers touching a household wallet are household-visible (the money left shared funds), plus the private side's readers.
- Firestore rules are not filters, so the app only issues the two provable queries (`audience == 'household'`, `readers array-contains uid`). An unconstrained list is denied (tested).
- Changing a wallet's sharing re-labels all its records in the same batch. The rules accept the re-label only when it matches the wallet's new readers, and only from one of its readers.

**Writes:**
- *Household wallets* need the role permission for the action:
  - `create` / `edit` / `delete` (void) for expenses;
  - `transfer` for movements;
  - `manageBudgets` for cycles;
  - `manageCommitments` for commitments;
  - `manageWallets` for the wallets themselves.
- *Personal wallets* need the caller to be one of the wallet's readers plus `expenses.personal`.
- Editing an expense needs permission on the old **and** the new wallet.

**Identity and audit:**
- `createdBy == request.auth.uid` and server timestamps on every create.
- `createdBy`, `createdAt`, `schemaVersion`, `source`, `originalRow` and `importBatchId` are immutable.
- A wallet's `ownerUid` and `currency` never change. A member can't create a wallet owned by someone else unless they hold `manageWallets`.

**Integrity:**
- Integer money only.
- Wallet, cycle and commitment references must exist **in the same home** (paths are built from `{h}`).
- Transfers require one currency on both sides (no silent conversion).
- Commitment payment: the expense id must be `cm_{id}_{due}` and the commitment must advance in the same batch. The advance itself requires that the payment did not exist before. Double payment is impossible.

**`expenses.viewFinancialTotals`** controls **presentation** of aggregates, balances and budgets. Anyone who can read records could add them up, so true financial secrecy comes from not granting `expenses.view` (the child role has only `expenses.personal`).

**Import** (`source: 'import'`) requires `expenses.import`, which is owner-only by default. Imported records are household, walletless history.

**Defaults:**

| Role | Finance permissions |
|---|---|
| owner | `*` |
| admin | everything except `import` |
| member | `view, viewFinancialTotals, create, edit, personal, transfer, manageBudgets` |
| viewer | `view` |
| child | `personal` |

Phase 4 changed **no** existing rule. Compared with Phase 3, the diff adds finance helper functions and five finance match blocks (plus the header comment).

Phase 3 changed **no** existing rule. Compared with Phase 2, the diff adds device helper functions and the `devices` match block only (plus the header comment).

Phase 2 changed **no** existing rule. The diff against Phase 1 adds helper functions and the `rooms` match block only. Home, membership, role, settings and user rules are untouched.


### Family & Members (Phase 4A)

**Rule changes to EXISTING rules (all in `homes/{h}/members/{u}`):**
1. `create`: the Phase 1 bootstrap condition is unchanged (only parenthesised) and OR-ed with the new **join-by-invitation** path.
2. Manager role/status edit: unchanged, except one **tightening**: it now applies only to `active`/`suspended` members. A removed member can no longer be reactivated by a role edit; they must be re-invited.
3. New update paths:
   - **remove** (`members.remove`, status only, never the owner, below your rank);
   - **guardians** (`members.manageChildren`, children only, 1–5 active adults, never the child);
   - **leave** (self, non-owner);
   - **re-join** (removed/left, only via a valid invitation).

No other existing rule changed. Finance rules are untouched.

**Invitations (`invites/{code}`):**

| Operation | Who | Enforced |
|---|---|---|
| get | any signed-in user **with the exact code** | code format; no enumeration (list only for inviters, filtered by `homeId`) |
| create | `members.invite` in that home | `createdBy == auth.uid`; `homeName` equals the real home name; role in admin/member/viewer/child and below the caller's rank (owner: any non-owner); child invites need 1–5 active guardians; expiry in (now, now + 14 days]; status pending |
| accept | the caller | pending → accepted once; `acceptedBy == auth.uid`; `acceptedAt == request.time`; before expiry; the caller's membership for **that** home is created in the same batch with role / relationship / guardians **copied from the invite**; an active member cannot re-accept |
| cancel | `members.invite` in that home | pending → cancelled, attributed |
| delete | nobody | invites are kept for audit |

**Threats considered:**
- **Guessing codes:** about 117 bits.
- **Reusing a used or cancelled invite:** status must be pending.
- **Expired invites:** `request.time` is checked.
- **Accepting for someone else:** acceptance is bound to `request.auth.uid`.
- **Choosing a stronger role:** the role is copied from the invite and checked in the membership rule.
- **Switching Home:** the invite's `homeId` must equal the membership's home.
- **Mutating an invite after creation:** only the accept and cancel shapes are allowed.
- **Accepted invite without membership:** both writes are checked with `getAfter`.
- **Self-promotion:** a member can't edit their own role or status.
- **Admin escalation:** rank checks.
- **Owner removal / ownerless Home:** the owner is immutable.
- **Guardian-as-admin:** guardianship is data, not a role.
- **Removed members:** every read requires an active membership.

**Financial privacy semantics (honest):**
- **Record-level, rules-enforced:** private and shared wallets and their records (readers lists), and household records (`expenses.view`).
- **`expenses.viewFinancialTotals` is a presentation gate only:** anyone who can read household records could add them up. Real secrecy comes from not granting `expenses.view`.
- **The child role has no `expenses.view`:** children cannot read household finance data at all.
- **Home ownership grants no access to another adult's private wallet.**

## Threats considered (Test D)

| Attempt | Blocked by |
|---|---|
| Read a home without membership | `homes` get requires `isActiveMember` |
| Give yourself privileges in another home | No member create outside bootstrap; bootstrap requires the home not to exist |
| Change your own role/status | `members` update: self may change `displayName` only |
| Admin promotes self or others to admin/owner | Rank checks plus explicit `!= 'owner'` |
| Edit protected role data | `roles.edit` is owner-only by default; rank immutable; owner locked to `["*"]` |
| Spoof another UID | Every identity check uses `request.auth.uid` / token email |
| Bypass the UI with raw Firestore calls | Rules are evaluated server-side for every call |
| Forge timestamps | `== request.time` |

All rows (plus the Rooms cases) are covered by `tests/rules/rules.test.mjs` (55 tests: Phase 1, Rooms, Devices, Finance). **These tests REQUIRE the Firestore emulator and were not run in the build environment.**

## Client-side hygiene

- One Firebase initialization (`src/core/firebase/firebase.js`). The SDK is imported only in `src/core/firebase/sdk.js`.
- Only the normal public web config is shipped. There is no Admin SDK and no service accounts.
- Passwords go straight to Firebase Auth and are never stored or logged. The logger never receives tokens.
- All UI text is inserted as text nodes (`src/core/utils/dom.js`). There is no `innerHTML` anywhere (enforced by a static test).
- Raw Firebase errors are mapped to friendly messages; only a short error code is shown as a reference.
- Password-reset responses are identical whether or not an account exists.
- Hosting adds `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options: DENY` headers.

## Known limitations

- No App Check yet (recommended before inviting other people).
- Home deletion, member removal and invitations are denied until their phases.
- Rooms have no per-Home count limit in the rules.
- No cap on homes per user.

### Phase 4A security fixes found during testing

- **Child could un-share an allowance wallet (fixed).** A child owner could edit a guardian-created allowance wallet, removing the guardians from its readers and escaping oversight. The personal-wallet update rule now allows changes only by the wallet's **creator**, or by the **owner when the owner is not a child**. This is the one Finance rule changed in 4A, and it is a tightening. Covered by an emulator test (child denied re-share/archive, guardian allowed) and by browser M18 (no Edit/Archive controls for the child).
- **Startup resilience regression (fixed).** `main.js` briefly imported Firebase-backed pages statically. An unreachable SDK would then have broken the whole app instead of showing "HomeHub can't connect". The pages are now lazy-loaded, and a static test enforces it.

### Life Savings & Zakat (Phase 5)

- **Read** (`canReadSavings`): an active member AND either a household-audience record + `savings.view`, or the caller is in `readers`. Rules are not filters, so the app only issues `visibility/audience == 'household'` or `readers array-contains <me>` queries; any unconstrained listener on these collections is denied.
- **Owner bypass: none.** Ownership of the Home grants no access to another adult's `savingsAssets`, `savingsEvents` or `zakatRecords`. Emulator tests cover:
  - owner denied her private savings;
  - the wife reads her own;
  - shared → the owner reads;
  - un-shared → the owner is denied again.
- **Ownership:** a personal asset is created for yourself (`savings.personal`) or, as an **explicit guardian** (`guardianUids` on the child's membership), for your child. The Home owner is not a guardian by role. `ownerUid`, `scope`, `type`, `currency`, `createdBy` and `createdAt` are immutable.
- **Sharing:** readers must equal owner + `sharedWith` exactly, and shared members must be members of this home. Only the creator, or a non-child owner, may change sharing, so a child cannot un-share from guardians. Re-labelling an asset's events requires labels equal to the asset's.
- **Events:**
  - Append-only, with a signed `qty` by type and a unit that matches the asset.
  - Access labels are copied exactly from the asset.
  - A transfer leg requires its partner (or the linked wallet movement) in the same batch, and the wallet movement requires its savings leg.
  - No update except privacy re-labelling; no delete.
- **Prices:**
  - Only `source: 'manual'` from clients, so a client cannot claim "live".
  - `observedAt` must be within ±10 min of server time, so no back-dating.
  - Append-only; any active member can read.
- **Zakat records:**
  - Written by the owner or their guardian (`savings.zakat`), readable only by `readers`, append-only.
  - A payment's `linkedExpenseId` must be `zk_<recordId>`, exist in the same batch, and have category `zakat` and the same amount, so there is exactly one expense. Re-creating it is denied.
- **Removed members:** `isActiveMember` fails, so they lose access. Their private assets are not transferred to anyone and remain unreadable to the owner.
- **Secrets:** no provider API keys anywhere in the client. `PRICE_ENDPOINT` is a URL of *your* server, which holds any key.
- **Hard delete:** denied on all four collections.

### Legacy Home adoption (Phase 5.1)

**Rules:**
- `isUnadoptedCreator(h)`: the **stored** `createdBy` equals the caller, and the caller has no membership in that Home.
- `isLegacyAdoption(h)` additionally requires, all proven from stored state:
  - no `roles/owner` before the batch;
  - `users/{caller}.defaultHomeId == h`;
  - the Home document byte-identical before and after (`getAfter == get`);
  - after the batch: the caller's own `owner` / `active` / `legacyAdoption:true` membership, and `roles/owner` with `["*"]` at rank 100.

**Reads:** the stored creator may `get` their own Home doc and individual role docs only while not a member. There is no `list`, and nobody else can read.

**Writes:**
- Member create (adoption path): exact keys; self only; owner; active; `addedBy` = self.
- Role create (adoption branch): system ids only; `templateVersion == 6` (kept equal to `ROLE_TEMPLATE_VERSION` by a static test); `"*"` only for owner. Create-only, so existing or custom roles can never be overwritten.
- Bootstrap (`isBootstrap`) is unchanged and still requires a brand-new Home.

| Question | Answer |
|---|---|
| Can another authenticated user claim the Home? | **No.** The stored `createdBy` must equal the caller, and a non-member cannot change it (Home updates require membership). Tests L2, L4, L13, plus the E2E attacker flow. |
| Can a user change `createdBy` and then claim it? | **No.** Editing the Home requires an active membership, and the adoption batch must leave the Home byte-identical. Test L5. |
| Can adoption overwrite an existing Owner? | **No.** It requires no `roles/owner` beforehand (which every initialised Home has), and member/role writes are create-only. Tests L10, L11. |
| Can adoption overwrite custom roles? | **No.** Create-only; system ids only; existing roles are skipped by the client and refused by the rules. Test L14. |
| Can adoption run twice? | **No.** A membership and `roles/owner` now exist. A client retry writes nothing (`alreadyMember`). Tests L11, L12. |
| Can adoption modify Devices/Finance/Savings? | **No.** Every business rule checks the *pre-batch* membership, which doesn't exist, so extra writes in the batch fail. Unit tests also prove those documents are byte-identical. Test L15. |
| Can Owner adoption expose another adult's private Finance/Savings? | **No.** Owner grants `*` role permissions, but private records are gated by `readers`, which Owner adoption does not change (Phase 4/5 privacy model). |
| Does new-Home bootstrap still work? | **Yes.** `isBootstrap` is unchanged. Test L19 and all bootstrap tests. |
| Is cross-Home isolation intact? | **Yes.** Test L20, and the existing cross-Home tests. |

### Phase 5.1.1 rules repair

- List concatenation must use `.concat()`. `[a] + b` is unsupported and raises an evaluation error, which means **deny**. Five occurrences made legitimate personal-wallet, private-transfer and personal-savings writes fail. Fixing them did not widen any rule: readers must still equal owner + `sharedWith` exactly. A static guard prevents regressions.
- Hot helpers evaluate each document once (`canWith`, `accessW`, `expenseWalletOkW`, `savingsEventCreateOk`, `joinsByInviteI`) to stay well within the 1000-expression limit. Hitting that limit also means **deny**, never allow.
- Status: **REQUIRES FIREBASE EMULATOR RERUN**; see PHASE-5.1.1-CHANGE-REPORT.md.

### Phase 5.1.2

- **Query-safe privacy reads.** Rules evaluate a query against its constraints only, and reading an unconstrained field is an evaluation error that denies the whole query. Optional `audience` / `visibility` are therefore read with `.get(…, '')`. The `readers` branch keeps its proven form. Semantics are unchanged: household records need the view permission; restricted records need the caller in `readers`.
- **Reordered conjuncts** (members, devices) for expression headroom. No condition was removed, so nothing is widened.
- See PHASE-5.1.2-RULES-REPORT.md (the production comparison is pending: the file was not received).

### Phase 5.2: Zakat sharing and payment linkage

- `zakatRecords` **update:**
  - **only `readers`** may change;
  - only by the record's **owner** or a **guardian of a child owner** (`savings.zakat`);
  - the owner, the caller and all of a child's guardians must remain;
  - readers are members of this Home;
  - **no Home-owner or admin override.**

  Content stays immutable; delete is denied. Revocation removes get **and** query access immediately (reads require `uid in readers`).
- `payment.snapshotId` must be null or reference a `snapshot` of the **same owner** (existing or created in the same batch).
- Tests: emulator Z1–Z8 use `assertDenied`, which fails if a denial was produced only by the 1000-expression limit (`STRICT_DENIALS=1` applies this suite-wide).

### Phase 5.2.1: rule-evaluation repair

- Multi-path rules use **dispatch** (`d ? A : (B || C)`) instead of evaluating every path. This is equivalent because each discriminator is implied by exactly one path's own conditions, and paths that can both accept a request are kept in an `||`. On a denial, the evaluator no longer runs every path's full validation, so a denial is reached by the intended condition rather than by the 1000-expression limit.
- Helpers keep the same truth table: `can()` / `roleGrants`, `grants()` via `hasAny`, `can && (owner || guardian)`, wallets and calculations bound once, and `oneOf(a, b)`.
- `npm run test:rules:strict` makes **every** denial assertion fail if it was produced by the expression limit.
- Details and per-rule equivalence: PHASE-5.2.1-SECURITY-IMPACT.md.

## Phase 5.4c: AI routine import privacy boundary

- **No AI service is called** by the app; there are no keys, no network calls and no Cloud Functions.
- The prompt contains **only what the user ticks**. It never includes member names, emails, finances, savings, Zakat, notes or ids.
- **Pasted JSON is untrusted:**
  - `JSON.parse` only; ≤ 100 KB, depth ≤ 6;
  - `__proto__` / `constructor` / `prototype` rejected; unknown, forged or id/path fields rejected;
  - URLs and control characters rejected;
  - rooms and devices are resolved only against the active household;
  - rendered with `textContent`.
- **Nothing is written before an explicit confirm.** Raw prompts and JSON are never stored.

## Phase 5.6: Reminders

- **Reminders are derived client-side** from subscriptions the user is already authorized for. The new rules grant nothing on Cleaning / Maintenance data.
- **Presentation state is owner-only:** other members of the same Home can't read, list, write or delete it.
- **No background delivery exists;** the UI says so explicitly.
- **The data-layer `delete`** is restricted by a static test to reminder state; module collections keep `allow delete: if false`.

## V6.4 Batch B: Shared Contacts

| Action | Owner | Admin | Member | Viewer | Child | Non-member / other Home |
|---|---|---|---|---|---|---|
| Read live contacts and categories (`contacts.view`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Read soft-deleted contacts: direct get or query (`contacts.view` + `contacts.delete`) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Add manually (`contacts.create`) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Edit, change the shared favourite (`contacts.edit`) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Import a `.vcf` (`contacts.import`) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Export a `.vcf` (`contacts.export`, client-side) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Soft delete / restore (`contacts.delete`) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Create / rename / remove categories (`contacts.manageCategories`) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Hard delete a contact | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

- **Household isolation:** every rule is under `homes/{h}` and gated by `can(h, 'contacts', …)` (active membership + role grant). There is no root collection.
- **Strict shape:** exact keys; every string is length-bounded; numbers and labels are validated by regex, so the stored value can never be a `javascript:` / markup payload. Names and notes are free text and are rendered with `textContent` only.
- **Audit:** `createdBy` / `updatedBy` / `deletedBy` must be the caller; `createdAt` / `updatedAt` / `deletedAt` must be the server time; `createdBy`, `createdAt`, `source` and `schemaVersion` are immutable.
- **Deleted contacts are hidden (rev 2):** the read rule is `can(view) && (resource == null || resource.data.deleted == false || can(delete))`. A get of a missing id reveals nothing. A deleted id is unreadable, so an importer without delete rights only learns "it exists, hidden" and nothing about its content.
- **Import idempotency (rev 2):**
  - Creates use a deterministic id (copy 0). A `set` on an existing id is evaluated as an update, and `rev == 1` can never equal `resource.rev + 1`, so it is always refused.
  - The client then reads the document and reports **already** (identical import), **kept** (changed since), **deleted** (not restored) or **hidden**.
  - A new copy id is used only for an explicit **Keep separate** or **Add as separate**.
- **No silent overwrite:** every update is `rev + 1`. A stale editor or a merge confirmed against an older revision is refused and the user re-confirms. Imports are create-only (an existing id is never overwritten).
- **Export is a separate right.** Viewing contacts does not let a viewer or child download the whole directory. The export happens in the browser after a personal-information warning. Nothing leaves the device otherwise.
- **Import:** parsed in the browser (≤ 1 MB, ≤ 500 records, bounded lines). Nothing is written before the user confirms the preview. Photos and other media are discarded.
- **Dialer and WhatsApp:** `tel:` links and `https://wa.me/<digits>` are built only from validated numbers. A national number asks for a country code (never guessed). WhatsApp opens with `noopener,noreferrer`.
- **Existing Homes:** the owner (`*`) has everything at once. Admins and members get import / export / category management after the owner uses **Update default roles** (template v9, additive: custom grants are kept).

## V6.4 Batch C: contact pictures and restaurant menus

| Action | Owner | Admin | Member | Viewer | Child | Non-member / other Home |
|---|---|---|---|---|---|---|
| See pictures and open menus (`contacts.view`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Add a contact with a picture or menus (`contacts.create`) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Set, replace or remove a picture; add, reorder or remove menus (`contacts.edit`) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Import media through `.vcf` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Change media on a deleted contact | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

- **Validation in the client and the rules:**
  - https only;
  - no credentials, executable schemes (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:` and so on), IP addresses or bare `localhost`;
  - no prohibited host names (rev 2): `*.localhost`, `.local`, `.localdomain`, `.internal`, `.intranet`, `.lan`, `.home`, `.home.arpa`, `.corp`, `.private`, and the wildcard-DNS services `nip.io`, `sslip.io`, `xip.io`, `localtest.me` and `lvh.me`;
  - menus are validated element by element (rev 2), so combined or split entries are refused;
  - URLs ≤ 500 characters, ≤ 10 menus, labels ≤ 40 characters;
  - exact key list, `rev + 1`, caller stamps, and tenant isolation under `homes/{h}`.
- **Rendering:** URLs are only assigned to `img.src`, `iframe.src` and `a.href`. User text is set with `textContent`; there is no HTML sink (static test).
- **Privacy:**
  - Pictures use `loading="lazy"` and `referrerpolicy="no-referrer"`, with no credentials (no `crossorigin`).
  - Menus make no external request until the Menu section is opened, and a Drive preview loads only on "Show preview". The section collapses again when you leave the contact.
  - The editor explains that the hosting site can see that a picture or menu was viewed.
- **Embedding:**
  - Only Google Drive and Google Docs file links are embedded, through their official `/preview` URL; private files stay private and sharing is never changed.
  - The iframe uses `sandbox="allow-scripts allow-same-origin"` (no top navigation, popups, forms, modals or downloads), `allow=""`, no referrer and lazy loading.
  - The CSP `frame-src` allows only YouTube (recipes) and `drive.google.com` / `docs.google.com`.
  - Iframe `load` is never treated as success; the "blocked or private" hint and **Open original** are always shown.
  - Other PDFs and websites are never embedded. Chromium cannot show PDFs inside a sandboxed frame, phone browsers do not embed PDFs at all, and an unsandboxed frame is not allowed.
- **External navigation:** `target="_blank"` with `rel="noopener noreferrer"` and `referrerpolicy="no-referrer"`.
- **Service worker:** network-only and same-origin navigations only. Cross-origin pictures and menus bypass it and are never cached (static test).
- **Older clients (6.4.0-b):** they write only field-level patches of the Batch B fields, soft delete and restore, so they cannot remove `avatarUrl` or `menus`. Rules emulator test `V64C-3` replays those writes. The new client compares media only when the edit form carries it, treating absent, `null` and `[]` as equal, so a no-op save writes nothing.

## V6.4.1 Stage A: Contacts UI and AI JSON import / export

| Action | Owner | Admin | Member | Viewer | Child | Non-member / other Home |
|---|---|---|---|---|---|---|
| Open the ⋮ management menu (shown only when at least one item is allowed) | ✓ | ✓ | ✓ (Import / Export / AI JSON) | ✗ | ✗ | ✗ |
| AI JSON export (`contacts.export`, client-side, warning first) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| AI JSON import (`contacts.import`; rules: `source: 'json'`) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Import media through AI JSON (validated like a manual add) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Replace an existing picture / menus through a JSON merge | only when ticked per contact (`contacts.edit`, `rev + 1`) | same | same | ✗ | ✗ | ✗ |
| Tile Call / WhatsApp (`contacts.view`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |

- **No AI service is called.** "Copy AI prompt", "Copy schema" and the example file are local text; the user pastes them into a tool of their choice. Nothing leaves the device unless the user does that. The export warning says the file holds personal information.
- **Parsing is defensive:** ≤ 1 MB, UTF-8 only, nesting ≤ 6 checked before `JSON.parse`, ≤ 500 items, the top level must be exactly `{ schema, version, items }` with the known schema and version — anything else rejects the WHOLE file. Items are read key by key from an allow-list (own properties, nothing spread), so `__proto__` / `constructor` / `id` / `createdBy` and any other key make that item invalid (named in the preview); invalid items are excluded, valid ones can still be imported.
- **Same validators and pipeline as .vcf:** every item passes `validateContact` and the contact-media URL checks, then the .vcf duplicate detection, deterministic ids (`vc_…`, create-only, a retry never duplicates), capacity limits and the store's occupied-id classification. Duplicates are skipped by default.
- **No silent overwrite:** a merge keeps every existing value; it only fills empty fields, adds new numbers and unites categories. A conflicting name / organization / e-mail / address / notes / picture / menu list is replaced only when the user ticks that field for that contact. Media are never deleted by an import.
- **Rules:** `source: 'json'` requires `contacts.import`; `source: 'vcf'` still may not carry `avatarUrl` / `menus`; the source is immutable.
- **Navigation:** the in-page history markers are validated on every `popstate` (sub-view allow-list, id pattern, permission check); a forged entry for a view the role may not open falls back to the list.
- **WhatsApp icon:** HomeHub does not draw the WhatsApp logo. The official SVG from WhatsApp's brand resources can be placed at `assets/brand/whatsapp.svg` (same origin); until then a neutral green "WA" badge is shown. The button's accessible name names the contact and number.

### Limits of the external-URL checks (V6.4 Batch C revision 2)

The URL checks are **syntactic and best-effort**. HomeHub has no server, proxy or Cloud Function (Spark plan), so it **cannot**:

- **resolve DNS.** A public-looking name can resolve to a private or loopback address (DNS rebinding, or a host the owner points at `10.x` / `192.168.x`). The deny-list only covers well-known local suffixes and wildcard-DNS services, and is necessarily incomplete.
- **see redirects.** The browser follows them itself when it loads an `<img>` or the Drive frame. An allowed https URL may redirect elsewhere. Browsers still block or upgrade `http:` subresources on this https page (mixed content), and recent Chromium versions restrict public-to-private-network requests (Private Network Access / Local Network Access), but HomeHub does not depend on or guarantee either.
- **inspect content.** A link can change what it serves at any time.

**What this means:** HomeHub does **not** claim complete protection against requests to private networks. Pictures, menu images and frames are requested without a referrer, and HomeHub adds no credentials (no `crossorigin`). The browser still sends that site's own cookies, as for any embedded image. The editor and Menu section tell people that the hosting site sees the request. Only household members with `contacts.edit` can add links.
