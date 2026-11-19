# HomeHub V6.3.0 — Cleaning, installed PWA, Recipes AI import

Baseline: V6.2.2.1. **Not deployed.** No production data accessed. No migration: existing documents are read as they are.

## 1. Cleaning

**Navigation**
- The former Advanced page is now the Cleaning page (`#/m/cleaning`), opening on **Today's routine**.
- The Main tab content, the Basic/Advanced switch and the back link are gone. `#/m/cleaning/advanced` still works and opens the same page.
- Tabs: Routine · Quick · Rooms · Devices · **Tasks** (new) · Templates · AI import · Stats · Settings.
  - **Tasks** holds the old task management: filters, setup banner, New task, the manage list, and the device focus from Device Details.
- Reminder deep links now land as follows:
  - "Pending cleaning" opens the routine.
  - "Overdue" opens Rooms.
  - Device Details "Add task" opens Tasks.
- Tasks that became due after the day's plan was saved now appear under the routine as "Also due today". The old hint pointed to the removed Main page.
- An empty home shows a "Set up cleaning tasks" button.

**AI Import layout:** rebuilt as cards with consistent spacing, wrapping action rows and a labelled prompt box, using design tokens. Checked at 360 px, in RTL and in dark mode.

**Claim removed**
- There are no Claim or Release buttons.
- An existing *claimed* record stays usable: anyone eligible for the task (or the claimer, or an editor) can complete it.
- Assigned/private tasks, children-only tasks and other homes' tasks are still refused.

