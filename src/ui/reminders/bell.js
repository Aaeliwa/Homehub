/**
 * Reminders bell (Phase 5.6): actionable count + an in-app alert when a NEW overdue / due-today
 * reminder appears while the app is open (never on first load; once per reminder per tab; quiet
 * hours respected). In-app only — nothing is delivered when the app is closed.
 */
import { t, formatNumber } from '../../core/i18n/i18n.js';
import { toast } from '../components/toast.js';
import { createRemindersFeed } from '../../core/reminders/reminders-service.js';
import { isQuiet } from '../../core/reminders/reminders-model.js';

const hourIn = (tz) => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date()));

export function mountBell(el, ctx) {
  const badge = el.querySelector('.bell-btn__badge');
  const tz = ctx.getState().home.timezone;
  let baseline = null; const alerted = new Set();
  const feed = createRemindersFeed(ctx, (d) => {
    if (!d || d.status !== 'ready') return;
    const n = d.counts.actionable;
    badge.textContent = n ? formatNumber(n) : ''; badge.hidden = !n;
    el.setAttribute('aria-label', n ? t('reminders.bellCount', { n }) : t('reminders.title'));
    const urgent = d.items.filter((r) => r.presentation === 'unread' && (r.bucket === 'overdue' || r.bucket === 'today'));
    if (baseline === null) { baseline = new Set(urgent.map((r) => r.key)); return; }   // first load: no alert
    const fresh = urgent.filter((r) => !baseline.has(r.key) && !alerted.has(r.key));
    for (const r of fresh) alerted.add(r.key);
    if (fresh.length && !isQuiet(d.prefs, hourIn(tz))) toast(fresh.length === 1 ? t('reminders.newOne', { title: fresh[0].titleKey ? t(fresh[0].titleKey) : fresh[0].title }) : t('reminders.newMany', { n: fresh.length }), { tone: 'info' });
  });
  return () => feed.dispose();
}
