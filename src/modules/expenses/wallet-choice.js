/**
 * V6.2.1 — ONE expense source: the Wallet (PURE, no DOM). Household entry offers exactly two choices,
 * Cash and Bank, mapped to the configured wallet RECORDS by stable fields (never a free-text name):
 *   cash = the active household V6 account with role 'cash', else the ONLY active household wallet of type 'cash';
 *   bank = likewise with role / type 'bank'. Two candidates and no role account → ambiguous → not configured.
 * Members without household entry (e.g. a child) — or the "Mine" scope — choose among their own writable
 * personal wallets. The persisted value is always the wallet id.
 */
const hhActive = (w) => w.active === true && w.visibility === 'household';

export function cashBank(wallets = []) {
  const pick = (slot) => {
    const byRole = wallets.filter((w) => hhActive(w) && w.role === slot);
    if (byRole.length === 1) return { wallet: byRole[0], ambiguous: false };
    if (byRole.length > 1) return { wallet: null, ambiguous: true };
    const byType = wallets.filter((w) => hhActive(w) && !w.role && w.type === slot);
    return byType.length === 1 ? { wallet: byType[0], ambiguous: false } : { wallet: null, ambiguous: byType.length > 1 };
  };
  const c = pick('cash'); const b = pick('bank');
  return { cash: c.wallet, bank: b.wallet, ambiguous: { cash: c.ambiguous, bank: b.ambiguous } };
}

/**
 * Choices for Add / Edit Expense. Returns { kind, options: [{ id, slot, wallet }], missing: [slot] }.
 * kind 'household' → only Cash / Bank (missing lists the unconfigured slots); kind 'personal' → own wallets.
 */
export function sourceOptions(wallets = [], { uid, canHousehold, canPersonal, scope = 'home' } = {}) {
  if (canHousehold && scope !== 'mine') {
    const cb = cashBank(wallets);
    const options = ['cash', 'bank'].filter((s) => cb[s]).map((s) => ({ id: cb[s].id, slot: s, wallet: cb[s] }));
    return { kind: 'household', options, missing: ['cash', 'bank'].filter((s) => !cb[s]) };
  }
  const own = canPersonal ? wallets.filter((w) => w.active === true && w.visibility !== 'household' && (w.readers || []).includes(uid)) : [];
  return { kind: 'personal', options: own.map((w) => ({ id: w.id, slot: null, wallet: w })), missing: own.length ? [] : ['personal'] };
}

/**
 * How an EXISTING expense's wallet relates to the offered choices (edit dialog):
 *  'listed'  — one of the choices;  'other' — a readable wallet outside the choices (archived, another
 *  scope): kept as-is unless the user picks a new one;  'none' — older record without a wallet;
 *  'unknown' — the wallet no longer exists / is not readable: the user MUST choose (never defaulted).
 */
export function currentSource(expense, options, walletById) {
  const id = expense && expense.walletId;
  if (!id) return 'none';
  if (options.some((o) => o.id === id)) return 'listed';
  return walletById(id) ? 'other' : 'unknown';
}

/** Older payment-method label: preserved unless the wallet changes (then the wallet alone is the source). */
export function editPaymentMethod(expense, walletId) {
  return (walletId || null) === (expense.walletId || null) ? (expense.paymentMethod ?? null) : null;
}
