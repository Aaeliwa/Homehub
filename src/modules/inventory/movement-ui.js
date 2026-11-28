/**
 * Pantry stock dialogs (V6.5 Phase 02): the stock-change dialog and the on-demand "recent history" dialog.
 *
 * Stock dialog: captures { baseStockRev, dimension, trackMode, operationId } when it opens and binds the submission to
 * them. A live preview shows the resulting balance (pure computeStock — nothing is written). Submit is single-shot:
 * after any server outcome other than "confirmed" the dialog does not submit again — the user reopens it from the
 * current balance (no automatic retry, never a fresh revision for a retry). A dialog whose product changed underneath it
 * (another device) is marked stale and cannot submit. "Unknown" outcomes offer an explicit server check (review).
 */
import { h } from '../../core/utils/dom.js';
import { t, getLanguage, getLocale } from '../../core/i18n/i18n.js';
import { banner, errorText, setBusy } from '../../ui/components/common.js';
import { openDialog } from '../../ui/components/dialog.js';
import { toast } from '../../ui/components/toast.js';
import { displayName } from './product-model.js';
import { unitsFor, BASE_UNIT } from './units.js';
import { computeStock, newOperationId, stockStatus, amountText, deltaText, PRESENCE_VALUES, NOTE_MAX, HISTORY_LIMIT, isRecorded } from './stock-model.js';

export const msg = (err) => (err && err.detail && /^pantry\./.test(String(err.detail)) ? t(String(err.detail)) : errorText(err));
const lang = () => (getLanguage() === 'ar' ? 'ar' : 'en');
const unitLabel = (u) => t(`pantry.unit.${u}`);
export const qtyLabel = (milli, unit) => t('pantry.stock.qty', { qty: amountText(milli, unit), unit: unitLabel(unit) });
/** Current balance sentence for a product (never presents an unrecorded 0 as "empty"). */
export function balanceText(p) {
  const s = stockStatus(p);
  if (s === 'unrecorded') return t('pantry.stock.unrecorded');
  if (p.trackMode === 'presence') return t(`pantry.presence.${p.presence}`);
  return qtyLabel(p.stockMilli, p.displayUnit);
}

/**
 * openStockDialog({ store, productId, can: { edit, adjust }, container, onDone }).
 * Quantity products: add / remove (inventory.edit), correction (inventory.adjust). Presence products: in / low / out.
 */
