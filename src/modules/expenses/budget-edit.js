/**
 * Edit active 10-day budget — PURE (Phase 5.3). Budget AMOUNT only: start/end dates, duration,
 * wallet, currency and identity never change. A budget is a TARGET, not cash: editing it creates
 * no wallet movement, income or expense and changes no balance or historical record.
 *
 * Concurrency: the cycle carries `budgetRevision` (missing = 0 for older cycles). An edit writes
 * revision n+1 together with an append-only record budgetAdjustments/{cycleId}_r{n+1} (old/new/
 * delta/editor/server time/reason). The rules require old == the STORED amount and revision ==
 * stored + 1, so a stale or concurrent edit is refused (conflict → reload → retry).
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { parseMinor } from './money.js';
import { cycleStats } from './ledger.js';

export const BUDGET_REASON_MAX = 200;
export const revisionOf = (cycle) => (Number.isInteger(cycle && cycle.budgetRevision) ? cycle.budgetRevision : 0);
export const adjustmentId = (cycleId, revision) => `${cycleId}_r${revision}`;
const fail = (detail) => new AppError(ErrorCode.VALIDATION, { detail });

/** Validate the new amount: finite, non-negative, ≤ 2 decimals, different from the current one. */
export function parseNewBudget(raw, cycle) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { error: 'finance.validation.amountRequired' };
  const p = parseMinor(raw, { allowZero: true });
  if (p.error || p.value === null) return { error: p.error || 'finance.validation.amountInvalid' };
  if (p.value === cycle.budgetMinor) return { error: 'finance.budget.unchanged' };
  return { value: p.value };
}

/** Before/after preview using the SAME formula as the cycle card (cycleStats). */
export function previewBudgetEdit(cycle, newBudgetMinor, data, today) {
  const before = cycleStats(cycle, data, today);
  const after = cycleStats({ ...cycle, budgetMinor: newBudgetMinor }, data, today);
  return { before, after, deltaMinor: newBudgetMinor - cycle.budgetMinor, overBudget: after.remainingMinor < 0 };
}

/** The two writes of ONE atomic batch. `now` is the server-timestamp sentinel. */
export function buildBudgetEdit({ cycle, newBudgetMinor, reason, uid, now }) {
  if (!cycle || cycle.status !== 'active') throw fail('finance.budget.notActive');
  if (!Number.isSafeInteger(newBudgetMinor) || newBudgetMinor < 0) throw fail('finance.validation.amountInvalid');
  if (newBudgetMinor === cycle.budgetMinor) throw fail('finance.budget.unchanged');
  const r = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim().slice(0, BUDGET_REASON_MAX) : '';
  const revision = revisionOf(cycle) + 1;
  return {
    revision,
    cyclePatch: { budgetMinor: newBudgetMinor, budgetRevision: revision, updatedBy: uid, updatedAt: now },
    adjustment: {
      id: adjustmentId(cycle.id, revision),
      data: {
        cycleId: cycle.id, walletId: cycle.walletId, revision,
        oldBudgetMinor: cycle.budgetMinor, newBudgetMinor, deltaMinor: newBudgetMinor - cycle.budgetMinor,
        currency: cycle.currency, reason: r || null, editorUid: uid, createdAt: now,
        audience: cycle.audience ?? 'household', readers: cycle.readers || [], schemaVersion: 1,
      },
    },
  };
}
