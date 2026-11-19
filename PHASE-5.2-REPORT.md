# HomeHub V5 — Phase 5.2 Report: Life Savings & Zakat (completion)

**Version:** 5.6.0 • **Baseline:** Phase 5.1.3 (rules published; 85/85 real emulator tests passed). **Nothing was deployed, no rules were published, and no production data was touched.**

## Recommendation: **NO-GO** (until the real emulator confirms)
Phase 5.2 changes `firestore.rules` (the Zakat records only). The real emulator could not run in the build environment. To move to **GO**, all three are needed:
1. `npm run test:rules` reports **90/90**;
2. `STRICT_DENIALS=1` reports **90/90** for the privacy suite (no denial produced only by the 1000-expression limit);
3. you have reviewed the two rule changes below.

## 1. Audit and gap analysis

**No authoritative "Phase 5.2" specification existed in the project.** Life Savings and Zakat were implemented in **Phase 5** (v5.5.0) and hardened in 5.1–5.1.3. I audited the code against the 5.2 brief.

| Brief capability | Status before 5.2 | Evidence |
|---|---|---|
| Savings dashboard; asset types & descriptions; opening balance; additions / withdrawals / adjustments; history; balances; currency | **Complete** | `savings-model.js`, `savings-store.js`, `page.js`; unit + E2E S-flows |
| Personal vs household; explicit sharing; revocation (assets + events) | **Complete** | `updateAsset` re-labels events in the same batch; emulator "5 CRITICAL" |
| Loading / empty / validation / error states | **Complete** | `page.js`, `savings-dialogs.js` |
| Configurable Nisab, Hawl (Hijri / Gregorian), eligible vs excluded, transparent formula | **Complete** | `zakat-engine.js`, `zakat-tab.js` |
| Record payments; history | **Complete** (append-only) | `recordPayment` |
| **Estimated liability vs recorded payments vs outstanding** | **Missing**: payments were never linked to a Hawl (`snapshotId` always null); no outstanding figure; `snapshotId` unvalidated by the rules | `zakat-tab.js`, `firestore.rules` |
| **Zakat privacy with optional explicit sharing; revocation** | **Missing**: readers fixed to owner (+ guardians); records fully immutable, so sharing could never be revoked | `zakat-tab.js`, `firestore.rules` |
| Owner never gets another adult's private data | **Complete** (rules) | emulator 5 CRITICAL, 5.1.3 "mine" queries |

Only the two missing items were implemented. Nothing that already worked was rebuilt.

## 2. Implemented

1. **Zakat ledger** (`zakat-ledger.js`, pure). For each saved Hawl calculation (snapshot) it shows:
   - **estimated**, **paid** (payments linked to it) and **outstanding** = max(0, estimated − paid);
   - overpayment shown separately; never negative.

   Payments without a valid link are listed separately as "not linked" and are **never guessed onto a Hawl**.
2. **Paying a completed Hawl** (`payHawl`): ONE batch = that Hawl's calculation (**only if none exists**) plus the payment linked to it (plus the optional single Finance expense). Further instalments link to the same calculation. With no completed Hawl, the payment is recorded as an **advance** (unlinked), labelled as such in the dialog.
3. **Explicit Zakat sharing** ("Who can see my Zakat"):
   - **private by default**; choose adult members;
   - unticking **revokes** access, re-labelling `readers` on all of that owner's records in this Home in one batch, with content untouched;
   - a child's guardians always remain readers.
4. **Read-only view for a sharee:** it shows **only the owner's saved records** (calculations, payments, ledger) and never a live estimate. A live estimate would be computed from the assets *the viewer* can read, not the owner's, and would be misleading. The selector labels these as "(shared with you)".
5. **Arabic/English:** 23 new keys per language. The existing design language is reused (cards, `zk-table`, `fin-members`).

**Proposals (not implemented; not previously approved):**
- an asset detail page;
- revocable sharing for *historical* payment-linked Finance expenses (governed by wallet privacy today);
- Zakat sharing across Homes.

## 3. Firestore rule changes and security explanation

Generated with `npm run rules:compare` (5.1.3 → 5.2):

## Functions
- Added (0): —
- Removed (0): —
- Changed (0): —