export function openStockDialog({ store, productId, can, container }) {
  const p0 = store.product(productId);
  if (!p0) return null;
  const L = lang(); const quantity = p0.trackMode === 'quantity';
  const captured = Object.freeze({ baseStockRev: p0.stockRev, dimension: p0.dimension ?? null, trackMode: p0.trackMode, operationId: newOperationId() });
  const types = quantity ? [can.edit && 'add', can.edit && 'remove', can.adjust && 'correction'].filter(Boolean) : (can.edit ? ['presence'] : []);
  if (!types.length) return null;
  let type = types[0]; let sent = false; let finished = false;

  const field = (label, control, { id, hint, hintId } = {}) => h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), control,
    hint ? h('p', { class: 'field__hint', id: hintId }, hint) : null);
  const current = h('p', { class: 'pn-stock__current', id: 'pn-s-current' },
    h('span', { class: 'pn-stock__label' }, t('pantry.stock.current')), ' ', h('strong', { dir: 'auto' }, balanceText(p0)));
  const typeGroup = h('fieldset', { class: 'pn-seg', id: 'pn-s-type' }, h('legend', { class: 'field__label' }, quantity ? t('pantry.stock.operation') : t('pantry.stock.newState')));
  const radios = [];
  const options = quantity ? types : PRESENCE_VALUES;
  for (const v of options) {
    const r = h('input', { type: 'radio', name: 'pn-s-type', value: v, id: `pn-s-type-${v}`, class: 'pn-seg__input',
      checked: quantity ? v === type : false, disabled: !quantity && v === p0.presence });
    r.addEventListener('change', () => { if (quantity) type = v; sync(); });
    radios.push(r);
    typeGroup.append(h('label', { class: 'pn-seg__opt', for: `pn-s-type-${v}` }, r, h('span', null, quantity ? t(`pantry.stock.type.${v}`) : t(`pantry.presence.${v}`))));
  }
  const amount = h('input', { class: 'input', id: 'pn-s-amount', inputmode: 'decimal', dir: 'ltr', autocomplete: 'off', 'aria-describedby': 'pn-s-preview' });
  const unit = h('select', { class: 'input', id: 'pn-s-unit', 'aria-label': t('pantry.unit') },
    quantity ? unitsFor(p0.dimension).map((u) => h('option', { value: u, selected: u === p0.displayUnit }, unitLabel(u))) : []);
  const note = h('textarea', { class: 'input', id: 'pn-s-note', maxlength: NOTE_MAX, rows: 2, dir: 'auto' });
  const noteLabel = h('span');
  const preview = h('p', { class: 'pn-stock__preview', id: 'pn-s-preview', 'aria-live': 'polite' });
  const messages = h('div', { class: 'gate__messages', id: 'pn-s-msg', 'aria-live': 'assertive' });
  const amountRow = quantity ? h('div', { class: 'pn-stock__amount' }, field(t('pantry.stock.amount'), amount, { id: 'pn-s-amount' }), field(t('pantry.unit'), unit, { id: 'pn-s-unit' })) : null;
  const intent = () => ({ type: quantity ? type : 'presence', amount: amount.value, unit: unit.value, note: note.value,
    state: quantity ? undefined : (radios.find((r) => r.checked) || {}).value });
  function sync() {
    noteLabel.textContent = quantity && type === 'correction' ? t('pantry.stock.reason') : t('pantry.stock.noteOptional');
    note.required = quantity && type === 'correction';
    amount.placeholder = quantity && type === 'correction' ? t('pantry.stock.countedPh') : '';
    if (finished) return;
    const cur = store.product(productId);
    if (!cur || cur.stockRev !== captured.baseStockRev || (cur.dimension ?? null) !== captured.dimension || cur.archived === true) {
      preview.textContent = '';
      if (!sent) { messages.replaceChildren(h('div', { id: 'pn-s-stale' }, banner('error', t('pantry.err.staleDialog')))); submit.disabled = true; }
      return;
    }
    const blocked = !sent && store.stockBlock(productId);
    try {
      const r = computeStock(cur, intent());
      preview.textContent = quantity ? t('pantry.stock.preview', { qty: amountText(r.afterMilli, cur.displayUnit), unit: unitLabel(cur.displayUnit) })
        : t('pantry.stock.previewPresence', { state: t(`pantry.presence.${r.afterPresence}`) });
      preview.classList.remove('pn-stock__preview--error');
    } catch (e) {
      const empty = quantity ? !String(amount.value).trim() : !intent().state;
      preview.textContent = empty ? '' : msg(e);
      preview.classList.toggle('pn-stock__preview--error', !empty);
    }
    if (!sent) {
      messages.replaceChildren(blocked ? h('div', { id: 'pn-s-blocked' }, banner('info', t(blocked))) : '');
      // Repeat guard: the same change on this product was confirmed moments ago → explicit "record it again".
      const repeat = !blocked && store.isRepeat(productId, intent());
      repeatBox.hidden = !repeat; if (!repeat) repeatOk.checked = false;
      submit.disabled = !!blocked || (repeat && !repeatOk.checked);
    }
  }
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', form: 'pn-s-form', id: 'pn-s-save' }, t('common.save'));
  const repeatOk = h('input', { type: 'checkbox', id: 'pn-s-dup-ok' });
  repeatOk.addEventListener('change', sync);
  const repeatBox = h('div', { class: 'pn-stock__repeat', id: 'pn-s-dup', hidden: true, role: 'group' },
    banner('info', t('pantry.stock.repeatWarn')),
    h('label', { class: 'pn-stock__repeat-ok', for: 'pn-s-dup-ok' }, repeatOk, h('span', null, t('pantry.stock.repeatOk'))));
  const close = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.close'));
  const reviewBtn = h('button', { type: 'button', class: 'btn btn--secondary', id: 'pn-s-review', hidden: true, onClick: () => review() }, t('pantry.stock.checkAgain'));
  function show(outcome) {
    finished = outcome.status !== 'unknown' && outcome.status !== 'pending';
    if (outcome.status === 'confirmed') {
      toast(outcome.recovered ? t('pantry.toast.stockRecovered') : t('pantry.toast.stockSaved'), { tone: 'success' });
      dlg.close(); return;
    }
    submit.disabled = true; submit.hidden = true;
    reviewBtn.hidden = !(outcome.status === 'unknown' || outcome.status === 'pending');
    const text = outcome.status === 'unknown' ? t('pantry.stock.unknown') : outcome.status === 'pending' ? t('pantry.stock.stillPending')
      : outcome.status === 'conflict' ? t('pantry.err.conflict') : `${t('pantry.stock.notApplied')} ${msg(outcome.error)}`;
    messages.replaceChildren(h('div', { id: `pn-s-${outcome.status}` }, banner(outcome.status === 'pending' || outcome.status === 'unknown' ? 'info' : 'error', text)));
    preview.textContent = '';
  }
  async function review() {
    const restore = setBusy(reviewBtn, t('pantry.stock.checking'));
    try { const o = await store.review(productId); if (!alive()) return; restore(); show(o.status === 'none' ? { status: 'confirmed' } : o); }
    catch (e) { if (!alive()) return; restore(); messages.replaceChildren(banner('error', msg(e))); }
  }
  let open = true; const alive = () => open;
  const form = h('form', { id: 'pn-s-form', class: 'room-form pn-stock', novalidate: true, onSubmit: async (e) => {
    e.preventDefault();
    if (sent || submit.disabled) return;                                    // duplicate submit / click guard
    let restoreBtn = null;
    try {
      computeStock(store.product(productId), intent());                     // validate before anything is sent
      sent = true; restoreBtn = setBusy(submit, t('common.saving'));
      for (const r of [...radios, amount, unit, note, repeatOk]) r.disabled = true;
      const pendingTimer = setTimeout(() => { if (alive() && !finished) messages.replaceChildren(h('div', { id: 'pn-s-waiting' }, banner('info', t('pantry.stock.waiting')))); }, 1500);
      const outcome = await store.submitStock(productId, intent(), { ...captured, confirmRepeat: repeatOk.checked });
      clearTimeout(pendingTimer);
      if (!alive()) {                                                        // dialog closed meanwhile: report once, if this Home is still current
        if (outcome.status === 'confirmed') toast(t('pantry.toast.stockSaved'), { tone: 'success' });
        else if (outcome.status !== 'pending') toast(t('pantry.stock.needsReview'), { tone: 'error', timeout: 6000 });
        return;
      }
      show(outcome);
    } catch (err) {
      if (!alive()) return;
      if (!sent) { messages.replaceChildren(banner('error', msg(err))); return; }   // validation / precondition: nothing was sent
      if (restoreBtn) restoreBtn();
      show({ status: 'rejected', error: err });
    }
  } },
    h('p', { class: 'pn-stock__name', dir: 'auto' }, displayName(p0, L)),
    current,
    !isRecorded(p0) && p0.trackMode === 'quantity' ? h('p', { class: 'field__hint', id: 'pn-s-firsthint' }, t('pantry.stock.firstHint')) : null,
    typeGroup, amountRow,
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'pn-s-note' }, noteLabel), note),
    preview, repeatBox, messages);
  for (const el of [amount, unit, note]) el.addEventListener('input', sync);
  unit.addEventListener('change', sync);
  const off = store.subscribe(() => { if (alive()) sync(); });
  const dlg = openDialog({ title: t('pantry.stock.title'), content: form, footer: [close, reviewBtn, submit], container,
    onClose: () => { open = false; off(); } });
  sync();
  // An earlier operation on this product is unconfirmed: the dialog opens in REVIEW mode (server check only, no new write).
  const op = store.operation(productId);
  if (op && op.status === 'unknown') {
    sent = true; for (const el of [...radios, amount, unit, note]) el.disabled = true;
    show({ status: 'unknown' }); reviewBtn.focus();
    return dlg;
  }
  (quantity ? amount : (radios.find((r) => !r.disabled) || note)).focus();
  return dlg;
}

