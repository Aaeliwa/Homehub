# HomeHub 6.4.0-c: Batch C (contact pictures + restaurant menus), Revision 2

**Status:** the independent-review findings C1–C4 are addressed. **Not deployed.** No Firebase project was touched, no data was written, and the app still uses its production configuration. Final integration was not started. Version `6.4.0-c`.

**Baseline:** HomeHub 6.4.0-b Revision 2, approved commit `a14dedff7faf687a27f441adfeef43246adc00a9`. The GitHub repository was not reachable from this session, so the baseline is the delivered Rev 2 full ZIP, byte-identical to the approved source. `V640C.patch` is **cumulative for Batch C (Rev 1 + Rev 2) and incremental against Batch B Revision 2**.

## 0. Revision 2: findings and resolutions

### C1: menu array validation (mandatory)

**Problem in Rev 1.** The rules checked the structure on `menus.join('|')`. Because elements were joined first:
- one element could carry two entries (`"image|a|URL1|pdf|b|URL2"`), which also bypassed the 10-entry limit;
- several elements could combine into one entry (`["image", "a|URL"]`).

**Fix.** Each element is now validated **on its own, by index**:

```
function contactMenuOk(l, i) {          // anchored: exactly ONE "kind|label|url" per element
  return l.size() <= i || (l[i].matches(<length pattern>) && l[i].matches(<format pattern>));
}
function contactMenusOk(l) {
  return l is list && l.size() <= 10 && contactMenuOk(l, 0) && … && contactMenuOk(l, 9)
    && (l.size() == 0 || !l.join('|').matches(<host deny pattern>));
}
```

- **Length pattern** `^[a-z]{3,5}[|][^|]{0,40}[|][^|]{8,500}$`: exactly two separators, label ≤ 40 code points, URL 8–500.
- **Format pattern:** kind ∈ `image|pdf|web|drive`; label without `|` or control characters; URL in the shared grammar.
- **Element types:** a non-string, `null` or map element makes `matches` fail, so the write is denied.
- **The joined string is used only for one negative check** (the host deny-list, C2), and only after all ten index checks pass. At that point every element is proven to have exactly three `|`-free fields, so the joined string's boundaries are the elements' own. The deny pattern only inspects URL fields (every third field); a label that merely *looks* like a local URL is still accepted as text.
- **Client:** `storedMenusOk` and `isStoredMenuEntry` apply exactly the same checks in the same order. A unit test extracts the regex literals from `firestore.rules` and asserts they are identical. An independent "rules model" built only from those literals is run against every adversarial case.
- **Complexity:** contacts create is **1035** and update **944** (Rev 1: 806 / 715). The tripwire is 1100; contacts create is now the highest rule in the file (commitments update 1026 is next). Placing the deny check on each element instead would have cost 1240 / 1149, over the tripwire, which is why it runs once on the validated list.

**Adversarial coverage** (each case is refused on create **and** on update, both by the client and in the emulator):

- **Combined or split elements:** two entries combined in one element; one entry split across two or three elements; `kind|label` followed by the URL in the next element; 11 entries smuggled into 6 elements.
- **Separator abuse:** leading or trailing separator; an extra field; `|` inside a label; `''`, `'||'` and `'image||'`; an empty element after a valid one.
- **Bad element types:** `null`, a map, or a number as an element.
- **Bad values:** an unknown or upper-case kind; a 41-character label; a 501-character URL; a newline in a label; `http:`; credentials.
- **Prohibited hosts:** a local host in the 2nd element; `nip.io`; `*.localhost`; `home.arpa`.

Still accepted: 10 entries at every limit (40-character Arabic and emoji labels, 500-character URLs), a "local-looking" label, every kind with an empty label, the empty list, and normal reorder updates.

### C2: external URL security

**Client (`normalizeHttpsUrl`) and rules (`contactUrlOk`, menus) now enforce the same checks:**
- **Unsafe protocols refused:** everything except `https:`, including `javascript`, `vbscript`, `data`, `file`, `blob`, `about`, `intent`, `ftp` and `http`.
- **Credentials refused:** `user:pass@` and any `@` in the authority.
- **Prohibited host names refused:**
  - numeric IP addresses and bracketed IP literals;
  - bare `localhost` and host names with a trailing dot;
  - names ending in `localhost`, `local`, `localdomain`, `internal`, `intranet`, `lan`, `home`, `home.arpa`, `corp` or `private`;
  - the wildcard-DNS services `nip.io`, `sslip.io`, `xip.io`, `localtest.me` and `lvh.me`;
  - the new message `contacts.v.urlHost` is shown in English and Arabic.

