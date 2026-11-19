/**
 * Zakat ledger — PURE (Phase 5.2). Keeps three things visibly separate:
 *   ESTIMATED LIABILITY  per saved calculation (snapshot) of a Hawl
 *   RECORDED PAYMENTS    payment records linked to that calculation (snapshotId)
 *   OUTSTANDING          max(0, estimate − linked payments)  — never negative; overpayment shown
 * Payments without a calculation link are listed separately (never guessed onto a Hawl).
 * Nothing here writes or alters records; historical snapshots/payments are read as stored.
 */
export function zakatLedger(snapshots, payments) {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const rows = snapshots
    .map((s) => {
      const linked = payments.filter((p) => p.snapshotId === s.id);
      const paid = linked.reduce((t, p) => t + (Number.isSafeInteger(p.amountMinor) ? p.amountMinor : 0), 0);
      const estimate = Number.isSafeInteger(s.estimateMinor) ? s.estimateMinor : 0;
      return { snapshot: s, estimateMinor: estimate, paidMinor: paid, outstandingMinor: Math.max(0, estimate - paid), overpaidMinor: Math.max(0, paid - estimate), payments: linked };
    })
    .sort((a, b) => ((a.snapshot.hawlEnd || a.snapshot.date) < (b.snapshot.hawlEnd || b.snapshot.date) ? 1 : -1));
  const unlinked = payments.filter((p) => !p.snapshotId || !byId.has(p.snapshotId));
  return {
    rows, unlinked,
    totals: {
      estimateMinor: rows.reduce((t, r) => t + r.estimateMinor, 0),
      paidLinkedMinor: rows.reduce((t, r) => t + r.paidMinor, 0),
      outstandingMinor: rows.reduce((t, r) => t + r.outstandingMinor, 0),
      unlinkedMinor: unlinked.reduce((t, p) => t + (Number.isSafeInteger(p.amountMinor) ? p.amountMinor : 0), 0),
    },
  };
}

/** The saved calculation for a completed Hawl (same owner, same Hawl end), if one exists. */
export const snapshotForHawl = (snapshots, hawlEnd) => snapshots.find((s) => s.hawlEnd === hawlEnd) || null;

/**
 * Readers for an owner's Zakat records. Owner always; guardians of a child owner always (oversight
 * cannot be removed); plus explicitly chosen members. Max 6 (rules limit).
 */
export function zakatReaders({ ownerUid, guardianUids = [], sharedWith = [] }) {
  const r = [...new Set([ownerUid, ...guardianUids, ...sharedWith].filter(Boolean))];
  if (r.length > 6) throw Object.assign(new Error('too many readers'), { detail: 'savings.validation.tooManyShared' });
  return r.sort();
}
