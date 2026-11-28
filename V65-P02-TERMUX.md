# HomeHub V6.5 Phase 02: Termux commands (you run these)

The implementation is on GitHub, on the feature branch **`feature/v6.5-p02-pantry-stock`**, one commit on top of the approved
baseline. Claude pushed only that branch. `main`, the release tags and Firebase are untouched. **A pushed branch is not release
approval.**

**Rules for every command below:**
- Temporary files go under **`$TMPDIR`** (Termux's writable temp folder), never `/tmp`.
- The staging web config lives **outside the repository**, in **`~/homehub-config/staging.json`**.
- `src/config/firebase-config.js` in the repository points at **production** (`expensetracker-d7309`). It is only ever
  replaced inside a throw-away staging worktree, and it is never committed.

## 0. Settings

```bash
REPO="$HOME/homehub-v65-p02"                          # your existing clone / worktree of Aaeliwa/Homehub
BASE_SHA=2de5b49dcb16a3d5b8db9fcea33ec38d51f798f3     # = v6.5.0-p01-approved = main
BRANCH=feature/v6.5-p02-pantry-stock
P02_SHA=<paste the commit SHA from Claude's report>
TEST_PROJECT=homehub-test-640
STAGING_JSON="$HOME/homehub-config/staging.json"
: "${TMPDIR:?TMPDIR is not set: run this inside Termux}"
```

## 1. Verify the remote: main, tag and branch

```bash
cd "$REPO" || exit 1
git remote get-url origin                                         # github.com/Aaeliwa/Homehub(.git)
git fetch origin --tags "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
test "$(git rev-parse origin/main)" = "$BASE_SHA" && echo "MAIN OK"
test "$(git rev-parse 'v6.5.0-p01-approved^{commit}')" = "$BASE_SHA" && echo "TAG OK"
test "$(git rev-parse "origin/$BRANCH")" = "$P02_SHA" && echo "BRANCH HEAD OK"
test "$(git rev-parse "origin/$BRANCH^")" = "$BASE_SHA" && echo "ONE COMMIT ON THE BASELINE"
git log --oneline "$BASE_SHA..origin/$BRANCH"                     # exactly one commit
```

## 2. Check out the branch in a clean tree. Your own work is never overwritten.

```bash
test -z "$(git status --porcelain)" || { echo "working tree not clean: commit or move your changes first"; exit 1; }
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "local $BRANCH exists:"; git log --oneline -3 "$BRANCH"
  # Only if your local branch is exactly the baseline (no local commits) is it safe to fast-forward:
  test "$(git rev-parse "$BRANCH")" = "$BASE_SHA" && git switch "$BRANCH" && git merge --ff-only "origin/$BRANCH" \
    || echo "local branch has other commits: STOP and compare them before doing anything"
else
  git switch -c "$BRANCH" --track "origin/$BRANCH"
fi
test "$(git rev-parse HEAD)" = "$P02_SHA" && echo "HEAD OK"
```

## 3. Review the change

```bash
git diff --stat "$BASE_SHA" HEAD
git diff --check "$BASE_SHA" HEAD && echo "whitespace OK"
git diff "$BASE_SHA" HEAD -- firestore.rules firestore.indexes.json src/core/permissions/roles.js .github/
#   .github/: must print nothing (CI is unchanged)
git show "$BASE_SHA":firestore.rules > "$TMPDIR/base.rules"
node tools/rules-compare.mjs "$TMPDIR/base.rules" firestore.rules
#   expected: functions added pnMovPath, pnProdPath, pnLinkOk, pnMovOk, pnStockCan, pnStockWriteOk, pnMovCreateOk;
#   changed adoptionTemplateVersion; path added pantryMovements; pantryProducts: changed update. Nothing else.
git diff --name-only "$BASE_SHA" HEAD | grep -E 'firebase-config|\.env|\.firebaserc|firebase\.json' && echo "UNEXPECTED: STOP" || echo "no config files changed"
```

## 4. Tests you can run in Termux

```bash
npm ci
npm test                       # expected: 510 / 510
npm run test:rules:smoke       # expected: 184 / 185. Only L14 fails (it needs the emulator). JS-level only: not security proof.
npm run rules:cost             # expected: max 1053 (contacts create, unchanged); pantryProducts update 866; pantryMovements create 658
wc -c firestore.rules          # expected: 201527 (gate 245000)
```

## 5. GitHub Actions: mandatory release gates

The workflow runs only when started by hand. Open **Actions → "HomeHub Verification" → Run workflow**, choose branch
**`feature/v6.5-p02-pantry-stock`**, then run it. With the GitHub CLI:

```bash
gh workflow run verify.yml --ref "$BRANCH"
gh run list --workflow verify.yml --branch "$BRANCH" --limit 3
gh run watch <RUN_ID> && gh run download <RUN_ID> -n homehub-verification-reports -D "$TMPDIR/p02-ci"
```

Release gates. **All are required.** None may be skipped, retried until green, or edited:

| Step | Expected |
|---|---|
| Unit and static tests | 510 / 510 |
| Rules smoke tests | 184 / 185 (L14 only) |
| Rules cost | max 1053 |
| **Normal Firestore emulator** | **185 / 185** (178 + 7 V65P02) |
| Normal rules limits | no hit on `pantryProducts` or `pantryMovements` |
| **Strict Firestore emulator** | **185 / 185** (any limit-caused denial fails) |
| Strict rules limits | no pantry hit |
| Browser E2E | 143 / 143 |

Any failure blocks staging. Report it; do not work around it.

## 6. Staging (homehub-test-640): only after step 5 is green and after independent review

```bash
STAGE="$TMPDIR/homehub-stage-p02"
git worktree add --detach "$STAGE" "$P02_SHA"              # exactly the reviewed commit, isolated from your work tree
cd "$STAGE" && npm ci
firebase projects:list | grep -E "$TEST_PROJECT"           # must list the TEST project
```

**6a. Index first.** The CLI may offer to delete indexes that exist in the project but not in the file: answer **No**.
```bash
firebase deploy --only firestore:indexes --project "$TEST_PROJECT"
```
**6b. Rules.** This also validates the compiled size; record any error.
```bash
firebase deploy --only firestore:rules --project "$TEST_PROJECT"
```
**6c. Wait until the index is READY.** History needs it.
```bash
gcloud firestore indexes composite list --project="$TEST_PROJECT"   # pantryMovements (productId ASC, stockRev DESC): READY
# without gcloud: Firebase console → homehub-test-640 → Firestore → Indexes → wait for "Enabled".
```
**6d. Hosting with the external staging config.** The file is generated inside the throw-away worktree only, and checked
before any deploy. `staging.json` may be either the plain web-config object or the output of `firebase apps:sdkconfig web --json`.
```bash
test -f "$STAGING_JSON" || { echo "missing $STAGING_JSON"; exit 1; }
node -e '
  const fs = require("fs");
  const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const c = (raw.result && raw.result.sdkConfig) || raw.sdkConfig || raw;
  const need = ["apiKey", "authDomain", "projectId", "appId"];
  for (const k of need) if (typeof c[k] !== "string" || !c[k]) { console.error("staging.json: missing " + k); process.exit(1); }
  if (c.projectId !== "homehub-test-640") { console.error("staging.json projectId is " + c.projectId + ": STOP"); process.exit(1); }
  const keep = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"].filter((k) => c[k]);
  fs.writeFileSync("src/config/firebase-config.js", "export const firebaseConfig = Object.freeze(" + JSON.stringify(Object.fromEntries(keep.map((k) => [k, c[k]])), null, 2) + ");\n");
' "$STAGING_JSON"
grep -n '"projectId"' src/config/firebase-config.js                 # MUST show homehub-test-640
grep -q expensetracker-d7309 src/config/firebase-config.js && { echo "PRODUCTION CONFIG: STOP"; exit 1; }
firebase deploy --only hosting --project "$TEST_PROJECT"
git checkout -- src/config/firebase-config.js && git status --porcelain   # restored; must print nothing
cd "$REPO" && git worktree remove "$STAGE"
```
Never run `firebase deploy` without `--project "$TEST_PROJECT"`. Never deploy to `expensetracker-d7309` without explicit release approval.

**6e. Manual UAT** (phone; Arabic and English; light and dark; 320 px):
1. Owner: Settings → "Update default roles" (v10). Admin and member gain `inventory.adjust`; the child gains nothing.
2. Phase 01 products show "Not recorded yet", not "Out".
3. Eggs: add 12, remove 7 (Low if the threshold is 6). Removing 6 more is refused. Correct to 6 with a reason: In stock.
4. Rice (kg): add 250 g. It shows 0.25 kg. A presence product: set Running low.
5. An unrecorded product: correct to 0 with a reason. It shows Out.
6. History: newest first, before → after (delta), the actor, the note, "latest 50", and no edit or delete.
7. Add 2 to a product, then try to add 2 again: you must tick "Yes, record it again".
8. Two phones on the same product: save on one, and the other's open dialog shows "changed since you opened".
9. Airplane mode: a "not confirmed" banner appears and stock changes are paused.
10. Start a change, switch on airplane mode right after Save, close the app, reopen it online. Either a "saved" / "NOT saved" notice appears, or "Check now" resolves it. The change is never applied twice.
11. Viewer: history only. Member on a v9 role: no "Correct count".
12. Archive a product: read-only, with history still available.
13. Regression: Contacts scroll and delete, Calendar, Finance, Cleaning and the Dashboard.

## 7. Do not

- merge into `main`, move or retag `v6.5.0-p01-approved`, or force-push;
- deploy to production or change `src/config/firebase-config.js` in the repository;
- start Phase 03.

## Rollback

- **Branch:** nothing reached `main`. To abandon the work, delete the feature branch on GitHub after review.
- **Staging:** redeploy the P01 **rules and hosting** from `v6.5.0-p01-approved` with `--project "$TEST_PROJECT"`.
  - The P01 UI hides recorded stock.
  - The P01 rules freeze stock fields and make `pantryMovements` unreadable, but **keep** them.
  - Never delete movements or reset stock.
  - Never deploy the old, empty index file. Answer No to any index deletion.
  - Roles at v10 keep an unused `inventory.adjust`.
  - Devices may keep a pending-operation record. The P01 code ignores it.
- **Backups:** the Spark plan has no managed export or backups, so there is no restore point.