**Documented limitations** (SECURITY.md, "Limits of the external-URL checks"). The checks are **syntactic and best-effort**. Without a server, proxy or function, HomeHub cannot:
- resolve DNS (a public-looking name can resolve to a private address, as in DNS rebinding);
- see redirects (the browser follows them when loading an `<img>` or frame);
- inspect content (a link can change what it serves).

Browser mixed-content handling and Chromium's private-network restrictions may help, but HomeHub neither depends on nor guarantees them. **No claim of complete protection against private-network requests is made.** The earlier "no requests into the local network" wording was removed.

**Unchanged:**
- the privacy notes in the editor and Menu section;
- `referrerpolicy="no-referrer"` and no `crossorigin`;
- the iframe sandbox `allow-scripts allow-same-origin` with `allow=""`, used only for Google Drive / Docs `/preview` links;
- the CSP `frame-src` allow-list;
- `noopener noreferrer` on links;
- no backend, proxy, paid service or Storage.

### C3: full-screen viewer lifecycle

A single module-level controller now owns the viewer's temporary history entry, which is marked `{ ctViewer: token }` on the same URL so the router never sees it. It installs **one** `popstate` listener for the app's lifetime and allows at most one open viewer.

| How it ends | What happens |
|---|---|
| Close button / Esc (`'ui'`) | Overlay, key listener, scroll lock and image source are removed **immediately**. Then `history.back()` drops the entry; its `popstate` is recognised and ignored. A viewer reopened before that `popstate` arrives waits for it before pushing (fixes the rapid close/reopen race). If a browser never delivers the event, a 1.5 s fallback releases the wait so a later Back is not swallowed |
| Android / browser **Back** (`'pop'`) | Everything is removed; the entry is already gone |
| Page torn down (`'unmount'`): another module, household switch or context change, sign-out, language/theme re-render | Everything is removed **synchronously** and the marker is stripped with `replaceState`. There is never an asynchronous navigation in the middle of an app transition |
| Opening while already open (`'handover'`) | The new viewer takes over the existing entry; nothing is stacked |
| Landing later on a stale viewer entry | The marker is stripped and nothing reopens |

On sign-out the router's existing `replace('/dashboard')` overwrites the entry, so the next sign-in still starts on the dashboard (unchanged behaviour).

**Remaining limitation (documented):** browsers cannot delete a history entry synchronously. When the page is torn down *with the viewer open* and *without* a route change (household context change, re-render), the viewer's entry stays as an **unmarked duplicate of the same URL**. It reopens nothing and shows nothing; at most, one Back press produces no visible change. After a module change, Back returns to the contact as expected.

**Regression tests (E2E):**
- `V640-C rev 2 viewer lifecycle …` (desktop):
  - 11 open/close cycles mixing button, Esc, Back, a rapid close-and-reopen and a handover;
  - after the cycles: no overlay, no scroll lock, no marker, an idle controller, `history.length` unchanged, and **no `keydown` or `popstate` listener growth** (counted with the Chrome DevTools Protocol);
  - module navigation while open, then Back: the viewer is gone, Back does not reopen it, and no listener leaks;
  - household context change while open (membership suspended → gate → restored): clean;
  - sign-out while open: clean and back on the dashboard; after signing in again the viewer still works.
- `V640-C rev 2 viewer lifecycle on Android-style mobile …` (touch, Arabic RTL): repeated hardware-Back closes with no history growth, no marker and no overflow.

### C4: integration and regression

- **Tests:** all 457 Rev 1 unit/static tests are still present and passing; the new total is 458. All earlier E2E checks pass, including Batch A, Batch B and Batch C Rev 1, in English LTR and Arabic RTL and at 320–412 px.
- **Unchanged:** `sw.js` (network-only), `firebase.json`, role templates (v9), the cleaning module and rules, every Batch A and B rule, `.gitignore`, `.github/` and `package-lock.json`.
- **Patch check:** verified on a simulated checkpoint repository (Rev 2 tree with a workflow file, `.gitignore` and a 6.4.0-b `package-lock.json`):
  - applies cleanly;
  - the protected files are byte-identical before and after;
  - `npm ci` passes with the lockfile at 6.4.0-b and after updating it to 6.4.0-c;
  - the patched tree is identical to the delivered source;
  - `npm test` gives 458/458.

## 1. Verification stages: exact results

