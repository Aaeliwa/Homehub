/** Phase 5.5 — Device Details → Maintenance: an in-memory, Home-scoped, READ-ONCE intent (pure). */
let focus = null;
export function setMaintenanceFocus({ homeId, deviceId = null, open = null, preset = null, planId = null, faultId = null }) {
  // Phase 5.6 (Reminders deep link): optional plan to highlight / fault to open.
  focus = homeId ? Object.freeze({ homeId, deviceId, open: open === 'plan' || open === 'fault' ? open : null, preset,
    ...(planId ? { planId } : {}), ...(faultId ? { faultId } : {}) }) : null;
}
export function takeMaintenanceFocus(homeId) {
  const f = focus; focus = null;
  return f && f.homeId === homeId ? f : null;
}
