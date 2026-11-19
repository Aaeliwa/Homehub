/**
 * Maintenance (#/m/maintenance) — Phase 5.5. Preventive plans (after-last-completion schedules),
 * fault reports with an audited lifecycle, and a combined per-device service history with costs
 * (per currency; maintenance metadata only — never posted to Finance). Separate from Cleaning.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { banner, errorText } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import { openDialog } from '../../ui/components/dialog.js';
import { todayIn, formatDateLong, addDays } from '../expenses/calendar.js';
import { formatMoney } from '../expenses/money.js';
import { getDevicesStore } from '../devices/devices-service.js';
import { getRoomsStore } from '../rooms/rooms-service.js';
import { getMaintenanceStore, takeMaintenanceFocus } from './maintenance-service.js';
import { nextDue, planStatus, allowedTransitions, totalsByCurrency } from './maintenance-model.js';
import { openPlanForm, openFaultForm, openServiceDialog, mmsg } from './maintenance-forms.js';

const VIEWS = ['due', 'plans', 'faults', 'history'];
const OPEN_FAULT = ['open', 'inProgress', 'resolved'];

export function mount(outlet, ctx) {
  const state = ctx.getState();
  const { identity, home, permissions } = state;
  const can = (p) => permissions.can(p);
  const locale = state.profile && state.profile.language === 'ar' ? 'ar-EG' : 'en-GB';
  let store; let devices = null; let rooms = null; let dir = null;
  try { store = getMaintenanceStore(ctx); } catch (err) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(err)))); return () => {}; }
  try { devices = getDevicesStore(ctx); } catch { devices = null; }
  try { rooms = getRoomsStore(ctx); } catch { rooms = null; }
  const offs = [];
  import('../../core/family/family-service.js').then((fam) => { try { const f = fam.getFamilyStore(ctx); offs.push(f.subscribe(() => { dir = f.directory(); render(); })); } catch { /* none */ } });
  let view = 'due'; let deviceFilter = 'all'; let planFilter = 'active'; let faultFilter = 'open';
  let highlightPlanId = null;   // Phase 5.6: deep-link highlight, applied on EVERY render (survives re-renders)
  const today = () => todayIn(home.timezone);
  const deviceList = () => { const s = devices ? devices.getSnapshot() : null; return (s && s.devices) || []; };
  const roomName = (id) => { const s = rooms ? rooms.getSnapshot() : null; const r = id && s && (s.rooms || []).find((x) => x.id === id); return r ? r.name : null; };
  const members = () => (dir ? dir.active() : []);
  const nameOf = (uid) => (uid === identity.uid ? t('settings.you') : !dir ? '…' : dir.nameOf(uid, t('family.formerMember')) || t('family.formerMember'));
  const devName = (id) => { const d = deviceList().find((x) => x.id === id); return !d ? t('maintenance.deviceRemoved') : d.active === false ? `${d.name} (${t('maintenance.deviceArchived')})` : d.name; };
  const env = { root: null, store, devices: deviceList, members, roomName, today, homeCurrency: home.currency || null };
  const byDevice = (x) => deviceFilter === 'all' || x.deviceId === deviceFilter;
  const date = (d) => (d ? formatDateLong(d, locale) : '—');

  const root = h('div', { class: 'page page--maintenance accent-violet', id: 'mt-page' }); env.root = root;
  const head = h('header', { class: 'page-head page-head--row' });
  const tabs = h('div', { class: 'view-switch view-switch--scroll', role: 'tablist', 'aria-label': t('module.maintenance.name') });
  const filters = h('div', { class: 'toolbar' });
  const body = h('div', { id: 'mt-body' });
  root.append(head, tabs, filters, body); outlet.replaceChildren(root);

  function complete(plan) {
    openServiceDialog(env, { title: t('maintenance.completeTitle', { title: plan.title }), intro: t('maintenance.completeIntro'), submitLabel: t('maintenance.markDone'),
      submit: async (service) => {
        const r = await store.completePlan(plan.id, service);
        return r === 'existing' ? 'maintenance.toast.alreadySaved' : 'maintenance.toast.completed';   // after the server confirmed
      } });
  }
  function planRow(p) {
    const st = planStatus(p, today()); const n = nextDue(p);
    return h('li', { class: `cl-item mt-item mt-item--${st}${p.id === highlightPlanId ? ' is-focus' : ''}`, dataset: { plan: p.id, status: st } },
      h('div', { class: 'cl-item__main' },
        h('p', { class: 'cl-item__title', dir: 'auto' }, p.title, h('span', { class: `pill mt-pill--${st}` }, t(`maintenance.status.${st}`))),
        h('p', { class: 'cl-item__meta' }, [devName(p.deviceId), n ? t('maintenance.nextOn', { date: date(n) }) : null,
          p.recurrence.kind === 'once' ? t('maintenance.rec.onceShort') : t(`maintenance.rec.everyShort.${p.recurrence.unit}`, { n: p.recurrence.interval }),
          p.assigneeUid ? t('maintenance.assignedTo', { name: nameOf(p.assigneeUid) }) : null].filter(Boolean).join(' · '))),
      h('div', { class: 'cl-item__actions' },
        p.active && st !== 'completed' && can('maintenance.complete') ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-action': 'complete', onClick: () => complete(p) }, t('maintenance.markDone')) : null,
        p.active && can('maintenance.edit') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'edit', onClick: () => openPlanForm(env, p) }, t('maintenance.edit')) : null,
        can('maintenance.delete') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': p.active ? 'archive' : 'reactivate', onClick: async () => {
          try { await store.archivePlan(p.id, p.active); toast(t(p.active ? 'maintenance.toast.archived' : 'maintenance.toast.reactivated'), { tone: 'success' }); } catch (e) { toast(mmsg(e), { tone: 'error' }); } } },
          t(p.active ? 'maintenance.archive' : 'maintenance.reactivate')) : null));
  }
  function faultRow(f) {
    return h('li', { class: `cl-item mt-item mt-fault--${f.status}`, dataset: { fault: f.id, status: f.status } },
      h('button', { type: 'button', class: 'cl-item__main mt-linkish', onClick: () => faultDetail(f.id) },
        h('p', { class: 'cl-item__title', dir: 'auto' }, f.summary, h('span', { class: `pill mt-sev--${f.severity}` }, t(`maintenance.severity.${f.severity}`))),
        h('p', { class: 'cl-item__meta' }, [devName(f.deviceId), t(`maintenance.fault.${f.status}`), f.assigneeUid ? t('maintenance.assignedTo', { name: nameOf(f.assigneeUid) }) : null].filter(Boolean).join(' · '))));
  }
  async function faultDetail(id) {
    const f = store.fault(id); if (!f) return;
    const trail = h('ol', { class: 'fin-list', id: 'mt-fault-trail' }, h('li', null, t('common.loading')));
    const actions = allowedTransitions(f, can).map((to) => h('button', { type: 'button', class: `btn btn--sm ${to === 'resolved' ? 'btn--primary' : 'btn--secondary'}`, 'data-to': to, onClick: () => { dlg.close(); transition(f, to); } }, t(`maintenance.to.${to}`)));
    const content = h('div', { id: 'mt-fault-detail' },
      h('p', { class: 'cl-item__meta' }, [devName(f.deviceId), t(`maintenance.fault.${f.status}`), t(`maintenance.severity.${f.severity}`)].join(' · ')),
      f.description ? h('p', { dir: 'auto' }, f.description) : null,
      f.diagnosis ? h('p', { dir: 'auto' }, `${t('maintenance.diagnosis')}: ${f.diagnosis}`) : null,
      f.resolution ? h('p', { dir: 'auto' }, `${t('maintenance.resolution')}: ${f.resolution}`) : null,
      f.estimateMinor != null ? h('p', null, `${t('maintenance.estimate')}: ${formatMoney(f.estimateMinor, f.estimateCurrency, locale)}`) : null,
      h('h3', { class: 'cl-setup__title' }, t('maintenance.history')), trail);
    const footer = [...actions, f.status !== 'closed' && can('maintenance.edit') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'edit', onClick: () => { dlg.close(); openFaultForm(env, f); } }, t('maintenance.edit')) : null].filter(Boolean);
    const dlg = openDialog({ title: f.summary, content, footer, container: root });
    try {
      const ev = (await store.faultEvents(id)).sort((a, b) => a.rev - b.rev);
      trail.replaceChildren(...ev.map((e) => h('li', { class: 'fin-row', dataset: { rev: e.rev } }, h('span', { class: 'fin-row__main' },
        `${e.fromStatus ? `${t(`maintenance.fault.${e.fromStatus}`)} → ` : ''}${t(`maintenance.fault.${e.toStatus}`)} · ${nameOf(e.actorUid)}`, e.note ? h('span', { class: 'fin-row__sub', dir: 'auto' }, e.note) : null))));
    } catch (e) { trail.replaceChildren(h('li', null, errorText(e))); }
  }
  function transition(f, to) {
    if (to === 'resolved') {
      const res = h('textarea', { id: 'mt-resolution', class: 'input', rows: 2, dir: 'auto', maxlength: 2000 });
      openServiceDialog(env, { title: t('maintenance.resolveTitle', { title: f.summary }), intro: t('maintenance.resolveIntro'), submitLabel: t('maintenance.to.resolved'),
        extraFields: [h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('maintenance.resolution')), res)],
        submit: async (service) => {
          const hasService = service.workPerformed || service.provider || service.parts || service.costMinor != null || service.notes;
          await store.transitionFault(f.id, 'resolved', { fields: { resolution: res.value }, service: hasService ? service : null });
          return 'maintenance.toast.resolved';
        } });
      return;
    }
    const note = h('textarea', { id: 'mt-note', class: 'input', rows: 2, dir: 'auto', maxlength: 500 });
    import('../expenses/dialogs.js').then(({ formDialog }) => formDialog({ title: t(`maintenance.to.${to}`), id: 'mt-transition-form', submitLabel: t(`maintenance.to.${to}`), container: root,
      fields: [h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('maintenance.noteOptional')), note)],
      onSubmit: async () => { try { await store.transitionFault(f.id, to, { note: note.value }); } catch (e) { toast(mmsg(e), { tone: 'error' }); return false; } return 'maintenance.toast.statusChanged'; } }));
  }
  function historyView(snap) {
    const recs = snap.records.filter(byDevice).sort((a, b) => String(b.serviceDate).localeCompare(String(a.serviceDate)) || String(b.id).localeCompare(String(a.id)));
    const totals = totalsByCurrency(recs.filter((r) => !recs.some((x) => x.correctsRecordId === r.id)));   // a corrected record's cost is superseded by its correction
    return h('div', { id: 'mt-history' },
      Object.keys(totals).length ? h('p', { class: 'cl-progress__text', id: 'mt-totals' }, `${t('maintenance.totalActual')}: ${Object.entries(totals).map(([c, v]) => formatMoney(v, c, locale)).join(' · ')}`) : null,
      recs.length ? h('ul', { class: 'cl-list', id: 'mt-history-list' }, recs.map((r) => h('li', { class: 'cl-item', dataset: { record: r.id, kind: r.kind } },
        h('div', { class: 'cl-item__main' },
          h('p', { class: 'cl-item__title', dir: 'auto' }, `${t(`maintenance.kind.${r.kind}`)}${r.correctsRecordId ? ` · ${t('maintenance.correction')}` : ''} — ${date(r.serviceDate)}`),
          h('p', { class: 'cl-item__meta', dir: 'auto' }, [devName(r.deviceId), r.workPerformed, r.provider, r.parts, r.costMinor != null ? formatMoney(r.costMinor, r.currency, locale) : null, nameOf(r.actorUid)].filter(Boolean).join(' · '))),
        can('maintenance.edit') && !r.correctsRecordId ? h('div', { class: 'cl-item__actions' }, h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'correct', onClick: () => openServiceDialog(env, {
          title: t('maintenance.correctTitle'), intro: t('maintenance.correctIntro'), submitLabel: t('common.save'),
          submit: async (service) => { await store.addCorrection(r.id, service); return 'maintenance.toast.corrected'; } }) }, t('maintenance.correct'))) : null)))
        : h('p', { class: 'empty', id: 'mt-history-empty' }, t('maintenance.noHistory')));
  }

  function render() {
    const snap = store.getSnapshot();
    head.replaceChildren(h('div', null, h('h1', { class: 'page-head__title' }, t('module.maintenance.name')), h('p', { class: 'page-head__sub' }, t('maintenance.sub'))),
      h('div', { class: 'page-head__actions' },
        can('maintenance.create') ? h('button', { type: 'button', class: 'btn btn--secondary', id: 'mt-report', onClick: () => openFaultForm(env, null, deviceFilter !== 'all' ? { deviceId: deviceFilter } : null) }, t('maintenance.reportFault')) : null,
        can('maintenance.create') ? h('button', { type: 'button', class: 'btn btn--primary', id: 'mt-new', onClick: () => openPlanForm(env, null, deviceFilter !== 'all' ? { deviceId: deviceFilter } : null) }, t('maintenance.newPlan')) : null));
    tabs.replaceChildren(...VIEWS.map((v) => h('button', { type: 'button', role: 'tab', id: `mt-tab-${v}`, class: 'view-switch__btn', 'aria-selected': String(view === v), 'aria-pressed': String(view === v), onClick: () => { view = v; render(); } }, t(`maintenance.tab.${v}`))));
    const devs = deviceList();
    const dsel = h('select', { id: 'mt-device-filter', class: 'input input--sm', onChange: (e) => { deviceFilter = e.target.value; render(); } },
      [h('option', { value: 'all' }, t('maintenance.allDevices')), ...devs.filter((d) => d.active !== false || d.id === deviceFilter || snap.plans.some((p) => p.deviceId === d.id)).map((d) => h('option', { value: d.id }, d.active === false ? `${d.name} (${t('maintenance.deviceArchived')})` : d.name))]);
    dsel.value = deviceFilter;
    const extra = view === 'plans' ? h('select', { id: 'mt-plan-filter', class: 'input input--sm', onChange: (e) => { planFilter = e.target.value; render(); } }, ['active', 'archived', 'all'].map((v) => h('option', { value: v, selected: v === planFilter }, t(`maintenance.filter.${v}`))))
      : view === 'faults' ? h('select', { id: 'mt-fault-filter', class: 'input input--sm', onChange: (e) => { faultFilter = e.target.value; render(); } }, ['open', 'closed', 'all'].map((v) => h('option', { value: v, selected: v === faultFilter }, t(`maintenance.filter.${v}`)))) : null;
    filters.replaceChildren(...[h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, t('maintenance.device')), dsel), extra].filter(Boolean));
    if (snap.status === 'error') { body.replaceChildren(banner('error', errorText(snap.error))); return; }
    if (snap.status !== 'ready') { body.replaceChildren(h('p', { class: 'muted', role: 'status' }, t('common.loading'))); return; }
    if (!devs.length && !snap.plans.length && !snap.faults.length) { body.replaceChildren(h('p', { class: 'empty', id: 'mt-no-devices' }, t('maintenance.noDevices'))); return; }
    if (view === 'due') {
      const act = snap.plans.filter((p) => p.active && byDevice(p));
      const group = (st) => act.filter((p) => planStatus(p, today()) === st && (st !== 'upcoming' || nextDue(p) <= addDays(today(), 30))).sort((a, b) => String(nextDue(a)).localeCompare(String(nextDue(b))));
      const sec = (st) => { const list = group(st); return list.length ? h('section', { id: `mt-due-${st}` }, h('h2', { class: 'cl-setup__title' }, t(`maintenance.status.${st}`)), h('ul', { class: 'cl-list' }, list.map(planRow))) : null; };
      const parts = ['overdue', 'dueToday', 'upcoming'].map(sec).filter(Boolean);
      body.replaceChildren(...(parts.length ? parts : [h('p', { class: 'empty', id: 'mt-due-empty' }, t('maintenance.nothingDue'))]));
    } else if (view === 'plans') {
      const list = snap.plans.filter((p) => byDevice(p) && (planFilter === 'all' || (planFilter === 'active') === (p.active === true)));
      body.replaceChildren(list.length ? h('ul', { class: 'cl-list', id: 'mt-plans' }, list.map(planRow)) : h('p', { class: 'empty', id: 'mt-plans-empty' }, t('maintenance.noPlans')));
    } else if (view === 'faults') {
      const list = snap.faults.filter((f) => byDevice(f) && (faultFilter === 'all' || (faultFilter === 'open') === OPEN_FAULT.includes(f.status)))
        .sort((a, b) => String(b.id).localeCompare(String(a.id)));
      body.replaceChildren(list.length ? h('ul', { class: 'cl-list', id: 'mt-faults' }, list.map(faultRow)) : h('p', { class: 'empty', id: 'mt-faults-empty' }, t('maintenance.noFaults')));
    } else body.replaceChildren(historyView(snap));
  }
  offs.push(store.subscribe(() => render()));
  if (devices) offs.push(devices.subscribe(() => render()));
  if (rooms) offs.push(rooms.subscribe(() => render()));
  render();
  // Device Details → Maintenance (Home-scoped, read-once).
  const focus = takeMaintenanceFocus(home.id);
  if (focus && focus.deviceId) { deviceFilter = focus.deviceId; render(); }
  if (focus && focus.open === 'plan' && can('maintenance.create')) queueMicrotask(() => openPlanForm(env, null, { ...(focus.preset || {}), deviceId: focus.deviceId }));
  if (focus && focus.open === 'fault' && can('maintenance.create')) queueMicrotask(() => openFaultForm(env, null, { deviceId: focus.deviceId }));
  // Phase 5.6: Reminders → highlight a plan (Plans tab, all) or open a fault, once it is loaded.
  let pendingPlan = focus && focus.planId ? focus.planId : null; let pendingFault = focus && focus.faultId ? focus.faultId : null;
  if (pendingPlan) { view = 'plans'; planFilter = 'all'; render(); }
  const applyFocus = () => {
    if (store.getSnapshot().status !== 'ready') return;
    if (pendingFault) { const id = pendingFault; pendingFault = null; if (store.fault(id)) faultDetail(id); }
    if (pendingPlan && store.plan(pendingPlan)) {
      highlightPlanId = pendingPlan; pendingPlan = null; render();   // the class now comes from render state
      const el = [...body.querySelectorAll('[data-plan]')].find((x) => x.dataset.plan === highlightPlanId);
      if (el) { el.setAttribute('tabindex', '-1'); if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); }
    }
  };
  offs.push(store.subscribe(() => queueMicrotask(applyFocus)));
  queueMicrotask(applyFocus);
  return () => { for (const off of offs) off(); };
}