| # | Stage | Command | Result |
|---|---|---|---|
| 1 | Unit + static | `npm test` | **458 / 458 pass**: 445 Batch A/B + 13 Batch C (12 Rev 1 + 1 new C1 adversarial test). The C1 sync test was rewritten for the per-element patterns |
| 2 | Rules smoke (JS-level; **does not evaluate rules**) | `npm run test:rules:smoke` | **170 / 171**. The single failure is **L14**, the expected stub limitation. No JavaScript-level failures. 171 = 165 Batch A/B + 6 Batch C (`V64C-1` … `V64C-6`; `V64C-5` and `V64C-6` are new) |
| 3 | Rules cost | `npm run rules:cost` | **Pass**: 0 allow statements above 1100. Contacts create 1035, update 944, get/list 181 |
| 4 | Normal Firestore emulator | `npm run test:rules` | **NOT EXECUTED here**: `firebase-tools` cannot be installed (network and package installs disabled). It must run in CI; it includes `V64C-1` … `V64C-6` |
| 5 | Normal rules limits | `npm run rules:limits <stage-4 output>` | **NOT EXECUTED**: needs stage 4 output |
| 6 | Strict emulator | `npm run test:rules:strict` | **NOT EXECUTED**: needs the emulator |
| 7 | Strict rules limits | `npm run rules:limits <stage-6 output>` | **NOT EXECUTED**: needs stage 6 output |
| 8 | Browser E2E | `npm run test:e2e` | **130 / 130 pass**: 126 Batch A/B + 4 Batch C (2 Rev 1 + 2 Rev 2 lifecycle). The four Batch C checks passed in 2 consecutive runs |

- No test was skipped. No assertion was weakened.
- Rules smoke test `V64C-3` no longer reads the document back after a *denied* write, because the smoke stub applies denied writes. A denied write is atomic, and the denial itself is still asserted.
- **Stages 4–7 are pending in GitHub Actions** and are required before approval. The workflow was not modified.

## 2. Changed-file inventory (relative to Batch B Revision 2)

The inventory is also in `V640C-CHANGED-FILES.txt`: 20 entries, 16 modified and 4 added, nothing deleted.

| File | Rev 1 | Rev 2 |
|---|---|---|
| `src/modules/contacts/contact-media.js` (new) | URL grammar, menus, Drive mapping, detection | per-element entry and length patterns; host deny patterns (single URL and joined-after-validation); `isStoredMenuEntry`; `storedMenusOk` element by element; limitation notes |
| `src/modules/contacts/media-ui.js` (new) | avatar, Menu section, viewer | single history controller (`'ui'`, `'pop'`, `'unmount'`, `'handover'`), one `popstate` listener, pending-back queue and fallback, `viewerState()` diagnostics |
| `src/modules/contacts/page.js` | avatar, menu, editor | unmount calls `finish('unmount')` |
| `src/modules/contacts/contact-model.js` | media in validate / create / edit | — |
| `firestore.rules` | media functions, optional keys | `contactMenuOk(l, i)` ×10; deny checks in `contactUrlOk` and `contactMenusOk`; comments |
| `index.html` | CSP adds Drive / Docs | — |
| `assets/css/modules/contacts.css` | avatar, menu, viewer | — |
| `src/core/i18n/locales/en.js`, `ar.js` | 60 keys | +1 (`contacts.v.urlHost`); parity 2,646 / 2,646 |
| `src/config/app-config.js`, `package.json` | `6.4.0-c` | — |
| `tests/unit/v640c-media.test.mjs` (new) | 12 tests | sync test for the new patterns, prohibited-host cases, C1 adversarial test with an independent rules model |
| `tests/rules/rules.test.mjs` | `V64C-1` … `V64C-4` | `V64C-5` (C1 adversarial), `V64C-6` (C2 hosts); `V64C-3` read-back note |
| `tests/e2e/run-e2e.mjs` | 2 checks | 2 lifecycle checks |
| `tests/static/static.test.mjs`, `tests/unit/v640-contacts.test.mjs` | exact CSP pin; required/optional keys | — |
| `FIRESTORE-SCHEMA.md`, `SECURITY.md`, `CHANGELOG.md` | Batch C sections | C1/C2 schema notes; "Limits of the external-URL checks"; Rev 2 changelog |
| `V640C-REPORT.md` (new) | report | this report |

## 3. Schema decisions

| Key (optional) | Type | Limits |
|---|---|---|
| `avatarUrl` | string \| null | https, ≤ 500 characters, shared grammar, no prohibited host |
| `menus` | list of string | ≤ 10 elements; **each** exactly one `kind|label|url` (kind `image` `pdf` `web` `drive`; label ≤ 40 code points, no `|` or control characters; URL ≤ 500, no prohibited host) |

