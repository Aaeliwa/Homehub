/**
 * Life Savings live store — ONE per context scope. PURE (repository injected).
 * Listeners (max 6): assets×2, events×2 (household only with savings.view), quotes×1, zakat×1.
 * Every page/widget shares it; all stop on dispose (sign-out / Home change).
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { SCOL } from './collections.js';
import { buildAssetCreate, validateAssetInput, buildEvent, balanceOf, accessOf, assetReaders, isMetal, sortActivity, ASSET_EDITABLE } from './savings-model.js';
import { buildQuote, portfolio as portfolioOf } from './valuation.js';
import { assess, validateProfile, DEFAULT_PROFILE } from './zakat-engine.js';
import { parseMinor, parseGrams } from './quantity.js';
import { zakatLedger, snapshotForHawl } from './zakat-ledger.js';

const fail = (detail) => new AppError(ErrorCode.VALIDATION, { detail });
const MAX_BATCH = 450;

export function createSavingsStore({ homeId, uid, repo, homeCurrency = 'EGP', nowMs = () => Date.now() }) {
  if (!homeId || !uid) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  const parts = {}; const status = {}; const stops = new Map(); const listeners = new Set();
  let household = false; let disposed = false; let lastError = null; let cache = null;
  const emit = () => { cache = null; for (const fn of [...listeners]) fn(snapshot()); };
  const guard = () => { if (disposed) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE); };

  function listen(name, kind) {
    const key = `${name}:${kind}`;
    if (stops.has(key)) return;
    status[key] = 'loading';
    stops.set(key, repo.watch(homeId, name, kind, uid, (d) => { parts[key] = d; status[key] = 'ready'; emit(); }, (e) => { status[key] = 'error'; lastError = e; emit(); }));
  }
  function stop(name, kind) { const k = `${name}:${kind}`; const o = stops.get(k); if (o) o(); stops.delete(k); delete parts[k]; delete status[k]; }
  const merged = (name) => { const m = new Map(); for (const k of ['household', 'mine', 'all']) for (const d of parts[`${name}:${k}`] || []) m.set(d.id, d); return [...m.values()]; };

  function snapshot() {
    if (cache) return cache;
    const ks = Object.keys(status);
    cache = Object.freeze({
      status: !ks.length ? 'idle' : ks.some((k) => status[k] === 'error') ? 'error' : ks.every((k) => status[k] === 'ready') ? 'ready' : 'loading',
      error: lastError,
      assets: merged(SCOL.assets), events: merged(SCOL.events), quotes: merged(SCOL.quotes), zakat: merged(SCOL.zakat),
    });
    return cache;
  }
  const asset = (id) => snapshot().assets.find((a) => a.id === id) || null;
  const need = (id) => { const a = asset(id); if (!a) throw fail('savings.validation.assetUnavailable'); return a; };
  const balances = () => { const s = snapshot(); return Object.fromEntries(s.assets.map((a) => [a.id, balanceOf(a.id, s.events)])); };

  /** Re-label events/zakat-free records of an asset whose sharing changed (same batch). */
  function resyncOps(updated) {
    const acc = accessOf(updated); const ops = [];
    for (const e of snapshot().events) {
      if (e.assetId !== updated.id) continue;
      if (e.audience === acc.audience && JSON.stringify(e.readers || []) === JSON.stringify(acc.readers)) continue;
      ops.push({ mode: 'update', name: SCOL.events, id: e.id, data: { ...acc } });
    }
    return ops;
  }

  function qtyFor(a, raw) {
    const p = isMetal(a.type) ? parseGrams(raw) : parseMinor(raw);
    if (p.error || p.value === null || p.value === 0) throw fail(p.error || 'savings.validation.amountRequired');
    return p.value;
  }

  /** Payment record (+ optional single linked Finance expense, deterministic id zk_<paymentId>). */
  function paymentOps(ownerUid, id, { amountMinor, date, note, snapshotId, readers, linkExpense, wallet }) {
    const now = repo.now();
    const ops = [{ mode: 'set', name: SCOL.zakat, id, data: { kind: 'payment', ownerUid, date, amountMinor, currency: homeCurrency,
      snapshotId: snapshotId || null, note: note || null, linkedExpenseId: linkExpense ? `zk_${id}` : null, readers: [...new Set(readers)].sort(), createdBy: uid, createdAt: now, schemaVersion: 1 } }];
    if (linkExpense) {
      const access = !wallet || wallet.visibility === 'household' ? { audience: 'household', readers: [] } : { audience: 'restricted', readers: [...(wallet.readers || [])].sort() };
      ops.push({ mode: 'set', name: 'expenses', id: `zk_${id}`, data: {
        amountMinor, currency: wallet ? wallet.currency : homeCurrency, date, category: 'zakat', note: note || null, merchant: null,
        paymentMethod: null, walletId: wallet ? wallet.id : null, budgetCycleId: null, paidBy: ownerUid, commitmentId: null, commitmentDueDate: null,
        ...access, status: 'active', voidedAt: null, voidedBy: null, voidReason: null, source: 'app',
        createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 } });
    }
    return ops;
  }
  function snapshotDoc(ownerUid, a, { date, readers }) {
    return {
        kind: 'snapshot', ownerUid, date, hawlStart: a.due ? a.due.start : a.hawlStart, hawlEnd: a.due ? a.due.end : a.hawlEnd,
        zakatableMinor: a.due ? a.due.zakatableMinor : a.zakatableMinor, nisabMinor: a.nisab.valueMinor, nisabBasis: a.nisab.basis,
        rateBps: a.rateBps, estimateMinor: a.due ? a.due.estimateMinor : a.estimateMinor, currency: homeCurrency,
        lines: (a.due ? a.due.lines : a.breakdown).map((l) => ({ assetId: l.asset.id, name: l.asset.name, bps: l.bps, valueMinor: l.valueMinor, shareMinor: l.shareMinor })),
        profileVersion: api.profileFor(ownerUid)._version, readers: [...new Set(readers)].sort(), createdBy: uid, createdAt: repo.now(), schemaVersion: 1 };
  }

  const api = {
    homeId,
    ensure({ canViewHousehold }) {
      guard();
      for (const n of [SCOL.assets, SCOL.events]) listen(n, 'mine');
      listen(SCOL.quotes, 'all'); listen(SCOL.zakat, 'mine');
      if (canViewHousehold && !household) { household = true; for (const n of [SCOL.assets, SCOL.events]) listen(n, 'household'); }
      if (!canViewHousehold && household) { household = false; for (const n of [SCOL.assets, SCOL.events]) stop(n, 'household'); emit(); }
    },
    subscribe(fn) { guard(); listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
    getSnapshot: snapshot,
    listenerCount: () => stops.size,
    asset, balance: (id) => balanceOf(id, snapshot().events), balances,
    activity: (filter = {}) => sortActivity(snapshot().events.filter((e) => (!filter.assetId || e.assetId === filter.assetId) && (!filter.type || e.type === filter.type) && (!filter.createdBy || e.createdBy === filter.createdBy))),
    /** Visible wealth only — the store holds only what the member can read. */
    portfolio(assets = snapshot().assets) { return portfolioOf(assets, balances(), snapshot().quotes, { homeCurrency, nowMs: nowMs() }); },
    /** Latest settings version for an owner (append-only history; newest wins). */
    profileFor(ownerUid) {
      const v = snapshot().zakat.filter((r) => r.kind === 'profile' && r.ownerUid === ownerUid)
        .sort((a, b) => (b.version || 0) - (a.version || 0))[0];
      return v ? { ...DEFAULT_PROFILE, ...v.settings, _version: v.version, _id: v.id } : { ...DEFAULT_PROFILE, _version: 0 };
    },
    zakatFor(ownerUid, today) {
      const s = snapshot();
      return assess({ ownerUid, profile: api.profileFor(ownerUid), assets: s.assets, events: s.events, quotes: s.quotes, today, homeCurrency, nowMs: nowMs() });
    },
    payments: (ownerUid) => snapshot().zakat.filter((r) => r.kind === 'payment' && r.ownerUid === ownerUid).sort((a, b) => (a.date < b.date ? 1 : -1)),
    snapshots: (ownerUid) => snapshot().zakat.filter((r) => r.kind === 'snapshot' && r.ownerUid === ownerUid).sort((a, b) => (a.date < b.date ? 1 : -1)),

    // ---- assets ----------------------------------------------------------------------
    async createAsset(input, { memberUids, date }) {
      guard();
      const id = repo.newId(homeId, SCOL.assets);
      const { data, openingQty } = buildAssetCreate({ input, uid, memberUids, homeCurrency, now: repo.now() });
      const ops = [{ mode: 'set', name: SCOL.assets, id, data }];
      if (openingQty) ops.push({ mode: 'set', name: SCOL.events, id: repo.newId(homeId, SCOL.events), data: buildEvent({ asset: { ...data, id }, type: 'opening', qty: openingQty, date, uid, now: repo.now() }) });
      await repo.commit(homeId, ops);
      return id;
    },
    /** Metadata only — never quantity. Sharing changes re-label the asset's events in the same batch. */
    async updateAsset(id, input, { memberUids }) {
      guard();
      const cur = need(id);
      const { value: v, errors } = validateAssetInput({ ...cur, ...input, type: cur.type, scope: cur.scope, ownerUid: cur.ownerUid, currency: cur.currency, opening: null }, { uid, memberUids, homeCurrency });
      if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
      const patch = {};
      for (const k of ASSET_EDITABLE) if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(v[k] ?? null)) patch[k] = v[k];
      if (!Object.keys(patch).length) return false;
      const next = { ...cur, ...patch };
      const acc = accessOf(next);
      const ops = [{ mode: 'update', name: SCOL.assets, id, data: { ...patch, ...acc, updatedBy: uid, updatedAt: repo.now() } }];
      if (JSON.stringify(acc.readers) !== JSON.stringify(cur.readers || []) || acc.audience !== cur.audience) ops.push(...resyncOps({ ...next, id }));
      if (ops.length > MAX_BATCH) throw fail('savings.validation.tooManyRecords');
      await repo.commit(homeId, ops);
      return true;
    },
    async archiveAsset(id) { guard(); need(id); await repo.commit(homeId, [{ mode: 'update', name: SCOL.assets, id, data: { active: false, archivedAt: repo.now(), archivedBy: uid, updatedBy: uid, updatedAt: repo.now() } }]); },
    async restoreAsset(id) { guard(); need(id); await repo.commit(homeId, [{ mode: 'update', name: SCOL.assets, id, data: { active: true, archivedAt: null, archivedBy: null, updatedBy: uid, updatedAt: repo.now() } }]); },

    // ---- events ------------------------------------------------------------------------
    /** contribution (+) | withdrawal (−) | adjustment (±, raw may be negative) */
    async addEvent(assetId, { type, amount, date, note }) {
      guard();
      const a = need(assetId);
      let qty;
      if (type === 'adjustment') {
        const neg = String(amount).trim().startsWith('-');
        qty = qtyFor(a, String(amount).replace(/^\s*-/, '')) * (neg ? -1 : 1);
      } else qty = qtyFor(a, amount) * (type === 'withdrawal' ? -1 : 1);
      if (qty < 0 && balanceOf(assetId, snapshot().events) + qty < 0 && type !== 'adjustment') throw fail('savings.validation.insufficient');
      await repo.commit(homeId, [{ mode: 'set', name: SCOL.events, id: repo.newId(homeId, SCOL.events), data: buildEvent({ asset: a, type, qty, date, note, uid, now: repo.now() }) }]);
    },
    /**
     * Asset → asset transfer (incl. conversion, e.g. cash → gold): ONE transferId, TWO linked
     * legs written atomically with deterministic ids. Never income, never an expense.
     * `inAmount` is required when units differ (money → grams); the money out is recorded as cost.
     */
    async transfer({ fromId, toId, amount, inAmount, date, note }) {
      guard();
      const from = need(fromId); const to = need(toId);
      if (fromId === toId) throw fail('savings.validation.sameAsset');
      const outQty = qtyFor(from, amount);
      const sameUnit = !isMetal(from.type) && !isMetal(to.type) && from.currency === to.currency;
      if (!sameUnit && (inAmount === undefined || inAmount === null || inAmount === '')) throw fail('savings.validation.inAmountRequired');
      const inQty = sameUnit ? outQty : qtyFor(to, inAmount);
      if (balanceOf(fromId, snapshot().events) < outQty) throw fail('savings.validation.insufficient');
      const tid = repo.newId(homeId, SCOL.events);
      const now = repo.now();
      const cost = !isMetal(from.type) ? { costMinor: outQty, costCurrency: from.currency } : {};
      await repo.commit(homeId, [
        { mode: 'set', name: SCOL.events, id: `${tid}_out`, data: buildEvent({ asset: from, type: 'transfer_out', qty: -outQty, date, note, transferId: tid, uid, now }) },
        { mode: 'set', name: SCOL.events, id: `${tid}_in`, data: buildEvent({ asset: to, type: 'transfer_in', qty: inQty, date, note, transferId: tid, uid, now, ...cost }) },
      ]);
      return tid;
    },
    /**
     * Wallet ↔ savings (Finance integration). direction 'in' = wallet → savings, 'out' = savings → wallet.
     * ONE batch: a Finance walletMovement of type 'savings' + the linked savings event (same transferId).
     * Spending and income totals are untouched: it is a transfer.
     */
    async walletTransfer({ wallet, assetId, direction, amount, inAmount, date, note }) {
      guard();
      const a = need(assetId);
      if (!wallet || wallet.active !== true) throw fail('savings.validation.walletUnavailable');
      const moneyQty = parseMinor(amount).value;
      if (!moneyQty) throw fail('savings.validation.amountRequired');
      if (!isMetal(a.type) && a.currency !== wallet.currency) throw fail('savings.validation.currencyMismatch');
      if (isMetal(a.type) && direction === 'out') throw fail('savings.validation.sellMetalFirst');
      const assetQty = isMetal(a.type) ? qtyFor(a, inAmount) : moneyQty;
      if (direction === 'out' && balanceOf(assetId, snapshot().events) < assetQty) throw fail('savings.validation.insufficient');
      const tid = repo.newId(homeId, SCOL.events);
      const now = repo.now();
      const ev = buildEvent({ asset: a, type: direction === 'in' ? 'transfer_in' : 'transfer_out', qty: direction === 'in' ? assetQty : -assetQty, date, note, transferId: tid, walletId: wallet.id, uid, now,
        ...(direction === 'in' && isMetal(a.type) ? { costMinor: moneyQty, costCurrency: wallet.currency } : {}) });
      const access = wallet.visibility === 'household' ? { audience: 'household', readers: [] } : { audience: 'restricted', readers: [...(wallet.readers || [])].sort() };
      const mv = { type: 'savings', amountMinor: moneyQty, currency: wallet.currency, date,
        fromWalletId: direction === 'in' ? wallet.id : null, toWalletId: direction === 'out' ? wallet.id : null,
        cycleId: null, note: note || null, savingsTransferId: tid, ...access, status: 'active', voidedAt: null, voidedBy: null,
        createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 };
      await repo.commit(homeId, [
        { mode: 'set', name: SCOL.events, id: `${tid}_${direction === 'in' ? 'in' : 'out'}`, data: ev },
        { mode: 'set', name: 'walletMovements', id: `sv_${tid}`, data: mv },
      ]);
      return tid;
    },

    // ---- prices ------------------------------------------------------------------------
    async addQuote({ kind, key, price, note }) {
      guard();
      const p = parseMinor(price, { allowZero: false });
      if (p.error || !p.value) throw fail(p.error || 'savings.validation.amountRequired');
      await repo.commit(homeId, [{ mode: 'set', name: SCOL.quotes, id: repo.newId(homeId, SCOL.quotes),
        data: buildQuote({ kind, key, price: p.value, currency: homeCurrency, uid, nowMs: nowMs(), now: repo.now(), note: note || null }) }]);
    },

    // ---- zakat -------------------------------------------------------------------------
    /** Settings are versioned (append-only): who changed what, when, is always answerable. */
    async saveProfile(ownerUid, settings, { readers }) {
      guard();
      const errs = validateProfile({ ...DEFAULT_PROFILE, ...settings });
      if (Object.keys(errs).length) throw fail(Object.keys(errs).join(','));
      const prev = api.profileFor(ownerUid);
      const clean = Object.fromEntries(Object.keys(DEFAULT_PROFILE).map((k) => [k, settings[k] ?? DEFAULT_PROFILE[k]]));
      await repo.commit(homeId, [{ mode: 'set', name: SCOL.zakat, id: `${ownerUid}_p${(prev._version || 0) + 1}`,
        data: { kind: 'profile', ownerUid, version: (prev._version || 0) + 1, settings: clean, readers: [...new Set(readers)].sort(), createdBy: uid, createdAt: repo.now(), schemaVersion: 1 } }]);
    },
    /** Evidence of a calculation (kept forever; a new Hawl never overwrites an old one). */
    async recordSnapshot(ownerUid, a, { date, readers }) {
      guard();
      const id = repo.newId(homeId, SCOL.zakat);
      await repo.commit(homeId, [{ mode: 'set', name: SCOL.zakat, id, data: snapshotDoc(ownerUid, a, { date, readers }) }]);
      return id;
    },
    /**
     * Record a Zakat payment. Optionally ALSO record it as ONE Finance expense (category 'zakat')
     * in the SAME batch, with a deterministic id (zk_<paymentId>) — never two expenses.
     */
    async recordPayment(ownerUid, { amount, date, note, snapshotId = null, readers, linkExpense = false, wallet = null }) {
      guard();
      const p = parseMinor(amount, { allowZero: false });
      if (p.error || !p.value) throw fail(p.error || 'savings.validation.amountRequired');
      const id = repo.newId(homeId, SCOL.zakat);
      await repo.commit(homeId, paymentOps(ownerUid, id, { amountMinor: p.value, date, note, snapshotId, readers, linkExpense, wallet }));
      return id;
    },

    /** Phase 5.2: estimate vs linked payments vs outstanding, per saved calculation. */
    ledger(ownerUid) { return zakatLedger(api.snapshots(ownerUid), api.payments(ownerUid)); },
    /** Current readers of an owner's Zakat records (latest profile version, else the latest record). */
    zakatReadersOf(ownerUid) {
      const recs = snapshot().zakat.filter((r) => r.ownerUid === ownerUid);
      if (!recs.length) return null;
      const prof = recs.filter((r) => r.kind === 'profile').sort((x, y) => (y.version || 0) - (x.version || 0))[0];
      return [...((prof || recs[0]).readers || [])].sort();
    },
    /**
     * Phase 5.2: pay a COMPLETED Hawl. ONE batch: the calculation snapshot for that Hawl (only if
     * none exists yet) + the payment linked to it (+ the optional single Finance expense).
     */
    async payHawl(ownerUid, assessment, { amount, date, note, readers, linkExpense = false, wallet = null }) {
      guard();
      const due = assessment && assessment.due;
      if (!due) throw fail('savings.validation.noCompletedHawl');
      const existing = snapshotForHawl(api.snapshots(ownerUid), due.end);
      const snapId = existing ? existing.id : repo.newId(homeId, SCOL.zakat);
      const ops = [];
      if (!existing) ops.push({ mode: 'set', name: SCOL.zakat, id: snapId, data: snapshotDoc(ownerUid, assessment, { date, readers }) });
      const p = parseMinor(amount, { allowZero: false });
      if (p.error || !p.value) throw fail(p.error || 'savings.validation.amountRequired');
      const pid = repo.newId(homeId, SCOL.zakat);
      ops.push(...paymentOps(ownerUid, pid, { amountMinor: p.value, date, note, snapshotId: snapId, readers, linkExpense, wallet }));
      await repo.commit(homeId, ops);
      return { paymentId: pid, snapshotId: snapId };
    },
    /**
     * Phase 5.2: explicit Zakat sharing / revocation. Re-labels readers on ALL of the owner's
     * existing Zakat records in one batch (content untouched; rules allow only `readers`).
     */
    async setZakatSharing(ownerUid, readers) {
      guard();
      const recs = snapshot().zakat.filter((r) => r.ownerUid === ownerUid);
      if (!readers.includes(ownerUid)) throw fail('savings.validation.invalid');
      const ops = recs.filter((r) => JSON.stringify([...(r.readers || [])].sort()) !== JSON.stringify([...readers].sort()))
        .map((r) => ({ mode: 'update', name: SCOL.zakat, id: r.id, data: { readers: [...readers].sort() } }));
      if (ops.length > MAX_BATCH) throw fail('savings.validation.tooManyRecords');
      if (ops.length) await repo.commit(homeId, ops);
      return ops.length;
    },

    dispose() {
      disposed = true;
      for (const o of stops.values()) { try { o(); } catch { /* ignore */ } }
      stops.clear(); listeners.clear();
      for (const k of Object.keys(parts)) delete parts[k];
      for (const k of Object.keys(status)) delete status[k];
      cache = null;
    },
  };
  return Object.freeze(api);
}

export { assetReaders };
