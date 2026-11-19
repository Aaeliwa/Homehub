/** Phase 5.4d — pure, no Firebase. */
// ---------------------------------------------------------------- Phase 5.4d: navigation focus
// Device Details → Cleaning: an in-memory, Home-scoped, READ-ONCE intent (device filter and/or
// "add a task for this device"). Nothing in the URL; consumed only when the Home matches, so a stale
// or other-Home intent can never apply. Also cleared on Home switch (homeId mismatch).
let focus = null;
export function setCleaningFocus({ homeId, deviceId = null, roomId = null, openNew = false, preset = null, view = null, highlightTaskId = null }) {
  // Phase 5.6 (Reminders deep link): optional tab + task to highlight.
  focus = homeId ? Object.freeze({ homeId, deviceId, roomId, openNew: !!openNew, preset, ...(view ? { view } : {}), ...(highlightTaskId ? { highlightTaskId } : {}) }) : null;
}
export function takeCleaningFocus(homeId) {
  const f = focus; focus = null;
  return f && f.homeId === homeId ? f : null;
}
