# HomeHub V5

A household app (Arabic-first, bilingual) built on Firebase. **Phase 1 (live verified), Phase 2 Rooms, Phase 3 Devices, Phase 4 Finance, Phase 4A Family & Members.**
Start with **PROJECT-STATE.md**.

## Run locally

ES modules need an HTTP server (opening `index.html` as a file won't work).

```bash
cd HomeHub-V5
python3 -m http.server 5173        # or: npx serve -l 5173 .   or: firebase serve
# open http://localhost:5173
```

It connects to the real Firebase project in `src/config/firebase-config.js`.
On `localhost` the `[HomeHub]` development log is on; elsewhere add `?debug=1`.

If Firebase Auth rejects the domain, add it under Firebase console → Authentication → Settings → Authorized domains. `localhost` is allowed by default.

## Deploy

```bash
npm i -g firebase-tools
firebase login
firebase use expensetracker-d7309          # .firebaserc already sets this as default
firebase deploy --only firestore:rules     # 1) rules FIRST — the app needs them for setup
firebase deploy --only hosting             # 2) the app
```

Deploy the rules before using the app: first-time setup only succeeds against the V5 rules, Rooms, Devices and Finance each need their phase's rules.
Deploying is additive: it never touches existing Firestore data.

## Test

```bash
npm test                                   # unit + static (no install needed)
```
Browser E2E and emulator rules tests are described in **TESTING.md**.

## Documents

| File | Purpose |
|---|---|
| PROJECT-STATE.md | Authoritative handoff for future phases |
| ARCHITECTURE.md | Layers, lifecycle, registry contract, conventions |
| FIRESTORE-SCHEMA.md | Implemented and reserved paths, fields, reference conventions |
| SECURITY.md | Rules design, bootstrap reasoning, threat table |
| TESTING.md | How to test, plus the live smoke-test checklist and results |
