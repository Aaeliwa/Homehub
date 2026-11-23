/**
 * Pantry page (#/m/inventory) — V6.5 Phase 01: the shared, bilingual PRODUCT CATALOG.
 * Module page contract: mount(outlet, ctx) -> unmount.
 *
 * Phase 01 deliberately has NO stock operations: every product shows "stock tracking not enabled yet" instead of
 * a number, and nothing here writes stock fields. Reads come from the scope-bound inventory store (one bounded
 * listener, disposed on Home switch / sign-out); writes go store → repository → shared data layer and are
 * re-checked by the Firestore rules.
 */
import { h } from '../../core/utils/dom.js';
import { t, tp, getLanguage, formatNumber } from '../../core/i18n/i18n.js';
import { icon } from '../../ui/components/icons.js';
import { banner, errorText, setBusy } from '../../ui/components/common.js';
import { openDialog, confirmDialog } from '../../ui/components/dialog.js';
import { toast } from '../../ui/components/toast.js';
import { getInventoryStore } from './inventory-service.js';
import { CATEGORIES, LOCATIONS, LIMITS, matches, displayName, otherName, sortProducts, similarProducts, minText, validateProduct } from './product-model.js';
import { unitsFor, DIMENSIONS } from './units.js';

const msg = (err) => (err && err.detail && /^pantry\./.test(String(err.detail)) ? t(String(err.detail)) : errorText(err));

