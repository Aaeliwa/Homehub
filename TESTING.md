# HomeHub V5 — Testing

Three automated layers, plus a manual live smoke test. Results from the Phase 1 build are recorded at the end.

| Layer | What it proves | Needs |
|---|---|---|
| `npm test` (unit + static) | Permission logic, roles, registry, state machine, session lifecycle and races (with fakes), setup batch shape, i18n parity, error mapping, architecture rules. **Phase 2:** room model (validation, ordering, summary, write shapes), rooms store (CRUD, archive/restore, batch reorder, shared listener, home isolation, scope disposal), rooms permission matrix, Rooms static/security guards | Node 20+ |
| `tests/e2e/run-e2e.mjs` | The real app in Chromium against a **fake** Firebase SDK: Tests A/B/C flows, UI states, RTL/LTR, themes, responsive layout. **Phase 2:** R1–R15 Rooms flows (empty state, templates, add/edit/reorder/archive/restore, persistence, widget counts, shared listener, Arabic, viewer role, logout/login) plus mobile Rooms | Node + Playwright |
| `tests/rules/rules.test.mjs` | `firestore.rules` on the **real rules engine** (Firestore emulator): bootstrap, isolation, escalation. **Phase 4:** 11 Finance tests (household/member/viewer/child access, private wallet denied to another adult and to the owner, shared and child wallets, unconstrained list denied, wallet-create spoofing, expense create/edit/void permissions and labels, integer money, transfer permission + currency + cross-home + private-wallet denial, cycle permissions and close, commitment pay pairing and double-pay denial, owner-only import, cross-home isolation, no hard delete). **Phase 3:** 10 Devices tests (read/create by role, spoofed createdBy, 23 malformed shapes, same-home/existing/active room on create, move into archived room denied, device in a later-archived room still editable/archivable/restorable, edit/archive/restore permissions, audit fields, no delete/root/under-rooms, tenant isolation, v3 role refresh). **Phase 2:** 10 Rooms tests (create shape, malformed writes, role matrix, audit-field protection, archive/restore paths, no hard delete, tenant isolation, suspended members, role refresh) | Java + firebase-tools |
| Manual smoke test (below) | Real Firebase Auth + Firestore in your project | Your Firebase project |

## Commands

```bash
npm test                                            # unit + static (no install needed)

npm i -D playwright && npx playwright install chromium
node tests/e2e/run-e2e.mjs --screens ./screens      # browser E2E (+ screenshots)

cd tests/rules && npm install
npx firebase emulators:exec --only firestore --project demo-homehub "npm test"   # rules
```

The E2E fake (`tests/e2e/fake-sdk/`) replaces the three `gstatic.com/firebasejs` URLs. It persists to `localStorage` so reloads behave like a real session. It enforces only a minimal membership check on reads. **It is not a security test.**

## Manual live smoke test (REQUIRES LIVE SMOKE TEST)

Prerequisites: rules deployed (`firebase deploy --only firestore:rules`), Firestore empty, and your Auth account exists. Open DevTools → Console; on localhost the `[HomeHub]` lifecycle log is visible (elsewhere add `?debug=1`).

### TEST A — new user, empty Firestore
1. Firestore is empty. 2. Open HomeHub → Login (Arabic, RTL). 3. Sign in.
4. **First-time setup** appears (not an error). 5. Enter your name. 6. Enter the home name. 7. Press "إنشاء المنزل".
8. Dashboard opens with your home name in the banner.
9. In the Firebase console you should see:
   - `users/<your uid>` with `defaultHomeId`;
   - `homes/<auto id>` with `createdBy` = your uid;
   - `homes/<id>/members/<your uid>` with `roleId: owner`, `status: active`;
   - `homes/<id>/roles/{owner, admin, member, viewer, child}`;
   - `homes/<id>/settings/general`.

   **Nothing else.**
10. The console shows `Firebase initialized → Authenticated → No profile yet → Home created → Profile resolved → Home resolved → Membership verified → Role resolved → Context ready`.

### TEST B — session
Refresh. The session restores, the dashboard loads, and setup does **not** reappear. The document count in Firestore is unchanged.

### TEST C — logout
User menu → Sign out → Login screen; the home name is no longer on screen. Sign in → the same home loads.

### TEST D — security (live)
The emulator suite covers these in depth. To spot-check against production from the browser console while signed in:
```js
const { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp } =
  await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
const db = getFirestore();
await getDoc(doc(db, 'homes', 'SOME_OTHER_ID'));                         // expect permission-denied
await updateDoc(doc(db, 'homes', '<yourHome>', 'members', '<yourUid>'),
  { roleId: 'admin', updatedAt: serverTimestamp() });                     // expect permission-denied
await setDoc(doc(db, 'users', 'someone-else'), { email: 'x' });           // expect permission-denied
```

### Also check
- Wrong password → friendly message. Forgot password → neutral confirmation.
- Language toggle (العربية ↔ English) flips RTL/LTR and persists across reload and devices.
- Theme toggle (and Settings → System/Light/Dark) persists.
- Settings → rename home → banner and header update.
- Phone (≤480px), tablet (~820px), desktop (≥1024px): no sideways scrolling; bottom dock vs sidebar.
- Offline at startup → "HomeHub can't connect" screen.

## Phase 2 — Rooms live smoke test (REQUIRES LIVE SMOKE TEST)

**Before you start**
1. Deploy the Phase 2 rules: `firebase deploy --only firestore:rules`. This is additive and doesn't change existing data.
2. Deploy the app: `firebase deploy --only hosting` (or run it locally).
3. Optional: Settings, then Roles, then **Update default roles**. This brings the other seeded roles to template v2 (members become view-only for Rooms). The owner doesn't need it.

**Steps**
1. Sign in to the existing HomeHub V5 Home. The Dashboard shows a **Rooms** summary card saying "No rooms yet".
2. Open **Rooms** from the sidebar, the bottom dock, the summary card or the Rooms tile.
3. Confirm the empty state: "No rooms yet", an **Add room** button, and four quick templates.
4. Add **Living Room** (type Living room, floor "Ground floor").
5. Add **Kitchen** (type Kitchen). Optionally use the Kitchen quick template and press Add room.
6. Add **Bedroom** (type Bedroom, floor "First floor").
7. Refresh the browser.
8. The three rooms persist in the order Living Room, Kitchen, Bedroom.
9. Open Bedroom, press **Edit**, rename it to "Master Bedroom", set type Master bedroom, and press **Save**. The card updates immediately.
10. Press **Move earlier** (↑) on Master Bedroom. The order becomes Living Room, Master Bedroom, Kitchen.
11. Refresh. The order persists.
12. Open Kitchen, press **Archive room**, read the confirmation, and press **Archive room** again.
13. Kitchen disappears from the active list, and an **Archived (1)** switch appears.
14. Switch to **Archived** and press **Restore** on Kitchen. It returns at the end of the active list.
15. Archive Kitchen again, then open the **Dashboard**. The Rooms card shows **2** active rooms and **1 archived**.
16. Sign out, then sign in. You land on the Dashboard.
17. Open Rooms. The same rooms load under the same Home.

