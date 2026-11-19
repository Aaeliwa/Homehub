# HomeHub 6.4.0-b: Batch B (Shared Contacts), Revision 2

**Status:** independent-review corrections B1–B4 are implemented and tested. Not deployed. No production data was touched. Batch C was not started.
**Baseline:** the approved Batch A Revision 2 (`v6.4.0-a-approved`). Branch `v6.4.0-b`. The version stays `6.4.0-b`.

## 0. Revision 2: review findings and resolutions

### B1: Deleted contact security

**Rule** (`firestore.rules`, `/homes/{h}/contacts/{contactId}`):

```
allow get, list: if can(h, 'contacts', 'view')
  && (resource == null || resource.data.deleted == false || can(h, 'contacts', 'delete'));
```

- A soft-deleted document can be fetched (directly or in any query) only by `contacts.delete` holders: owner `*`, admin, or any custom role granting it.
- Every other role's queries must be constrained to `deleted == false`. Unconstrained lists and queries on other fields are denied, because they could return deleted documents.
- The app's listener already uses `where deleted == false`. The Recently deleted query (`deleted == true`) is only offered to `contacts.delete` holders.
- `resource == null`: a get of a missing id is allowed and reveals nothing. It lets an importer tell "never written" from "exists".
- Restore remains a `contacts.delete` update and does not need read access.
- **Store:** a refused edit whose re-read is denied (the contact was deleted meanwhile) is reported as "changed by someone else".
- **Fake SDK** (E2E) mirrors the rule for direct gets, queries and unconstrained collection reads.
- **New emulator test `V64B-8`:**
  - owner, admin and a custom "archivist" role (`view` + `delete`) can make direct gets, run `deleted == true` queries and unconstrained lists;
  - member, viewer, child and a custom role with view/create/edit/import but no delete are denied the direct get of a deleted contact, the `deleted == true` query, the unconstrained list and a query on another field;
  - for the same roles, the active query, a live get and a missing-id get all succeed;
  - restore by the custom role without delete is denied, and by the archivist it succeeds; once restored, viewers can read the contact again;
  - the owner of another Home is denied deleted, active and direct reads, as are unauthenticated users and non-members;
  - a member's create onto a deleted id is denied (no resurrection).
- Rule cost: `get,list` went from 85 to 181 (the limit is 1100).

### B2: Import idempotency

**Planner (`planImport`):**
- **Create** always uses copy 0 of the deterministic id `vc_<fnv64(name + numbers + copy)>`. The planner never bumps an occupied id to a new copy.
- **Keep separate** (explicit) is the only path to copies 1, 2, …. It skips ids known to be taken, including copies planned earlier in the same run.

**Preview:**
- A record whose copy-0 id is already a live contact gets the new status **imported before**.
- Its default is skip. The allowed actions are skip, merge into it, or keep separate; plain "create" is not offered.
- The preview notes whether the contact was edited since the import.

**Execution (`importContacts`):** a refused create never counts as success until the occupying document has been read and classified (`classifyOccupied`):

| Occupant | Outcome | Writes |
|---|---|---|
| live, `source: vcf`, same imported content (name, organization, email, address, notes, phones, categories) | **already** (lost response / retry / other device) | none |
| live, different content (edited since, or a different import) | **kept**: existing data kept | none |
| soft-deleted (readable by `contacts.delete` holders) | **deleted**: not restored | none |
| unreadable (deleted, and the caller lacks `contacts.delete`) | **hidden**: nothing changed | none |
| nothing there | the original error → **failed** (retry) | none |

**Merge retries:** a merge whose target now holds exactly the merged content at `baseRev + 1` is recognised as **already** (lost response). Any other change makes it **stale**, and the user reviews it again.

**Rules guarantee:** a `set` on an existing contact is evaluated as an update. `rev == 1` can never equal `resource.rev + 1`, so the client cannot overwrite an existing contact even if it tried.

**Explicit choices in the UI:** the result lists kept, deleted and hidden items by name. **Add N as new, separate contacts** turns them into Keep-separate operations, and only those may move on to the next copy id. Deleted contacts are never restored by an import.

**Test coverage (unit):**