export function mount(outlet, ctx) {
  const { permissions } = ctx.getState();
  const can = { create: permissions.can('inventory.create'), edit: permissions.can('inventory.edit'), archive: permissions.can('inventory.delete') };
  let store;
  try { store = getInventoryStore(ctx); } catch (err) {
    outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(err))));
    return () => {};
  }
  const lang = () => (getLanguage() === 'ar' ? 'ar' : 'en');
  let q = ''; let cat = 'all'; let loc = 'all'; let view = 'active'; let archived = null;   // archived: null = not loaded

  const root = h('div', { class: 'page page--pantry accent-teal', id: 'pn-page' });
  const subtitle = h('p', { class: 'page-head__sub', id: 'pn-sub' });
  const status = h('div', { 'aria-live': 'polite', id: 'pn-status' });
  const list = h('ul', { class: 'pn-list', id: 'pn-list', 'aria-label': t('module.inventory.name') });
  const empty = h('div', { id: 'pn-empty-slot' });
  const search = h('input', { type: 'search', class: 'input pn-search', id: 'pn-search', placeholder: t('pantry.search'), 'aria-label': t('pantry.search'),
    autocomplete: 'off', onInput: (e) => { q = e.target.value; paint(); } });
  const sel = (id, label, options, onChange) => h('select', { class: 'input pn-filter', id, 'aria-label': label, onChange: (e) => { onChange(e.target.value); paint(); } },
    options.map((o) => h('option', { value: o.value }, o.label)));
  const catSel = sel('pn-cat', t('pantry.category'), [{ value: 'all', label: t('pantry.allCategories') }, ...CATEGORIES.map((c) => ({ value: c, label: t(`pantry.cat.${c}`) }))], (v) => { cat = v; });
  const locSel = sel('pn-loc', t('pantry.location'), [{ value: 'all', label: t('pantry.allLocations') }, ...LOCATIONS.map((l) => ({ value: l, label: t(`pantry.loc.${l}`) }))], (v) => { loc = v; });
  const tabs = h('div', { class: 'view-switch', role: 'group', 'aria-label': t('pantry.viewLabel'), id: 'pn-tabs' });

  root.append(
    h('header', { class: 'page-head page-head--row' },
      h('div', null, h('h1', { class: 'page-head__title' }, t('module.inventory.name')), subtitle),
      can.create ? h('button', { type: 'button', class: 'btn btn--primary', id: 'pn-new', onClick: () => openForm() }, icon('plus', { size: 18 }), t('pantry.add')) : null),
    h('p', { class: 'banner banner--info pn-notice', id: 'pn-notice', role: 'note' }, t('pantry.stockNotYet')),
    h('div', { class: 'pn-tools' }, search, h('div', { class: 'pn-filters' }, catSel, locSel)),
    tabs, status, list, empty);
  outlet.replaceChildren(root);

  // ------------------------------------------------------------------------------------------------ rows
  function modeText(p) {
    if (p.trackMode === 'presence') return t('pantry.mode.presence');
    return t('pantry.mode.quantityIn', { unit: t(`pantry.unit.${p.displayUnit}`) });
  }
  function row(p, isArchived) {
    const L = lang(); const other = otherName(p, L); const min = minText(p);
    const tools = [];
    if (!isArchived && can.edit) tools.push(h('button', { type: 'button', class: 'icon-btn', 'data-action': 'edit', 'aria-label': t('pantry.editX', { name: displayName(p, L) }), title: t('pantry.edit'), onClick: () => openForm(p) }, icon('edit', { size: 18 })));
    if (!isArchived && can.archive) tools.push(h('button', { type: 'button', class: 'icon-btn', 'data-action': 'archive', 'aria-label': t('pantry.archiveX', { name: displayName(p, L) }), title: t('pantry.archive'), onClick: () => archive(p) }, icon('archive', { size: 18 })));
    if (isArchived && can.archive) tools.push(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-action': 'restore', onClick: () => restore(p) }, icon('restore', { size: 16 }), t('pantry.restore')));
    return h('li', { class: ['pn-item', isArchived && 'pn-item--archived'], dataset: { id: p.id } },
      h('div', { class: 'pn-item__main' },
        h('span', { class: 'pn-item__name', dir: 'auto' }, displayName(p, L)),
        other ? h('span', { class: 'pn-item__alt', dir: 'auto' }, other) : null,
        h('span', { class: 'pn-item__meta' },
          h('span', { class: 'pill' }, t(`pantry.cat.${p.category}`)), h('span', { class: 'pill' }, t(`pantry.loc.${p.location}`)),
          h('span', { class: 'pn-item__mode' }, modeText(p)),
          min ? h('span', { class: 'pn-item__min' }, t('pantry.lowBelow', { qty: min, unit: t(`pantry.unit.${p.displayUnit}`) })) : null),
        h('span', { class: 'pn-item__stock', title: t('pantry.stockNotYet') }, t('pantry.stockOff'))),
      tools.length ? h('div', { class: 'pn-item__tools' }, tools) : null);
  }
  function filtered(items) {
    return sortProducts(items.filter((p) => (cat === 'all' || p.category === cat) && (loc === 'all' || p.location === loc) && matches(p, q)), lang());
  }
  function tabButton(id, label) {
    return h('button', { type: 'button', class: 'view-switch__btn', id: `pn-tab-${id}`, 'aria-pressed': String(view === id),
      onClick: async () => { view = id; if (id === 'archived') await loadArchived(); paint(); } }, label);
  }
  async function loadArchived() {
    try { archived = await store.listArchived(); } catch (err) { archived = { items: [], truncated: false, error: err }; }
  }

  function paint() {
    const snap = store.getSnapshot();
    subtitle.textContent = snap.status === 'ready' ? tp('pantry.count', snap.products.length) : '';
    tabs.replaceChildren(...(can.archive ? [tabButton('active', t('pantry.tabActive')), tabButton('archived', t('pantry.tabArchived'))] : []));
    const notes = [];
    if (snap.status === 'error') notes.push(h('div', { id: 'pn-error' }, banner('error', errorText(snap.error))));
    else if (snap.status === 'loading') notes.push(h('div', { class: 'spinner', role: 'progressbar', id: 'pn-loading', 'aria-label': t('common.loading') }));
    if (snap.status === 'ready' && snap.truncated && view === 'active') notes.push(h('div', { id: 'pn-trunc' }, banner('error', t('pantry.truncated', { n: formatNumber(LIMITS.maxProducts) }))));
    if (view === 'archived' && archived && archived.error) notes.push(banner('error', msg(archived.error)));
    if (view === 'archived' && archived && archived.truncated) notes.push(h('div', { id: 'pn-arch-trunc' }, banner('error', t('pantry.archivedTruncated', { n: formatNumber(LIMITS.archivedList) }))));
    status.replaceChildren(...notes);
    if (newBtn()) newBtn().disabled = snap.status === 'ready' && snap.atLimit;
    const source = view === 'archived' ? (archived ? archived.items : []) : snap.products;
    const items = snap.status === 'ready' ? filtered(source) : [];
    list.replaceChildren(...items.map((p) => row(p, view === 'archived')));
    list.hidden = !items.length;
    let e = '';
    if (snap.status === 'ready' && !items.length) {
      if (view === 'archived') e = h('p', { class: 'empty', id: 'pn-empty' }, t('pantry.archivedEmpty'));
      else if (source.length) e = h('p', { class: 'empty', id: 'pn-nomatch' }, t('pantry.noMatch'));
      else e = h('section', { class: 'card empty-state', id: 'pn-empty' },
        h('span', { class: 'empty-state__mark', 'aria-hidden': 'true' }, '📦'),
        h('h2', { class: 'empty-state__title' }, t('pantry.emptyTitle')),
        h('p', { class: 'empty-state__body' }, can.create ? t('pantry.emptyBody') : t('pantry.emptyBodyReadOnly')));
    }
    empty.replaceChildren(e);
  }
  const newBtn = () => root.querySelector('#pn-new');

  // ------------------------------------------------------------------------------------------------ actions
  async function archive(p) {
    const ok = await confirmDialog({ title: t('pantry.archiveTitle'), message: t('pantry.archiveBody', { name: displayName(p, lang()) }), confirmLabel: t('pantry.archive'), container: root });
    if (!ok) return;
    try { await store.archiveProduct(p.id); toast(t('pantry.toast.archived'), { tone: 'success' }); }
    catch (err) { toast(msg(err), { tone: 'error', timeout: 5000 }); }
  }
  async function restore(p) {
    try { await store.restoreProduct(p.id); toast(t('pantry.toast.restored'), { tone: 'success' }); await loadArchived(); paint(); }
    catch (err) { toast(msg(err), { tone: 'error', timeout: 5000 }); }
  }

  function openForm(p = null) {
    const L = lang();
    const field = (label, control, { hint, id } = {}) => h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), control, hint ? h('p', { class: 'field__hint' }, hint) : null);
    const select = (id, options, value, attrs = {}) => h('select', { class: 'input', id, ...attrs }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
    const en = h('input', { class: 'input', id: 'pn-f-en', maxlength: LIMITS.name, dir: 'ltr', value: p ? p.nameEn || '' : '', autocomplete: 'off' });
    const ar = h('input', { class: 'input', id: 'pn-f-ar', maxlength: LIMITS.name, dir: 'rtl', lang: 'ar', value: p ? p.nameAr || '' : '', autocomplete: 'off' });
    const catF = select('pn-f-cat', CATEGORIES.map((c) => ({ value: c, label: t(`pantry.cat.${c}`) })), p ? p.category : 'other');
    const locF = select('pn-f-loc', LOCATIONS.map((l) => ({ value: l, label: t(`pantry.loc.${l}`) })), p ? p.location : 'pantry');
    const mode = select('pn-f-mode', [{ value: 'quantity', label: t('pantry.mode.quantity') }, { value: 'presence', label: t('pantry.mode.presence') }], p ? p.trackMode : 'quantity',
      { disabled: !!p, 'aria-describedby': 'pn-f-mode-hint' });
    const dimLocked = !!(p && (p.stockRev || 0) !== 0);
    const dim = select('pn-f-dim', DIMENSIONS.map((d) => ({ value: d, label: t(`pantry.dim.${d}`) })), p && p.dimension ? p.dimension : 'count', { disabled: dimLocked });
    const unit = h('select', { class: 'input', id: 'pn-f-unit' });
    const min = h('input', { class: 'input', id: 'pn-f-min', inputmode: 'decimal', dir: 'ltr', value: p ? minText(p) : '', autocomplete: 'off' });
    const aliases = h('input', { class: 'input', id: 'pn-f-aliases', dir: 'auto', value: p ? (p.aliases || []).join(', ') : '', autocomplete: 'off' });
    const note = h('textarea', { class: 'input', id: 'pn-f-note', maxlength: LIMITS.note, rows: 2, dir: 'auto' }, p ? p.note || '' : '');
    const qtyBox = h('div', { class: 'pn-form__qty', id: 'pn-f-qty' });
    const similar = h('div', { id: 'pn-f-similar', 'aria-live': 'polite' });
    const fillUnits = () => {
      const cur = unit.value || (p && p.displayUnit);
      unit.replaceChildren(...unitsFor(dim.value).map((u) => h('option', { value: u, selected: u === cur }, t(`pantry.unit.${u}`))));
    };
    const syncMode = () => { qtyBox.hidden = mode.value !== 'quantity'; };
    dim.addEventListener('change', () => { unit.value = ''; fillUnits(); });
    mode.addEventListener('change', syncMode);
    fillUnits(); syncMode();
    const input = () => ({ nameEn: en.value, nameAr: ar.value, category: catF.value, location: locF.value, trackMode: mode.value, dimension: dim.value,
      displayUnit: unit.value, minQty: min.value, aliases: aliases.value, note: note.value });
    const checkSimilar = () => {
      const { value } = validateProduct(input(), { current: p });
      const dup = similarProducts(value, store.getSnapshot().products, p ? p.id : null);
      similar.replaceChildren(dup.length ? banner('info', t('pantry.similar', { names: dup.map((x) => displayName(x, L)).join('، ') })) : '');
    };
    en.addEventListener('input', checkSimilar); ar.addEventListener('input', checkSimilar);
    qtyBox.append(
      field(t('pantry.dimension'), dim, { id: 'pn-f-dim', hint: dimLocked ? t('pantry.dimensionLocked') : null }),
      field(t('pantry.unit'), unit, { id: 'pn-f-unit' }),
      field(t('pantry.minQty'), min, { id: 'pn-f-min', hint: t('pantry.minHint') }));
    const messages = h('div', { class: 'gate__messages', id: 'pn-f-msg' });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary', form: 'pn-form' }, t('common.save'));
    const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.cancel'));
    const form = h('form', { id: 'pn-form', class: 'room-form pn-form', novalidate: true, onSubmit: async (e) => {
      e.preventDefault();
      const restoreBtn = setBusy(submit, t('common.saving'));
      try {
        if (p) { const changed = await store.updateProduct(p.id, input(), { baseRev: p.rev }); if (changed) toast(t('pantry.toast.saved'), { tone: 'success' }); }
        else { await store.createProduct(input()); toast(t('pantry.toast.created'), { tone: 'success' }); }
        dlg.close();
      } catch (err) { restoreBtn(); messages.replaceChildren(banner('error', msg(err))); }
    } },
      h('p', { class: 'field__hint' }, t('pantry.nameHint')),
      field(t('pantry.nameEn'), en, { id: 'pn-f-en' }), field(t('pantry.nameAr'), ar, { id: 'pn-f-ar' }), similar,
      h('div', { class: 'pn-form__row' }, field(t('pantry.category'), catF, { id: 'pn-f-cat' }), field(t('pantry.location'), locF, { id: 'pn-f-loc' })),
      field(t('pantry.mode'), mode, { id: 'pn-f-mode', hint: p ? t('pantry.modeLocked') : t('pantry.modeHint') }),
      qtyBox,
      field(t('pantry.aliases'), aliases, { id: 'pn-f-aliases', hint: t('pantry.aliasesHint', { n: LIMITS.aliases }) }),
      field(t('pantry.note'), note, { id: 'pn-f-note' }),
      messages);
    const dlg = openDialog({ title: p ? t('pantry.editTitle') : t('pantry.newTitle'), content: form, footer: [cancel, submit], container: root });
    en.focus();
  }

  const off = store.subscribe(() => paint());
  return () => off();
}
