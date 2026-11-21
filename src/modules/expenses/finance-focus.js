/** V6.4.1 Stage B — pure. Upcoming / Reminders → Finance: a Home-scoped, READ-ONCE intent (tab + commitment). */
let focus = null;
export function setFinanceFocus({ homeId, tab = null, commitmentId = null }) { focus = homeId ? Object.freeze({ homeId, tab, commitmentId }) : null; }
export function takeFinanceFocus(homeId) { const f = focus; focus = null; return f && f.homeId === homeId ? f : null; }
