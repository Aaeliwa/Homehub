/**
 * Phase 5.3.1 production-bug DIAGNOSTIC (emulator only; never touches production).
 *   npm run diagnose:setup
 * Replays "Review → Add selected tasks" with the REAL builder (buildSetupPlan + planWrites) on a
 * realistic household seeded with production-shaped rooms/devices, and prints the emulator's
 * VERBATIM denial reasons for: (1) the shipped single batch, (2) batch-size thresholds,
 * (3) every task written on its own (separates payload/rule defects from batch limits).
 */
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, writeBatch, serverTimestamp, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { buildSetupPlan, planWrites } from '../../src/modules/cleaning/cleaning-integration.js';
import { defaultRoles } from '../../src/modules/index.js';

const env = await initializeTestEnvironment({ projectId: 'demo-homehub-diag', firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') } });
const OWNER = { uid: 'ownerDiag', email: 'owner@diag.test' };
const H = 'hDiag';
const rooms = [['k', 'kitchen'], ['b1', 'bathroom'], ['b2', 'bathroom'], ['m', 'master_bedroom'], ['br', 'bedroom'], ['kids', 'kids_room'], ['lv', 'living_room'], ['hall', 'hallway'], ['bal', 'balcony'], ['gar', 'garage']]
  .map(([id, type], i) => ({ id: `R${i}${id}`, name: id, type }));
const devices = [['fr', 'kitchen_appliance', 'refrigerator'], ['dw', 'kitchen_appliance', 'dishwasher'], ['mw', 'kitchen_appliance', 'microwave'], ['ov', 'kitchen_appliance', 'oven'], ['af', 'kitchen_appliance', 'air_fryer'], ['vc', 'cleaning_appliance', 'vacuum_cleaner'], ['ac1', 'climate', 'split_ac']]
  .map(([id, category, subtype], i) => ({ id: `D${i}${id}`, name: id, category, subtype, roomId: 'R0k' }));

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore(); const now = new Date();
    await setDoc(doc(f, 'users', OWNER.uid), { email: OWNER.email, displayName: 'Owner', defaultHomeId: H, language: 'ar', theme: 'system', schemaVersion: 1, createdAt: now, updatedAt: now });
    await setDoc(doc(f, 'homes', H), { name: 'Diag Home', createdBy: OWNER.uid, currency: 'EGP', timezone: 'Africa/Cairo', language: 'ar', schemaVersion: 1, createdAt: now, updatedAt: now });
    await setDoc(doc(f, 'homes', H, 'members', OWNER.uid), { uid: OWNER.uid, email: OWNER.email, displayName: 'Owner', roleId: 'owner', status: 'active', addedBy: OWNER.uid, joinedAt: now, createdAt: now, updatedAt: now });
    for (const r of defaultRoles()) await setDoc(doc(f, 'homes', H, 'roles', r.id), { name: r.name, rank: r.rank, permissions: r.permissions, system: r.system, templateVersion: r.templateVersion, createdAt: now, updatedAt: now });
    for (const [i, r] of rooms.entries()) await setDoc(doc(f, 'homes', H, 'rooms', r.id), { name: r.name, type: r.type, icon: r.type, floor: null, notes: null, order: i + 1, active: true, archivedAt: null, archivedBy: null, createdBy: OWNER.uid, createdAt: now, updatedBy: OWNER.uid, updatedAt: now, schemaVersion: 1 });
    for (const d of devices) await setDoc(doc(f, 'homes', H, 'devices', d.id), { name: d.name, category: d.category, subtype: d.subtype, roomId: d.roomId, status: 'operational', icon: d.subtype, brand: null, model: null, serialNumber: null, purchaseDate: null, installationDate: null, purchasePrice: null, currency: null, warrantyExpiry: null, notes: null, active: true, archivedAt: null, archivedBy: null, createdBy: OWNER.uid, createdAt: now, updatedBy: OWNER.uid, updatedAt: now, schemaVersion: 1 });
  });
}
const fs = () => env.authenticatedContext(OWNER.uid, { email: OWNER.email }).firestore();
const reason = (e) => String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 400);
const writesFor = (lang) => {
  const plan = buildSetupPlan({ rooms: rooms.map((r) => ({ ...r, active: true })), devices: devices.map((d) => ({ ...d, active: true })), tasks: [] });
  return planWrites({ plan, accepted: new Set(plan.pending.flatMap((g) => g.add.map((a) => a.id))), lang, uid: OWNER.uid, now: serverTimestamp(), today: new Date().toISOString().slice(0, 10) });
};
async function commitBatch(f, part) { const b = writeBatch(f); for (const w of part) b.set(doc(f, 'homes', H, 'cleaningTasks', w.id), w.data); await b.commit(); }

for (const lang of ['ar', 'en']) {
  const writes = writesFor(lang);
  console.log(`\n================ ${lang.toUpperCase()}: ${writes.length} generated tasks (${new Set(writes.map((w) => w.data.source.id)).size} rooms/devices)`);
  await seed();
  try { await commitBatch(fs(), writes); console.log('(1) SHIPPED single batch: OK'); }
  catch (e) { console.log(`(1) SHIPPED single batch: DENIED → ${reason(e)}`); }
  for (const size of [1, 2, 4, 8, 16, 32]) {
    await seed(); const f = fs(); let ok = 0; let firstErr = null;
    for (let i = 0; i < writes.length; i += size) {
      try { await commitBatch(f, writes.slice(i, i + size)); ok += Math.min(size, writes.length - i); } catch (e) { if (!firstErr) firstErr = `${writes[i].id}…: ${reason(e)}`; }
    }
    console.log(`(2) batches of ${String(size).padStart(2)}: ${ok}/${writes.length} created${firstErr ? ` | first denial: ${firstErr}` : ''}`);
  }
  await seed(); const f = fs(); const single = [];
  for (const w of writes) { try { await setDoc(doc(f, 'homes', H, 'cleaningTasks', w.id), w.data); } catch (e) { single.push(`${w.id} (title ${w.data.title.length} chars): ${reason(e)}`); } }
  console.log(`(3) one task per write: ${writes.length - single.length}/${writes.length} OK${single.length ? '\n    DENIED INDIVIDUALLY:\n    ' + single.join('\n    ') : ''}`);
}
await env.cleanup();