**Also check**
- Switch to Arabic. Types, counts (e.g. "غرفتان") and dialogs are right-to-left and translated.
- Switch to dark mode.
- On a phone, the add/edit form opens as a bottom sheet and there is no sideways scrolling.
- Open a second browser or device signed in to the same account. Changes from one appear on the other without refresh.

**Firestore documents expected afterwards** (Firebase console)
```
homes/{yourHomeId}/rooms/{autoId}   x3
  Living Room     type living_room     floor "Ground floor"  active true   sortOrder 1
  Master Bedroom  type master_bedroom  floor "First floor"   active true   sortOrder 2
  Kitchen         type kitchen         floor null            active false  archivedAt <time> archivedBy <your uid>
  every room: createdBy = your uid, createdAt/updatedAt server timestamps, schemaVersion 1, NO devices field
```
- Kitchen's sortOrder is 4 after the restore and second archive. Exact numbers can vary with the order you clicked; what matters is that the order shown matches.
- Unchanged: `users/{uid}`, `homes/{homeId}`, `members/{uid}`, `settings/general`.
- `roles/*` change only if you pressed *Update default roles* (`templateVersion: 2`).
- There must be **no** root `rooms` collection and no `devices` collection.

**Security spot checks** (browser console while signed in; each should fail with permission-denied):
```js
const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
const db = fs.getFirestore();
const room = fs.doc(db, 'homes', '<yourHomeId>', 'rooms', '<aRoomId>');
await fs.deleteDoc(room);                                                             // no hard delete
await fs.updateDoc(room, { createdBy: 'someone', updatedBy: '<yourUid>', updatedAt: fs.serverTimestamp() });
await fs.setDoc(fs.doc(db, 'rooms', 'x'), { name: 'root' });                           // no root collection
await fs.getDocs(fs.collection(db, 'homes', 'SOME_OTHER_HOME', 'rooms'));             // other home
```

## Phase 3 — Devices live smoke test (REQUIRES LIVE SMOKE TEST)

**Before you start**
1. Deploy rules: `firebase deploy --only firestore:rules`. This is additive; no data changes.
2. Deploy the app: `firebase deploy --only hosting`.
3. Optional: Settings, then Roles, then **Update default roles**. Roles move to v3. Only the rooms/devices grants of non-owner roles change; everything else is kept.

**Steps**
1. Sign in. Your existing Home loads, and the Dashboard shows both **Rooms** and **Devices** cards.
2. Open Rooms and confirm your existing rooms are all still there.
3. Open **Devices**. You see the empty state ("No devices yet") with six quick templates.
4. Add **Split AC** (template or Add device) to an **active** room. Archived rooms are not offered.
5. Add **Refrigerator** to your Kitchen (or any active room).
6. Add **Router** with Room = **Unassigned**. Its card shows "Unassigned".
7. Refresh. All three persist (sorted by name).
8. Edit the AC: open *Additional information* and set brand and model. Optionally set price **0** and a warranty date such as 30 June 2027. The detail view shows the same date, not a day earlier.
9. Edit Router: move it into a room. Its card shows the room.
10. Edit Refrigerator: set Status to **Needs attention**.
11. Dashboard: the Devices card shows **3** active and "1 needs attention".
12. Devices: search a name ("router"), then a model ("ax"). Clear.
13. Filter by Room, then by Category, then by Status. "Clear search and filters" resets them.
14. Archive one device (confirm). It leaves the list; **Archived (1)** appears.
15. Open Archived and press **Restore**. It's back.
16. Refresh, sign out, sign in. Devices load the same.
17. Rooms: open a room that holds a device. It shows "1 device in this room" → **View devices** opens Devices filtered to that room.
18. Archive that room. In Devices, its device still shows, labelled "**Room name (Archived)**".
19. Edit that device's brand and save. It succeeds, and the room stays the archived room.
20. Add device / edit another device: the archived room is **not** in the Room list.
21. Optional: in Arabic, statuses read يعمل / يحتاج متابعة / خارج الخدمة / في المخزن and the layout is RTL; check dark mode and a phone.

**Firestore documents expected afterwards**
```
homes/{homeId}/devices/{autoId} x3   (ids never change; no root "devices" collection; nothing under rooms/)
  Split AC      category air_conditioning, subtype split_ac, roomId <active room>, brand/model set,
                purchasePrice 0 (number, not null) + currency "EGP" if you set it, warrantyExpiry "2027-06-30" (string)
  Refrigerator  category refrigeration, status needs_attention, roomId <the room you archived>  ← unchanged by the room archive
  Router        category networking, roomId <room it was moved into>, active true after restore (archivedAt/By null)
  every device: createdBy = your uid, server timestamps, schemaVersion 1;
                NO sortOrder, maintenance, cleaning or expense fields
homes/{homeId}/rooms/{roomId}   the archived room: active false — its devices were not modified
```
Unchanged: users, home, membership, settings, and other rooms. `roles/*` change only if you pressed *Update default roles* (`templateVersion: 3`).

**Security spot checks** (browser console, each should fail with permission-denied):
```js
const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
const db = fs.getFirestore(); const t = fs.serverTimestamp();
const dev = fs.doc(db, 'homes', '<homeId>', 'devices', '<deviceId>');
await fs.deleteDoc(dev);                                                          // no hard delete
await fs.updateDoc(dev, { roomId: '<archivedRoomId>', updatedBy: '<uid>', updatedAt: t }); // into archived room
await fs.updateDoc(dev, { createdBy: 'x', updatedBy: '<uid>', updatedAt: t });   // audit field
await fs.updateDoc(dev, { category: 'spaceship', updatedBy: '<uid>', updatedAt: t });
```

## Phase 4 — Finance live smoke test (REQUIRES LIVE SMOKE TEST)

**Before you start**
1. `firebase deploy --only firestore:rules`, then `firebase deploy --only hosting`. Both are additive; no existing documents change.
2. Optional: Settings → Roles → **Update default roles**. Roles move to v4; only `expenses.*` grants of non-owner roles change.

**A. Bring in the expense history (once)**
1. Sign in as the owner → **Finance** → **Wallets** → *Import from CSV…* → choose your Expenses backup CSV.
2. Check the column mapping (Date, Amount required; also Category, Description, Payment/isVisa, Original id). If dates look like `03/04/2026`, choose the date format.
3. **Before pressing Import, confirm the preview:**
   - **Expenses to import = 330**;
   - **Total = EGP 207,464.90**;
   - **0 problems**;
   - the by-month totals match your records.