## Match paths
- Added (0): —
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/zakatRecords/{recordId}`: changed create/update

**Only `zakatRecords` changed.** No function, path or other rule was touched.

**A. New `update` path (sharing / revocation): only `readers` may change.** All of these are required:
- `changed().hasOnly(['readers'])`: amounts, dates, calculations, owner and kind stay **immutable**;
- the caller is the record's **owner**, or a **guardian of a child owner**, and holds `savings.zakat`;
- the owner remains a reader; the caller remains a reader;
- **all of a child's guardians remain** readers (`hasAll(guardianUids)`);
- readers are members of this Home (at most 5 besides the owner; at most 6 in total).

**The Home owner gains nothing:** unless they are the record's owner or a guardian, the update is denied. There is no `isOwner` / admin override (a static test pins this). Delete stays denied.

**B. Tightening: `payment.snapshotId`** must be `null`, or reference a `kind: 'snapshot'` record of the **same owner**, existing already or created in the same batch (`getAfter`). Previously any string was accepted. Existing production payments are compatible: the app only ever wrote `null` before 5.2.

**Unchanged:**
- read access is `isActiveMember && uid in readers`, so revocation takes effect immediately for get **and** query;
- creation rules for profiles and snapshots;
- every Phase 5.1.3 protection (adoption L1–L20, private wallets / savings, cross-Home, roles).

## 4. Data preservation and legacy

- **No schema migration.** No field was added. Records with `snapshotId: null` show as "not linked".
- Sharing changes only `readers`, and only when the owner asks. Historical amounts, calculations and dates are never rewritten.
- The legacy Home, members, roles, wallets, savings and Zakat records are untouched; no data step runs automatically.
- **No new indexes** are needed: every query uses one field (`readers array-contains`, `audience` / `visibility ==`).

## 5. Files

**Added:**
- `src/modules/savings/zakat-ledger.js`
- `tests/unit/zakat-ledger.test.mjs`

**Modified:**
- `firestore.rules`
- `src/modules/savings/savings-store.js` (`payHawl`, `setZakatSharing`, `ledger`, `zakatReadersOf`; shared `paymentOps` / `snapshotDoc` builders)
- `src/modules/savings/zakat-tab.js`
- `src/core/i18n/locales/{en,ar}.js`
- `tests/rules/rules.test.mjs` (`assertDenied`, `STRICT_DENIALS`, Z1–Z8)
- `tests/static/static.test.mjs`
- `tests/e2e/run-e2e.mjs` (Z-UI)
- `package.json`, `src/config/app-config.js` (version)
- Documentation

## 6. Tests and exact commands

| Suite | Command | Result here |
|---|---|---|
| Unit + static | `npm test` | **241/241 PASS** (+5 ledger/store, +1 rules-shape guard) |
| Offline rules-file check (not a rules result) | `npm run test:rules:smoke` | No JavaScript-level failures (90 tests) |
| Browser E2E | `npm run test:e2e` | **105/105 PASS** (+ Z-UI) on repeated runs and from the clean unzip |
| **Real emulator** | `npm run test:rules` | **UNVERIFIED** (not runnable here): expect **90/90** |
| Real emulator, strict denials | `$env:STRICT_DENIALS=1; npm run test:rules` | **UNVERIFIED** |

New emulator tests:

| Test | What it covers |
|---|---|
| **Z1/Z2** | Private by default → explicit share → reader (get and query) → revoke → denied again |
| **Z3/Z4** | Only the owner may re-label; neither the Home owner nor an admin can grant themselves access; the owner must stay; no content change; non-members refused; no delete |
| **Z5** | A child's guardian re-labels but can't be removed; the Home owner (not a guardian) is denied; the child is denied |
| **Z6/Z7** | Dangling or another owner's or non-snapshot link refused; calculation + payment in one batch; instalments; unlinked payments still allowed; amounts and estimates immutable |
| **Z8** | Phase 5.1.3 regression: savings privacy and explicit share |

All Phase 5 / 5.1.3 / 5.2 **privacy denials** use `assertDenied`, which **fails** if the denial message shows the 1000-expression limit.

## 7. Deployment checklist (manual, by you)

1. `npm test` → 241/241.
2. `npm run test:rules` → 90/90; then `$env:STRICT_DENIALS=1; npm run test:rules` → 90/90.
3. `npm run rules:limits -- <emulator output>` → no hits in any **failing** test.
4. Review section 3 (the two rule changes).
5. **Optional backup:** Firestore export from the console.
6. `firebase deploy --only firestore:rules`, then `firebase deploy --only hosting`.
7. Smoke test on production:
   - open Life Savings → Zakat; check the ledger;
   - record an advance payment → listed as "not linked";
   - share with a family member → they see "(shared with you)", read-only;
   - revoke → it is gone;
   - confirm the Home owner still cannot see another adult's private savings or Zakat.

## 8. Known limitations and risks

- **The real emulator result is unverified;** rules logic is proven only by your run.
- Zakat sharing is **per Home** and applies to **all** of an owner's Zakat records in that Home (not per record). It is limited to 5 extra readers.
- Re-labelling is limited to 450 records per change (one batch). A household is far below that, but it is not paginated.
- A payment-linked **Finance expense** follows *wallet* privacy, not Zakat sharing (unchanged from Phase 5).
- The sharee sees saved records only, by design (no live estimate).
- Older-format (pre-V5) business records remain preserved but not shown in V5 screens (unchanged; see Phase 5.1).
