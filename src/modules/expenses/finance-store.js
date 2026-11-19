/**
 * Finance live store — ONE per context scope (uid + homeId). PURE (repository injected).
 *
 * Listeners: for each of the 5 collections, a "mine" listener (readers contains uid) and —
 * only when the member may view household finance — a "household" listener. Results are
 * merged by id. Every page, the Dashboard widget and dialogs share this store; nothing else
 * listens to finance data. All listeners stop on dispose (sign-out / Home change).
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { COL } from './collections.js';
import {
  buildWalletCreate, buildExpenseCreate, buildExpenseEdit, buildExpenseVoid, buildExpenseRestore,
  buildMovementCreate, buildCycleCreate, buildCommitmentCreate, validateCommitmentInput, accessFor,
  walletReaders, validateWalletInput, paymentExpenseId,
} from './finance-model.js';
import { sortHistory, cycleFor, cycleStats, walletBalance, spendingTotals, upcoming } from './ledger.js';
import { advance } from './recurrence.js';
import { buildBudgetEdit } from './budget-edit.js';
import { addDays } from './calendar.js';
import { parseMinor, minorToPlain } from './money.js';
import * as v6 from './finance-v6.js';
import { monthBudget } from './finance-monthly.js';
import { planCorrection, removalCheck, restoreCheck, adjustmentHistory } from './wallet-admin.js';

const NAMES = [COL.wallets, COL.expenses, COL.movements, COL.cycles, COL.commitments, COL.adjustments];
const fail = (detail) => new AppError(ErrorCode.VALIDATION, { detail });
const MAX_BATCH = 450;

export function createFinanceStore({ homeId, uid, repo, homeCurrency = 'EGP' }) {
  if (!homeId || !uid) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  const parts = {};            // `${name}:${kind}` -> array of docs
  const status = {};           // `${name}:${kind}` -> 'loading'|'ready'|'error'
  const stops = new Map();     // key -> unsubscribe
  const listeners = new Set();
  let household = false;
  let disposed = false;
  let lastError = null;
  let cache = null;
  const inflight = new Set();   // V6.2.2: wallets with a correction being written (double-click guard)
  let periods = []; let head = null; let v6On = false; let monthly = [];   // V6.2: monthly settings   // V6 household budget (batch 1)

  const emit = () => { cache = null; for (const fn of [...listeners]) fn(snapshot()); };
  const guard = () => { if (disposed) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE); };

  function listen(name, kind) {
    const key = `${name}:${kind}`;
    if (stops.has(key)) return;
    status[key] = 'loading';
    stops.set(key, repo.watch(homeId, name, kind, uid,
      (docs) => { parts[key] = docs; status[key] = 'ready'; emit(); },
      (err) => { status[key] = 'error'; lastError = err; emit(); }));
  }
  function stop(name, kind) {
    const key = `${name}:${kind}`;
    const off = stops.get(key);
    if (off) off();
    stops.delete(key); delete parts[key]; delete status[key];
  }

  function merged(name) {
    const m = new Map();
    for (const kind of ['household', 'mine']) for (const d of parts[`${name}:${kind}`] || []) m.set(d.id, d);
    return [...m.values()];
  }

  function snapshot() {
    if (cache) return cache;
    const keys = Object.keys(status);
    const st = !keys.length ? 'idle' : keys.some((k) => status[k] === 'error') ? 'error'
      : keys.every((k) => status[k] === 'ready') ? 'ready' : 'loading';
    cache = Object.freeze({
      status: st, error: lastError,
      wallets: merged(COL.wallets), expenses: merged(COL.expenses), movements: merged(COL.movements),
      cycles: merged(COL.cycles), commitments: merged(COL.commitments), adjustments: merged(COL.adjustments),
      periods, head, monthly,   // V6 (+ V6.2 monthly)
    });
    return cache;
  }

  const wallet = (id) => (id ? snapshot().wallets.find((w) => w.id === id) || null : null);
  /** V6 movement document: the existing movement shape + the type's own fields. */
  const v6Mv = (fields, ws) => { const now = repo.now(); return { cycleId: null, note: null, ...fields, ...accessFor(ws),
    status: 'active', voidedAt: null, voidedBy: null, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 }; };
  /** U3: the original's period while open; else the current open period; else unbudgeted. */
  const refundAttribution = (e) => {
    const p = e.periodId ? periods.find((x) => x.id === e.periodId) : null;
    if (p && p.status !== 'closed') return { periodId: p.id };
    const cur = head && periods.find((x) => x.id === head.lastPeriodId && x.status !== 'closed');
    return { periodId: cur ? cur.id : null };
  };
  const isV6 = () => v6.v6Mode({ wallets: snapshot().wallets, periods });
  /** One path for every new V6 expense (manual or commitment payment): account checks + period attribution. */
  const applyV6 = (data, w) => {
    if (w && w.role) {
      if (!v6.paymentOk(data.paymentMethod, w)) throw fail('finance.v6.visaBankOnly');
      if (!v6.datedOk(w, data.date)) throw fail('finance.v6.beforeOpening');
    }
    if (periods.length) Object.assign(data, v6.attribute(periods, head, data.date));   // R1 / R2
    return data;
  };
  function needWallet(id) {
    if (!id) return null;
    const w = wallet(id);
    if (!w) throw fail('finance.validation.walletUnavailable');
    return w;
  }
  const find = (list, id) => { const x = list.find((r) => r.id === id); if (!x) throw fail('not found'); return x; };

  /** Ops that re-sync audience/readers on every record of a wallet whose sharing changed. */
  function resyncOps(updatedWallet) {
    const s = snapshot(); const ops = [];
    const others = (r) => [r.fromWalletId, r.toWalletId].filter((x) => x && x !== updatedWallet.id).map((x) => {
      const w = wallet(x); if (!w) throw fail('finance.validation.walletUnavailable'); return w;
    });
    const push = (name, r, ws) => {
      const a = accessFor(ws);
      if ((r.audience ?? 'household') === a.audience && JSON.stringify(r.readers || []) === JSON.stringify(a.readers)) return;
      ops.push({ mode: 'update', name, id: r.id, data: { ...a, updatedBy: uid, updatedAt: repo.now() } });
    };
    for (const e of s.expenses) if (e.walletId === updatedWallet.id) push(COL.expenses, e, [updatedWallet]);
    for (const c of s.cycles) if (c.walletId === updatedWallet.id) push(COL.cycles, c, [updatedWallet]);
    for (const c of s.commitments) if (c.walletId === updatedWallet.id) push(COL.commitments, c, [updatedWallet]);
    for (const m of s.movements) if (m.fromWalletId === updatedWallet.id || m.toWalletId === updatedWallet.id) push(COL.movements, m, [updatedWallet, ...others(m)]);
    return ops;
  }

  const api = {
    homeId,
    /** Server-timestamp sentinel (for writers that prepare documents elsewhere, e.g. import). */
    nowSentinel: () => repo.now(),
    /** Start/adjust listeners for the member's current permissions (household visibility). */
    ensure({ canViewHousehold }) {
      guard();
      for (const n of NAMES) listen(n, 'mine');
      if (canViewHousehold && !household) { household = true; for (const n of NAMES) listen(n, 'household'); }
      if (canViewHousehold && !v6On) {   // V6: household budget periods + head
        v6On = true; status['v6:periods'] = 'loading'; status['v6:head'] = 'loading';
        // Same provable constraint as all household finance data (audience == 'household').
        stops.set('v6:periods', repo.watch(homeId, COL.periods, 'household', uid, (d) => { periods = d; status['v6:periods'] = 'ready'; emit(); }, (e) => { status['v6:periods'] = 'error'; lastError = e; emit(); }));
        status['v6:monthly'] = 'loading';
        stops.set('v6:monthly', repo.watch(homeId, COL.monthly, 'household', uid, (d) => { monthly = d; status['v6:monthly'] = 'ready'; emit(); }, (e) => { status['v6:monthly'] = 'error'; lastError = e; emit(); }));
        stops.set('v6:head', repo.watch(homeId, COL.head, 'household', uid, (d) => { head = d.find((x) => x.id === 'primary') || null; status['v6:head'] = 'ready'; emit(); }, (e) => { status['v6:head'] = 'error'; lastError = e; emit(); }));
      }
      if (!canViewHousehold && household) { household = false; for (const n of NAMES) stop(n, 'household'); emit(); }
      if (!canViewHousehold && v6On) {   // V6 listeners need household view (rules): stop them too
        v6On = false; monthly = []; for (const k of ['v6:periods', 'v6:head', 'v6:monthly']) { const off = stops.get(k); if (off) off(); stops.delete(k); delete status[k]; }
        periods = []; head = null; emit();
      }
    },
    subscribe(fn) { guard(); listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
    getSnapshot: snapshot,
    listenerCount: () => stops.size,
    wallet,
    activeWallets: () => snapshot().wallets.filter((w) => w.active === true),
    history: () => sortHistory(snapshot().expenses),
    balance: (walletId) => v6.accountBalance(wallet(walletId) || { id: walletId }, snapshot()),   // V6 F1 (same formula for pre-V6 wallets)
    v6: () => ({ periods, head }),
    cycleStats: (cycle, today) => cycleStats(cycle, snapshot(), today),
    activeCycles: () => snapshot().cycles.filter((c) => c.status === 'active'),
    cycleFor: (walletId, date) => cycleFor(snapshot().cycles, walletId, date),
    totals: (month) => spendingTotals(snapshot().expenses, { month }),
    upcoming: (today, days) => upcoming(snapshot().commitments, today, days),
    /** Dashboard contract (no record internals). */
    summary(today) {
      const s = snapshot();
      const month = today.slice(0, 7);
      const t = spendingTotals(s.expenses, { month });
      const cyc = s.cycles.filter((c) => c.status === 'active' && c.startDate <= today && c.endDate >= today)
        .map((c) => ({ id: c.id, walletId: c.walletId, currency: c.currency, endDate: c.endDate, ...cycleStats(c, s, today) }));
      const next = upcoming(s.commitments, today, 60)[0] || null;
      return Object.freeze({ month, monthTotalMinor: t.totalMinor, monthFixedMinor: t.fixedMinor, monthVariableMinor: t.variableMinor,
        currency: homeCurrency, monthBudget: monthBudget(s, month), activeCycles: isV6() ? [] : cyc, nextCommitment: next && { name: next.name, nextDueDate: next.nextDueDate, amountMinor: next.amountMinor, currency: next.currency },
        v6: (() => { const p = v6.periodFor(periods, today); return p ? { ...v6.budgetStatus(p, s), endDateExclusive: p.endDateExclusive } : null; })() });
    },

    // ---- wallets -----------------------------------------------------------------------
    async createWallet(input, { memberUids, date }) {
      guard();
      const id = repo.newId(homeId, COL.wallets);
      const { data, openingBalanceMinor } = buildWalletCreate({ input: { currency: homeCurrency, ...input }, uid, memberUids, now: repo.now() });
      const ops = [{ mode: 'set', name: COL.wallets, id, data }];
      if (openingBalanceMinor) {
        const mv = buildMovementCreate({ type: 'funding', amount: minorToPlain(openingBalanceMinor), date, toWallet: { ...data, id }, note: input.openingNote || null, uid, now: repo.now() });
        mv.amountMinor = openingBalanceMinor; // keep exact minor units
        ops.push({ mode: 'set', name: COL.movements, id: repo.newId(homeId, COL.movements), data: mv });
      }
      await repo.commit(homeId, ops);
      return id;
    },
    async updateWallet(id, input, { memberUids }) {
      guard();
      const cur = needWallet(id);
      const { value: v, errors } = validateWalletInput({ ...cur, ...input, scope: cur.scope, ownerUid: cur.ownerUid, currency: cur.currency }, { uid, memberUids });
      delete errors.openingBalance;
      if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
      const patch = { name: v.name, type: v.type, updatedBy: uid, updatedAt: repo.now() };
      let ops = [];
      if (cur.scope === 'personal') {
        Object.assign(patch, { visibility: v.visibility, sharedWith: v.sharedWith });
        patch.readers = walletReaders({ ...cur, ...patch });
        if (JSON.stringify(patch.readers) !== JSON.stringify(cur.readers || [])) ops = resyncOps({ ...cur, ...patch });
      }
      if (ops.length + 1 > MAX_BATCH) throw fail('finance.validation.tooManyRecords');
      await repo.commit(homeId, [{ mode: 'update', name: COL.wallets, id, data: patch }, ...ops]);
    },
    /** V6.2.2: what "Delete wallet" would do (blocked reason, bills using it, warnings). */
    removalCheck: (id) => removalCheck(wallet(id), snapshot(), v6.accountBalance(wallet(id) || { id }, snapshot())),
    restoreCheck: (id) => restoreCheck(wallet(id), snapshot().wallets),
    adjustmentHistory: (id) => adjustmentHistory(snapshot().movements, id),
    /** "Delete wallet" = ARCHIVE (soft): history keeps its wallet id / name; no new expenses or bill payments. */
    async archiveWallet(id) {
      guard(); needWallet(id);
      const chk = removalCheck(wallet(id), snapshot(), v6.accountBalance(wallet(id), snapshot()));
      if (chk.blocked) throw fail(chk.blocked);
      await repo.commit(homeId, [{ mode: 'update', name: COL.wallets, id, data: { active: false, archivedAt: repo.now(), archivedBy: uid, updatedBy: uid, updatedAt: repo.now() } }]);
    },
    async restoreWallet(id) {
      guard(); needWallet(id);
      const chk = restoreCheck(wallet(id), snapshot().wallets); if (chk.blocked) throw fail(chk.blocked);
      await repo.commit(homeId, [{ mode: 'update', name: COL.wallets, id, data: { active: true, archivedAt: null, archivedBy: null, updatedBy: uid, updatedAt: repo.now() } }]);
    },

    // ---- expenses ----------------------------------------------------------------------
    /** budgetCycleId 'auto' (default) links the active cycle of that wallet covering the date. */
    async addExpense(input) {
      guard();
      const w = needWallet(input.walletId || null);
      const cycleId = isV6() ? null   // batch 2: one budget model — wallet cycles are history in V6 Homes
        : input.budgetCycleId === undefined || input.budgetCycleId === 'auto'
          ? (w ? (cycleFor(snapshot().cycles, w.id, input.date) || {}).id || null : null) : input.budgetCycleId || null;
      const data = applyV6(buildExpenseCreate({ input: { ...input, budgetCycleId: cycleId }, uid, wallet: w, currency: homeCurrency, now: repo.now() }), w);
      const id = repo.newId(homeId, COL.expenses);
      await repo.commit(homeId, [{ mode: 'set', name: COL.expenses, id, data }]);
      return id;
    },
    async editExpense(id, input, base) {
      guard();
      const cur = find(snapshot().expenses, id);
      if ((cur.status ?? 'active') !== 'active') throw fail('finance.validation.voidReadOnly');
      const w = needWallet(input.walletId || null);
      const patch = buildExpenseEdit({ original: base || cur, input, uid, wallet: w, now: repo.now() });
      if (!patch) return false;
      const money = ['amountMinor', 'walletId', 'date', 'currency'].some((k) => k in patch);
      if (money && v6.periodLocked(periods, cur.periodId)) throw fail('finance.v6.periodClosed');   // batch 2: closed periods read-only
      if (money && String(id).startsWith('zk_')) throw fail('finance.v6.zakatOwned');
      if ('date' in patch && periods.length) { const a = v6.attribute(periods, head, patch.date); if (a.periodId !== (cur.periodId ?? null) || a.lateEntry !== (cur.lateEntry ?? false)) Object.assign(patch, a); }
      await repo.commit(homeId, [{ mode: 'update', name: COL.expenses, id, data: patch }]);
      return true;
    },
    async voidExpense(id, reason) { guard(); const cur = find(snapshot().expenses, id);
      if (v6.periodLocked(periods, cur.periodId)) throw fail('finance.v6.periodClosed');
      if (String(id).startsWith('zk_')) throw fail('finance.v6.zakatOwned'); await repo.commit(homeId, [{ mode: 'update', name: COL.expenses, id, data: buildExpenseVoid({ uid, now: repo.now(), reason }) }]); },
    async restoreExpense(id) { guard(); find(snapshot().expenses, id); await repo.commit(homeId, [{ mode: 'update', name: COL.expenses, id, data: buildExpenseRestore({ uid, now: repo.now() }) }]); },

    // ---- V6 finance (batch 1) ---------------------------------------------------------------
    /** A V6 account: wallet (role + openingDate, immutable) + its direction-signed opening, one batch. */
    async createAccount({ name, role, type, openingDate, openingMinor = 0 }, { memberUids }) {
      guard();
      if (!v6.ACCOUNT_ROLES.includes(role)) throw fail('finance.v6.role');
      const id = repo.newId(homeId, COL.wallets);
      const { data } = buildWalletCreate({ input: { currency: homeCurrency, name, type: type || (role === 'bank' ? 'bank' : 'cash'), scope: 'home' }, uid, memberUids, now: repo.now() });
      const w = { ...data, id, role, openingDate };
      const ops = [{ mode: 'set', name: COL.wallets, id, data: { ...data, role, openingDate } }];
      const op = v6.openingFields(w, openingMinor);
      if (op) ops.push({ mode: 'set', name: COL.movements, id: v6.openingId(id), data: v6Mv(op, [w]) });
      await repo.commit(homeId, ops);
      return id;
    },
    async addIncome({ walletId, amountMinor, date, today, source }) {
      guard();
      const w = needWallet(walletId);
      const id = repo.newId(homeId, COL.movements);
      await repo.commit(homeId, [{ mode: 'set', name: COL.movements, id, data: v6Mv(v6.incomeFields({ wallet: w, amountMinor, date, today, source }), [w]) }]);
      return id;
    },
    /** Balance-only correction (never income / spending / budget). Returns null when nothing to adjust. */
    async reconcileAccount({ walletId, actualMinor, date, reason }) {
      const w = needWallet(walletId);
      if (actualMinor === v6.accountBalance(w, snapshot())) return null;
      return api.correctBalance({ walletId, actualMinor, date, reason });
    },
    /**
     * V6.2.2 Correct Balance — the ONE correction path. Appends exactly one 'reconciliation' movement
     * rc_{wallet}_{n} (before / after / delta, reason, actor) and bumps the wallet's correctionSeq to n in
     * the SAME batch: a double click, a second tab or another device computing the same n collides and
     * is refused (rules: create-only id + seq must advance by one). A balance that changed since the
     * dialog opened is refused as stale. Historical rows and the opening funding are never rewritten.
     */
    async correctBalance({ walletId, actualMinor, date, reason, expectedBeforeMinor, today: day }) {
      guard();
      const w = needWallet(walletId);
      if (inflight.has(walletId)) throw fail('finance.v622.busy');
      const p = planCorrection({ wallet: w, currentMinor: v6.accountBalance(w, snapshot()), actualMinor, expectedBeforeMinor, date, reason, today: day });
      const f = v6.reconciliationFields({ wallet: w, appBalance: p.beforeMinor, actualBalance: p.afterMinor, date, reason: p.reason });
      const now = repo.now();
      inflight.add(walletId);
      try {
        await repo.commit(homeId, [
          { mode: 'set', name: COL.movements, id: p.id, data: { ...v6Mv(f, [w]), beforeMinor: p.beforeMinor, afterMinor: p.afterMinor, correctionSeq: p.seq } },
          { mode: 'update', name: COL.wallets, id: walletId, data: { correctionSeq: p.seq, updatedBy: uid, updatedAt: now } }]);
      } catch (e) {
        if (e && (e.code === 'permission-denied' || e.code === ErrorCode.PERMISSION_DENIED)) throw fail('finance.v622.stale');
        throw e;
      } finally { inflight.delete(walletId); }
      return p.id;
    },
    /** New period + head in one batch (serialized: a concurrent creator is refused by the rules). */
    async createPeriod({ startDate, endDateExclusive, capMinor }) {
      guard();
      const v = v6.validatePeriod({ startDate, endDateExclusive, capMinor }, head);
      const id = v6.periodId(v.startDate); const now = repo.now();
      const period = { ...v, audience: 'household', readers: [], status: 'open', closingSnapshot: null, rev: 1, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 };
      const nextHead = { lastPeriodId: id, endDateExclusive: v.endDateExclusive, audience: 'household', readers: [], rev: head ? head.rev + 1 : 1, updatedBy: uid, updatedAt: now };
      try { await repo.commit(homeId, [{ mode: 'set', name: COL.periods, id, data: period }, { mode: 'set', name: COL.head, id: 'primary', data: nextHead }]); }
      catch (e) { if (e && (e.code === 'permission-denied' || e.code === ErrorCode.PERMISSION_DENIED)) throw fail('finance.v6.periodConflict'); throw e; }
      return id;
    },
    async closePeriod(id, nowMs = Date.now()) {
      guard();
      const p = periods.find((x) => x.id === id); if (!p) throw fail('finance.validation.notFound');
      if (!v6.canClose(p, nowMs)) throw fail('finance.v6.periodNotEnded');
      await repo.commit(homeId, [{ mode: 'update', name: COL.periods, id, data: { status: 'closed', closingSnapshot: v6.closingSnapshot(p, snapshot()), rev: p.rev + 1, updatedBy: uid, updatedAt: repo.now() } }]);
    },
    readLedger: (expenseId) => repo.read(homeId, COL.ledgers, expenseId),
    isV6,
    /** V6.2: set THIS month's budget baseline / category limits (owner / admin; rules refuse past months). */
    async setMonthly(ym, { budgetMinor, categoryLimits }) {
      guard();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw fail('finance.validation.dateInvalid');
      if (budgetMinor !== null && (!Number.isInteger(budgetMinor) || budgetMinor < 0)) throw fail('finance.validation.amountInvalid');
      const limits = {}; for (const [k, v] of Object.entries(categoryLimits || {})) { if (!Number.isInteger(v) || v < 0) throw fail('finance.validation.amountInvalid'); if (v > 0 && k !== 'zakat') limits[k] = v; }
      const cur = monthly.find((m) => m.id === ym);
      try {
        await repo.commit(homeId, [{ mode: 'set', name: COL.monthly, id: ym, data: { budgetMinor, categoryLimits: limits, audience: 'household', readers: [], rev: cur ? cur.rev + 1 : 1, updatedBy: uid, updatedAt: repo.now(), schemaVersion: 1 } }]);
      } catch (e) { if (e && (e.code === 'permission-denied' || e.code === ErrorCode.PERMISSION_DENIED)) throw fail('finance.v62.monthLocked'); throw e; }
    },
    /** Batch 2: ATM withdrawal / cash deposit between V6 accounts — a balance movement only. */
    async transferBetween({ fromId, toId, amountMinor, date, note = null }) {
      guard();
      const a = needWallet(fromId); const b = needWallet(toId);
      if (!v6.datedOk(a, date) || !v6.datedOk(b, date)) throw fail('finance.v6.beforeOpening');
      const data = buildMovementCreate({ type: 'transfer', amount: minorToPlain(amountMinor), date, fromWallet: a, toWallet: b, note, uid, now: repo.now() });
      data.amountMinor = amountMinor;
      const id = repo.newId(homeId, COL.movements);
      await repo.commit(homeId, [{ mode: 'set', name: COL.movements, id, data }]);
      return id;
    },
    /** Batch 2: rename only (id, role, opening and references never change). */
    async renameAccount(id, name) {
      guard(); needWallet(id);
      const n = typeof name === 'string' ? name.trim() : '';
      if (!n || n.length > 60) throw fail('finance.validation.nameRequired');
      await repo.commit(homeId, [{ mode: 'update', name: COL.wallets, id, data: { name: n, updatedBy: uid, updatedAt: repo.now() } }]);
    },
    /** Batch 2: audited cap edit — period (cap, rev + 1) + create-only change record, one batch. */
    async editCap(periodId, { toMinor, reason }) {
      guard();
      const p = periods.find((x) => x.id === periodId); if (!p) throw fail('finance.validation.notFound');
      const plan = v6.capChangePlan(p, { toMinor, reason }); if (!plan) return null;
      const now = repo.now();
      try {
        await repo.commit(homeId, [
          { mode: 'update', name: COL.periods, id: periodId, data: { ...plan.periodPatch, updatedBy: uid, updatedAt: now } },
          { mode: 'set', name: COL.capChanges, id: plan.id, data: { ...plan.change, audience: 'household', readers: [], actorUid: uid, at: now, schemaVersion: 1 } }]);
      } catch (e) { if (e && (e.code === 'permission-denied' || e.code === ErrorCode.PERMISSION_DENIED)) throw fail('finance.v6.periodConflict'); throw e; }
      return plan.id;
    },
    /** S3: refund + ledger in one batch; ids are deterministic per sequence (a retry can't double-count). */
    async refundExpense(expenseId, { amountMinor, date }) {
      guard();
      const e = find(snapshot().expenses, expenseId);
      const ledger = await repo.read(homeId, COL.ledgers, expenseId);
      const plan = v6.refundPlan({ expense: e, ledger, amountMinor, date, attribution: refundAttribution(e) });
      const w = needWallet(e.walletId); const now = repo.now();
      await repo.commit(homeId, [
        { mode: plan.ledgerMode, name: COL.ledgers, id: expenseId, data: { ...plan.ledger, updatedBy: uid, updatedAt: now, schemaVersion: 1 } },
        { mode: 'set', name: COL.movements, id: plan.id, data: v6Mv(plan.movement, [w]) }]);
      return plan.id;
    },
    async voidRefund(refundMovementId, reason) {
      guard();
      const r = find(snapshot().movements, refundMovementId);
      const ledger = await repo.read(homeId, COL.ledgers, r.refundOf);
      const p = r.periodId ? periods.find((x) => x.id === r.periodId) : null;
      const plan = v6.refundVoidPlan({ refund: r, ledger, reason, periodOpen: !r.periodId || (p && p.status === 'open') });
      const now = repo.now();
      await repo.commit(homeId, [
        { mode: 'update', name: COL.movements, id: refundMovementId, data: { ...plan.refundPatch, voidedAt: now, voidedBy: uid, updatedBy: uid, updatedAt: now } },
        { mode: 'update', name: COL.ledgers, id: r.refundOf, data: { ...plan.ledger, updatedBy: uid, updatedAt: now, schemaVersion: 1 } }]);
    },

    // ---- movements -----------------------------------------------------------------------
    async addMovement({ type, amount, date, fromWalletId, toWalletId, note, cycleId }) {
      guard();
      // V6 batch 3: V6 accounts record received money as income and corrections as reconciliation.
      if ((type === 'funding' || type === 'adjustment') && [fromWalletId, toWalletId].some((id) => { const w = id && wallet(id); return w && w.role; }))
        throw fail(type === 'funding' ? 'finance.v6.useIncome' : 'finance.v6.useReconcile');
      const data = buildMovementCreate({ type, amount, date, fromWallet: needWallet(fromWalletId), toWallet: needWallet(toWalletId), note, cycleId, uid, now: repo.now() });
      const id = repo.newId(homeId, COL.movements);
      await repo.commit(homeId, [{ mode: 'set', name: COL.movements, id, data }]);
      return id;
    },
    async voidMovement(id) { guard(); find(snapshot().movements, id); await repo.commit(homeId, [{ mode: 'update', name: COL.movements, id, data: { status: 'void', voidedAt: repo.now(), voidedBy: uid, updatedBy: uid, updatedAt: repo.now() } }]); },

    // ---- spending cycles ----------------------------------------------------------------
    /**
     * Start a cycle. fundFrom: null (no movement) | 'external' (funding into the wallet) |
     * <walletId> (transfer from that wallet, e.g. the bank). The funding movement is NOT an expense.
     */
    async startCycle({ walletId, startDate, days, budget, fundFrom = null, carryInMinor = 0, previousCycleId = null }) {
      guard();
      const w = needWallet(walletId);
      const overlap = snapshot().cycles.find((c) => c.status === 'active' && c.walletId === walletId);
      if (overlap) throw fail('finance.validation.cycleActive');
      const id = repo.newId(homeId, COL.cycles);
      const data = buildCycleCreate({ wallet: w, startDate, days, budget, carryInMinor, previousCycleId, uid, now: repo.now() });
      const ops = [{ mode: 'set', name: COL.cycles, id, data }];
      if (fundFrom) {
        const mv = buildMovementCreate({ type: fundFrom === 'external' ? 'funding' : 'transfer', amount: budget, date: startDate,
          fromWallet: fundFrom === 'external' ? null : needWallet(fundFrom), toWallet: w, note: null, cycleId: id, uid, now: repo.now() });
        ops.push({ mode: 'set', name: COL.movements, id: repo.newId(homeId, COL.movements), data: mv });
      }
      await repo.commit(homeId, ops);
      return id;
    },
    /**
     * Phase 5.3: edit the ACTIVE cycle's budget amount (only). ONE batch: cycle (amount + revision)
     * + append-only adjustment record. No wallet movement / expense / balance change.
     * A rules denial here means the cycle changed meanwhile (or no permission): 'budgetConflict'.
     */
    async editBudget(id, { newBudgetMinor, reason }) {
      guard();
      const c = find(snapshot().cycles, id);
      const { cyclePatch, adjustment } = buildBudgetEdit({ cycle: c, newBudgetMinor, reason, uid, now: repo.now() });
      try {
        await repo.commit(homeId, [
          { mode: 'update', name: COL.cycles, id, data: cyclePatch },
          { mode: 'set', name: COL.adjustments, id: adjustment.id, data: adjustment.data },
        ]);
      } catch (err) {
        if (err && (err.code === 'permission-denied' || err.code === ErrorCode.PERMISSION_DENIED)) throw fail('finance.budget.conflict');
        throw err;
      }
      return adjustment.id;
    },
    adjustmentsFor: (cycleId) => snapshot().adjustments.filter((a) => a.cycleId === cycleId).sort((a, b) => b.revision - a.revision),
    /** Record counted cash. Writes an explicit adjustment movement for the difference (never a fake expense). */
    async reconcileCycle(id, { actual, date, today }) {
      guard();
      const c = find(snapshot().cycles, id);
      const a = parseMinor(actual);
      if (a.error || a.value === null) throw fail(a.error || 'finance.validation.amountRequired');
      const st = cycleStats(c, snapshot(), today);
      const diff = a.value - st.remainingMinor;
      if (diff === 0) return 0;
      const w = needWallet(c.walletId);
      const mv = buildMovementCreate({ type: 'adjustment', amount: minorToPlain(Math.abs(diff)), date, fromWallet: diff < 0 ? w : null, toWallet: diff > 0 ? w : null, note: 'reconciliation', cycleId: id, uid, now: repo.now() });
      mv.amountMinor = Math.abs(diff);
      await repo.commit(homeId, [{ mode: 'set', name: COL.movements, id: repo.newId(homeId, COL.movements), data: mv }]);
      return diff;
    },
    /**
     * Close a cycle. outcome:
     *   'carry'  → start the next cycle (same wallet) with carryIn = remaining (≥ 0)
     *   'return' → transfer the remaining cash to another wallet
     *   'keep'   → just close (money stays in the wallet; recorded on the cycle)
     */
    async closeCycle(id, { outcome, today, next = {}, returnToWalletId = null }) {
      guard();
      const c = find(snapshot().cycles, id);
      if (c.status !== 'active') throw fail('finance.validation.cycleClosed');
      const w = needWallet(c.walletId);
      const remaining = cycleStats(c, snapshot(), today).remainingMinor;
      const now = repo.now();
      const close = { status: 'closed', closedAt: now, closedBy: uid, closeOutcome: outcome, closingRemainingMinor: remaining, nextCycleId: null, updatedBy: uid, updatedAt: now };
      const ops = [];
      if (outcome === 'carry') {
        const nextId = repo.newId(homeId, COL.cycles);
        const data = buildCycleCreate({ wallet: w, startDate: next.startDate || addDays(c.endDate, 1), days: next.days || c.days,
          budget: next.budget, carryInMinor: Math.max(0, remaining), previousCycleId: id, uid, now });
        close.nextCycleId = nextId;
        ops.push({ mode: 'set', name: COL.cycles, id: nextId, data });
        if (next.fundFrom) {
          const mv = buildMovementCreate({ type: next.fundFrom === 'external' ? 'funding' : 'transfer', amount: next.budget, date: data.startDate,
            fromWallet: next.fundFrom === 'external' ? null : needWallet(next.fundFrom), toWallet: w, note: null, cycleId: nextId, uid, now });
          ops.push({ mode: 'set', name: COL.movements, id: repo.newId(homeId, COL.movements), data: mv });
        }
      } else if (outcome === 'return') {
        if (remaining > 0) {
          const mv = buildMovementCreate({ type: 'transfer', amount: minorToPlain(remaining), date: today, fromWallet: w, toWallet: needWallet(returnToWalletId), note: null, cycleId: id, uid, now });
          mv.amountMinor = remaining;
          ops.push({ mode: 'set', name: COL.movements, id: repo.newId(homeId, COL.movements), data: mv });
        }
      } else if (outcome !== 'keep') throw fail('outcome');
      await repo.commit(homeId, [{ mode: 'update', name: COL.cycles, id, data: close }, ...ops]);
      return close.nextCycleId;
    },

    // ---- commitments -----------------------------------------------------------------------
    async createCommitment(input) {
      guard();
      const w = needWallet(input.walletId || null);
      const data = buildCommitmentCreate({ input, wallet: w, currency: homeCurrency, uid, now: repo.now() });
      const id = repo.newId(homeId, COL.commitments);
      await repo.commit(homeId, [{ mode: 'set', name: COL.commitments, id, data }]);
      return id;
    },
    async editCommitment(id, input) {
      guard();
      const cur = find(snapshot().commitments, id);
      const { value: v, errors } = validateCommitmentInput(input);
      if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
      const w = needWallet(v.walletId);
      if (w && w.currency !== cur.currency) throw fail('finance.validation.currencyMismatch');
      await repo.commit(homeId, [{ mode: 'update', name: COL.commitments, id, data: {
        name: v.name, amountMinor: v.amountMinor, category: v.category, recurrence: v.recurrence,
        anchorDay: v.nextDueDate !== cur.nextDueDate ? Number(v.nextDueDate.slice(8, 10)) : cur.anchorDay,
        nextDueDate: v.nextDueDate, paymentMethod: v.paymentMethod, walletId: v.walletId, notes: v.notes,
        ...accessFor(w ? [w] : []), updatedBy: uid, updatedAt: repo.now() } }]);
    },
    async archiveCommitment(id) { guard(); find(snapshot().commitments, id); await repo.commit(homeId, [{ mode: 'update', name: COL.commitments, id, data: { active: false, archivedAt: repo.now(), archivedBy: uid, updatedBy: uid, updatedAt: repo.now() } }]); },
    async restoreCommitment(id) { guard(); find(snapshot().commitments, id); await repo.commit(homeId, [{ mode: 'update', name: COL.commitments, id, data: { active: true, archivedAt: null, archivedBy: null, updatedBy: uid, updatedAt: repo.now() } }]); },
    /**
     * Mark the current due date paid: ONE batch = the payment expense (deterministic id) +
     * commitment advanced to its next due date. A repeat for the same due date is refused.
     */
    async payCommitment(id, { date, amount, walletId, paymentMethod, note }) {
      guard();
      const c = find(snapshot().commitments, id);
      if (c.active !== true) throw fail('finance.validation.commitmentArchived');
      const expenseId = paymentExpenseId(c.id, c.nextDueDate);
      if (snapshot().expenses.some((e) => e.id === expenseId)) throw fail('finance.validation.alreadyPaid');
      const w = needWallet(walletId || null);
      const cycleId = isV6() ? null : w ? (cycleFor(snapshot().cycles, w.id, date) || {}).id || null : null;
      const exp = buildExpenseCreate({ input: { amount: amount ?? minorToPlain(c.amountMinor), category: c.category, date, note: note ?? c.name,
        paymentMethod: paymentMethod ?? c.paymentMethod, walletId: w ? w.id : null, budgetCycleId: cycleId }, uid, wallet: w, currency: c.currency, commitment: c, now: repo.now() });
      applyV6(exp, w);
      const nextDueDate = advance(c.nextDueDate, c.recurrence, c.anchorDay);
      await repo.commit(homeId, [
        { mode: 'set', name: COL.expenses, id: expenseId, data: exp },
        { mode: 'update', name: COL.commitments, id, data: { nextDueDate, lastPaidDate: date, updatedBy: uid, updatedAt: repo.now() } },
      ]);
      return expenseId;
    },

    // ---- historical import ---------------------------------------------------------------
    /** Write prepared rows (from import-model) in batches; existing ids are skipped by the caller. */
    async importRows(rows, onProgress) {
      guard();
      for (let i = 0; i < rows.length; i += 400) {
        const chunk = rows.slice(i, i + 400);
        await repo.commit(homeId, chunk.map((r) => ({ mode: 'set', name: COL.expenses, id: r.id, data: r.doc })));
        if (onProgress) onProgress(Math.min(rows.length, i + chunk.length), rows.length);
      }
    },

    dispose() {
      disposed = true;
      for (const off of stops.values()) { try { off(); } catch { /* ignore */ } }
      stops.clear(); listeners.clear();
      for (const k of Object.keys(parts)) delete parts[k];
      periods = []; head = null; v6On = false; monthly = [];   // V6: no previous-home budget data
      for (const k of Object.keys(status)) delete status[k];
      cache = null;
    },
  };
  return Object.freeze(api);
}