| Scenario | Test |
|---|---|
| Re-import after soft deletion | as admin → **deleted**; as member → **hidden**; byte-for-byte nothing written; explicit "add as separate" → copy 1 while the deleted one stays deleted |
| Re-import after editing | preview shows **imported before** (edited) with default skip and no plan; a stale or empty snapshot gives creates at copy 0 → **kept** + **already**, edited data intact, no copy |
| Retry after a committed write whose response was lost | creates, an intentional copy and a merge: the first run reports unknown outcomes (merge recognised at once); the retry gives 4 × **already**, exactly one intentional copy, merge applied once (rev 2) |
| Concurrent imports from two devices | `Promise.all` gives each record once (2 created + 2 already); different content on the second device gives **kept**, not overwritten |
| Incomplete or stale directory snapshot | stale snapshot above; truncated directory → import refused (B3); snapshot not ready → refused |
| Explicit intentional duplicates | Keep separate for a record and its in-file twin gives copies 1 and 2; an explicit copy whose id is occupied by a different document moves on to copy 2, and the occupant is untouched |

**Test coverage (E2E):**
- Re-importing the same file shows "0 new · 2 imported before · 1 duplicate" with nothing selectable as create.
- Re-import after deleting a contact reports it as "imported before and later deleted — not restored" with no writes.
- "Add as separate" then creates a new contact while the deleted one stays deleted.

### B3: Directory limits

**Strategy:** bounded reads suitable for Spark, with truncation detected rather than assumed.

- **Live listener:** `where deleted == false` + `limit 1001`. That is the capacity of 1,000 plus one sentinel document. At most 1,001 reads per attach, and only changes after that.
  - **Exactly 1,000:** `atLimit`. A capacity banner shows, **New contact** is disabled, and the store refuses creates.
  - **More than 1,000:** `truncated`. Only 1,000 are kept in memory.
- **What the user sees when truncated:**
  - A red banner explains that the list, search, duplicate checks and export are incomplete.
  - The count reads "n of the first 1000 loaded contacts — the directory has more", and the capacity line reads "More than 1000 contacts — only 1000 loaded".
  - **Import** is disabled, and the store refuses it (`contacts.import.truncated`), because duplicate detection would be unreliable.
  - **Export** still works, but its warning starts with "Incomplete: only the first 1000 loaded contacts can be exported".
- **Capacity during import:**
  - The preview shows "This import adds N; room for M". If N exceeds M, a warning appears.
  - Creates beyond capacity are **failed** with `contacts.err.atLimit` and listed. They are never silently dropped.
- **Recently deleted:** `where deleted == true` + `limit 201`. It shows 200, and "Older deleted contacts exist and are not listed" appears when there are more.
- **Why not a server count:** rules cannot count documents, so the limit is a client limit. A Home can only exceed it through concurrent devices or direct API writes, and then the UI shows the truncation honestly.
- **Tests:**
  - Unit: exactly-at-capacity vs 1,001 contacts (flags, create and import refusal, failures reported, never more than 1,000 in memory); 201 deleted gives `more: true`; a static check that the repository uses `limit + 1`.
  - E2E: 1,004 contacts show the truncated banner, capacity and count text, 1,000 cards, Import and New disabled, and the export warning's "Incomplete" text.

### B4: Integration

- **Patch:** `V640B.patch` was generated against the approved Batch A Revision 2 source.
- **Simulated checkpoint repository:** the Batch A Revision 2 tree plus a `.github/workflows/ci.yml`, the existing `.gitignore` and a `package-lock.json` generated at `6.4.0-a`, committed and tagged `v6.4.0-a-approved`. On a new branch `v6.4.0-b`:
  - `git apply --check` and `git apply` succeeded;
  - `.gitignore`, `.github/workflows/ci.yml` and `package-lock.json` were byte-identical before and after (sha256);
  - `npm ci` passed (npm 10.9.9) both with the lockfile still at `6.4.0-a` and after `npm install --package-lock-only` (lockfile `6.4.0-b`);
  - the resulting tree is identical to the delivered source;
  - `npm test` gave 445/445 and the rules smoke check 164/165 on the patched tree.
- **Not touched by the patch:** `.gitignore`, `.github/` and `package-lock.json`. The root `package.json` declares no dependencies; only its version changes, via the patch.
- **Regression tests:** every previous test is still present. The only renames are the two version pins from v8 to v9 (rules L3, E2E L4).
- **Cleaning reset generation protection:** `src/modules/cleaning/` and every cleaning rule line are byte-identical to Batch A Revision 2.
- **Caveat:** the real GitHub repository could not be reached from this session (no GitHub account linked), so the check above uses a faithful simulation. Run `git apply --check` on the real branch first (§8).

## 1. Features (spec section B), unchanged from the first delivery except where noted