4. Press **Import now**.
5. Firestore now has 330 documents in `homes/{homeId}/expenses`, each with:
   - its original id if the CSV has one;
   - `source: "import"`, `walletId: null`, `audience: "household"`;
   - `originalRow` holding the CSV columns verbatim;
   - `paymentMethod: "visa"` where `isVisa` was true.
6. Open the dialog again with the same file: it shows **Already imported: 330** and **Import now** stays disabled. Never edit these documents by hand.

**B. Daily finance**
1. **History:** the newest date is at the top. Groups read "Today / Yesterday / date". The imported 2025–2026 records appear under their own dates.
2. **Wallets** → Add wallet **Household Bank** (Bank, current balance e.g. 20000), **Daily Cash** (Cash), and a personal **My wallet** (Private).
   - *Firestore:* 3 `wallets` docs, plus `walletMovements` docs of type `funding` for the opening balances.
   - Overview spending is unchanged.
3. **10-day budget** → Start: Daily Cash, today, 10 days, 6000, "Moved from Household Bank".
   - *Firestore:* 1 `spendingCycles` doc (`status: active`, `endDate` = start + 9) and 1 `walletMovements` doc (`type: transfer`, `cycleId` set).
   - **Total spending does not change.**
4. **Quick add** 450 Groceries "Carrefour", then 85 Food "Coffee". Both appear at the top of History.
   - Remaining shows 5,465; safe/day and pace update.
   - *Firestore:* 2 `expenses` docs with `walletId` (Daily Cash), `budgetCycleId`, `createdBy` = you, `paymentMethod: cash`.
5. Edit Coffee to 95. Only `amountMinor`, `updatedBy` and `updatedAt` change.
6. **Count cash** → enter a different amount (e.g. 5300). *Firestore:* one `walletMovements` doc `type: adjustment`. **Spending is unchanged.**
7. **Close period** → *Carry the rest*. The old cycle shows `status: closed`, `closeOutcome: carry`, `closingRemainingMinor`; a new cycle has `carryInMinor`.
8. **Fixed & recurring** → add **Microsoft 365**: 2999, Yearly, next due 15 March 2027, Household Visa (if you added one). The card says "Set aside about EGP 249.92/month". No expense is created.
9. **Mark paid** → *Firestore:* exactly one expense with id `cm_{commitmentId}_20270315` and `commitmentId` set. The commitment's `nextDueDate` is now 2028-03-15. History shows it once, marked *Fixed*.
10. **Archive / restore** a commitment and a wallet (they disappear from or return to the active lists). **Void** an expense: it stays in History marked *Voided* and leaves the totals.
11. Sign out and sign in. Everything persists. On the Dashboard, the Finance card shows this month's total and the 10-day budget.