- **Keys:** the 18 Batch B keys are required (`hasAll`); `avatarUrl` and `menus` are the only optional extras (`hasOnly`). There is no migration, and older contacts are valid as they are.
- **Restaurants:** detected by category **key** `restaurants`.
  - A rename keeps the Menu section.
  - Removing or un-assigning the category hides it; the menu data is kept.
  - Reassigning the category shows it again.
- **Edits:** media changes are ordinary `contacts.edit` edits with `rev + 1`. Deleted contacts are read-only.
- **Imports:** a `.vcf` import never carries media (the rules refuse it), and nothing is fetched. Merges never touch media.
- **Export:** vCard export intentionally excludes media, so files are unchanged from 6.4.0-b.

## 4. Permission matrix

| Action | Owner | Admin | Member | Viewer | Child | Other Home / outsider |
|---|---|---|---|---|---|---|
| See pictures, open menus and the viewer | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Create a contact with a picture or menus | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Set, replace or remove a picture; add, reorder or remove menus | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Media through `.vcf` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Media on a deleted contact | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

All Batch B protections are preserved: deleted contacts are visible only with `contacts.delete`; imports are idempotent and create-only; concurrency uses `rev + 1`; capacity and truncation detection still apply; and access is isolated by household.

## 5. Security review

| Threat | Mitigation | Evidence |
|---|---|---|
| Combined, split or smuggled menu entries | Per-element anchored validation by index; join only for the negative check after validation | unit C1 rev2 (client + independent rules model); rules `V64C-5` (create + update) |
| Script URLs / HTML injection | https only; URLs only assigned to `src` / `href`; no HTML sink | unit C-url, C-static; rules `V64C-1`/`V64C-2` |
| Credential phishing (`https://bank@evil`) | Credentials and `@` in the authority refused | unit, rules |
| Local-network targets | IP literals, bare `localhost`, local suffixes and wildcard-DNS services refused. **Best-effort:** DNS answers and redirects cannot be checked (documented) | unit, rules `V64C-6` |
| Oversized values | URL ≤ 500, ≤ 10 menus, label ≤ 40; raw input over 2,000 characters refused before parsing | unit, rules |
| Cross-household access | All under `homes/{h}`, gated by `can()` | rules `V64C-4` |
| Tracking / privacy | No referrer; lazy pictures; no menu request before the section is opened; Drive only on "Show preview"; collapsed again on leaving; explicit notes | E2E |
| Framing attacks | CSP allow-list plus code allow-list; `sandbox="allow-scripts allow-same-origin"`, `allow=""` | unit C-static, E2E |
| Blocked frame reported as success | Never; the hint and Open original are always visible (E2E serves `X-Frame-Options: DENY`) | E2E |
| Reverse tabnabbing / URL leak | `target=_blank` with `rel="noopener noreferrer"` and no referrer | E2E |
| Leftover overlay or key handler capturing input after leaving | Single controller; synchronous teardown on every path | E2E lifecycle (listener counts via the Chrome DevTools Protocol) |
| SW caching external media | `sw.js` unchanged (same-origin navigations only, no Cache API) | unit C-static |

## 6. Compatibility (older clients cannot erase media)

This section is unchanged from Revision 1:
- 6.4.0-b clients only send field patches of the Batch B fields, soft delete or restore, and create-only `set` calls, so they never write `avatarUrl` or `menus`. Rules test `V64C-3` replays those writes on a media-bearing contact.
- The new client compares media only when the edit form carries it (absent = `null` = `[]`), so saving an untouched old contact writes nothing.
- Imports and merges never carry media.
- A stale editor is refused, so nothing is overwritten.

## 7. Remaining limitations

1. **Stages 4–7 (emulator, strict mode, limits) were not executed here.** They must pass in CI before approval.
2. **The URL checks are syntactic** and cannot see DNS answers or redirects; the deny-list is not exhaustive (C2).
3. **A viewer torn down without a route change can leave an unmarked same-URL history entry**: no reopen, at most one Back press with no visible change (C3).
4. **Other PDFs open in a new tab** instead of embedding: Chromium does not render PDFs in sandboxed frames, and unsandboxed frames are not allowed. Embedding them would require an approved architectural change.
5. **Contacts create is the costliest rule** (1035 of 1100). Future contact fields need a cost review.
6. **The baseline was reconstructed from the delivered Rev 2 ZIP.** Run `git apply --check` on the real `a14dedff` checkout.

## 8. Rollback

- **Recommended:** roll back hosting and rules together, to `a14dedff…` (6.4.0-b Rev 2).
- **Under the Rev 2 rules,** contacts that have `avatarUrl` or `menus`:
  - stay fully editable by the 6.4.0-b client, because those rules check only the Batch B fields and its edits change only those;
  - keep their media stored but **dormant** (not shown, not modified).