// ------------------------------------------------------------------------------------------------ history
const toDate = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : v ? new Date(v) : null);
function when(v) {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
/** The unit a historical movement is shown in: the product's display unit if the dimension still matches, else the base unit. */
const histUnit = (m, p) => (m.dimension && p && p.dimension === m.dimension && p.displayUnit ? p.displayUnit : BASE_UNIT[m.dimension]);

/** openHistoryDialog({ store, product, nameOf, container }) — read-only; no edit / delete anywhere. */
export function openHistoryDialog({ store, product, nameOf, container }) {
  const L = lang();
  const list = h('ol', { class: 'pn-hist', id: 'pn-hist', 'aria-label': t('pantry.history.recent', { n: HISTORY_LIMIT }) });
  const status = h('div', { id: 'pn-hist-status', 'aria-live': 'polite' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') }));
  let open = true;
  const close = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.close'));
  const dlg = openDialog({ title: t('pantry.history.title'), container, footer: [close], onClose: () => { open = false; },
    content: h('div', { class: 'pn-hist-wrap' },
      h('p', { class: 'pn-stock__name', dir: 'auto' }, displayName(product, L)),
      h('p', { class: 'field__hint', id: 'pn-hist-label' }, t('pantry.history.recent', { n: HISTORY_LIMIT })),
      status, list) });
  store.history(product.id).then(({ items, limited }) => {
    if (!open) return;                                                       // closed / Home switched: drop the late result
    status.replaceChildren(items.length ? '' : h('p', { class: 'empty', id: 'pn-hist-empty' }, t('pantry.history.empty')),
      limited ? h('p', { class: 'field__hint', id: 'pn-hist-limited' }, t('pantry.history.limited', { n: HISTORY_LIMIT })) : '');
    list.replaceChildren(...items.map((m) => {
      const u = histUnit(m, product);
      const numbers = m.type === 'presence'
        ? t('pantry.history.presence', { from: m.beforePresence ? t(`pantry.presence.${m.beforePresence}`) : t('pantry.stock.unrecorded'), to: t(`pantry.presence.${m.afterPresence}`) })
        : t('pantry.history.numbers', { before: amountText(m.beforeMilli, u), after: amountText(m.afterMilli, u), delta: deltaText(m.deltaMilli, u), unit: unitLabel(u) });
      return h('li', { class: ['pn-hist__item', `pn-hist__item--${m.type}`], dataset: { rev: String(m.stockRev) } },
        h('div', { class: 'pn-hist__head' },
          h('span', { class: 'pill' }, t(`pantry.stock.type.${m.type}`)),
          h('span', { class: 'pn-hist__numbers' }, numbers)),
        h('div', { class: 'pn-hist__meta' },
          h('span', null, when(m.at)), h('span', { dir: 'auto' }, t('pantry.history.by', { name: nameOf(m.actorUid) })),
          m.dimension ? h('span', null, t(`pantry.dim.${m.dimension}`)) : null),
        m.note ? h('p', { class: 'pn-hist__note', dir: 'auto' }, m.note) : null);
    }));
  }).catch((err) => { if (open) status.replaceChildren(h('div', { id: 'pn-hist-error' }, banner('error', msg(err)))); });
  return dlg;
}
