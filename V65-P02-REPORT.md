# HomeHub V6.5 Phase 02: Pantry stock foundation (6.5.0-p02)

**Status:** implemented, updated for the independent review findings (§11), and pushed **only** to
`feature/v6.5-p02-pantry-stock` as one commit on the approved baseline. **Not deployed and not merged.** A pushed branch is
not release approval. The change is not production-ready until it has had an independent review, a green CI run (including
the real Firestore emulator in normal **and** strict mode, which could not run in Claude's sandbox) and staging UAT.

## 1. Baseline and source audit

| Item | Value |
|---|---|
| Repository | `Aaeliwa/Homehub` (read-only, anonymous `git fetch` through the sandbox proxy) |
| Baseline | `2de5b49dcb16a3d5b8db9fcea33ec38d51f798f3` = `refs/tags/v6.5.0-p01-approved^{}` = `origin/main` at build time |
| Target branch | `feature/v6.5-p02-pantry-stock`. It did not exist on the remote; Claude created it from the baseline and pushed one commit (no force-push). |
| Work tree | A fresh detached worktree at the baseline. The earlier Phase 01 sandbox patch was **not** reused. |

Every file was inspected **from the approved baseline** before it was changed: the inventory module (all 7 files),
`firestore.rules` (helpers, `can` / `canWith` / `roleGrants`, stamp helpers, the pantry block, legacy adoption, the role rules,
and the paired-revision precedents such as `cleaningDeviceSeasons {id}_s{rev}`), `firestore.js`, `sdk.js`, `roles.js`,
`settings-service.refreshSystemRoles`, the registry, the family directory, i18n, the CSS, the fake SDK, the smoke stub,
the rules test helpers, the tools (`rules-cost`, `rules-limits`, `rules-compare`, `run-strict`) and the CI workflow.

**Discrepancies reported before coding.** None of them is a scope conflict.

1. The approved P01 differs from Claude's earlier P01 sandbox patch:
   - alias validation is per index (`pnAliasOk(a, i)` × 8), not a joined regex;
   - the rules test spoof fixtures use `adminA`;
   - there are later Contacts scroll-test commits.
   The approved code was used as the source of truth throughout.
2. The audits assumed "two update statements" were possible. The repository has **no** precedent for multiple `allow update`
   statements in one match, and the cost tool counts both on a denial. Phase 02 therefore uses **one** statement with a
   top-level ternary (§3.1). The Phase 01 catalog expression is kept verbatim inside it.
3. The existing additive role upgrade (v8 / v9) unions **every** template grant of the namespace. For v10 that would re-grant an
   `inventory.edit` an owner had deliberately revoked. A narrowly scoped `ADDED_GRANTS` mechanism (§4) avoids this.
4. `firestore.indexes.json` was empty, as the audit stated, so the history index is its first entry.

Baselines measured before any change:
- unit/static: **489/489**;
- E2E (fake SDK, separate worktree at the baseline): **139/139**;
- rules: 194,704 bytes; maximum cost estimate 1053.

## 2. Decisions and deviations

| Topic | Decision |
|---|---|
| Initial stock | Creation keeps **zero / unrecorded** stock, and the first stock operation is a separate batch. The roadmap's optional atomic `initial` type is **deferred**: it would change the create permission (`inventory.create` would start writing stock and movements) and the shape of the create rule. `initial` is refused as a type. |
| Unrecorded vs empty | Quantity products with `stockRev 0` are **not recorded yet**, even though their stored `stockMilli` is 0. Presence `null` is also not recorded. A correction with a reason may record a first count of 0, which is the only allowed zero-delta movement. |
| Dimension lock | The Phase 01 rule (`dimension` changes only while `stockRev == 0`) is unchanged, so the dimension stays locked when the balance returns to 0. This is tested in the emulator and E2E. |
| Display-unit change | A real bug was found in the existing editor: changing the unit (kg → g) kept the threshold text, so "1" was re-read as 1 g. That is a silent 1000× rescale. **Narrow fix in `page.js`:** a same-dimension unit change re-expresses the text exactly (1 kg → "1000" g, integer math). Changing the **dimension** (allowed only while unrecorded) still re-reads the number in the new dimension, which is unchanged Phase 01 behaviour and documented here. |
| Update statement | One statement. `incoming().stockRev == resource.data.stockRev ? <Phase 01 catalog expression, verbatim> : pnStockWriteOk(...)`. The branches are disjoint and only one is evaluated. |
| Product-side validation | Includes `pnContentOk` (as required) plus `pnLinkOk`: mode, dimension, revision, before/after arithmetic, presence, type, actor and server time. Type-specific bounds (add > 0 and ≤ 10^9, reasons, no-ops, neutral future fields, key set) are enforced by the movement rule, which must pass in the same batch. |
| Optional notes | Add, remove and presence take an optional note (null or 1–200 characters, non-blank). A correction requires one. |
| Actor names | History reuses the **existing shared, scope-bound family directory**: one members listener, with `members.view`. There are no per-row reads. The fallback is "member" plus the first 8 characters of the UID, or "You". |
| History freshness | History is a one-shot `getDocs`. When offline the SDK may answer it from the memory cache. It is labelled "Recent history (latest 50)" and is never used for a write decision. |
| Version | `6.5.0-p02` in `app-config.js`, `sw.js` (`SW_VERSION`), `package.json` and `package-lock.json`. The legacy `APP.phase: '4A'` display label is **unchanged**: it appears only in the Settings version line and is not a routing contract, so changing it was out of scope. |
| No new types | Only add, remove, correction and presence. Consumption, purchase, cook and initial are refused by both the model and the rules. |

## 3. Schema and rules invariants

### 3.1 Product: the stock branch (`pantryProducts/{productId}`, same update statement)

- Mask: `changed().hasOnly(['stockMilli','presence','stockRev','updatedBy','updatedAt'])`.
- `stockRev` is an int equal to stored + 1. `rev` is unchanged.
- The product was active before (`resource.data.archived == false`) and is active after (the mask excludes `archived`, and `pnLinkOk` checks `A.archived == false`).
- `stampedBy()`: `updatedBy` is the caller and `updatedAt == request.time`. `pnContentOk(incoming())` holds.
- `!exists(movement) && existsAfter(movement)` at `{productId}_s{incoming().stockRev}`. The movement must be **new in this batch**; `existsAfter` alone would accept a planted, pre-existing movement, which is tested in V65P02-4.
- `pnLinkOk(getAfter(movement), resource.data, incoming(), productId)`:
  - same product, `M.stockRev == A.stockRev == B.stockRev + 1`;
  - actor is the caller and `at == request.time`;
  - `A.rev == B.rev`, and track mode and dimension unchanged with `M.dimension == B.dimension`;
  - quantity: type is add, remove or correction, `before == B.stockMilli`, `after == A.stockMilli`, `delta == after − before`, `A.presence == null`;
  - presence: type is presence, `beforePresence == B.presence`, `afterPresence == A.presence`, `A.stockMilli == null`.
- `pnStockCan`: `inventory.view` **and** `inventory.adjust` for a correction or `inventory.edit` otherwise.

### 3.2 Movement (`pantryMovements/{productId}_s{stockRev}`)

The movement is create-only, with `allow update, delete: if false` for everyone. The create rule checks:
- exact keys (24);
- `productId` matches the id regex, `stockRev` is an int ≥ 1, and the doc id equals `productId + '_s' + string(stockRev)`;
- `exists(product)` before and `existsAfter(product)`;
- `pnLinkOk(M, get(product), getAfter(product), M.productId)`, so the product advanced exactly one stock revision, is active before and after, and has the same `rev`;
- `pnMovOk(M, B.stockRev == 0)`;
- `pnStockCan`.

Reads need `inventory.view`.

Field types, as checked by `pnMovOk` (full table in `FIRESTORE-SCHEMA.md`):

| Field | add | remove | correction | presence |
|---|---|---|---|---|
| beforeMilli / afterMilli | int 0…10^12, whole pieces for count | same | same | null |
| deltaMilli | 1…10^9 | −10^9…−1 | ≠ 0, or 0 only for the first count | null |
| requestedMilli | \|delta\| | \|delta\| | \|delta\| | null |
| unfulfilledMilli | 0 | 0 | 0 | null |
| note | null or 1–200 | null or 1–200 | **1–200, required** | null or 1–200 |
| beforePresence / afterPresence | null / null | null / null | null / null | null, in, low or out / in, low or out, ≠ before |
| dimension | count, mass or volume = product's | same | same | null |
| ruleRev, segment, occFrom, occTo, tripId, line, cookId | null | null | null | null |
| coveredMilli | 0 | 0 | 0 | 0 (the D.2 neutral value) |
| operationId | `^[A-Za-z0-9_-]{16,64}$` | same | same | same |
| actorUid / at / schemaVersion | caller / `request.time` / 1 | same | same | same |

Refused writes:
- a standalone product or movement write;
- a mixed metadata + stock write, or archive + stock;
- create + stock;
- a skipped or repeated `stockRev`, or stock carried in the catalog branch;
- reuse of a pre-existing movement, or a second movement for one revision;
- a wrong, malformed or other-product id;
- missing or extra keys;
- future types, or non-neutral provenance;
- forged actor, `updatedBy`, `at` or `updatedAt`;
- an update or delete, even by the owner;
- cross-home writes, unauthenticated writes, and writes by viewers, children or non-members.

### 3.3 Client protocol (`inventory-store.submitStock`)

1. **Preconditions:**
   - the store is ready;
   - the snapshot is **not `fromCache`** and this product has no pending local writes (`includeMetadataChanges`);
   - the browser reports online (necessary, never sufficient);
   - the product is active;
   - no unresolved operation exists on this product;
   - `stockRev`, `dimension` and `trackMode` still equal the values the dialog **captured** when it opened.
2. Pure `planStock` (validation and integer math) produces **one** batch: product mask + movement at the deterministic id.
3. **Confirmed** only when `commit()` resolves. While it is pending the product shows "Saving…" / "Waiting for server", never "saved".
4. On failure there is a **server-confirmed** read (`getDocFromServer`) of the same movement id:
   - every field matches except `at` (`operationId`, actor, values) → **confirmed** (lost acknowledgement);
   - another movement is there → **conflict**;
   - nothing is there after a settled commit → **rejected** (not applied); the reason comes from a server read of the product (stale, archived);
   - the server is unreachable → **unknown**: the product is blocked, and the dialog opens in review mode with "Check again" (a server read, no write).
5. **No automatic retry.** No fresh revision is generated for a retry: after any non-confirmed outcome the dialog cannot submit, and the user reopens it from the current balance. Submissions are de-duplicated with an immediate `sent` flag, a busy (disabled) button and the store's in-flight block.
6. Disposal on Home switch, sign-out or unmount clears in-flight state, stops emissions and drops late dialog or history results.

**Stated limits:**
- The rules cannot prevent a member from intentionally submitting two distinct valid operations, for example adding 1 twice.
- `operationId` is client-generated and only identifies *our* write at a deterministic id; it is not a global uniqueness guarantee.
- After a network drop the SDK may deliver a queued write later. The client cannot cancel it or guarantee an offline rejection, so it shows the write as pending or unconfirmed.

## 4. Permission upgrade (role template v10)

- `inventory.adjust` is declared with `standardPermissions('inventory', { extra: ['adjust'] })` and defaults to admin and member. The owner gets it through `*`; viewer and child do not.
- `ROLE_TEMPLATE_VERSION = 10`, `TEMPLATE_CHANGES[10] = ['inventory']`, `ADDITIVE_VERSIONS` includes 10, and the new `ADDED_GRANTS[10] = ['inventory.adjust']`.
- `upgradeRolePermissions` unions **only** `inventory.adjust`, and only when the role's template has it. It does not re-add any other `inventory.*` default, keeps every custom grant, never touches a role already at v10, and leaves the owner at `['*']`.
- The upgrade happens only when the owner clicks **Settings → Update default roles**, the existing flow. There is no silent migration.
- **Existing Homes:** until the owner upgrades or grants `inventory.adjust` by hand, admins and members cannot correct stock. They can still add, remove and set presence. The rules never fall back to `inventory.edit`.
- `adoptionTemplateVersion()` in the rules is 10, kept equal to `ROLE_TEMPLATE_VERSION` by the existing static test.
- No `manageRules` permission was added.

## 5. Files (35: 28 modified, 7 new, 0 deleted)

| Area | Files |
|---|---|
| New source | `src/modules/inventory/stock-model.js` (pure model), `src/modules/inventory/movement-ui.js` (stock and history dialogs), `src/modules/inventory/pending-ops.js` (unresolved-operation registry, §11) |
| New tests and docs | `tests/unit/v65-p02.test.mjs`, `tests/unit/v65-p02-review.test.mjs`, `V65-P02-REPORT.md`, `V65-P02-TERMUX.md` |
| Inventory | `inventory-repository.js` (metadata listener, history, server reads, `commitStock`), `inventory-store.js` (protocol, recovery, repeat guard), `page.js` (status, filter, controls, unresolved-operation banner and notices, threshold fix, notice removed), `module.js` (`adjust`) |
| Core (additive) | `core/data/firestore.js` (+`watchWhereLimitedMeta`, `readWhereOrderedLimited`, `readDocServer`), `core/firebase/sdk.js` (+`getDocFromServer`, `orderBy`), `core/permissions/roles.js` (v10) |
| Rules / index | `firestore.rules`, `firestore.indexes.json` |
| UI | `assets/css/modules/inventory.css`, `core/i18n/locales/en.js` and `ar.js` (89 keys in each language, of which 12 are review keys; 2 obsolete keys removed) |
| Version | `src/config/app-config.js`, `sw.js`, `package.json`, `package-lock.json` |
| Docs | `CHANGELOG.md`, `FIRESTORE-SCHEMA.md`, `SECURITY.md` |
| Tests changed | `tests/rules/rules.test.mjs`, `tests/e2e/run-e2e.mjs`, `tests/e2e/fake-sdk/firebase-firestore.js`, `tests/e2e/fake-sdk/store.js`, `tests/rules-smoke/stub_modules/firebase/firestore.js`, `tests/unit/v65-p01.test.mjs`, `tests/unit/zakat.test.mjs`, `tests/unit/legacy-adoption.test.mjs`, `tests/static/static.test.mjs` |

Not changed: `.github/workflows/verify.yml`, `src/config/firebase-config.js`, `firebase.json`, `.firebaserc`, and the rules
outside the pantry block and `adoptionTemplateVersion`.

## 6. Tests and results

| Command | Result | Notes |
|---|---|---|
| `npm test` | **510 / 510 pass** | baseline 489 + 14 (`v65-p02`) + 7 (`v65-p02-review`) |
| `npm run test:rules:smoke` | **184 / 185**: the only failure is L14, as expected. Prints "OK: no JavaScript-level failures" | JS-level only. **Not security proof**: it does not evaluate rules. |
| `npm run rules:cost` | max **1053** (contacts create, unchanged); pantryProducts update **640 → 866**; pantryMovements create **658**; pantryProducts create 706 (unchanged) | an estimate; the emulator is authoritative |
| `node tools/rules-compare.mjs <baseline> firestore.rules` | 7 functions added, `adoptionTemplateVersion` changed, path `pantryMovements` added, pantryProducts: changed update. Nothing else. | |
| rules size | **201,527 bytes** (gate 245,000; limit 256 KB) | |
| `npm run test:e2e` (full, fake SDK) | **143 / 143 pass** | §6.1 |
| `npm run test:rules` / `test:rules:strict` / `rules:limits` | **NOT RUN** | No Firestore emulator in the sandbox: the npm registry and the emulator download are blocked. They must run in GitHub Actions and are **mandatory release gates**; expected **185 / 185** normal and strict (178 + 7 new tests). |

### 6.1 E2E (full suite, fake SDK, Playwright Chromium, run in the sandbox)

- **143 / 143 passed** on the final tree: baseline 139 + 4 new (3 V65-P02 + 1 review check). Exit 0, no page errors.
  Every prior regression passed, including the Contacts scroll / delete / Back checks (V641-A, all variants), the legacy
  adoption checks L1–L20, and the V65-P01 pantry checks.
- Before the review round: a first full run was 141 / 142, because E2E L4 still pinned the adopted owner role at template v9.
  It was updated to v10, and a clean rerun gave 142 / 142.
- The E2E uses the fake SDK. It mirrors key rules for meaningful UI flows, but it is **not** security proof.

### 6.2 New and changed tests

**New unit tests** (`tests/unit/v65-p02.test.mjs`, 14):
- exact add/remove arithmetic, including the 0.1 + 0.2 no-drift case;
- limits: 10^9 per step, 10^12 per product;
- Arabic digits, incompatible units, whole pieces;
- unrecorded vs known zero and the first zero count;
- no-ops and correction reasons (required, blank, too long, trimmed);
- presence transitions; threshold equality is not low;
- the deterministic id, the 24 keys and the neutral future fields;
- independent masks (stock never touches `rev`; catalog never touches stock);
- operation ids and reconciliation matching;
- the store: confirmation only after the ack, a single batch, captured-revision binding, stale and dimension races, gating (cache, pending, offline), lost ack, conflict, rejected/stale, archived meanwhile, unknown → review, a pending write never declared "not applied", disposal, bounded history;
- role v10: exact grant, revoked defaults stay revoked, custom grants kept, v8 → v10;
- static guards: additive data layer, SDK exports, create-only movements, the index, no delete, no timers or retries in the store, a single commit site, no money fields, no shopping, no `navigator.onLine` in the UI, the notice removed, version;
- i18n coverage, including dynamic keys.

**New emulator tests** (`V65P02-1` … `-7`; not run here):
- happy paths for every role and type, the first zero count, reads, and the bounded history query;
- the product side, adversarial;
- the movement side, adversarial: about 45 cases;
- immutability and replay: update and delete by the owner, overwrite, replay, a planted movement, two movements per revision, cross-home;
- permissions: viewer, child and outsider; v9 roles without `adjust`; the owner-triggered v10 role update accepted; a custom child `view + adjust`; no `view` means no stock writes; revoked `adjust`; a suspended member;
- concurrency and races: two writers, a stale plan, catalog and stock independence, the dimension lock at balance 0, the dimension race, the archive race, restore, and archive + stock mixed;
- (review) **V65P02-7**: a multi-product batch with two valid pairs passes; one invalid pair, or an unproven stock update, rejects the whole batch.

**New E2E tests** (4):
- the core flows: unrecorded status, add, remove, overdraft, correction with Arabic digits and a reason, g on a kg product, presence, the first zero count, history, the status filter with search and category, the threshold unit fix, the dimension lock;
- safety: a stale dialog, a concurrent write → conflict, a lost ack → confirmed once, a quadruple submit → 1 movement, a pending write shown as pending and confirmed when the connection returns, the offline/cached block, unknown → review mode → "Check again" → not applied, the archive race, listener release;
- (review) recovery and repeats: an unconfirmed change survives sign-out and reload, is resolved only by server reads ("NOT saved" and "saved" notices, never resent, registry cleared), and an identical repeat needs "record it again";
- permissions and layout: a viewer has history only; a v9 member has no correction; the owner upgrades through Settings; the child is unchanged; archived products are read-only; Arabic, RTL, dark mode at 320 px (dialog fits, focus on the amount).

**Changed existing tests.** Every original assertion was kept or replaced with a stronger one.

| Test | Change and reason |
|---|---|
| `v65-p01` "P01 permissions" | It pinned "no template change" and template v9. It now asserts that v10 is the **only** version touching inventory, adds only `inventory.adjust`, and leaves all Phase 01 defaults unchanged, with Shopping still empty. |
| `v65-p01` "P01 static" | "stock written only at creation" became "stock fields are built only by `product-model` / `stock-model`". The rules check now targets the **catalog branch** of the update statement and asserts that none of its masks contain a stock field. |
| `zakat` (role matrix) | `ROLE_TEMPLATE_VERSION` 9 → 10, plus `TEMPLATE_CHANGES[10]`. The v6, v7, v8 and v9 assertions are kept. |
| `legacy-adoption` | 9 → 10: adoption must write the current template. |
| `rules.test` L3/L16/L17/L18 | The adopted owner role's `templateVersion` 9 → 10, for the same reason. |
| E2E V65-P01 catalog | `#pn-notice` "not enabled yet" became "notice absent", plus all three products **not recorded yet** and stock controls present. "No stock controls" became "one stock control per product". |
| E2E V65-P01 permissions | The viewer read-only selector now also requires no `[data-action="stock"]`. |
| `static` browser-storage policy | (review) The allowlist adds **one** file, `pending-ops.js`, and is **tightened** for it: localStorage only, one guarded handle, a fixed key prefix, every get/set/remove inside `try`, and no credentials. **This is a policy change; the reviewer must accept it.** |
| `v65-p02` store tests | (review) Each submission uses a fresh `operationId` (reuse is now refused) and states `confirmRepeat` where a test repeats a change on purpose. The guards are tested separately in `v65-p02-review`. |
| E2E L4 (legacy adoption) | The adopted owner role's `templateVersion` 9 → 10: adoption writes the current template. |
| Fake SDK / smoke stub | Additive test doubles:<br>• metadata (`fromCache`, `hasPendingWrites`) and the options form of `onSnapshot`;<br>• an offline pending overlay and `setOffline`;<br>• `getDocFromServer`, `orderBy`;<br>• `__fakeLoseAckNext`, `__fakeHoldNextCommit` and `__fakeServerDown` controls;<br>• a pantry stock **mirror** of the rules.<br>The real enforcement remains the emulator suite. |

CI was not modified.

## 7. Cost and limits

- **Document accesses:**
  - a stock batch reads at most 6 distinct documents: member, role, product (`get` / `getAfter`) and movement (`exists` / `existsAfter` / `getAfter`). That is within 10 per operation and 20 per batch;
  - the history query is one query with `can()`, using 2 reads.
- **Expressions:** the exhaustive estimates are update 866 and movement create 658, both below the existing maximum of 1053, which passes CI today. The real counter is lower than the estimate but **unverified here**. `rules:limits` on the CI logs must show no pantry hit.
- **Reads per screen:** one bounded products listener (limit 501). History is on demand (limit 50) with no listeners, and there are no per-row reads.

## 8. Unresolved items and blockers

1. **The emulator suites (normal and strict) and `rules:limits` were NOT RUN.** The rules are unverified by a real engine until CI runs. This is the main open risk, and both emulator runs remain **mandatory** release gates (§11, R4).
2. **Real-SDK offline behaviour is not exercised.** E2E uses the fake SDK's model of `fromCache` and `hasPendingWrites`; staging UAT step 10 covers it.
3. The index must be **READY** in each project before history works, so deploy the index first.
4. Existing Homes need the owner's "Update default roles" before admins and members can correct stock (by design).
5. Duplicate protection is client-side. The rules cannot reject a second distinct, valid operation, and `operationId` is not unique server-side (§11, R2).
6. Another open tab of the same user may still hold a queued write when a reload-recovered operation is judged "not saved". The data stays correct (deterministic id + `stockRev` precondition); only that verdict could be early (§11, R1).

## 9. Rollback

- **Code:** drop the branch. Nothing reached `main`.
- **Staging:** redeploy the P01 rules and hosting from `v6.5.0-p01-approved`.
  - The P01 UI shows no stock numbers, so recorded stock is hidden.
  - The P01 rules freeze stock: no mask contains a stock field, and `pnContentOk` still accepts stored non-zero stock, so catalog edits keep working.
  - `pantryMovements` becomes unreadable but is **kept**. Never delete data and never reset stock fields.
  - **Do not** redeploy the old, empty index file, and answer *No* to index deletion prompts. The extra index is harmless.
  - Roles at v10 keep an unused `inventory.adjust`.
- **Backups:** the Spark plan has **no managed export or backups**. This phase rewrites no existing documents, but there is no restore point.

## 10. Manual UAT

See `V65-P02-TERMUX.md` §9e (13 steps).

## 11. Independent review findings: resolution

| # | Finding | Resolution | Regression tests |
|---|---|---|---|
| R1 | Uncertain operation recovery across reload, sign-out, Home switch and store disposal | **Fixed.** See R1 below. | unit R1 × 4 (registry, Home switch while pending, reload, sign-out / other user / failure after disposal); E2E "V65-P02 review" (sign-out + reload) |
| R2 | Duplicate logical operations and the limits of `operationId` uniqueness | **Mitigated and documented.** See R2 below. | unit R2; E2E "V65-P02 review" step 4 |
| R3 | One product per batch: an application constraint or a security invariant? | **Clarified: an application constraint.** See R3 below. | emulator V65P02-7; unit R3 |
| R4 | Keep the normal and strict Firestore emulator release gates | **Kept, CI unchanged**, and now **pinned by a test.** See R4 below. | unit R4 |
| R5 | Termux instructions: use `$TMPDIR` and `~/homehub-config/staging.json` | **Fixed.** See R5 below. | n/a (documentation) |

**R1: recovery.** A per-device registry, `pending-ops.js`, records every stock intent **before** it is sent: the exact expected movement, its deterministic id, the base `stockRev`, and the user and Home.
- **Storage.** It lives in memory, which survives store disposal, Home switches and sign-out within the page. It is mirrored to guarded `localStorage`, which survives a reload, under the key `homehub.pantry.pendingStock.v1.{uid}.{homeId}`. Records are capped at 50, validated, and removed once resolved.
- **Recovery.** A new store for the same user and Home recovers its records and blocks those products.
- **Resolution.** Records are resolved **only by server reads**:
  - automatically, once, on the first server-confirmed snapshot;
  - or with "Check now", or the product's "Check again".
  - The read gives one of three outcomes:
    - our movement is there → confirmed;
    - another movement is there → conflict;
    - nothing is there and the commit has finished → not saved.
- **Commits still in flight.** A commit still pending in this page is never declared "not saved". A record from an earlier page load counts as finished, because that page's memory-only write queue is gone.
- **Notices.** Outcomes are shown as dismissible notices. Nothing is ever resent.

**R2: duplicates.**
- The store refuses any `operationId` already used in this page or still recorded, which makes it "one id, one submission" even across stores.
- An identical change to the same product within 2 minutes of a confirmed one requires an explicit "Yes, record it again". This compares add/remove by signed amount, a correction by its target, and presence by its target state.
- Each dialog still submits once, and each product has at most one unresolved operation.
- **Documented limits (SECURITY.md):** neither guard is enforced by the server. The rules cannot look up movements by field, so two distinct valid operations, from two devices or deliberately, are both accepted. Only `{productId}_s{stockRev}` is unique server-side.

**R3: one product per batch.** This is an **application constraint, not a security invariant.**
- `commitStock` always builds exactly one product update and one movement (a static test pins this).
- The rules validate every pair independently, so a batch of several valid pairs is allowed, bounded by 20 document accesses per batch.
- Any invalid pair rejects the whole batch (V65P02-7).
- This is documented in SECURITY.md and in the store header.

**R4: release gates.** `.github/workflows/verify.yml` is **unchanged**. A new static test fails if:
- any gate step disappears (unit, smoke, cost, normal emulator + limits, strict emulator + limits, E2E);
- any step loses `pipefail`;
- `continue-on-error` appears;
- the step order changes;
- the strict run no longer uses `STRICT_DENIALS=1`;
- any V65P02 emulator test disappears.

The emulator runs were not possible in the sandbox and **must pass in CI before staging.**

**R5: Termux.** `V65-P02-TERMUX.md` was rewritten for the pushed branch:
- it verifies main, the tag and the branch HEAD against the reported SHA;
- it never overwrites local work, and fast-forwards only from the baseline;
- every temporary path is under `$TMPDIR`;
- the staging web config is generated from `~/homehub-config/staging.json` inside a throw-away worktree only, checked to be `homehub-test-640` and never production, then restored;
- it lists the CI gates as mandatory.
