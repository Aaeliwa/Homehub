/**
 * Home Routine & Cleaning (#/m/cleaning). Contract: mount(outlet, ctx) → unmount.
 * V6.3: the former Advanced page IS the Cleaning page (#/m/cleaning and the old #/m/cleaning/advanced
 * both open it). The former main page's daily lists are gone; its task management (template setup
 * review, room / device filters, edit / archive / restore) lives on as the "Tasks" tab, mounted here
 * by mountTaskManager. Every write goes through the cleaning store → repository (atomic, audited).
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { icon } from '../../ui/components/icons.js';
import { banner, errorText } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import { confirmDialog } from '../../ui/components/dialog.js';
import { formDialog } from '../expenses/dialogs.js';
import { todayIn } from '../expenses/calendar.js';
import { getCleaningStore } from './cleaning-service.js';
import { getRoomsStore } from '../rooms/rooms-service.js';
import { buildSetupPlan, planWrites, sourceActive, effectiveRoomId, generatableAs, linkedDeviceId } from './cleaning-integration.js';
import { getDevicesStore } from '../devices/devices-service.js';
import { mountAdvanced } from './advanced-page.js';
import { openTaskForm as openSharedTaskForm, deviceLabel } from './task-form.js';

export const cmsg = (e) => (e && e.detail && /^cleaning\./.test(String(e.detail).split(',')[0]) ? t(String(e.detail).split(',')[0]) : errorText(e));

export function mount(outlet, ctx, opts = {}) { return mountAdvanced(outlet, ctx, opts); }

/** V6.3 "Tasks" tab: task management only (no daily lists, no claim). `focus` = Device Details intent. */
export function mountTaskManager(outlet, ctx, { focus = null } = {}) {
  const state = ctx.getState();
  const { identity, home, permissions } = state;
  const can = (p) => permissions.can(p);
  const today = () => todayIn(home.timezone);
  let store; let rooms = null;
  try { store = getCleaningStore(ctx); } catch (err) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(err)))); return () => {}; }
  try { rooms = getRoomsStore(ctx); } catch { rooms = null; }
  let devices = null;
  try { devices = getDevicesStore(ctx); } catch { devices = null; }
  const lang = state.profile && state.profile.language === 'en' ? 'en' : 'ar';

  let roomFilter = 'all'; let dir = null;
  let highlightTaskId = null;   // Phase 5.6: deep-link highlight, applied on EVERY render (survives re-renders)
  let deviceFilter = 'all';   // Phase 5.4d: tasks linked to one device (from the filter or Device Details)
  const devMatch = (tk) => deviceFilter === 'all' || linkedDeviceId(tk) === deviceFilter;
  let setupResult = null;   // last partial-setup outcome (shown until the next complete setup)
  const offs = [];
  import('../../core/family/family-service.js').then((fam) => {
    try { const f = fam.getFamilyStore(ctx); offs.push(f.subscribe(() => { dir = f.directory(); render(); })); } catch { /* no member directory */ }
  });
  // While the member directory is still loading, show a neutral placeholder — never "former member".
  const nameOf = (uid) => (uid === identity.uid ? t('settings.you') : !dir ? '…' : dir.nameOf(uid, t('family.formerMember')) || t('family.formerMember'));
  const roomList = () => { const s = rooms ? rooms.getSnapshot() : null; return (s && (s.rooms || s.items)) || []; };
  const deviceList = () => { const s = devices ? devices.getSnapshot() : null; return (s && s.devices) || []; };
  const roomById = (id) => roomList().find((x) => x.id === id) || null;
  const deviceById = (id) => deviceList().find((x) => x.id === id) || null;
  const visible = (t) => sourceActive(t, { roomById, deviceById });
  const roomOf = (t) => effectiveRoomId(t, { deviceById });
  const roomName = (id) => { if (!id) return null; const r = rooms && rooms.get ? rooms.get(id) : roomList().find((x) => x.id === id); return r ? (r.active === false ? t('cleaning.roomArchived', { name: r.name }) : r.name) : t('cleaning.roomMissing'); };

  const root = h('div', { class: 'cl-tasks', id: 'cl-tasks' });
  const filters = h('div', { class: 'toolbar' });
  const body = h('div', { class: 'cl-body', id: 'cl-body' });
  root.append(filters, body);
  outlet.replaceChildren(root);

  function render() {
    const snap = store.getSnapshot();
    const roomOpts = [h('option', { value: 'all' }, t('cleaning.allRooms')), h('option', { value: 'none' }, t('cleaning.noRoom')),
      ...roomList().filter((r) => r.active !== false).map((r) => h('option', { value: r.id }, r.name))];
    for (const o of roomOpts) if (o.value === roomFilter) o.selected = true;
    const devs = deviceList();
    const devOpts = [h('option', { value: 'all' }, t('cleaning.device.all')), ...devs.filter((d) => d.active !== false || d.id === deviceFilter).map((d) => h('option', { value: d.id }, d.active === false ? `${d.name} (${t('cleaning.device.archivedTag')})` : d.name))];
    for (const o of devOpts) if (o.value === deviceFilter) o.selected = true;
    filters.replaceChildren(...[h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, t('cleaning.room')),
      h('select', { id: 'cl-room-filter', class: 'input input--sm', onChange: (e) => { roomFilter = e.target.value; render(); } }, roomOpts)),
      devs.length || deviceFilter !== 'all' ? h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, t('cleaning.device.label')),
        h('select', { id: 'cl-device-filter', class: 'input input--sm', onChange: (e) => { deviceFilter = e.target.value; render(); } }, devOpts)) : null].filter(Boolean));
    if (snap.status === 'loading' || snap.status === 'idle') { body.replaceChildren(h('p', { class: 'muted', role: 'status' }, t('common.loading'))); return; }
    if (snap.status === 'error') { body.replaceChildren(banner('error', errorText(snap.error))); return; }
    const setup = setupBanner(snap);
    body.replaceChildren(...[setup, can('cleaning.create') ? h('div', { class: 'cl-tasks__actions' }, h('button', { type: 'button', class: 'btn btn--secondary', id: 'cl-new', onClick: () => openTaskForm(null) }, icon('plus', { size: 18 }), t('cleaning.newTask'))) : null,
      manageView(snap.tasks.filter((tk) => devMatch(tk) && (roomFilter === 'all' || (roomOf(tk) || 'none') === roomFilter)))].filter(Boolean));
  }

  /** Phase 5.3.1: rooms/devices with template tasks not yet added → one-tap review. */
  function setupBanner(snap) {
    if (!can('cleaning.create')) return null;
    const plan = buildSetupPlan({ rooms: roomList(), devices: deviceList(), tasks: snap.tasks });
    const resultEl = setupResult ? h('div', { class: 'banner banner--error', id: 'cl-setup-result', role: 'status' }, setupSummary(setupResult)) : null;
    if (!plan.addCount) { if (setupResult && !setupResult.failed.length) setupResult = null; return resultEl; }
    const rc = plan.pending.filter((g) => g.kind === 'room').length; const dc = plan.pending.filter((g) => g.kind === 'device').length;
    return h('div', { class: 'banner banner--info cl-setup', id: 'cl-setup', role: 'status' },
      h('p', null, t('cleaning.setup.banner', { n: plan.addCount, rooms: rc, devices: dc })),
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'cl-setup-btn', onClick: () => reviewDialog(plan) }, t('cleaning.setup.review')),
      resultEl);
  }
  /** Outcome of the last setup, from CONFIRMED saves only. */
  function setupSummary(r) {
    const parts = [t('cleaning.setup.partial', { saved: r.saved, total: r.total })];
    if (r.failed.length) parts.push(t('cleaning.setup.failedN', { n: r.failed.length, titles: r.failed.slice(0, 3).map((f) => `«${f.title}» (${t(`cleaning.setup.reason.${f.reason}`)})`).join('، ') }));
    if (r.alreadyExisted) parts.push(t('cleaning.setup.alreadyN', { n: r.alreadyExisted }));
    if (r.remaining) parts.push(t('cleaning.setup.remainingN', { n: r.remaining }));
    parts.push(t('cleaning.setup.retryHint'));
    return parts.join(' ');
  }
  /** Phase 5.4b: how a suggestion repeats — usage / season tasks have no frequency. */
  function suggestionLabel(g, tt) {
    const how = g.kind === 'room' ? 'periodic' : generatableAs(g.template, tt);
    if (how === 'afterUse') return t('cleaning.setup.afterUse');
    if (how === 'seasonStart') return t('cleaning.setup.seasonStart');
    if (how === 'seasonEnd') return t('cleaning.setup.seasonEnd');
    const f = freqLabel(tt.freq.unit, tt.freq.n);
    return how === 'seasonalActive' ? t('cleaning.setup.inSeasonOnly', { freq: f }) : f;
  }
  function reviewDialog(plan) {
    const groupEl = (g) => {
      const name = g.source.name;   // device.icon is an icon key, never printed as text
      const tplName = lang === 'en' ? g.template.nameEn : g.template.nameAr;
      return h('section', { class: 'cl-setup__group', dataset: { kind: g.kind, source: g.source.id } },
        h('h3', { class: 'cl-setup__title' }, `${name} — ${t('cleaning.setup.template', { name: tplName })}`),
        h('ul', { class: 'cl-setup__list' }, g.add.map((it) => h('li', null, h('label', { class: 'fin-check' },
          h('input', { type: 'checkbox', name: 'cl-setup-item', value: it.id, checked: true }),
          h('span', null, h('strong', null, lang === 'en' ? it.template.titleEn : it.template.titleAr), ' — ',
            suggestionLabel(g, it.template), ' · ', t('cleaning.setup.minutes', { n: it.template.minutes })))))),
        g.covered.length ? h('p', { class: 'field__hint' }, t('cleaning.setup.covered', { n: g.covered.length, titles: g.covered.map((c) => c.task.title).join('، ') })) : null,
        g.deferred.length ? h('p', { class: 'field__hint' }, t('cleaning.setup.deferred', { n: g.deferred.length })) : null);
    };
    formDialog({ title: t('cleaning.setup.title'), id: 'cl-setup-form', submitLabel: t('cleaning.setup.confirm'), container: root,
      fields: [h('p', { class: 'fin-callout' }, t('cleaning.setup.explain')),
        h('p', { class: 'cl-setup__progress', id: 'cl-setup-progress', role: 'status', 'aria-live': 'polite', hidden: true }),
        ...plan.pending.map(groupEl)],
      onSubmit: async () => {
        const accepted = new Set([...root.querySelectorAll('input[name="cl-setup-item"]:checked')].map((x) => x.value));
        const writes = planWrites({ plan, accepted, lang, uid: identity.uid, now: store.now(), today: today() });
        const progressEl = root.querySelector('#cl-setup-progress');
        let res;
        try {
          res = await store.applySetup(writes, { onProgress: (r) => { if (progressEl) { progressEl.hidden = false; progressEl.textContent = t('cleaning.setup.progress', { saved: r.saved, total: r.total }); } } });
        } catch (e) { toast(cmsg(e), { tone: 'error' }); return false; }
        if (!res.failed.length && !res.remaining) { setupResult = null; toast(t('cleaning.setup.done', { n: res.saved }), { tone: 'success' }); }
        else { setupResult = res; toast(setupSummary(res), { tone: 'error' }); }
        render();                      // the banner/plan now reflects the confirmed, live task list
        return null;
      } });
  }

  function manageView(tasks) {
    const sorted = [...tasks].sort((a, b) => (a.active === b.active ? a.title.localeCompare(b.title) : a.active ? -1 : 1));
    if (!sorted.length) return h('p', { class: 'empty', id: 'cl-empty' }, t('cleaning.emptyNoTasks'));
    return h('ul', { class: 'cl-list', id: 'cl-manage' }, sorted.map((tk) => h('li', { class: `cl-item${tk.active ? '' : ' cl-item--archived'}${tk.id === highlightTaskId ? ' is-focus' : ''}`, dataset: { task: tk.id } },
      h('div', { class: 'cl-item__main' }, h('p', { class: 'cl-item__title' }, tk.title, tk.active ? null : h('span', { class: 'pill' }, t('cleaning.archived'))),
        h('p', { class: 'cl-item__meta' }, [sourceLabel(tk), roomName(roomOf(tk)), recurrenceLabel(tk.recurrence), tk.source && !tk.active ? t('cleaning.setup.declinedHint') : null].filter(Boolean).join(' · '))),
      h('div', { class: 'cl-item__actions' },
        tk.active && can('cleaning.edit') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'edit', onClick: () => openTaskForm(tk) }, t('cleaning.editAction')) : null,
        tk.active && can('cleaning.delete') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'archive', onClick: async () => {
          if (!(await confirmDialog({ title: t('cleaning.archiveTitle'), message: t('cleaning.archiveBody', { title: tk.title }), confirmLabel: t('cleaning.archive'), container: root }))) return;
          try { await store.archiveTask(tk.id); toast(t('cleaning.toast.archived'), { tone: 'success' }); } catch (e) { toast(cmsg(e), { tone: 'error' }); }
        } }, t('cleaning.archive')) : null,
        !tk.active && can('cleaning.delete') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'restore', onClick: async () => {
          try { await store.restoreTask(tk.id); toast(t('cleaning.toast.restored'), { tone: 'success' }); } catch (e) { toast(cmsg(e), { tone: 'error' }); }
        } }, t('cleaning.restore')) : null))));
  }
  // Phase 5.4d: device tag for ANY device-linked task (plain, trigger, generated) — honest when archived / removed.
  const sourceLabel = (tk) => { const id = linkedDeviceId(tk); if (!id) return null; const d = deviceById(id); return !d ? t('cleaning.device.removedTag') : d.active === false ? `${d.name} (${t('cleaning.device.archivedTag')})` : d.name; };
  const freqLabel = (unit, n) => t(unit === 'month' ? 'cleaning.rec.afterMonths' : 'cleaning.rec.afterDays', { n });
  const recurrenceLabel = (r) => (r && r.kind === 'after' ? freqLabel(r.unit, r.interval) : !r || r.kind === 'once' ? t('cleaning.rec.once')
    : r.kind === 'days' ? (r.interval === 1 ? t('cleaning.rec.daily') : t('cleaning.rec.everyNDays', { n: r.interval }))
    : r.kind === 'weeks' ? t(r.interval === 1 ? 'cleaning.rec.weekly' : 'cleaning.rec.everyNWeeks', { n: r.interval, days: r.weekdays.map((d) => t(`cleaning.wd.${d}`)).join('، ') })
    : t('cleaning.rec.monthly', { n: r.interval, day: r.dayOfMonth }));

  /** Phase 5.4d: the shared New / Edit form (task-form.js), also used by Advanced. */
  function openTaskForm(task, preset = null) {
    openSharedTaskForm({ root, store, identity, dir, roomList, deviceList, today, errorText, recurrenceLabel }, task, preset);
  }


  offs.push(store.subscribe(() => render()));
  if (rooms) offs.push(rooms.subscribe(() => render()));
  if (devices) offs.push(devices.subscribe(() => render()));
  if (focus && focus.deviceId) deviceFilter = focus.deviceId;
  if (focus && focus.openNew && can('cleaning.create')) queueMicrotask(() => openTaskForm(null, { ...(focus.preset || {}), deviceId: focus.deviceId }));
  let pendingHighlight = focus && focus.highlightTaskId ? focus.highlightTaskId : null;
  const applyHighlight = () => {
    if (!pendingHighlight) return;
    const el = [...body.querySelectorAll('[data-task]')].find((x) => x.dataset.task === pendingHighlight);
    if (!el) return;
    highlightTaskId = pendingHighlight; pendingHighlight = null;
    el.classList.add('is-focus'); el.setAttribute('tabindex', '-1');   // and every later render keeps it (highlightTaskId)
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  };
  offs.push(store.subscribe(() => queueMicrotask(applyHighlight)));
  render(); queueMicrotask(applyHighlight);
  return () => { for (const off of offs) off(); };
}
