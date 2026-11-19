/**
 * Historical CSV import (owner). Steps: choose file → check column mapping → PREVIEW (rows,
 * exact total, months, problems) → confirm → write in batches. Re-running skips ids already
 * present, so it can never duplicate. Nothing is written before the confirmation.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { openDialog } from '../../ui/components/dialog.js';
import { banner, errorText, setBusy } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import { parseCsv, guessMapping, buildImportPlan, withoutExisting } from './import-model.js';
import { money } from './finance-ui.js';
import { formatMonth } from './calendar.js';

export function openImport(env) {
  const { store, home, identity, ctx, locale } = env;
  let table = null; let plan = null;
  const body = h('div', { class: 'fin-import' });
  const go = h('button', { type: 'button', class: 'btn btn--primary', disabled: true }, t('finance.import.write'));
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.cancel'));
  const file = h('input', { type: 'file', id: 'imp-file', accept: '.csv,text/csv', class: 'input', onChange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    table = parseCsv(await f.text());
    if (table.length < 2) { body.replaceChildren(banner('error', t('finance.import.empty'))); return; }
    renderMapping(guessMapping(table[0]));
  } });

  function renderMapping(mapping) {
    const headers = table[0];
    const sel = (key, required) => h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, t(`finance.import.col.${key}`) + (required ? ' *' : '')),
      h('select', { class: 'input input--sm', id: `imp-${key}`, onChange: (e) => { mapping[key] = e.target.value === '' ? null : Number(e.target.value); preview(mapping); } },
        h('option', { value: '' }, t('finance.import.notMapped')), headers.map((hd, i) => h('option', { value: String(i), selected: mapping[key] === i }, hd || `#${i + 1}`))));
    const fmt = h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, t('finance.import.dateFormat')),
      h('select', { class: 'input input--sm', id: 'imp-datefmt', onChange: (e) => { mapping.dateFormat = e.target.value; preview(mapping); } },
        ['auto', 'ymd', 'dmy', 'mdy'].map((f) => h('option', { value: f, selected: mapping.dateFormat === f }, t(`finance.import.fmt.${f}`)))));
    body.replaceChildren(h('div', { class: 'toolbar__filters' }, sel('date', true), sel('amount', true), sel('category'), sel('note'), sel('payment'), sel('id'), fmt), h('div', { id: 'imp-preview' }));
    preview(mapping);
  }

  function preview(mapping) {
    const existing = store.getSnapshot().expenses.map((e) => e.id);
    plan = withoutExisting(buildImportPlan(table, mapping, { uid: identity.uid, currency: home.currency, batchId: `import-${Date.now().toString(36)}`, now: null }), existing);
    const slot = body.querySelector('#imp-preview');
    const months = Object.entries(plan.months).sort(([a], [b]) => (a < b ? 1 : -1));
    slot.replaceChildren(
      h('div', { class: 'fin-stats' },
        h('div', { class: 'fin-stat' }, h('span', { class: 'fin-stat__label' }, t('finance.import.rows')), h('span', { class: 'fin-stat__value', id: 'imp-count' }, String(plan.rows.length))),
        h('div', { class: 'fin-stat' }, h('span', { class: 'fin-stat__label' }, t('finance.import.total')), h('span', { class: 'fin-stat__value', dir: 'ltr', id: 'imp-total' }, money(plan.totalMinor, home.currency))),
        h('div', { class: 'fin-stat' }, h('span', { class: 'fin-stat__label' }, t('finance.import.skipped')), h('span', { class: 'fin-stat__value', id: 'imp-skipped' }, String(plan.alreadyImported || 0)))),
      plan.errors.length ? banner('error', t('finance.import.problems', { n: plan.errors.length, lines: plan.errors.slice(0, 8).map((e) => e.line).join(', ') })) : '',
      months.length ? h('details', { class: 'form-section' }, h('summary', { class: 'form-section__summary' }, t('finance.import.byMonth')),
        h('ul', { class: 'fin-list' }, months.map(([m, v]) => h('li', { class: 'fin-row' }, h('span', { class: 'fin-row__main' }, formatMonth(m, locale)), h('span', { class: 'fin-row__amount', dir: 'ltr' }, money(v, home.currency)))))) : '',
      h('p', { class: 'field__hint' }, t('finance.import.safety')));
    go.disabled = !plan.rows.length || plan.errors.length > 0;
  }

  go.addEventListener('click', async () => {
    if (!plan || !plan.rows.length) return;
    const restore = setBusy(go, t('finance.import.writing'));
    cancel.disabled = true;
    try {
      const now = store.nowSentinel();
      const rows = plan.rows.map((r) => ({ id: r.id, doc: { ...r.doc, createdAt: now, updatedAt: now } }));
      await store.importRows(rows, (done, total) => { go.lastChild.textContent = t('finance.import.progress', { done, total }); });
      toast(t('finance.import.done', { n: rows.length }), { tone: 'success', timeout: 6000 });
      dlg.close();
    } catch (err) { restore(); cancel.disabled = false; body.prepend(banner('error', errorText(err))); }
  });

  body.replaceChildren(h('p', { class: 'field__hint' }, t('finance.import.step1')));
  const dlg = openDialog({ title: t('finance.import.title'), content: h('div', null, h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'imp-file' }, t('finance.import.file')), file), body), footer: [cancel, go], container: ctx.financeRoot });
  return dlg;
}
