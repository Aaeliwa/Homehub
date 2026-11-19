# Browser E2E (fake Firebase)

Runs the real app in Chromium. The three `gstatic.com/firebasejs` SDK URLs are served from `fake-sdk/`.

```bash
npm i -D playwright && npx playwright install chromium
node tests/e2e/run-e2e.mjs --screens ./screens
```

The fake is a **test double**. It validates the client lifecycle, UI and write shapes, not Firebase or the security rules (see `tests/rules`).
