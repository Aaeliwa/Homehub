/** V6.4.1 Stage B — pure. Upcoming / Reminders → Calendar: a Home-scoped, READ-ONCE intent (date to show,
 * event to highlight). Nothing in the URL; consumed only when the Home matches (same pattern as Cleaning). */
let focus = null;
export function setCalendarFocus({ homeId, date = null, eventId = null }) { focus = homeId ? Object.freeze({ homeId, date, eventId }) : null; }
export function takeCalendarFocus(homeId) { const f = focus; focus = null; return f && f.homeId === homeId ? f : null; }