- **Do not** run a 6.4.0-c client against the Rev 2 rules: its media writes would be refused.
- Re-applying 6.4.0-c later shows the stored media again. No migration either way; role templates are unchanged (v9).

## 9. Android acceptance checklist (Batch C, Revision 2)

1. Edit a contact and paste an https picture link: the preview appears, and after saving the circular picture shows in the list and the detail view.
2. Each of these shows a clear error and saves nothing:
   - `http://…` and `javascript:…`;
   - a link with `user:pass@`;
   - `https://192.168.1.1/…`;
   - **`https://router.home/…`, `https://printer.local/…`, `https://x.nip.io/…`, `https://nas.home.arpa/…`** (new);
   - a 600-character link.
3. A link to a missing image: the preview warns and the contact shows initials. Removing the picture brings initials back.
4. Assign **Restaurants** and add 3 image links, 1 PDF, 1 website and 1 Google Drive file. Reorder with ↑ ↓, remove one, and save: the order is kept.
5. Open the restaurant. The Menu section is collapsed and nothing loads until you tap **Show menu**.
6. Tap an image. It opens full screen with "1 / N".
   - Swipe (right = forward in Arabic), pinch, double-tap and pan all work.
   - **Open original** opens the image in a new tab.
   - **The phone's Back button closes the viewer and stays on the contact.**
7. **Repeat open → Back, open → ✕, open → Back about ten times**, then press Back once more: you leave the contact normally. There are no extra "dead" Back presses and no stuck dark overlay.
8. **With the viewer open, switch to another app section through a notification or link, then press Back:** you are on Contacts and the viewer is not reopened.
9. **With the viewer open, sign out from another device (or let the session expire):** the login screen appears with no overlay; after signing in, the app starts on the dashboard.
10. A broken image page shows a clear error and Open original.
11. PDF: **Open PDF** opens a new tab and the hint explains why it is not embedded. Website: opens in a new tab.
12. Google Drive **Show preview**: a file shared with "anyone with the link" previews. A private file shows sign-in, no access or an empty frame; the hint explains it and **Open original** works.
13. Rename Restaurants: the menu stays. Remove the category: the Menu section disappears, and editing the contact shows "N saved menu links are kept". **Add suggested** again: the menu is back, unchanged.
14. Edit the same restaurant on two phones at once. The second save says "Someone else changed this contact" and nothing is overwritten.
15. Import a `.vcf` with photos and URLs: photos are reported as skipped. Merging into a restaurant keeps its picture and menus. The exported `.vcf` has no picture or menu (by design).
16. Viewer or child role: pictures and menus are visible and the viewer works; there is no Edit.
17. Arabic RTL and dark at 320–412 px: no sideways scrolling, the viewer buttons are reachable, and the page counter reads "1 / 3".
18. Batch A/B spot-checks: deleted contacts hidden from members, re-importing a file adds nothing, the capacity line is shown, cleaning resets work.

## 10. Termux integration commands

These are for review on a branch. They do **not** deploy anything.

```bash
termux-setup-storage                       # once, to reach ~/storage/downloads
cd ~/HomeHub-V5                            # your clone
git fetch origin && git status             # must be clean
git checkout -b v6.4.0-c a14dedff7faf687a27f441adfeef43246adc00a9   # if v6.4.0-c exists from Rev 1: git checkout v6.4.0-c && git reset --hard a14dedff7faf687a27f441adfeef43246adc00a9
cp ~/storage/downloads/V640C.patch .
git apply --check V640C.patch && git apply V640C.patch
rm V640C.patch
npm install --package-lock-only --ignore-scripts   # optional: lockfile version → 6.4.0-c (npm ci passes either way)
npm ci
npm test                                   # expect 458/458
npm run test:rules:smoke                   # expect 170/171 (L14 expected)
npm run rules:cost                         # expect 0 above 1100
git add -A
git commit -m "V6.4.0-c Rev 2: contact pictures and restaurant menus (Batch C)"
git push -u origin v6.4.0-c                # (after a reset: git push --force-with-lease) — CI runs all eight stages
```

- Playwright and the emulator normally cannot run inside Termux, so stages 4–8 are verified in GitHub Actions.
- The changed-files ZIP is an alternative to the patch. It omits `package.json`, so take the version line from the patch.

## 11. Packaging

- **Full ZIP** excludes: `.git`, `.github`, `.gitignore`, `node_modules`, `package-lock.json`, logs, test results, credentials and personal data. Test fixtures use example and `.test` domains only.
- **Changed-files ZIP** contains the changed files (except `package.json`), the patch and `V640C-CHANGED-FILES.txt`.
