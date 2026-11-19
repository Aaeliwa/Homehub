#!/usr/bin/env node
/**
 * HomeHub V6 clean-start DRY RUN — READ-ONLY (no write / delete call exists in this file; a static
 * test enforces that). Lists the EXACT document paths an approved clean start would delete / archive
 * in ONE Home, the Savings / Zakat-linked paths that are preserved, and a pairing audit.
 * See docs/CLEAN-START.md.
 *   npm i firebase-admin   (outside the repo's dependencies)
 *   node tools/clean-start-dryrun.mjs --project <id> --home <homeId> --confirm-name "<exact Home name>" [--out plan.json]
 * Credentials: GOOGLE_APPLICATION_CREDENTIALS (a read-only service account is sufficient).
 */
import { hash } from 'node:crypto';   // one-shot SHA-256 (Node >= 21.7)
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCANNED = Object.freeze(['expenses', 'walletMovements', 'wallets', 'spendingCycles', 'budgetAdjustments', 'commitments', 'savingsEvents', 'zakatRecords']);

/** Pure: the plan for ONE Home from its documents ({ [collection]: [{ id, ...data }] }). */
export function buildCleanStartPlan(home, c) {
  const P = (col, id) => `homes/${home.id}/${col}/${id}`;
  const ids = (col, pred = () => true) => (c[col] || []).filter(pred).map((d) => P(col, d.id)).sort();
  const isZk = (d) => d.id.startsWith('zk_'); const isSv = (d) => d.id.startsWith('sv_');
  const del = [...ids('expenses', (d) => !isZk(d)), ...ids('walletMovements', (d) => !isSv(d)),
    ...ids('spendingCycles'), ...ids('budgetAdjustments'), ...ids('commitments')];
  const evIds = new Set((c.savingsEvents || []).map((e) => e.id));
  const zkLinks = new Set((c.zakatRecords || []).filter((z) => z.linkedExpenseId).map((z) => z.linkedExpenseId));
  const orphanSv = ids('walletMovements', (m) => isSv(m) && !evIds.has(`${m.savingsTransferId}_in`) && !evIds.has(`${m.savingsTransferId}_out`));
  const orphanZk = ids('expenses', (e) => isZk(e) && !zkLinks.has(e.id));
  return {
    home: { id: home.id, name: home.name },
    delete: { paths: del, count: del.length, sha256: hash('sha256', del.join('\n')) },
    archive: { paths: ids('wallets', (w) => w.active === true && !w.role) },
    preserve: { zakatExpenses: ids('expenses', isZk), savingsMovements: ids('walletMovements', isSv), v6Accounts: ids('wallets', (w) => !!w.role),
      counts: { savingsEvents: (c.savingsEvents || []).length, zakatRecords: (c.zakatRecords || []).length } },
    pairingAudit: { orphanSavingsMovements: orphanSv, orphanZakatExpenses: orphanZk, ok: !orphanSv.length && !orphanZk.length },
    untouched: 'every other collection of this Home, and every other Home',
  };
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  const project = arg('project'); const home = arg('home'); const confirm = arg('confirm-name'); const out = arg('out');
  if (!project || !home || !confirm) { console.error('Usage: --project <id> --home <homeId> --confirm-name "<exact Home name>" [--out plan.json]'); process.exit(2); }
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: applicationDefault(), projectId: project });
  const db = getFirestore();
  const H = db.doc(`homes/${home}`);
  const h = await H.get();
  if (!h.exists) { console.error(`Home ${home} not found.`); process.exit(3); }
  if (h.data().name !== confirm) { console.error(`Home name mismatch: stored "${h.data().name}" ≠ --confirm-name. Stopping.`); process.exit(4); }
  const docs = {};
  for (const col of SCANNED) docs[col] = (await H.collection(col).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const plan = { project, generatedAt: new Date().toISOString(), ...buildCleanStartPlan({ id: home, name: h.data().name }, docs) };
  const json = JSON.stringify(plan, null, 2);
  if (out) writeFileSync(out, json); else console.log(json);
  console.log(`\nDRY RUN ONLY — nothing was written. ${plan.delete.count} paths listed (sha256 ${plan.delete.sha256.slice(0, 12)}…); pairing audit ${plan.pairingAudit.ok ? 'OK' : 'FAILED — stop'}.`);
  console.log('A live clean start needs separate written approval (docs/CLEAN-START.md); it is NOT deployment approval.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