| # | Requirement | Implementation |
|---|---|---|
| 1 | Shared household contacts | `homes/{h}/contacts`: one directory per Home, visible to every role with `contacts.view` |
| 2 | Add / edit / delete / search | Revisioned field-level edits; soft delete with Recently deleted and restore; search by name, organization, email, category or number in any format (`+20 100…` ↔ `0100…`, Arabic-Indic digits); Arabic folding |
| 3 | Multiple categories | ≤ 10 per contact; 10 suggested (EN/AR, idempotent) plus custom (owner/admin); removing a category never touches contacts |
| 4 | Labelled phones | ≤ 10, with standard or custom labels |
| 5 | Dialer | `tel:` from validated numbers only |
| 6 | WhatsApp | `wa.me/<digits>` with `noopener,noreferrer`; a national number asks for the country code and never guesses it |
| 7 | Shared favourites | `favorite` on the contact (`contacts.edit`); sorted first; filter |
| 8 | VCF import 2.1 / 3.0 / 4.0 | Bounded parse (1 MB, 500 records), preview, duplicate resolution (skip default, merge, keep separate), retry; **rev 2:** imported-before status, verified conflicts, no automatic copies or restores |
| 9 | VCF export | vCard 3.0, UTF-8, CRLF, escaping, ≤ 75-octet folding; personal-information warning; **rev 2:** truncation warning |
| 10 | Navigation | Mobile dock, desktop rail and Tools tile |
| 11 | EN / AR + RTL | All `contacts.*` keys in both locales (2,585 keys each) |
| 12 | Responsive light / dark | 320–412 and desktop, RTL, dark, no overflow |
| 13 | Permissions, audit, isolation | Template v9 and strict rules; **rev 2:** deleted-contact visibility |
| 14 | Additive schema / rules | 2 new collections and 5 new functions; `adoptionTemplateVersion` 8 → 9; no existing allow statement changed |

## 2. Firestore schema and permission matrix

The full schema is in `FIRESTORE-SCHEMA.md` and the full matrix in `SECURITY.md`. Both are updated for rev 2.

| Permission | owner | admin | member | viewer | child |
|---|---|---|---|---|---|
| contacts.view: read **live** contacts and categories | ✓ | ✓ | ✓ | ✓ | ✓ |
| read **soft-deleted** contacts (view + delete) | ✓ | ✓ | – | – | – |
| contacts.create / edit (incl. shared favourite) | ✓ | ✓ | ✓ | – | – |
| contacts.import / export | ✓ | ✓ | ✓ | – | – |
| contacts.delete (soft delete / restore) | ✓ | ✓ | – | – | – |
| contacts.manageCategories | ✓ | ✓ | – | – | – |
| hard delete | – | – | – | – | – |

- Template v9 is additive. In existing Homes the owner has everything at once.
- The v8 contacts grants already work for the other roles: view for all, create and edit for admin and member, delete for admin.
- Admin and member get import, export and category management after **Update default roles**.

## 3. Security rules: changes and complexity

- **New:**
  - functions `contactPhoneOk`, `contactPhonesOk`, `contactCatsOk`, `contactContentOk`, `contactCategoryOk`;
  - matches `/homes/{h}/contacts/{contactId}` and `/homes/{h}/contactCategories/{catId}`.
- **Changed:** `adoptionTemplateVersion()` returns 9. No allow statement on any existing path changed (`tools/rules-compare.mjs`).
- **Contacts:**
  - create: exact keys, bounded and validated content, `rev 1`, the caller as author, server time, `source` decides `create` vs `import`;
  - update: `rev + 1`, stamped by the caller; a delete or restore changes only the delete fields and needs `contacts.delete`; an edit needs a live contact and `contacts.edit`; `createdBy`, `createdAt`, `source` and `schemaVersion` are immutable;
  - delete: never.
- **Categories:** `manageCategories`; suggested `key` ↔ `s_<key>` id; `rev + 1`.
- **Estimated cost** (static, worst case; limit 1100 per allow; the highest existing rule is 1026):

| Rule | Cost |
|---|---|
| contacts create | 714 |
| contacts update | 647 |
| **contacts get/list (rev 2)** | **181** |
| contactCategories create | 257 |
| contactCategories update | 214 |
| contactCategories get/list / delete | 85 |

- Document lookups: membership and role only (2 reads, cached per request). The rev 2 `can(delete)` reuses the same membership and role documents.

## 4. Test results (exact)

| Suite | Command | Result |
|---|---|---|
| Unit + static | `npm test` | **445 / 445 pass**: 425 Batch A, 14 Batch B, 6 new rev 2 |
| Rules: JS smoke (offline; **does not evaluate rules**) | `npm run test:rules:smoke` | **164 / 165**. The single failure is the known L14, which needs real rule enforcement (as before). No JavaScript-level failures |
| Rules: cost | `npm run rules:cost` | every statement < 1100 |
| Browser E2E (Playwright + fake SDK) | `npm run test:e2e` | **126 / 126 pass**. The `V640-B` check is extended for rev 2 |
| Patch on simulated checkpoint | `git apply` + `npm ci` + `npm test` | applied cleanly; protected files unchanged; `npm ci` passes; 445 / 445 |

