/**
 * Devices → Device Details → Maintenance (Phase 5.5). Built by the Maintenance module and exposed
 * through maintenance-service, so Devices never imports Maintenance internals. Live; dispose() on close.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { formatDateLong, todayIn } from '../expenses/calendar.js';
import { formatMoney } from '../expenses/money.js';
import { nextDue, planStatus } from './maintenance-model.js';
import { maintenanceSuggestionsFor } from './maintenance-catalog.js';

const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const OPEN = ['open', 'inProgress', 'resolved'];

export function buildDeviceMaintenanceSection({ store, state, device, onNavigate, setFocus }) {
  const can = (p) => state.permissions.can(p);
  const lang = state.profile && state.profile.language === 'en' ? 'en' : 'ar';
  const locale = lang === 'ar' ? 'ar-EG' : 'en-GB';
  const el = h('section', { class: 'card fin-card dev-maintenance', id: 'dev-maintenance', 'aria-labelledby': 'dev-maintenance-title' });
  const go = (opts) => { setFocus({ homeId: state.home.id, deviceId: device.id, ...opts }); onNavigate('/m/maintenance'); };
  function render() {
    const snap = store.getSnapshot();
    const head = h('h3', { class: 'card__title', id: 'dev-maintenance-title' }, `🔧 ${t('maintenance.sectionTitle')}`);
    if (snap.status === 'error') { el.replaceChildren(head, h('p', { class: 'field__error', role: 'alert' }, t('maintenance.loadError'))); return; }
    if (snap.status !== 'ready') { el.replaceChildren(head, h('p', { class: 'muted', role: 'status' }, t('common.loading'))); return; }
    const today = todayIn(state.home.timezone);
    const plans = snap.plans.filter((p) => p.deviceId === device.id && p.active);
    const faults = snap.faults.filter((f) => f.deviceId === device.id && OPEN.includes(f.status));
    const recent = snap.records.filter((r) => r.deviceId === device.id).sort((a, b) => String(b.serviceDate).localeCompare(String(a.serviceDate))).slice(0, 5);
    const active = device.active !== false; const canAdd = active && can('maintenance.create');
    const titles = new Set(snap.plans.filter((p) => p.deviceId === device.id).map((p) => norm(p.title)));
    const sugg = canAdd ? maintenanceSuggestionsFor(device).filter((s) => !titles.has(norm(s.titleAr)) && !titles.has(norm(s.titleEn))).slice(0, 3) : [];
    const any = plans.length || faults.length || recent.length;
    el.replaceChildren(...[head,
      plans.length ? h('ul', { class: 'fin-list', id: 'dev-mt-plans' }, plans.map((p) => { const st = planStatus(p, today); const n = nextDue(p);
        return h('li', { class: 'fin-row', dataset: { plan: p.id, status: st } }, h('span', { class: 'fin-row__main', dir: 'auto' }, p.title,
          h('span', { class: 'fin-row__sub' }, [t(`maintenance.status.${st}`), n ? t('maintenance.nextOn', { date: formatDateLong(n, locale) }) : null].filter(Boolean).join(' · ')))); })) : null,
      faults.length ? h('ul', { class: 'fin-list', id: 'dev-mt-faults' }, faults.map((f) => h('li', { class: 'fin-row', dataset: { fault: f.id } },
        h('span', { class: 'fin-row__main', dir: 'auto' }, `⚠ ${f.summary}`, h('span', { class: 'fin-row__sub' }, `${t(`maintenance.fault.${f.status}`)} · ${t(`maintenance.severity.${f.severity}`)}`))))) : null,
      recent.length ? h('div', { id: 'dev-mt-recent' }, h('p', { class: 'field__label' }, t('maintenance.recentService')),
        h('ul', { class: 'fin-list' }, recent.map((r) => h('li', { class: 'fin-row', dataset: { record: r.id } }, h('span', { class: 'fin-row__main', dir: 'auto' },
          `${t(`maintenance.kind.${r.kind}`)} — ${formatDateLong(r.serviceDate, locale)}`,
          h('span', { class: 'fin-row__sub' }, [r.workPerformed, r.costMinor != null ? formatMoney(r.costMinor, r.currency, locale) : null].filter(Boolean).join(' · '))))))) : null,
      !any ? h('p', { class: 'empty', id: 'dev-mt-empty' }, t('maintenance.noneForDevice')) : null,
      !active ? h('p', { class: 'field__hint' }, t('maintenance.archivedReadOnly')) : null,
      h('div', { class: 'cl-item__actions' },
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'dev-mt-view', onClick: () => go({}) }, t('maintenance.view')),
        canAdd ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'dev-mt-add-plan', onClick: () => go({ open: 'plan' }) }, t('maintenance.addPlan')) : null,
        canAdd ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'dev-mt-report', onClick: () => go({ open: 'fault' }) }, t('maintenance.reportFault')) : null),
      sugg.length ? h('div', { id: 'dev-mt-suggest' }, h('p', { class: 'field__label' }, t('maintenance.suggested')), h('p', { class: 'field__hint' }, t('maintenance.suggestDisclaimer')),
        h('ul', { class: 'fin-list' }, sugg.map((s) => h('li', { class: 'fin-row', dataset: { suggestion: s.key, pro: String(s.pro) } },
          h('span', { class: 'fin-row__main', dir: 'auto' }, lang === 'en' ? s.titleEn : s.titleAr,
            h('span', { class: 'fin-row__sub' }, [t(`maintenance.rec.everyShort.${s.recurrence.unit}`, { n: s.recurrence.interval }), s.pro ? `🛠 ${t('maintenance.proOnly')}` : null].filter(Boolean).join(' · '))),
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'use-suggestion', onClick: () => go({ open: 'plan', preset: {
            title: lang === 'en' ? s.titleEn : s.titleAr, recurrence: s.recurrence, instructions: s.pro ? t('maintenance.proOnlyNote') : null } }) }, t('maintenance.useSuggestion')))))) : null,
    ].filter(Boolean));
  }
  const off = store.subscribe(() => render());
  render();
  return { el, dispose: off };
}
