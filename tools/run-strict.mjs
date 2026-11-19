/**
 * Run the REAL emulator suite with STRICT_DENIALS=1 (Phase 5.2.1), on Windows, macOS and Linux:
 *   npm run test:rules:strict
 * In strict mode every assertFails() in tests/rules/rules.test.mjs becomes assertDenied(), which
 * FAILS when the denial message shows the 1000-expression limit, i.e. when a request was denied
 * because evaluation stopped, not because the intended rule refused it.
 */
import { spawnSync } from 'node:child_process';
const r = spawnSync('npm', ['run', 'test:rules'], { stdio: 'inherit', shell: true, env: { ...process.env, STRICT_DENIALS: '1' } });
process.exit(r.status ?? 1);
