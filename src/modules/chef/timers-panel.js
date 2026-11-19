/**
 * Cooking timers panel (V6.1) — ONE implementation, mounted by both cooking mode and the dashboard
 * widget over the SAME store. Countdown is derived locally every second (no writes); alarms play
 * only while this page is open (browsers do not run timers while closed / suspended).
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { toast } from '../../ui/components/toast.js';
import { remainingMs, durationMs, fmt, isRinging, isActive } from './timer-model.js';
import { useAlarm } from './alarm.js';

const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;
export function alarm(tm) {
  toast(t('timers.done', { label: tm.label }), { tone: 'success' });   // audio: the shared coordinator (alarm.js), repeating until stopped
  if (notifySupported() && Notification.permission === 'granted') { try { new Notification(t('timers.done', { label: tm.label })); } catch { /* ignore */ } }
}

export function mountTimersPanel(el, store, { recipeId = null, compact = false, title = true } = {}) {
  const list = h('ul', { class: 'fin-list ck-timers', id: compact ? 'ck-timers-compact' : 'ck-timers' });
  const err = (e) => toast(t(e && e.detail && /^timers\./.test(e.detail) ? e.detail : 'timers.err.save'), { tone: 'error' });
  const run = (fn) => async (ev) => { const b = ev && ev.currentTarget; if (b) b.disabled = true; try { await fn(); } catch (e) { err(e); } finally { if (b) b.disabled = false; } };
  const form = compact ? null : h('form', { class: 'ck-new', id: 'ck-new-timer', onSubmit: (ev) => { ev.preventDefault(); run(async () => {
    const q = (s) => form.querySelector(s).value;
    await store.createTimer({ label: q('#ck-t-label'), durationMs: durationMs({ h: q('#ck-t-h'), m: q('#ck-t-m'), s: q('#ck-t-s') }), recipeId });
    form.reset();
  })(); } },
    h('input', { id: 'ck-t-label', class: 'input', maxlength: 60, placeholder: t('timers.labelPh'), 'aria-label': t('timers.label'), required: true, dir: 'auto' }),
    ...[['h', 23], ['m', 59], ['s', 59]].map(([k, max]) => h('input', { id: `ck-t-${k}`, class: 'input ck-hms', type: 'number', min: 0, max, inputmode: 'numeric', placeholder: t(`timers.${k}`), 'aria-label': t(`timers.${k}Long`) })),
    h('button', { type: 'submit', class: 'btn btn--primary btn--sm', id: 'ck-t-add' }, t('timers.add')));
  const notifyBtn = !compact && notifySupported() && Notification.permission === 'default'
    ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-notify', onClick: async (ev) => { try { await Notification.requestPermission(); } catch { /* ignore */ } ev.currentTarget.remove(); } }, t('timers.enableNotifications')) : null;
  const { coordinator, release } = useAlarm(store);
  const soundBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: compact ? 'ck-enable-sound-c' : 'ck-enable-sound', hidden: true,
    onClick: () => coordinator.enableSound() }, `🔔 ${t('timers.enableSound')}`);
  el.replaceChildren(...[title ? h('h3', { class: 'card__title' }, `⏱ ${t('timers.title')}`) : null, form, soundBtn, list,
    h('p', { class: 'field__hint' }, t('timers.openOnly')), notifyBtn].filter(Boolean));
  function render() {
    const snap = store.getSnapshot(); const now = Date.now();
    // Ringing alarms first (each individually identifiable), then by remaining time.
    let ts = snap.timers.slice().sort((a, b) => (isRinging(b, now) - isRinging(a, now)) || (remainingMs(a, now) - remainingMs(b, now)));
    if (compact) ts = ts.filter((x) => isActive(x, now)).slice(0, 6);
    soundBtn.hidden = !(coordinator.audioBlocked && ts.some((x) => isRinging(x, now)));
    if (!ts.length) { list.replaceChildren(h('li', { class: 'empty', id: compact ? 'ck-timers-none-c' : 'ck-timers-none' }, t('timers.none'))); return; }
    list.replaceChildren(...ts.map((tm) => { const rem = remainingMs(tm, now); const done = isRinging(tm, now);
      const B = (k, fn, cls = 'btn--ghost') => h('button', { type: 'button', class: `btn ${cls} btn--sm`, 'data-action': k, onClick: run(fn) }, t(`timers.${k}`));
      return h('li', { class: `fin-row ck-timer ck-timer--${done ? 'ringing' : tm.status}`, dataset: { timer: tm.id, status: done ? 'ringing' : tm.status }, role: done ? 'alert' : null },
        h('span', { class: 'fin-row__main', dir: 'auto' }, tm.label, h('span', { class: 'fin-row__sub' }, t(`timers.status.${done ? 'ringing' : tm.status}`))),
        h('span', { class: 'fin-row__amount ck-remaining', dir: 'ltr', role: 'timer' }, fmt(rem)),
        h('span', { class: 'cl-item__actions' },
          done ? h('button', { type: 'button', class: 'btn btn--danger btn--sm ck-stop', 'data-action': 'stop-alarm', onClick: run(() => store.dismissAlarm(tm.id)) }, `⏹ ${t('timers.stopAlarm')}`) : null,
          tm.status === 'running' && !done ? B('pause', () => store.timerAction(tm.id, 'pause'), 'btn--secondary') : null,
          tm.status === 'paused' ? B('resume', () => store.timerAction(tm.id, 'resume'), 'btn--primary') : null,
          tm.status === 'idle' ? B('start', () => store.timerAction(tm.id, 'start'), 'btn--primary') : null,
          done ? null : B('restart', () => store.timerAction(tm.id, 'restart')),
          compact || done ? null : B('rename', async () => { const n = window.prompt(t('timers.rename'), tm.label); if (n != null) await store.renameTimer(tm.id, n); }),
          done && compact ? null : B('delete', () => store.deleteTimer(tm.id))));
    }));
  }
  const offA = store.subscribe(render);
  const offT = store.useTicker(alarm);
  const offC = coordinator.onChange(render);
  render();
  return () => { offA(); offT(); offC(); release(); };
}
