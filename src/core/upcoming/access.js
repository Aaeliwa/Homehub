/**
 * V6.4.1 Stage B — pure, dependency-free: who sees Reminders / the Upcoming panel and from which sources.
 * Kept separate so the shell and the dashboard can ask without loading any module store.
 */
export function sourceFlags(perms) {
  return Object.freeze({ cleaning: perms.can('cleaning.view'), maintenance: perms.can('maintenance.view'), calendar: perms.can('calendar.view'),
    finance: perms.can('expenses.view'), totals: perms.can('expenses.viewFinancialTotals') });
}
export const anySource = (f) => f.cleaning || f.maintenance || f.calendar || f.finance;
/** Reminders (bell, page, Tools entry) and the Dashboard Upcoming panel share one audience. */
export const canSeeReminders = (perms) => anySource(sourceFlags(perms));
