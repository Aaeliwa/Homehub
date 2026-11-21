# HomeHub V6.4.1 — Stage A report: Contacts UI + AI JSON

**Version:** `6.4.1-a` (development). **Status:** NOT DEPLOYED. Production, production rules and production data were not touched.
**Baseline:** official tag `v6.4.0`, commit `01c12f073159a1b6bf7a00fc01aa1c752b7ccf6f` (archive `HomeHub-V6.4.0-Official-Source.zip`, SHA256 `62706f02973fb670a53915042d54b9486a811a52265fdfd875619689fde3e91e`; the zip comment names the same commit). The older V6.4.0-C Revision 2 working copy was **not** used as the base.
**Scope:** Stage A only. Stage B (Calendar activities, reminders, the upcoming-events panel) has not been started.

## 1. Baseline verification

- The official archive was extracted into a clean directory and committed as `v6.4.0` before any change. The patch is `git diff v6.4.0`.
- Baseline results on the official tree: unit + static 458/458, rules smoke 170/171 (L14 is the known emulator-only case), E2E 130/130, rules-cost maximum 1035 (contacts create), 0 above 1100.
- The official tree contains `.github/`, `.gitignore`, `package-lock.json` and `firebase.json`; all are preserved unchanged (except the lockfile's own version lines, see §3).

## 2. Requirements → implementation

| # | Requirement | Implementation | Verified by |
|---|---|---|---|
| 1 | Import VCF, Export VCF, Manage Categories, Deleted Contacts, AI JSON only in the list ⋮ menu | `header()` builds one `ellipsisMenu` (`#ct-more-btn`), list view only, each item gated by its permission; no other copies of these buttons exist | E2E V641-A UI (menu ids, hidden until opened, absent on sub-views), permissions check |
| 2 | Edit, Delete, single-contact Export in the details ⋮ menu | `#ct-detail-menu` with `#ct-edit`, `#ct-export-one`, `#ct-delete` (danger tone) | E2E V641-A UI, permissions check, existing V640-B/C via `ctAct` |
| 3 | Full-width New Contact immediately above the list | `#ct-new` (`.ct-new`, 100 % inline size, 48 px), rendered directly before the count/list | E2E: width = list width ± 2 px, gap < 60 px |
| 4 | Category + Favourites side by side on narrow screens | `.ct-filters` grid `minmax(0,1fr) auto`; below 380 px the Favourites text collapses to the ★ (accessible name kept) | E2E at 320/360/390/412, EN light and AR dark, no overflow |
| 5 | Call + WhatsApp on tiles without opening details | `.ct-card__acts`: `tel:` link (one number) or chooser (several); WhatsApp direct (international) / chooser / country-code form (national). `stopPropagation` on click and keydown; the tile click handler ignores links/buttons | E2E: mouse, keyboard Enter, touch tap; history unchanged |
| 6 | Prominent Back to Contacts; Android/browser Back = exactly one step; filters + scroll kept | `contacts-nav.js`: sub-views are ONE history entry on the same URL (`ctNav`), the list entry carries `{ q, cat, fav, y }` (`ctList`). Popstate is state-driven; a back is idempotent while pending | E2E: button, browser Back, Forward, rapid ×6, delete, viewer → details → list, Back from list leaves Contacts in one step; Android-style touch test |
| 7 | Recognizable WhatsApp icon + green; remove dialer note | Green `#1fa855` buttons; icon slot `assets/brand/whatsapp.svg` (see §8); `contacts.callHint` removed from code and both locales | E2E: colour, no dialer text |
| 8 | Portable AI JSON import/export with preview, validation, duplicate protection, explicit merge, permissions | `contacts-json.js` + the existing preview/plan/store pipeline (`source: 'json'`) | Unit v641-a (7 tests), E2E AI JSON check, rules test V641A-1 |
| 9 | Stable category identity EN↔AR; never silently overwrite media | Categories exported by display name; import recognises the EN and AR suggested labels → same `s_<key>` id; media only filled when empty, replaced only when ticked | Unit (EN/AR round trip, locale labels = recogniser labels), E2E |
| 10 | Upcoming-events panel hidden until Stage B | `section#ct-upcoming[hidden]`, empty, no listener, no query | E2E |

### Architecture notes

- **Reuse:** contact model, validators, media URL checks, `.vcf` preview / plan / deterministic ids / occupied-id classification and the store's import executor are reused unchanged in behaviour; JSON only adds a parser and a field-by-field merge.
- **History:** no router change. The hash router never sees the Contacts entries (same URL; `history.pushState` / `replaceState` only). The menu viewer's controller copies the state under it, so popping the viewer lands on the same `ctNav` (no change). One `popstate` listener per mounted page, removed on unmount. No Calendar deep links were needed.
- **Re-render safety:** an open ⋮ menu survives a snapshot re-render (it is closed cleanly and reopened with the same focus), and every menu's document listeners are removed on unmount.
- **Cost / queries:** no new listener or query. JSON export uses the existing snapshot; JSON import reads nothing extra (same occupied-id `get` per conflicting create as `.vcf`).
- **Not used:** paid services, Cloud Functions, Storage uploads, any AI API, any network request (unit test greps the JSON module for network APIs).

## 3. Changed files (relative to `v6.4.0`)

| File | Change |
|---|---|
| `src/modules/contacts/contacts-nav.js` | **new** — in-page history (sub-views, saved list state, validated markers) |
| `src/modules/contacts/contacts-json.js` | **new** — parse/validate, export, AI prompt/schema/example, explicit merge |
| `src/modules/contacts/contacts-ui.js` | **new** — accessible ⋮ menu (+ re-render `paint`), WhatsApp icon slot, number chooser |
| `src/modules/contacts/page.js` | menus, tiles, filters, New, Back, JSON view, shared preview, navigation |
| `src/modules/contacts/contacts-import.js` | `source` option; JSON merge path; JSON `unknownFields` passed to the preview |
| `src/modules/contacts/contacts-store.js` | create doc `source: 'json'` |
| `src/modules/contacts/contact-model.js` | media kept on `json` creates; `classifyOccupied` treats `json` like `vcf` |
| `firestore.rules` | contacts create: `source` ∈ manual / vcf / json (see §5) |
| `assets/css/modules/contacts.css` | filters, ⋮ menu (`ct-more*`), New, tile actions, WhatsApp, Back, chooser, JSON |
| `src/ui/components/icons.js` | generic `phone` handset path |
| `src/core/i18n/locales/en.js`, `ar.js` | new keys (EN = AR key sets), `contacts.callHint` removed |
| `package.json`, `package-lock.json` (version lines only), `src/config/app-config.js`, `sw.js` | `6.4.1-a` |
| `tests/unit/v641-a.test.mjs` | **new** — 7 tests |
| `tests/rules/rules.test.mjs` | `V641A-1` (emulator) |
| `tests/e2e/run-e2e.mjs` | `ctAct` helper for relocated controls (same assertions); four new V641-A checks |
| `CHANGELOG.md`, `FIRESTORE-SCHEMA.md`, `SECURITY.md` | documented; this report |

Existing E2E checks changed only where a control moved into a menu (`page.click('#ct-edit')` → `ctAct(page, '#ct-edit')`, 17 places), plus the lifecycle listener-leak comparison now measures twice on the same Contacts screen (the open ⋮ menu legitimately adds document listeners while open). No assertion was weakened or removed.

## 4. AI JSON contract

```json
{ "schema": "homehub.contacts", "version": 1, "items": [
  { "name": "…", "organization": "…", "phones": [{ "label": "mobile", "number": "…" }], "email": "…", "address": "…",
    "notes": "…", "favorite": true, "categories": ["Doctors"], "avatarUrl": "https://…",
    "menus": [{ "type": "image", "label": "Page 1", "url": "https://…" }] } ] }
```

- **Whole-file rejection:** > 1 MB, not UTF-8, empty, nesting > 6 (checked before parsing), not JSON, not an object, any top-level key other than `schema` / `version` / `items` (named), wrong schema, wrong version (also `"1"`), `items` not an array, > 500 items.
- **Per-item exclusion (shown in the preview, never imported):** any non-allow-listed key incl. `__proto__`, `constructor`, `id`, `createdBy` (the refused keys are listed); wrong types; > 10 phones / categories / menus; no name; then the shared validators (lengths, e-mail, phone characters, https-only public-host media URLs, menu element format).
- **Duplicates:** in-file, already-imported (deterministic id), phone or name matches → **Skip** by default. **Merge** keeps everything; it fills empty fields, adds new numbers, unites categories, and adds a picture / menus only when the contact has none. Each conflicting field (name, organization, e-mail, address, notes, picture, menus) has its own "use the file's value" checkbox, unticked by default. **Keep separate** creates a new copy id.
- **Export:** all / current filter / favourites / one category / picked; personal-information warning first; no ids, audit fields, timestamps, household data, roles, deleted contacts or Calendar data; empty values omitted.
- **Categories:** by name. Suggested categories export in the UI language and are recognised in English **or** Arabic on import (unit test proves the locale strings equal the recogniser's labels), so an Arabic export imported in English maps to the same ids. Unknown names are reported, never created.
- **AI helpers:** Copy AI prompt (explicit "never guess or invent", exact schema, limits), Copy schema (JSON Schema, `additionalProperties: false`), Download example (itself valid). All local text.

## 5. Rules delta and cost

```
allow create (contacts):
  … && (incoming().source == 'manual' ? can(h, 'contacts', 'create')
        : (incoming().source in ['vcf', 'json'] && can(h, 'contacts', 'import')
           && (incoming().source == 'json' || (!('avatarUrl' in incoming()) && !('menus' in incoming())))));
```

Media on a `json` create pass the same `contactContentOk → contactMediaOk` checks as a manual create (per-element menu validation, host deny-list). Update / delete rules are unchanged; `source` remains immutable.

| Rule | v6.4.0 | 6.4.1-a |
|---|---|---|
| contacts create | 1035 | **1053** |
| contacts update | 944 | 944 |
| highest other rule (commitments update) | 1026 | 1026 |
| rules above the 1100 budget | 0 | **0** |

## 6. Permission matrix (Stage A)

| Action | Owner | Admin | Member | Viewer | Child |
|---|---|---|---|---|---|
| List ⋮ menu | all 5 items | all 5 | Import, Export, AI JSON | no menu | no menu |
| Details ⋮ menu | Edit, Export, Delete | same | Edit, Export | no menu | no menu |
| New contact | ✓ | ✓ | ✓ | ✗ | ✗ |
| AI JSON export / import | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | ✗ | ✗ |
| Tile Call / WhatsApp | ✓ | ✓ | ✓ | ✓ | ✓ |

A forged history entry for a view the role may not open falls back to the list (E2E).

## 7. Test results (actually run in this workspace)

| Stage | Result |
|---|---|
| `npm test` (unit + static) | **465 / 465** (baseline 458 + 7 new) |
| `npm run test:rules:smoke` | **171 / 172** — the one failure is the known L14 emulator-only case (baseline 170/171; +1 new `V641A-1`) |
| `npm run rules:cost` | max **1053**, 0 above 1100 |
| `npm run test:e2e` (Playwright + fake SDK, Chromium) | **134 / 134** (baseline 130 + 4 new V641-A checks) |
| Firestore emulator (`npm run test:rules`, incl. `V641A-1`) | **NOT RUN** — firebase-tools / Java are not available and the network is off here. Must run in CI. |
| Real Android device | **NOT RUN** — the Android-style checks are Playwright mobile emulation (touch, RTL, dark). Use the checklist in §9. |

Bugs found and fixed by the new tests during Stage A: a double `history.back()` when deleting from details (the handler and the re-render both went back); the new ⋮ menu's class names collided with the restaurant Menu section; an open ⋮ menu vanished on a snapshot re-render; JSON `unknownFields` were not shown in the preview; the ⋮ wrapped under the title in Arabic at 360 px and overflowed; the example file's two contacts matched as duplicates.

## 8. Residual risks and limitations

- **WhatsApp logo:** HomeHub does not draw or ship the WhatsApp logo. To show the recognizable icon, place the official SVG from WhatsApp's brand resources at `assets/brand/whatsapp.svg` (same origin; one probe per session). Until then a neutral green "WA" badge is shown. White on `#1fa855` is 3.1:1 — meets the 3:1 non-text contrast requirement; the button's accessible name carries the meaning.
- **Category identity is by name.** A renamed suggested category exports under its custom name and is recognised by that name (and still by its EN/AR suggested labels). A custom category with different names on two households will not match; it is reported, not created.
- **Scroll restore** is approximate (± one row) when contacts are added or removed by another device while the details are open.
- **Opening a management view from the ⋮ menu** saves the list scroll at the time of opening (the menu is at the top of the list).
- **Emulator and real-device verification are pending** (§7).
- Existing (pre-Stage A) risk, unchanged: the Calendar store's listeners are unbounded; relevant to Stage B.

## 9. Mobile / Android acceptance checklist

Run on a real Android phone (Chrome, installed PWA if possible), Arabic and English, light and dark:

1. Contacts list: only the title row's ⋮ shows Import / Export / AI JSON / Categories / Deleted (member: first three only; viewer: no ⋮).
2. The ⋮ opens toward the inline end, stays on screen at 320–412 px, closes on outside tap and on Back-less dismissal; TalkBack announces "menu" and each item.
3. **New contact** spans the full width, directly above the list.
4. Category selector and ★ Favourites sit on one row at your phone's width; no horizontal scrolling anywhere.
5. Tile phone icon: one number → dialer opens with the number (nothing dialled); several numbers → a chooser. The details do **not** open.
6. Tile WhatsApp (green): international number → WhatsApp chat; national number → asks the country code; several numbers → chooser. Details do **not** open.
7. No "Call opens your phone's dialer…" note on the details.
8. Search, choose a category, enable Favourites, scroll down, open a contact → **Back to Contacts** returns to the same filtered list at the same scroll position.
9. Repeat 8 with the **Android Back** gesture/button: one step back to the list; one more Back leaves Contacts to the previous screen (it must not skip it or need two presses).
10. Details ⋮: Edit / Export .vcf / Delete; Delete → confirm → you are on the list (one step), contact gone.
11. Restaurant with menus: open a page full-screen → Back closes the viewer → Back returns to the list.
12. ⋮ → AI JSON: Copy AI prompt / Copy schema work; Download example; export Favourites → warning first → `.json` file.
13. Paste the example (or an AI output) → preview: invalid items explained and excluded; a duplicate shows **Skip**; choose **Merge** → the picture is kept unless "use the file's picture" is ticked.
14. Import the same file again → items show "imported before", nothing duplicated.
15. The upcoming-events panel is not visible anywhere.

## 10. Rollback

Nothing is deployed. To abandon Stage A: discard the branch (`git checkout v6.4.0` / delete `v6.4.1-a`). If ever deployed, rolling back the client and rules to v6.4.0 is safe: v6.4.0 rules refuse new `source: 'json'` creates but still read, edit and delete existing `json` contacts (update rules never inspect `source` except for immutability); the v6.4.0 client displays them like any contact.

## 11. Termux integration commands (review branch; deploys nothing)

```bash
cd ~/HomeHub-V5
git fetch --tags origin && git status            # must be clean
git checkout -b v6.4.1-a v6.4.0                  # official baseline 01c12f07…
cp ~/storage/downloads/V641A.patch .
git apply --check V641A.patch && git apply V641A.patch && rm V641A.patch
npm ci
npm test                                         # expect 465/465
npm run test:rules:smoke                         # expect 171/172 (L14 expected)
npm run rules:cost                               # expect max 1053, 0 above 1100
git add -A && git commit -m "V6.4.1 Stage A: Contacts UI + AI JSON (6.4.1-a)"
git push -u origin v6.4.1-a                      # CI runs emulator + E2E
```

## 12. Packaging

- `V641A.patch` — `git diff v6.4.0` (binary-safe), applies to the official tag.
- `HomeHub-V6.4.1-a-Source.zip` — full tree as in the official archive (including `.github/`, `.gitignore`, `package-lock.json`, `firebase.json`); excludes `.git`, `node_modules`, logs, test results and screenshots. No `.env`, private keys, credentials or customer data (test fixtures use example / `.test` domains).
- `HomeHub-V6.4.1-a-Changed.zip` — changed and new files (except `package.json`; take its version line from the patch), this report and `V641A-CHANGED-FILES.txt`.
- SHA256 of each deliverable: `V641A-SHA256SUMS.txt` (delivered alongside; not inside the archives).