**Mark All Done** (Today's routine and Quick routine)
- It acts on exactly the pending items **shown**: the routine list, or the Quick pick for the chosen minutes. A 10-minute pick never touches a 15-minute task.
- The button shows the count and is disabled at 0. A confirmation dialog states the count and scope.
- The items are captured at confirmation and rechecked against live data at commit: task active, in schedule, user still eligible, still pending.
- Each item is one audited write (occurrence + log), so the rules check every write.
- An item completed elsewhere in the meantime counts as "already" and is never completed twice.
- A double click is refused (`cleaning.bulk.busy`). Partial failures are reported; pressing again retries only what is still pending.
- Routines, the dashboard and the single "Pending cleaning tasks" reminder update from the same live listeners.

**Settings → Reset tasks** (shown only to authorized managers; the backend is enforced by rules)
- **Reset task progress** (`cleaning.edit`):
  - Recurring tasks get `startDate = today`. Earlier dates and their progress drop out of the schedule.
  - Progress recorded for today or later is undone with the existing audited inverse actions (reopen / unclaim / resume).
  - Nothing is deleted; the audit log is kept. Custom tasks are included.
  - Device-triggered tasks keep their trigger, and only today's progress is undone. One-off tasks in the past remain history.
- **Restore default tasks** (`cleaning.edit` + `create` + `delete`):
  - Room/device template tasks get their original definitions back, using the stable IDs `r_/d_<source>_<key>`. Archived defaults are reactivated, missing ones created, and their progress reset.
  - It is idempotent: a second run changes nothing and never duplicates.
  - Only active rooms/devices are considered, so no tasks are created for removed ones.
  - Custom tasks are **kept** by default. The unchecked-by-default "Also remove my custom tasks" option **archives** them (soft, restorable, history kept) after a warning.
- **Rooms and devices are never written.** The reset code only names `cleaningTasks`, `cleaningOccurrences` and `cleaningLog` (asserted in unit tests and E2E). The old Settings reset text was replaced.
- **No resurrection:**
  - The model ignores occurrences dated before `startDate` (`afterNextDue`, `buildBoard`, `routineItems`).
  - The rules (`cleanDateOk`) refuse new occurrences before `startDate`, so a stale tab cannot recreate pre-reset instances.
  - Retry repeats only the failed steps; an already-reopened item counts as done.

## 2. Installed PWA (URL header)

**Cause found:** HomeHub had **no web app manifest, no service worker and no PNG icons**. Chrome therefore could not install it as an app: "Add to Home screen" created a **browser shortcut**, which opens in a Chrome tab or window with the URL bar. Hosting itself was not the cause:
- no redirects or rewrites;
- hash routing keeps every route on `/`;
- email/password sign-in has no redirect flow;
- external links (YouTube) already open with `target=_blank rel=noopener`.

**Fix**
- **`manifest.webmanifest`**: `id "/"`, `start_url "/#/dashboard"`, `scope "/"`, `display "standalone"` (no fullscreen, no `display_override`), theme/background colours, and 192/512 "any" + "maskable" PNG icons.
- **`index.html`**: links the manifest, apple-touch icon and PNG favicon.
- **`sw.js`** (root scope):
  - It is **network-only**: it caches nothing, so an installed app can never be stuck on old code.
  - On activate it clears any old caches and takes control of open windows.
  - It handles only same-origin page navigations, showing an offline page on failure.
- **`src/pwa.js`**: registers the worker (only on https or localhost; skipped under automation).
- **`firebase.json`**: `no-cache` for `/sw.js` and the manifest, plus the correct manifest MIME type. JS/CSS were already `no-cache`.

**Reinstall needed: yes.** An existing home-screen icon is a shortcut and does not upgrade itself:
1. Remove the old icon.
2. Open the site in Chrome.
3. Use **⋮ → Install app** (not "Add shortcut").

**Real-Android verification: USER VERIFICATION PENDING.** Only static checks and desktop runs were done here.

**Manual Android checklist**
1. After deploy, open the site in Chrome. The menu should offer **Install app**.
2. Install, then launch from the icon. There should be **no address bar**; the status and navigation bars may remain.
3. Log in, move between modules and log out. Everything should stay inside the app window.
4. Open a recipe's "Open on YouTube" link. It should open outside the app, with the browser UI visible.
5. Deploy any later version and relaunch. The new version should appear without reinstalling.
6. Turn on airplane mode and relaunch. The offline page should show, and "Retry" should work once back online.

## 3. Recipes — AI JSON import (no AI API)

**Where:** Recipes → **AI import** (needs `chef.create`).
- Copy AI prompt, Copy JSON template, Download example JSON, paste, upload file.

**Format:** `{ "schema": "homehub.recipes", "version": 1, "items": [ … ] }`, with 1–25 recipes and up to 256 KB.
- Item fields map only to existing recipe fields: `titleEn`, `titleAr`, `description`, `category`, `servings`, `prepMinutes`, `cookMinutes`, `ingredients[{name, amount, unit, note}]`, `steps[{text, minutes}]`, `videoUrl`, `notes`.
- `review[]` holds uncertainty flags. They are shown in the preview and kept in the notes.
- The prompt makes the AI reply `{"needInput": …}` instead of inventing a recipe. The importer recognises that reply and shows the request.
- The template and example both preview as "ready" and pass `validateRecipe`.

**Validation**
- Unknown fields and protected fields (IDs, owners, timestamps, rev, favourites, permissions, `videoId`, …) are refused.
- Also checked: types, lengths, counts, numeric bounds, units, amounts and step timers (1–1440 minutes).
- Links must be safe https: YouTube is embedded as before; other links are shown as links. `javascript:`, `http:`, `data:` and credentialed URLs are refused.
- Text is rendered as plain text only.
- The existing `validateRecipe` has the final say, exactly as for a manual recipe.

**Preview and import**
- Each recipe shows its errors and warnings and a reviewable body. Duplicates (in the file, or in the cookbook by normalised title or video) are **not selected** by default and are never overwritten.
- Nothing is written before **Import n**. Each recipe is then one create-only write with a deterministic `ai_<hash>` ID.
- Counts are reported. **Retry failed** resends only the failures, and an ID that already exists counts as "already", so there are no duplicates.
- Imported documents are identical to `createDoc(validateRecipe(...))`, so search, edit, Start cooking, steps, timers, alarms and video work exactly as for manual recipes.

Also fixed: opening the import view before any recipe was selected bounced back to the library.

## 4. Firestore rules

The only change is in `firestore.rules`, `cleanOccUpdateOk`, on the done-from-*claimed* path:

`R.claimedBy == uid || can(edit)` → `… || cleanMayAct(h, T)`

This is the same eligibility check already used to complete an open occurrence. Assigned, child, private and cross-home tasks are still refused. Cost is within limits (`cleaningOccurrences` update 548 vs the 750 tripwire). Nothing else changed.

## 5. Files changed

- **Cleaning**
  - `src/modules/cleaning/`: `page.js` (now `mountTaskManager`), `advanced-page.js`, `advanced-templates.js`, `cleaning-model.js`, `cleaning-advanced.js`, `cleaning-store.js`, `cleaning-ops.js` (new)
  - `assets/css/modules/cleaning.css`
- **Recipes**
  - `src/modules/chef/`: `recipe-import.js` (new), `chef-store.js`, `chef-repository.js`, `page.js`
  - `assets/css/modules/chef.css`
- **PWA:** `manifest.webmanifest`, `sw.js`, `src/pwa.js`, `assets/icons/*` (all new), `index.html`, `firebase.json`
- **i18n:** `src/core/i18n/locales/en.js`, `ar.js`
- **Rules:** `firestore.rules`
- **Version:** `package.json`, `src/config/app-config.js` → 6.3.0
- **Tests**
  - new: `tests/unit/v630-cleaning.test.mjs`, `tests/unit/v630-recipes.test.mjs`, `tests/static/pwa-static.test.mjs`
  - updated: `tests/unit/chef.test.mjs` (one legacy-claim expectation changed on purpose, plus a new "assigned to someone else" negative), `tests/rules/rules.test.mjs` (+V630-1, V630-2), `tests/e2e/run-e2e.mjs` (cleaning E2E moved to the new layout, + V630-UI)
- **Bug fixed along the way:** the Cleaning settings Save button threw `Cannot set properties of null` after saving (`currentTarget` was used after an `await`).

## 6. Test results

| Check | Result |
|---|---|
| `npm test` (unit + static) | **402/402 pass** (+18 new: 9 cleaning, 5 recipes, 4 PWA) |
| `npm run test:e2e` | **124/124 pass** (10 cleaning E2E moved to the new layout, + V630-UI) |
| `npm run test:rules:smoke` | 156 tests, no JavaScript-level failures; the 1 failure is the same expected stub result as V6.2.2.1 |
| `npm run rules:cost` / static tripwire test | pass (highest cleaning cost: occurrence create 700, update 548) |
| `npm run test:rules` (Normal emulator) | **NOT RUN** (no Firestore emulator here); includes the new V630-1 and V630-2 |
| `npm run test:rules:strict` | **NOT RUN** |
| `npm run rules:limits -- emulator-*.txt` | **NOT RUN** (needs the emulator logs) |
| Real Android install / launch | **NOT RUN: user verification pending** |
| `npm run build` | not applicable (no build script) |

## 7. Deviations and limitations

- **Claimed records:** "complete a claimed record" is widened to eligible members, which is the only rules change. Claim metadata is kept, not erased.
- **Remove custom tasks archives them** (soft delete) rather than hard-deleting, because cleaning tasks have no hard delete by design (rules). They disappear from schedules and can be restored.
- **Reset progress keeps history.** Progress before today is not rewritten; it stops counting because the schedule now starts today.
- **Mark All Done is bounded** to 200 items per confirmation.
- **Recipes import:** there is no inline editing of preview items. They are reviewable read-only, and the user edits after import with the normal editor. The import size bounds (25 items, 256 KB) are HomeHub limits chosen for this feature.
- **The PWA works without offline caching** (intentional: no stale installs). Android verification is pending.

## 8. Windows verification

```cmd
npm test
set PLAYWRIGHT_BROWSERS_PATH=<your playwright browsers dir>
npm run test:e2e
npm run test:rules:smoke
npm run test:rules > emulator-normal.txt 2>&1
npm run test:rules:strict > emulator-strict.txt 2>&1
npm run rules:limits -- emulator-normal.txt
npm run rules:limits -- emulator-strict.txt
npm run rules:cost
```

Deploy only after the emulator runs pass:

```cmd
firebase deploy --only firestore:rules
firebase deploy --only hosting
```

Then complete the Android checklist above.