**C. Privacy (needs a second adult account in the Home, e.g. your wife's)**
1. As the owner, add an expense to **My wallet** (private).
2. Sign in as the other adult. My wallet and that expense are **not** visible in Wallets or History. Household items are.
3. Optional console check as the other adult (should fail with permission-denied):
```js
const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
const db = fs.getFirestore();
await fs.getDoc(fs.doc(db, 'homes', '<homeId>', 'wallets', '<ownerPrivateWalletId>'));      // denied
await fs.getDocs(fs.collection(db, 'homes', '<homeId>', 'expenses'));                        // denied (unconstrained)
await fs.deleteDoc(fs.doc(db, 'homes', '<homeId>', 'expenses', '<anyExpenseId>'));           // denied (no hard delete)
```


## Phase 4A — Family & Members live smoke test (REQUIRES LIVE SMOKE TEST)

You need: your owner account, plus a second email for the adult member (e.g. your wife) and, optionally, a third email for a child. Use different browsers or a private window for each person. Nothing here is automatic: no members, invitations or data are created for you.

**0. Deploy (you control production)**
1. `firebase deploy --only firestore:rules`. This adds the `invites` rules and the extended membership rules; existing data is untouched.
2. `firebase deploy --only hosting`.
3. Optional: Settings → Roles → **Update default roles**. Roles move to v5 (adds `members.manageChildren` for admin). Custom grants are kept.

**1. Owner: Family page**
1. Sign in → Settings → **Family & Members** (or the Family card).
2. You are listed as Owner · Active. The empty state reads "No other family members yet."
3. Press **Add family member** → **Adult member** → valid 7 days → **Create invitation**.
   - Expected Firestore: `invites/{CODE}` with `status: "pending"`, `homeId` = your home, `roleId: "member"`, `createdBy` = your uid, `expiresAtMillis` about 7 days ahead.
4. **Copy link**. The invite appears under Pending invitations.

**2. Adult member (second browser)**
1. Open the link. You see "Sign in or create your own account…".
2. **Create account** with their own email and a password of at least 8 characters.
3. The setup screen shows the invitation: your home's name, role Member, the expiry.
4. Enter their name → **Join**. They land on your home's Dashboard.
   - Expected: `invites/{CODE}` becomes `status: "accepted"`, `acceptedBy` = their uid. `homes/{homeId}/members/{theirUid}` has `roleId: "member"`, `status: "active"`, `inviteCode`, `relationship: "adult"`. `users/{theirUid}` has `defaultHomeId` = your home.
5. Reopen the same link. It shows "This invitation has already been used."

**3. Household finance as the member**
1. Finance → Quick add **750 · Groceries** into Household cash.
2. In the owner's browser, History shows the row with **"Added by <her name>"**.
   - Expected: `expenses/{id}.createdBy` = her uid.
3. Filter History by **Added by → her** to see only her entries. The default order is still newest first.

**4. Privacy**
1. As the member: Wallets → **Add wallet** → Personal, **Private**, "Sara wallet". Add an expense to it.
2. As the owner: the wallet and its expense appear **nowhere** (Wallets, History, totals).
3. As the member: edit the wallet → **Shared with selected members** → tick the owner → Save.
4. As the owner: the wallet and its history now appear.
5. Optional console check (owner, before sharing): the private wallet query returns permission-denied.

**5. Child (optional; needs the child's own email)**
1. Owner: **Add family member** → **Child**. You are pre-selected as guardian; tick the other parent if they're a member → Create.
2. Child: open the link → **Create account** → Join.
   - Expected member: `roleId: "child"`, `relationship: "child"`, `guardianUids: [...]`.
3. Owner: Wallets → Add wallet → Personal → owner = the child → Shared (guardians pre-selected) → opening balance 500.
4. Child: sees only their allowance wallet. Spend 40 → balance 460. There is no Home scope, no household history, and no totals.
5. Guardian: sees the child's wallet and its spending.

**6. Roles and removal**
1. Owner: change the member's role Member → Viewer → back to Member. The member's screens update without reload.
2. Member: there are no role controls on their own card; they can only Leave.
3. Owner: **Remove** the member.
   - Expected: `members/{uid}.status: "removed"`; nothing deleted.
   - The member sees "Not a member of this home".
   - Their earlier household expenses still show "Added by <name>".
   - Their private wallet stays invisible to you. A wallet they had shared with you remains visible.
4. Re-invite them if wanted. The same uid re-joins only through a new invite.

**7. Sessions**
Sign out and in as each person. Each lands in their own default home with the right role.

### Optional — historical expense import (separate, explicit, owner only)
Never runs automatically. Do it once, when you're ready:
1. Owner → Finance → Wallets → **Import from CSV…** → choose the backup CSV.
2. Check the column mapping (date, amount, category, description, payment / isVisa, original id). Pick the date format if asked.
3. The preview must show **330** expenses and **EGP 207,464.90**, with no problem rows. If not, stop and don't import.
4. Press **Import now**.
   - Expected: 330 documents in `homes/{homeId}/expenses` with `source: "import"`, original ids, `originalRow`, no wallet. History shows them as "Imported history".
5. Re-open the importer with the same file. It shows **0 to import, 330 already imported**, so no duplicates are possible.

## Results of the Phase 1 build (October 2026)

| Suite | Result | Notes |
|---|---|---|
| Syntax check (`node --check`, all JS) | PASS | |
| Unit tests | **50/50 PASS** | Found and fixed 1 bug: the profile was lost on context error, which would have broken "Create a new home" |
| Static architecture tests | **15/15 PASS** | |
| Browser E2E (fake SDK, Chromium) | **23/23 PASS** | Found and fixed 1 bug: a nav icon node was shared between sidebar and dock, leaving the sidebar icon blank |
| Rules tests (emulator) | **NOT RUN** | No emulator or network in the build environment. **REQUIRES LIVE SMOKE TEST / emulator run** |
| Live Firebase (Tests A–D) | **NOT RUN** | **REQUIRES LIVE SMOKE TEST** |

Phase 1 was subsequently **verified live by the owner**: login, first-time setup, session restore, and logout/login all passed.

## Results of the Phase 2 build (October 2026)

Baseline before any Phase 2 change: `npm test` **65/65**, E2E **23/23**.

| Suite | Result | Notes |
|---|---|---|
| Syntax check (all JS) | PASS | |
| `npm test` (unit + static) | **98/98 PASS** | 65 Phase 1 tests + 33 Phase 2 tests |
| Browser E2E (fake SDK, Chromium) | **38/38 PASS** (3 consecutive runs) | 23 Phase 1 checks + R1–R15 + mobile Rooms. Found and fixed a Phase 1 defect: stale route after sign-out (R15 guards it) |
| Rules emulator (34 tests) | **NOT RUN** | No emulator or network in the build environment. **REQUIRES LIVE SMOKE TEST / emulator run** |
| Rooms live smoke test (above) | **NOT RUN** | **REQUIRES LIVE SMOKE TEST** |

Phase 1 tests changed in Phase 2, each because the behaviour they pinned was intentionally changed:

| Test | Change | Why |
|---|---|---|
| static: no legacy code | The bare word `archive` is no longer banned; V4-style archive *collections/paths* (`archive_`, `_archive`, `archives/`, `archiveCollection`) and B1/B2 are banned instead | Room archiving is a required Phase 2 feature |
| static: module folders | Folders must contain only `module.js`, **except implemented modules (rooms)** | Rooms is implemented |
| unit: registry | Expects **only rooms** enabled, with a page and widget; the other 9 still disabled | Rooms is enabled |
| E2E A7 | Expects 9 "Coming soon" tiles plus 1 live Rooms tile, instead of 10 | Same |

E2E ordering note: the Rooms block (R1–R15) leaves the UI in English on the Dashboard, the state the following Phase 1 checks were written for.

## Results of the Phase 3 build (October 2026)

Baseline before any Phase 3 change: `npm test` **98/98**, E2E **38/38**, emulator suite 34 written (not run).

| Suite | Result | Notes |
|---|---|---|
| Syntax check (all JS) | PASS | |
| `npm test` (unit + static) | **132/132 PASS** | 97 carried-over + 35 new (devices model/store/permissions/role upgrade/static) |
| Browser E2E (fake SDK, Chromium) | **55/55 PASS**, repeated runs | 38 carried-over + D1–D18 + mobile Devices |
| Rules emulator (44 tests) | **NOT RUN — REQUIRES FIREBASE EMULATOR TEST** | No Java or network in the build environment |
| Phase 3 live smoke test (above) | **NOT RUN — REQUIRES LIVE SMOKE TEST** | |

Tests changed in Phase 3. Each pinned behaviour that Phase 3 intentionally changes:

| Test | Old expectation | New expectation | Reason |
|---|---|---|---|
| static: rooms path scan | Scanned all of `src` for `['rooms'…` | Excludes `src/core/permissions/` | `TEMPLATE_CHANGES` lists permission *namespaces* (`['rooms']`), not Firestore paths (false positive) |
| static: rooms phase discipline | No devices rules / devices folder only `module.js` | Rooms never embed devices; no Cleaning/Maintenance/Expenses rules | Devices is now implemented as its own collection |
| static: planned module folders | Implemented = {rooms} | Implemented = {rooms, devices} | Devices enabled |
| unit: registry | Only rooms enabled | Only rooms + devices enabled, with page + widget | Devices enabled |
| unit: rooms-permissions "template bumped" | `ROLE_TEMPLATE_VERSION === 2` | `>= 2` and every role carries the current version | Phase 3 bumps to 3 |
| unit: rooms-permissions "devices unchanged" | member has provisional `devices.create` | **Removed**; replaced by `devices-permissions.test.mjs` | Devices defaults are now final |
| E2E A7 | 9 planned tiles + Rooms | 8 planned + Rooms + Devices | Devices enabled |
| E2E R1, R12, R13 | `.summary-card` (one card) | `.summary-card[href="#/m/rooms"]` | Two dashboard cards now |
| E2E R7 | Room detail Devices row = "Coming in a future update" | Devices row = "No devices in this room yet" (live); Cleaning still "coming later" | Room detail now consumes the Devices interface |

Harness change: Playwright's default timeout dropped from 30 s to 8 s, so a failure no longer cascades into a 5-minute run. All Phase 3 Devices checks restore the language and theme they changed, so the Phase 1 checks that follow see the state they were written for.

## Results of the Phase 4 build (October 2026)

Baseline before any Phase 4 change: `npm test` **132/132**, E2E **55/55**, emulator suite 44 written (not run).

| Suite | Result | Notes |
|---|---|---|
| Syntax check (all JS) | PASS | |
| `npm test` (unit + static) | **166/166 PASS** | 132 carried over + 34 new (money, calendar, recurrence, ledger semantics, privacy labels, builders, CSV import, finance store, permissions, finance static/security) |
| Browser E2E (fake SDK, Chromium) | **70/70 PASS**, repeated runs | 55 carried over + F1–F28 flows (incl. CSV import, private-wallet privacy, viewer/child restrictions, listener cleanup) + mobile finance |
| Rules emulator (55 tests) | **NOT RUN — REQUIRES FIREBASE EMULATOR TEST** | No Java or network in the build environment |
| Phase 4 live smoke test (above) | **NOT RUN — REQUIRES LIVE SMOKE TEST** | |

Note on the "330 records / 207,464.90 EGP" acceptance item: the V5 database holds **no** expense history (it is in the CSV backup). Compatibility is proven by the import tests (exact minor-unit totals, preserved ids, verbatim original columns, `isVisa` mapping, idempotency) and must be confirmed against the real CSV in step A above.

Tests changed in Phase 4 (each pinned a Phase 3 state that Phase 4 intentionally changes):

| Test | Old expectation | New expectation | Reason |
|---|---|---|---|
| static: planned module folders | Implemented = {rooms, devices} | + expenses | Finance implemented |
| static (devices): phase discipline | No expenses rules; expenses folder metadata-only | Devices hold no cleaning/maintenance/expense fields; Cleaning/Maintenance not started | Expenses now has its own rules |
| static (rooms): phase discipline | No expenses rules | No Cleaning/Maintenance rules | Same |
| unit: devices-permissions "template version 3" | `ROLE_TEMPLATE_VERSION === 3`, changed since v2 = [devices] | `≥ 3`; since v2 = [devices, expenses] | v4 adds expenses |
| unit: registry | Only rooms + devices enabled | Only expenses + rooms + devices enabled | Finance enabled |
| E2E A7, D1 | 8 planned tiles | 7 planned + Finance tile | Finance enabled |
| E2E "planned module route" | `#/m/expenses` shows "Coming soon" | `#/m/chef` (still planned) | Expenses is no longer a placeholder |

Harness additions: the fake SDK supports single-constraint `query`/`where` (`==`, `array-contains`; a missing field never matches, as in Firestore) and a second test user for privacy checks.

## Results of the Phase 4A build (October 2026)

Baseline before any 4A change, executed in the build environment from the Phase 4 ZIP: syntax 117/117 files; `npm test` **166/166**; browser E2E **70/70**; emulator suite 55 written (not run).

| Suite | Result | Notes |
|---|---|---|
| Syntax check | PASS | |
| `npm test` (unit + static) | **191/191 PASS** | Including family tests, the family static suite, the Quick-add default regression test, and the `main.js` import-graph guard |
| Browser E2E (fake SDK, Chromium) | **87/87 PASS** on repeated runs and from the clean unzip | 70 carried over + Family flows M0–M32 using distinct fake accounts (owner, Sara, Omar, Mona) |
| Emulator rules (65 tests; 10 of them Phase 4A, including the child-wallet regression) | **NOT RUN: REQUIRES FIREBASE EMULATOR TEST** | No Java or network in the build environment |
| Phase 4A live smoke test (above) | **NOT RUN: REQUIRES LIVE SMOKE TEST** | |

Defects found by the 4A tests and fixed:

| Found by | Defect | Fix |
|---|---|---|
| E2E M18 | Child's Quick add had no default wallet → expense not recorded | Default to the member's own personal wallet (+ unit test) |
| E2E M18 screenshot | Child could edit/archive (un-share) a guardian-created allowance wallet | Rules + UI tightened (+ emulator test) |
| E2E "SDK unavailable" | Static import of Firebase-backed pages from `main.js` | Lazy-loaded pages (+ static import-graph test) |
| Visual review | Duplicate "Child" badge; Latin digits in Arabic summary | Fixed |

Tests changed in Phase 4A (each pinned a Phase 4 state that 4A intentionally changes):

| Test | Old expectation | New expectation | Reason |
|---|---|---|---|
| unit: devices-permissions "template history" | changed since v2 = [devices, expenses] | Equals every later version's namespaces | v5 adds `members` |
| unit: finance-store "role matrix" | `ROLE_TEMPLATE_VERSION === 4` | `≥ 4` (the finance matrix itself unchanged) | 4A is v5 |
| unit: registry | (new test added; none removed) | `alsoVisibleWith` lets a child reach Finance | Child allowance access |
| E2E M18 (written in 4A) | Page text never contains "Household" | Exactly one wallet card; no Edit/Archive; named household data absent | The word appears in static intro text |
| E2E M25 (written in 4A) | Hero visible right after re-login | Re-login lands on the kept invite link, then dashboard | Invite links intentionally survive sign-in |

No Phase 1–4 test was deleted.

## Results of the Phase 5 build (October 2026)

Baseline before any Phase 5 change, run from the Phase 4A ZIP in the build environment: syntax 128/128 files; `npm test` **191/191**; browser E2E **87/87**; emulator suite 65 written (not run).

| Suite | Result | Notes |
|---|---|---|
| Syntax check | PASS | |
| `npm test` (unit + static) | **214/214 PASS** | +23 Phase 5: precision, assets/events, privacy labels, valuation/freshness, providers (timeout / 429 / invalid), Hijri, Nisab/Hawl/per-owner/allocation, store privacy/transfers/wallet/Zakat payments, permissions v6 |
| Browser E2E (fake SDK) | **100/100 PASS** on repeated runs and from the clean unzip | 87 carried over + S0–S48 (13 checks) |
| Emulator rules | 74 written (9 Phase 5): **REQUIRES FIREBASE EMULATOR TEST** | Includes the four critical owner/wife privacy cases |
| External price provider | **REQUIRES PROVIDER CONFIGURATION** | `PRICE_ENDPOINT` is null; only manual prices exist |
| Phase 5 live smoke test (below) | **REQUIRES LIVE SMOKE TEST** | |

Tests changed in Phase 5 (each pinned the Phase 4A state; intent kept, none deleted):

**Harness flake found and fixed during the clean-unzip run:** a `while (theme !== 'dark') click()` loop could race the async preference save and spin forever (it had passed twice before). Replaced with a bounded `ensureTheme()` that clicks once, waits for the theme to settle, retries at most 3 times and then fails with a message. No unbounded loop remains in the suite. Two consecutive clean-unzip runs after the fix: 100/100 each.

| Test | Old expectation | New expectation | Reason |
|---|---|---|---|
| static: family-static phase discipline | No Zakat/Nisab anywhere in `src` | No Nisab/Hawl/gold-price logic **outside** the savings module | Phase 5 adds the module |
| static: finance-static phase discipline | Finance files never mention "zakat" | Finance may name the `zakat` category; no Nisab/karat/gold-price logic | Deliberate payment link |
| static: implemented modules | rooms, devices, expenses | + savings | New module |
| unit: family template v5 | `ROLE_TEMPLATE_VERSION === 5` | `≥ 5` (v5 behaviour still asserted) | Phase 5 is v6 |
| unit: registry | 10 modules; 3 enabled | 11 modules; expenses, savings, rooms, devices enabled | New module |

### Phase 5 live smoke test (manual; never touches historical expenses)

Deploy rules first (`firebase deploy --only firestore:rules`), then hosting.

1. **Owner opens Life Savings:** the empty state appears and no data is created. Firestore: nothing new.
2. **Add Emergency Cash, private, opening 25,000:** `savingsAssets/<id>` (`readers: [owner]`) and `savingsEvents/<id>` (`type opening`, `qty 2500000`).
3. **Add Bank savings 150,000 and Gold 50 g 21K:** the gold event has `unit 'mg'`, `qty 50000`.
4. **Prices & value → enter 21K = 4,000:** `priceQuotes/<id>` (`source 'manual'`, `priceMinor 400000`). Gold shows EGP 200,000, labelled Manual, never Live.
5. **Add USD 2,500 and enter USD = 48.50:** value EGP 121,250. The total equals the visible sum only.
6. **Contribution, withdrawal, adjustment:** each creates one event. Renaming an asset creates none.
7. **Wallet → Emergency Cash 10,000:** `walletMovements/sv_<t>` (`type 'savings'`) + `savingsEvents/<t>_in`. Finance spending is unchanged.
8. **Wife (own account) adds private savings:**
   - the owner does not see it, and his totals are unchanged;
   - she shares it with the owner → he sees it;
   - she un-shares → it is hidden again, including its history.
9. **Child savings created by a guardian:** the child sees only their own; the child sees no household savings or totals.
10. **Zakat tab:**
    - Nisab = 85 g × the 21K price, with the price source and time shown;
    - Hawl start and expected end, with Hijri dates;
    - a breakdown with any exclusions;
    - change the settings to silver or manual → a new `zakatRecords/<uid>_p<n>`, the old version kept.
11. **Record a Zakat payment with "also in Finance":** `zakatRecords/<id>` (`linkedExpenseId zk_<id>`) + `expenses/zk_<id>` (category `zakat`). Exactly one expense.
12. **Archive an asset:** it stays in history. Log out and back in: the same data, nothing duplicated.

**Optional, separate:** the historical expense CSV import (Finance → Wallets). The preview must show 330 rows and EGP 207,464.90 before confirming. It is unrelated to Life Savings and never imported into it.

## Results of the Phase 5.1 build (October 2026)

Baseline before any 5.1 change, run from the Phase 5 ZIP: syntax 146/146; `npm test` **214/214**; browser E2E **100/100**; emulator suite 74 written (not run).

| Suite | Result | Notes |
|---|---|---|
| `npm test` (unit + static) | **229/229 PASS** | +15 adoption unit tests (eligibility, partial states, write set, never-overwrite, data byte-identical, idempotency, resolver routing, full session flow), +1 static (template sync, bootstrap unchanged, no broad list) |
| Browser E2E (fake SDK) | **104/104 PASS** on repeated runs and from the clean unzip | +L1–L6 (4 checks): legacy fixture → EN/AR upgrade screen → adopt → same Home → Devices/Finance/Savings preserved → owner write → refresh/re-login without upgrade → attacker refused |
| Emulator rules | 83 written (9 Phase 5.1 tests covering L1–L20): **REQUIRES FIREBASE EMULATOR TEST** | |

**Tests changed** (intent kept, none deleted):

| Test | Old expectation | New expectation | Reason |
|---|---|---|---|
| static: no legacy / migration / V4 code | The word "legacy" banned everywhere | Banned everywhere **except** the exact adoption vocabulary; a self-check proves V4 paths, `hr_*`, `ownerId` and migration are still caught | The requested repair is named "legacy Home adoption" |
| static: rules contain no "legacy" | No "legacy" in rule code | Only `isLegacyAdoption` / `legacyAdoption` exempt; `hr_` and migration still banned | Same |

The fake SDK mirrors the adoption rule invariants so the browser attacker flow is meaningful. The authoritative proof is the emulator suite.

### Phase 5.1 live test procedure (production; never edit data by hand)

1. **Deploy the candidate rules FIRST:** `firebase deploy --only firestore:rules`, then `firebase deploy --only hosting`. Your current "ليست لديك صلاحية" screen indicates the deployed rules predate Phase 5; with Phase 5 rules alone you would see «لست عضوًا في هذا المنزل».
2. **Optional backup:** export the database in the Firebase console first (adoption only adds documents, but a backup is good practice).
3. Sign in as the Home's original creator. Expect the upgrade screen (English or Arabic), showing your Home's name and reference `LEGACY_HOME_ADOPTION_REQUIRED`.
4. Press **Upgrade Home / ترقية المنزل**. The app reloads by itself to your Dashboard with the same Home name.
5. **In the Firestore console, under `homes/<sameId>`,** check:
   - new `members/<yourUid>` (`roleId owner`, `status active`, `legacyAdoption true`);
   - new `roles/{owner, admin, member, viewer, child}` (owner `["*"]`, rank 100, `templateVersion 6`);
   - the Home document unchanged;
   - `users/<yourUid>.defaultHomeId` unchanged;
   - no new Home.
6. Open Devices, Finance and Life Savings; existing V5-shaped records appear. Add a room (owner write works).
7. Refresh, and sign out and in again: no upgrade screen.
8. **(Optional, with a second account)** point nothing at your Home. A different user signing in sees only their own state, and cannot read your Home.

If you see `LEGACY_HOME_ADOPTION_BLOCKED`, nothing was changed: the Home already has an Owner role. Send me the list of documents under `homes/<id>/roles` and `members` (no edits) for a manual plan.

## Phase 5.1.1: rules & rules-test repair (October 2026)

**Input:** your local emulator run reported 83 tests, 62 passed and 21 failed. The log itself was not attached, so the failures were diagnosed from the source. Full details are in **PHASE-5.1.1-CHANGE-REPORT.md**.

| Suite | Result in the build environment |
|---|---|
| `npm test` (unit + static) | **231/231 PASS** (+2 guards: no list `+` in rules; bound-once hot paths) |
| `npm run test:rules:smoke` (new, offline) | **PASS**: 82/83; the only failure (L14) needs real rule enforcement. *Rules are not evaluated.* |
| Browser E2E | **104/104 PASS** (repeated and from the clean unzip) |
| `npm run test:rules` (REAL emulator, 83 tests) | **REQUIRES FIREBASE EMULATOR RERUN.** Cannot run here: no network to fetch `firebase-tools` / the emulator JAR. |

**Measured with the offline check** (shipped 5.1 test file → repaired):
- the missing `assert` import caused 2 failures;
- write batches mixing Firestore instances caused 3 failures;
- after the repair, both causes are at 0.

**Fixed by source diagnosis, confirmable only by the emulator:**
- five list additions with `+` in the rules (unsupported, so evaluation error and **deny**);
- the bound-once refactor of the hot helpers (1000-expression headroom).

**Tests changed:**

| Test | Old | New | Why |
|---|---|---|---|
| static: finance-static "identity fields…" | Pinned `([ownerUid] + sharedWith)`, the unsupported form | Pins `[ownerUid].concat(sharedWith)` | The old text *was* the defect |
| static: family-static "invite join…" | `inv(d.inviteCode).field` | `joinsByInviteI(h, u, d, inv(d.inviteCode))` + `I.field` | Invitation bound once; same checks |
| rules: helper `db()` | A new Firestore instance per call | One instance per account | Batches must not mix instances |
| rules: imports | No `assert` | `import assert from 'node:assert/strict'` | It was a `ReferenceError` |

**Acceptance still open:** `npm run test:rules` must report **83/83** (or more) with **zero failures** and no 1000-expression warnings. If anything remains, the emulator output names the rule and the test. Send it.

## Phase 5.1.2: emulator-driven repair (October 2026)

**Input:** your emulator run of 5.1.1 (`emulator-result.txt`): **83 tests, 68 pass, 15 fail**, with 86 "maximum of 1000 expressions" lines. All Legacy Home Adoption tests (L1–L20) passed. Details are in **PHASE-5.1.2-RULES-REPORT.md**.

| Suite | Result in the build environment |
|---|---|
| `npm test` (unit + static) | **233/233 PASS**: guards for query-safe reads and for the rules-test pitfalls |
| `npm run test:rules:smoke` (offline; rules NOT evaluated) | **PASS**. The stand-in now mirrors the real library (a second `context.firestore()` throws; `withSecurityRulesDisabled` resolves to undefined). It reproduces **exactly the 14 fixture failures** of your log on the 5.1.1 file, and **0** on 5.1.2 (L14 needs real rules) |
| Browser E2E | **104/104 PASS** (repeated and from the clean unzip) |
| `npm run test:rules` (REAL emulator) | **REQUIRES YOUR RERUN.** Expected: 83/83, and no 1000-expression lines |

**Tests changed:**
- **rules fixtures:** two callbacks now bind `c.firestore()` once; two values are captured inside `withSecurityRulesDisabled`.
- **static patterns:** updated for the reordered `members` paths and the `.get('audience'|'visibility')` reads. They keep bounded, per-path assertions (the owner is still excluded from the remove and leave paths).

**Production comparison:** pending (the file was not received). Run `npm run rules:compare -- production.rules`.

## Phase 5.1.3: final rules repair (October 2026)

**Input:** your real emulator run of 5.1.2 gave **81/83**. The two failures were "finance: PRIVATE wallet…" (`false for 'list' @ L900`) and "4A accept: used / cancelled / expired…" (the L336/L357 errors). See PHASE-5.1.3-SECURITY-REPORT.md.

| Suite | Result in the build environment |
|---|---|
| `npm test` | **235/235 PASS** |
| `npm run test:rules:smoke` (offline stand-in; NOT a rules result) | No JavaScript-level failures (85 tests) |
| Browser E2E | **104/104 PASS** (repeated and from the clean unzip) |
| `npm run test:rules` (REAL emulator, **85** tests = 83 + 2 new) | **UNVERIFIED.** Not runnable here; required before any deployment |

**Changed and new tests:**
- the expired-invite fixture now expires a *valid* invite;
- the `j` invite write is asserted;
- new: an expired-invite control, and "mine" queries across 8 collections;
- static: patterns for the corrected `canReadFinance`, a guard against `readers is list`, a guard for the adoption-companion structure, and the `isLegacyAdoptionCompanion` exemption in the rules legacy-word check.

## Phase 5.2: Life Savings & Zakat completion (October 2026)

| Suite | Result in the build environment |
|---|---|
| `npm test` | **241/241 PASS** |
| `npm run test:rules:smoke` (NOT a rules result) | No JavaScript-level failures (90 tests) |
| Browser E2E | **105/105 PASS** (incl. Z-UI: ledger, advance payment, share → read-only sharee → revoke) |
| `npm run test:rules` (REAL emulator, **90** tests = 85 + Z1/Z2, Z3/Z4, Z5, Z6/Z7, Z8) | **UNVERIFIED.** Required before deployment |
| `STRICT_DENIALS=1 npm run test:rules` | **UNVERIFIED.** Every denial must be a genuine rule denial |

See **PHASE-5.2-REPORT.md** for the gap analysis, rule changes, deployment checklist and GO/NO-GO.

## Phase 5.2.1: rule-evaluation repair (October 2026)

**Input:** your real emulator run of 5.2: **89/90**. The failure was Z6/Z7 "dangling snapshotId" (`maximum of 1000 expressions … create @ L1263`). Limit messages also appeared in passing negative tests.

| Suite | Result in the build environment |
|---|---|
| `npm test` | **242/242 PASS** (incl. cost tripwires) |
| `npm run test:rules:smoke` (NOT a rules result) | No JavaScript-level failures (90 tests) |
| Browser E2E | **PASS** (see the clean-unzip result in the report) |
| `npm run test:rules` (REAL) | **UNVERIFIED.** Required: 90/90 |
| `npm run test:rules:strict` (REAL, `STRICT_DENIALS=1` for the whole suite) | **UNVERIFIED.** Required: 90/90 |

No security test was weakened, skipped or removed. The static patterns were updated to the dispatched forms (`mvTransferOk` / `mvTransferW` currency checks, `perms.hasAny`, `zakatSnapshotOfOwner`).

## Phase 5.3: Home Routine & Cleaning + Edit Active Budget (October 2026)

| Suite | Command | Result in the build environment |
|---|---|---|
| Unit + static | `npm test` | **258/258 PASS** (+6 budget, +10 cleaning) |
| Offline rules-file check (NOT a rules result) | `npm run test:rules:smoke` | No JavaScript-level failures (101 tests) |
| Browser E2E | `npm run test:e2e` | **107/107 PASS** (+ B-UI budget, + C-UI cleaning) |
| REAL emulator | `npm run test:rules` | **UNVERIFIED.** Expect **101/101** (90 baseline + B1–B6 + C1–C5) |
| REAL emulator, strict | `npm run test:rules:strict` | **UNVERIFIED.** Expect **101/101**; every denial must be a genuine rule denial |
| Expression-limit audit | `npm run rules:limits -- <output>` | Run on both outputs: no hit may sit inside a failing test |

**Windows (PowerShell, in `HomeHub-V5`):**
```powershell
npm test
npm run test:rules        *> emulator-5.3-normal.txt
npm run test:rules:strict *> emulator-5.3-strict.txt
npm run rules:limits -- emulator-5.3-normal.txt
npm run rules:limits -- emulator-5.3-strict.txt
npm run test:e2e
```

**Existing tests changed (intent kept):**

| Test | Before | After | Why |
|---|---|---|---|
| static phase discipline (devices, finance, rooms, planned dirs) | Cleaning must not exist | Maintenance / inventory / shopping / chef must not exist; Cleaning has its own collections; rooms and devices never embed cleaning data | Cleaning ships in 5.3 |
| unit registry | 4 enabled modules | 5 (+ cleaning); widget order pinned | Cleaning enabled |
| unit finance-store listeners | 10 / 5 | 12 / 6 | Budget history adds household + mine listeners |
| static rules helpers allow-list | — | `string` added | A genuine rules built-in (deterministic revision ids) |
| E2E A7, D1 planned tiles | 7 | 6 | Cleaning implemented |
| E2E navigation icons | dock 2 | 2 + "More" | Dock overflow fix |

**Required indexes / configuration:** none. All new queries are single-field. No new environment variables or dependencies.

## Phase 5.3.1: Cleaning widget & Rooms/Devices integration (October 2026)

| Suite | Command | Result in the build environment |
|---|---|---|
| Unit + static | `npm test` | **265/265 PASS** (+7 integration) |
| Offline rules-file check (NOT a rules result) | `npm run test:rules:smoke` | No JavaScript-level failures (106 tests) |
| Browser E2E | `npm run test:e2e` | **109/109 PASS** |
| REAL emulator | `npm run test:rules` | **UNVERIFIED.** Expect **106/106** (101 + G1–G5) |
| REAL emulator, strict | `npm run test:rules:strict` | **UNVERIFIED.** Expect **106/106** |

**Windows (PowerShell, in `HomeHub-V5`):**
```powershell
npm test
npm run test:rules        *> emulator-5.3.1-normal.txt
npm run test:rules:strict *> emulator-5.3.1-strict.txt
npm run rules:limits -- emulator-5.3.1-normal.txt
npm run rules:limits -- emulator-5.3.1-strict.txt
npm run test:e2e
```

`tests/unit/cleaning-integration.test.mjs` re-extracts the template literals from `docs/reference/homeCleaning.html` (shipped read-only) on every run and fails on any difference with `cleaning-templates.js`. **The comparison always runs; it is never skipped.**

## Phase 5.3.2 hotfix (October 2026)

| Suite | Command | Result in the build environment |
|---|---|---|
| Unit + static | `npm test` | **272/272 PASS** |
| Browser E2E | `npm run test:e2e` | **110/110 PASS** (+ H-UI) |
| REAL emulator | `npm run test:rules` / `npm run test:rules:strict` | **UNVERIFIED.** Expect **109/109** each |
| Diagnostic (emulator) | `npm run diagnose:setup` | Prints the verbatim reason the old single batch was rejected (optional) |

**Fake SDK additions (all off by default; existing tests unaffected):**
- `__fakeOptimistic`: optimistic writes with rollback, as in the real SDK;
- `__fakeMaxOpsPerCommit`: a per-request limit;
- `__fakeDenyIds`: reject specific documents.

### v5.7.2 r2: H2 test correction
H2 saved owner-authored payloads as a member, so the rules correctly refused every task (`createdBy` must be the caller). Payloads are now built for the user who saves them, as the app does. H2 also asserts that **forged authorship is denied**, and its re-run check can now fail only because the task already exists. App code and `firestore.rules` are unchanged. **Real emulator (normal + strict): run locally; expected 109/109.**

## Phase 5.4a (v5.8.0)

| Suite | Result in the build environment |
|---|---|
| Unit + static | **281/281** |
| Browser E2E | **111/111** |
| Real emulator, Normal / Strict | **NOT EXECUTED HERE.** Expected **114/114** each (`npm run test:rules`, `npm run test:rules:strict`). |

## Phase 5.4b (v5.8.1)

| Suite | Result in the build environment |
|---|---|
| Unit + static | **290/290** |
| Browser E2E | **112/112** |
| Real emulator, Normal / Strict | **NOT EXECUTED HERE.** Expected **119/119** each |

**Windows CMD:**
- `npm run test:rules > emulator-5.8.1-normal.txt 2>&1`
- `npm run test:rules:strict > emulator-5.8.1-strict.txt 2>&1`
- `npm run rules:limits -- <file>`

## Phase 5.4c (v5.8.2)

| Suite | Result in the build environment |
|---|---|
| Unit + static | **298/298** |
| Browser E2E | **113/113** |
| Real emulator, Normal / Strict | **NOT EXECUTED.** Expected **122/122** each |

**Windows CMD:**
- `npm run test:rules > emulator-5.8.2-normal.txt 2>&1`
- `npm run test:rules:strict > emulator-5.8.2-strict.txt 2>&1`
- `npm run rules:limits -- <file>`

## Phase 5.4d (v5.8.3)

| Suite | Result in the build environment |
|---|---|
| Unit + static | **303/303** |
| Browser E2E | **114/114** (single clean run) |
| Real emulator, Normal / Strict | **NOT EXECUTED.** Expected **125/125** each |

**Never run two E2E suites at once:** they share the fake database and corrupt each other's state.

## Phase 5.5 (v5.9.0)

| Suite | Result in the build environment |
|---|---|
| Unit + static | **312/312** |
| Browser E2E | **115/115** |
| Real emulator, Normal / Strict | **NOT RUN.** Expected **130/130** each |

**Count E2E processes with:** `ps -eo comm,args | awk '$1=="node" && /run-e2e/'` (a plain `grep` also matches the calling shell).

## Phase 5.6 (v5.9.1)

| Suite | Result in the build environment |
|---|---|
| Unit + static | **322/322** |
| Browser E2E | **116/116** (lightweight bell; see the report §4a for the run history) |
| Real emulator, Normal / Strict | **NOT EXECUTED.** Expected **133/133** each |