**Outstanding (not executed here):**
1. **`npm run test:rules` (Firestore emulator).** NOT RUN: firebase-tools cannot be installed in this environment (package installs blocked). It includes the 8 contacts emulator tests (`V64B-1` … `V64B-8`, with B1 in `V64B-8`). It must pass in CI or locally before approval. In particular, it is the only real proof of the `resource == null` / `deleted == false` query-constraint behaviour.
2. `npm run test:rules:strict` (emulator audit mode). NOT RUN, for the same reason.
3. Android device checks (§6). Manual.
4. `git apply --check` on the real `v6.4.0-a-approved` checkout (§8). The real repository was not reachable from here.

## 5. Constraints

- Batch A behaviour is preserved, and the cleaning module and rules are byte-identical.
- No Storage, Functions, paid APIs or binary media.
- `.gitignore`, `.github/` and `package-lock.json` are not in the patch or ZIPs.
- Version `6.4.0-b`. Batch C was not started. Nothing was deployed.

## 6. Android acceptance checklist (rev 2)

1. The dock shows **Contacts**, Tools shows an active Contacts tile, and the page shows "n of 1000 contacts".
2. Add an Arabic-named contact with a mobile number and a custom-label landline. Both are shown.
3. **Call** opens the dialer with the number pre-filled and nothing is dialled. **WhatsApp**: `+20…` opens directly; `0100…` asks for the country code first.
4. Search `احمد` finds `أحمد`. `+20 100…` finds a contact saved as `0100…`.
5. Favourite a contact on one phone; it shows as a favourite on another member's phone.
6. Import a `.vcf` exported from the phone. Duplicates are skipped by default and photos are reported as skipped. Confirm; the counts match.
7. Import the **same file again**. The rows show "imported before" or "duplicate", nothing is selected and nothing is added.
8. Edit one imported contact, then import the file again. It shows "imported before — edited since" and stays skipped. The edit is kept.
9. As an admin, delete an imported contact, then import the file again. The result says it was imported before and deleted — not restored. Recently deleted still lists it. "Add as new, separate contacts" creates a new one only when tapped.
10. Switch to airplane mode during an import. Failed rows show **Retry**. Go back online and retry: there are no duplicates.
11. Import the same file on two phones at the same time. Each contact exists only once.
12. **Export .vcf** for a category and open it in the phone's Contacts app. Names, numbers and Arabic text are intact.
13. As a member, viewer or child: there is no **Deleted** button, and deleted contacts never appear anywhere, including search. A viewer or child has no add, import, export or favourite controls, but Call works.
14. (Optional, test Home only) With more than 1,000 contacts: a red "incomplete" banner shows, Import and New are disabled, and the export warning starts with "Incomplete".
15. Arabic RTL and dark mode at phone width: no sideways scrolling. Batch A spot-check: the cleaning routine after a reset, the dock, and the finance tile.

## 7. Files

`V640B-CHANGED-FILES.txt` lists the 31 files (git name-status) changed relative to Batch A Revision 2: 21 modified and 10 added. Nothing is deleted.

## 8. Integration

```bash
git checkout -b v6.4.0-b v6.4.0-a-approved
git apply --check V640B.patch && git apply V640B.patch      # includes the package.json version hunk
npm install --package-lock-only --ignore-scripts            # optional: lockfile version → 6.4.0-b (npm ci passes either way)
npm ci
npm test && npm run test:rules:smoke && npm run rules:cost && npm run test:e2e
npm run test:rules                                          # emulator — REQUIRED before approval
git add -A && git commit -m "V6.4.0-b Revision 2: Shared Contacts"
```

- Alternatively, copy the changed-files ZIP over the checkout. It deliberately excludes `package.json`, so apply only that hunk from the patch.
- Existing workflows, `.gitignore` and `package-lock.json` are untouched.

**Deployment (after approval only):**
1. Deploy the rules.
2. Deploy hosting.
3. The owner of each Home runs **Update default roles** (template v9).

## 9. Rollback

- **Hosting:** redeploy `v6.4.0-a-approved`. Contacts disappears from navigation.
- **Rules:** the Batch B rules are additive. To remove them, redeploy the Batch A `firestore.rules` (this also restores `adoptionTemplateVersion` 8).
- **Data:** `contacts` and `contactCategories` remain and are ignored by the old client. Roles at v9 keep harmless extra `contacts.*` grants. No other data is changed.
