# RULES-PROD-VS-5.1.3: production rules vs Phase 5.1.3

## Status: PENDING. The production rules were NOT received

The brief refers to `Pasted text(9).txt` as the deployed production rules. **That file was not among the uploads** (only `emulator-result.txt` from the 5.1.1 run, the Phase 5.1 brief and the old V4 ZIP). This is the fourth request in which it was referenced but not attached.

Therefore this document **makes no statement about production**: no widened or narrowed access, no data effect, no migration need, and no client-version impact is asserted. A comparison against rules I have not seen would be invented.

### Produce the production section on your machine (Windows, offline)

```powershell
# 1) Firebase console → Firestore Database → Rules → copy the published rules into a file:
#    HomeHub-V5\production.rules
# 2) From the HomeHub-V5 folder:
npm run rules:compare -- production.rules firestore.rules --md RULES-PROD-VS-5.1.3.generated.md
```

Then attach both `production.rules` and the generated file, and the manual security review below gets completed against the real text.

### Manual review checklist (to complete against the real production text)

| # | Question | How to answer it from the generated report | Why it matters |
|---|---|---|---|
| 1 | Match paths **in production but not in 5.1.3** | "Match paths → Removed" | Every client read/write on those paths becomes **denied** after deployment (e.g. older-version collections) |
| 2 | Match paths **in 5.1.3 but not production** | "Added" | New capability; must be reviewed as new attack surface |
| 3 | Any production `allow … if true`, catch-all `match /{document=**}`, or `request.auth != null`-only rule | Search production.rules | Removing it denies every client that relied on it; keeping it would void Home isolation |
| 4 | Per-path `allow` changes | "Allow statements on common paths" | Each must be read for widened access (what newly passes) and narrowed access (what newly fails) |
| 5 | Fields production rules read that 5.1.3 documents lack (and vice versa) | Compare the field names in the changed allows | **Legacy documents:** 5.1.3 never rewrites data. A document lacking a field that 5.1.3 requires becomes unreadable or unwritable through the app until a separate, explicit data step. Your legacy Home's business data is in exactly this category. |
| 6 | Query/listener compatibility of the deployed app version | Map the app's queries (see below) to the production rules | A deployed client issuing an unconstrained list on a path 5.1.3 protects will be denied |
| 7 | Membership / roles / adoption | Production `members` / `roles` / `homes` rules | 5.1.3 adds the one-time adoption; production may have no membership concept at all |

**Queries issued by the 5.1.3 app** (all single-field, so no composite indexes are needed):
- `wallets`: `visibility == 'household'` | `readers array-contains <uid>`.
- `expenses`, `walletMovements`, `spendingCycles`, `commitments`, `savingsEvents`: `audience == 'household'` | `readers array-contains <uid>`.
- `savingsAssets`: `visibility == 'household'` | `readers array-contains <uid>`.
- `zakatRecords`: `readers array-contains <uid>`.
- `invites`: `homeId == <h>`.
- `priceQuotes`, `members`, `rooms`, `devices`: whole collection.
- Single gets on the profile, the membership, the Home, roles and `settings/general`.

## Verified comparisons I *can* make (generated with `npm run rules:compare`)

### Phase 5.1.2 (your last emulator run, 81/83) → 5.1.3
## Functions
- Added (1): isLegacyAdoptionCompanion
- Removed (0): —
- Changed (2): canReadFinance, canReadSavings

## Match paths
- Added (0): —
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/roles/{r}`: changed create


**Security reading of each change:**

| Change | Access effect |
|---|---|
| `canReadFinance` / `canReadSavings`: `(d.readers is list && uid in d.readers)` → `uid in d.readers` | For a **single-document get**: identical (a non-list or missing `readers` makes `in` an error, which already means deny). For a **query**: the `readers array-contains <me>` query becomes provable, so a member's own private records load. Other adults and the Home owner remain denied (they are not in `readers`). **Not widened.** |
| `roles` create (adoption branch) uses `isLegacyAdoptionCompanion` | A role write in an adoption batch now proves only that it belongs to that batch (unadopted stored creator, no prior owner role, the caller's own owner membership with `legacyAdoption` in the same batch). The membership create still runs the **full** `isLegacyAdoption()` proof, and the batch is atomic, so no role can exist without a fully proven adoption. Bootstrap and later role management are unchanged. **Not widened;** fewer evaluated expressions per adoption. |

### Phase 5.1 (original 5.1 ZIP) → 5.1.3 (all repairs since 5.1)
## Functions
- Added (6): canWith, accessW, expenseWalletOkW, joinsByInviteI, isLegacyAdoptionCompanion, savingsEventCreateOk
- Removed (0): —
- Changed (7): can, canReadFinance, access1, access2, expenseWalletOk, joinsByInvite, canReadSavings

## Match paths
- Added (0): —
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/members/{u}`: changed create/update
- `/databases/{database}/documents/homes/{h}/roles/{r}`: changed create
- `/databases/{database}/documents/homes/{h}/devices/{deviceId}`: changed update
- `/databases/{database}/documents/homes/{h}/wallets/{walletId}`: changed get/list/create/update
- `/databases/{database}/documents/homes/{h}/savingsAssets/{assetId}`: changed get/list/create/update
- `/databases/{database}/documents/homes/{h}/savingsEvents/{eventId}`: changed create


