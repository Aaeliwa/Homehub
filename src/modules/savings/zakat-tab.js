/**
 * Zakat al-Mal tab. An ESTIMATE based on the owner's SELECTED methodology — never a ruling.
 * Per owner: me, or a child I am an explicit guardian of. Everything shown is derived from
 * the owner's own (or explicitly allocated) assets; nobody else's private wealth is included.
 */
import { h } from '../../core/utils/dom.js';
import { t, formatNumber } from '../../core/i18n/i18n.js';
import { toast } from '../../ui/components/toast.js';
import { field, select, amountInput } from '../expenses/finance-ui.js';
import { formDialog, val, vmsg } from '../expenses/dialogs.js';
import { formatDateLong } from '../expenses/calendar.js';
import { minorToPlain } from '../expenses/money.js';
import { formatHijri } from './hijri.js';
import { money, grams, purityLabel, quoteTime } from './savings-ui.js';
import { parseGrams, mgToPlain, parseMinor } from './quantity.js';
import { percentToBps } from './savings-model.js';
import { NISAB_BASES, HAWL_CALENDARS, BELOW_POLICIES } from './zakat-engine.js';
import { zakatReaders } from './zakat-ledger.js';

const pct = (bps) => `${formatNumber(bps / 100)}%`;

function openSettings(env, ownerUid, readers) {
  const { store, ctx, home } = env;
  const p = store.profileFor(ownerUid);
  const basis = field(t('zakat.settings.basis'), select('zk-basis', NISAB_BASES.map((b) => ({ value: b, label: t(`zakat.basis.${b}`) })), p.nisabBasis), { id: 'zk-basis' });
  const goldG = field(t('zakat.settings.goldGrams'), h('input', { id: 'zk-gold', class: 'input', inputmode: 'decimal', dir: 'ltr', value: mgToPlain(p.goldMg) }), { id: 'zk-gold' });
  const goldK = field(t('zakat.settings.goldPurity'), select('zk-goldk', ['24', '22', '21', '18'].map((k) => ({ value: k, label: purityLabel('gold', k) })), p.goldPurity), { id: 'zk-goldk' });
  const silverG = field(t('zakat.settings.silverGrams'), h('input', { id: 'zk-silver', class: 'input', inputmode: 'decimal', dir: 'ltr', value: mgToPlain(p.silverMg) }), { id: 'zk-silver' });
  const manual = field(t('zakat.settings.manual', { currency: home.currency }), amountInput('zk-manual', p.manualNisabMinor ? minorToPlain(p.manualNisabMinor) : ''), { id: 'zk-manual' });
  const rate = field(t('zakat.settings.rate'), h('input', { id: 'zk-rate', class: 'input', inputmode: 'decimal', dir: 'ltr', value: String(p.rateBps / 100) }), { id: 'zk-rate' });
  const cal = field(t('zakat.settings.calendar'), select('zk-cal', HAWL_CALENDARS.map((c) => ({ value: c, label: t(`zakat.calendar.${c}`) })), p.hawlCalendar), { id: 'zk-cal' });
  const pol = field(t('zakat.settings.below'), select('zk-pol', BELOW_POLICIES.map((c) => ({ value: c, label: t(`zakat.below.${c}`) })), p.belowNisabPolicy), { id: 'zk-pol' });
  const note = field(t('zakat.settings.note'), h('input', { id: 'zk-note', class: 'input', maxlength: 200, dir: 'auto', value: p.methodologyNote || '' }), { id: 'zk-note', hint: t('zakat.settings.noteHint') });
  const sync = () => { const b = basis.root.querySelector('select').value; goldG.root.hidden = goldK.root.hidden = b !== 'gold'; silverG.root.hidden = b !== 'silver'; manual.root.hidden = b !== 'manual'; };
  const dlg = formDialog({ title: t('zakat.settings.title'), id: 'zakat-settings-form', submitLabel: t('common.save'), container: ctx.savingsRoot,
    fields: [h('p', { class: 'fin-callout' }, t('zakat.settings.explain')), h('div', { class: 'form-grid form-grid--tight' }, basis.root, goldG.root, goldK.root, silverG.root, manual.root, rate.root, cal.root, pol.root), note.root],
    onSubmit: async () => {
      const r = basis.root.closest('form');
      const settings = { nisabBasis: val(r, '#zk-basis'), goldMg: parseGrams(val(r, '#zk-gold')).value, goldPurity: val(r, '#zk-goldk'),
        silverMg: parseGrams(val(r, '#zk-silver')).value, silverPurity: '999',
        manualNisabMinor: parseMinor(val(r, '#zk-manual')).value ?? null,  // exact integer parse — no float
        rateBps: percentToBps(val(r, '#zk-rate')), hawlCalendar: val(r, '#zk-cal'), belowNisabPolicy: val(r, '#zk-pol'), methodologyNote: val(r, '#zk-note') || null };
      await store.saveProfile(ownerUid, settings, { readers });
      return 'zakat.toast.settingsSaved';
    } });
  basis.root.querySelector('select').addEventListener('change', sync); sync();
  return dlg;
}

function openPayment(env, ownerUid, readers, amountMinor, assessment, wallets) {
  const { store, ctx, today } = env;
  const amt = field(t('finance.field.amount'), amountInput('zp-amount', amountMinor ? minorToPlain(amountMinor) : ''), { id: 'zp-amount' });
  const date = field(t('zakat.payment.date'), h('input', { id: 'zp-date', type: 'date', class: 'input', value: today }), { id: 'zp-date' });
  const note = field(t('finance.field.note'), h('input', { id: 'zp-note', class: 'input', maxlength: 200, dir: 'auto' }), { id: 'zp-note' });
  const link = h('input', { type: 'checkbox', id: 'zp-link' });
  const wallet = field(t('finance.field.wallet'), select('zp-wallet', [{ value: '', label: t('finance.wallet.none') }, ...wallets.map((w) => ({ value: w.id, label: w.name }))], ''), { id: 'zp-wallet' });
  wallet.root.hidden = true;
  link.addEventListener('change', () => { wallet.root.hidden = !link.checked; });
  return formDialog({ title: t('zakat.payment.title'), id: 'zakat-payment-form', submitLabel: t('zakat.payment.record'), container: ctx.savingsRoot,
    fields: [h('p', { class: 'fin-callout', id: 'zp-link-info' }, assessment && assessment.due
      ? t('zakat.payment.linkedTo', { start: assessment.due.start, end: assessment.due.end })
      : t('zakat.payment.unlinkedNote')),
      h('div', { class: 'form-grid form-grid--tight' }, amt.root, date.root), note.root,
      h('label', { class: 'fin-check' }, link, h('span', null, t('zakat.payment.linkExpense'))), wallet.root, h('p', { class: 'field__hint' }, t('zakat.payment.linkHint'))],
    onSubmit: async () => {
      const r = amt.root.closest('form'); const wId = val(r, '#zp-wallet');
      const args = { amount: val(r, '#zp-amount'), date: val(r, '#zp-date'), note: val(r, '#zp-note'), readers,
        linkExpense: link.checked, wallet: wId ? wallets.find((w) => w.id === wId) : null };
      // Phase 5.2: a payment for a COMPLETED Hawl is linked to that Hawl's calculation; otherwise it is
      // recorded as an unlinked (advance) payment and shown separately in the ledger.
      if (assessment && assessment.due) await store.payHawl(ownerUid, assessment, args);
      else await store.recordPayment(ownerUid, { ...args, snapshotId: null });
      return 'zakat.toast.paymentRecorded';
    } });
}

export function renderZakatTab(env) {
  const { store, today, locale, identity, children, can, home, wallets, zakatOwner, setZakatOwner } = env;
  const owners = [{ uid: identity.uid, name: t('settings.you') }, ...children.map((c) => ({ uid: c.uid, name: c.displayName, guardians: c.guardianUids }))];
  // Phase 5.2: people who explicitly SHARED their Zakat with me (read-only; saved records only).
  const sharedOwners = [...new Set(store.getSnapshot().zakat.map((r) => r.ownerUid))]
    .filter((u) => u !== identity.uid && !owners.some((o) => o.uid === u))
    .map((u) => ({ uid: u, name: env.directory ? env.directory.nameOf(u, t('family.formerMember')) : t('family.formerMember'), sharedWithMe: true }));
  owners.push(...sharedOwners);
  const owner = owners.find((o) => o.uid === zakatOwner) || owners[0];
  if (owner.sharedWithMe) return sharedZakatView(env, owners, owner, setZakatOwner);
  const current = store.zakatReadersOf(owner.uid) || zakatReaders({ ownerUid: owner.uid, guardianUids: owner.guardians || [] });
  const readers = [...new Set([...current, identity.uid])].sort().slice(0, 6);
  const canAct = can('savings.zakat');
  const a = store.zakatFor(owner.uid, today);
  const date2 = (d) => (d ? h('span', null, formatDateLong(d, locale), h('span', { class: 'hijri' }, ` · ${formatHijri(d, locale)}`)) : '—');
  const n = a.nisab;
  const statusText = {
    unknown: t('zakat.status.unknown'), belowNisab: t('zakat.status.below'),
    inProgress: t('zakat.status.inProgress', { days: formatNumber(a.daysElapsed), total: formatNumber(a.daysTotal) }),
    complete: t('zakat.status.complete'),
  }[a.status];
  const lines = (ls) => h('table', { class: 'zk-table' },
    h('thead', null, h('tr', null, h('th', null, t('savings.field.name')), h('th', null, t('zakat.share')), h('th', null, t('zakat.value')))),
    h('tbody', null, ls.map((l) => h('tr', null, h('td', { dir: 'auto' }, l.asset ? l.asset.name : l.name), h('td', null, pct(l.bps)), h('td', { class: 'num', dir: 'ltr' }, money(l.shareMinor, home.currency))))));
  const due = a.due;
  return h('div', { class: 'fin-stack zakat' },
    h('div', { class: 'fin-intro' },
      owners.length > 1 ? h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, t('zakat.owner')),
        h('select', { id: 'zk-owner', class: 'input input--sm', onChange: (e) => setZakatOwner(e.target.value) }, owners.map((o) => h('option', { value: o.uid, selected: o.uid === owner.uid }, o.sharedWithMe ? t('zakat.share.sharedBy', { name: o.name }) : o.name)))) : h('p', null, t('zakat.intro')),
      canAct ? h('button', { type: 'button', class: 'btn btn--secondary', id: 'zk-settings', onClick: () => openSettings(env, owner.uid, readers) }, t('zakat.settings.open')) : null),
    h('section', { class: ['card', 'zk-status', `zk-status--${a.status}`], id: 'zk-status', dataset: { status: a.status } },
      h('p', { class: 'zk-status__label' }, t('zakat.estimateFor', { name: owner.name })),
      h('p', { class: 'zk-status__text' }, statusText),
      a.hawlStart ? h('dl', { class: 'facts' },
        h('div', null, h('dt', null, t('zakat.hawlStart')), h('dd', { id: 'zk-hawl-start' }, date2(a.hawlStart))),
        h('div', null, h('dt', null, t('zakat.hawlEnd')), h('dd', { id: 'zk-hawl-end' }, date2(a.hawlEnd)))) : null,
      a.historyIncomplete ? h('p', { class: 'field__hint' }, t('zakat.historyIncomplete')) : null),
    h('section', { class: 'card fin-card', id: 'zk-nisab' },
      h('h2', { class: 'card__title' }, t('zakat.nisab')),
      h('dl', { class: 'facts' },
        h('div', null, h('dt', null, t('zakat.basis')), h('dd', null, t(`zakat.basis.${n.basis}`))),
        n.basis !== 'manual' ? h('div', null, h('dt', null, t('zakat.weight')), h('dd', null, `${grams(n.mg)} · ${purityLabel(n.basis, n.purity)}`)) : null,
        n.quote ? h('div', null, h('dt', null, t('zakat.priceUsed')), h('dd', null, `${money(n.quote.priceMinor, home.currency)}/g · ${t(n.quote.derived ? 'savings.fresh.derived' : n.quote.source === 'manual' ? 'savings.fresh.manual' : 'savings.fresh.current')} · ${quoteTime(n.quote, locale)}`)) : null,
        h('div', null, h('dt', null, t('zakat.threshold')), h('dd', { id: 'zk-nisab-value', dir: 'ltr' }, n.valueMinor === null ? t('zakat.noPrice') : money(n.valueMinor, home.currency))))),
    h('section', { class: 'card fin-card', id: 'zk-breakdown' },
      h('h2', { class: 'card__title' }, t('zakat.breakdown')),
      (due ? due.lines : a.breakdown).length ? lines(due ? due.lines : a.breakdown) : h('p', { class: 'empty' }, t('zakat.noAssets')),
      h('div', { class: 'zk-calc', dir: 'ltr' },
        h('span', null, t('zakat.qualifying')), h('span', { class: 'num', id: 'zk-qualifying' }, money(due ? due.zakatableMinor : a.zakatableMinor, home.currency)),
        h('span', null, t('zakat.rate')), h('span', { class: 'num' }, pct(a.rateBps)),
        h('span', null, t('zakat.estimate')), h('span', { class: 'num zk-calc__total', id: 'zk-estimate' }, money(due ? due.estimateMinor : a.estimateMinor, home.currency))),
      a.unvalued.length ? h('p', { class: 'field__hint' }, t('zakat.unvalued', { names: a.unvalued.map((x) => x.name).join('، ') })) : null,
      a.excluded.length ? h('div', { id: 'zk-excluded' }, h('h3', { class: 'field__label' }, t('zakat.excluded')),
        h('ul', { class: 'fin-list' }, a.excluded.map((x) => h('li', { class: 'fin-row' }, h('span', { class: 'fin-row__main', dir: 'auto' }, x.asset.name), h('span', { class: 'fin-row__sub' }, t(`zakat.reason.${x.reason}`)))))) : null,
      canAct ? h('div', { class: 'fin-actions' },
        h('button', { type: 'button', class: 'btn btn--secondary', id: 'zk-snapshot', onClick: async () => { try { await store.recordSnapshot(owner.uid, a, { date: today, readers }); toast(t('zakat.toast.snapshot'), { tone: 'success' }); } catch (e) { toast(vmsg(e), { tone: 'error' }); } } }, t('zakat.saveCalculation')),
        h('button', { type: 'button', class: 'btn btn--primary', id: 'zk-pay', onClick: () => openPayment(env, owner.uid, readers, due ? due.estimateMinor : a.estimateMinor, a, wallets) }, t('zakat.payment.record'))) : null),
    zakatLedgerSection(env, owner),
    canAct ? zakatSharingSection(env, owner, current) : null,
    h('section', { class: 'card fin-card', id: 'zk-history' },
      h('h2', { class: 'card__title' }, t('zakat.history')),
      (() => {
        const items = [...store.payments(owner.uid).map((p) => ({ ...p, _k: 'payment' })), ...store.snapshots(owner.uid).map((s) => ({ ...s, _k: 'snapshot' }))].sort((x, y) => (x.date < y.date ? 1 : -1));
        return items.length ? h('ul', { class: 'fin-list' }, items.map((r) => h('li', { class: 'fin-row', dataset: { kind: r._k } },
          h('span', { class: 'fin-row__date' }, formatDateLong(r.date, locale)),
          h('span', { class: 'fin-row__main' }, r._k === 'payment' ? t('zakat.paid') + (r.linkedExpenseId ? ` · ${t('zakat.linkedExpense')}` : '') : t('zakat.calculation', { start: r.hawlStart || '—', end: r.hawlEnd || '—' })),
          h('span', { class: 'fin-row__amount', dir: 'ltr' }, money(r._k === 'payment' ? r.amountMinor : r.estimateMinor, home.currency))))) : h('p', { class: 'empty' }, t('zakat.noHistory'));
      })()),
    h('p', { class: 'zk-disclaimer' }, t('zakat.disclaimer')));
}

/** Phase 5.2: estimated liability vs recorded payments vs outstanding — kept visibly separate. */
function zakatLedgerSection(env, owner) {
  const { store, home, locale } = env;
  const l = store.ledger(owner.uid);
  const m = (v) => money(v, home.currency);
  return h('section', { class: 'card fin-card', id: 'zk-ledger' },
    h('h2', { class: 'card__title' }, t('zakat.ledger.title')),
    h('p', { class: 'field__hint' }, t('zakat.ledger.explain')),
    l.rows.length ? h('table', { class: 'zk-table' },
      h('thead', null, h('tr', null, h('th', null, t('zakat.ledger.hawl')), h('th', null, t('zakat.ledger.estimated')), h('th', null, t('zakat.ledger.paid')), h('th', null, t('zakat.ledger.outstanding')))),
      h('tbody', null, l.rows.map((r) => h('tr', { dataset: { snapshot: r.snapshot.id } },
        h('td', null, `${r.snapshot.hawlStart ? formatDateLong(r.snapshot.hawlStart, locale) : '—'} → ${r.snapshot.hawlEnd ? formatDateLong(r.snapshot.hawlEnd, locale) : formatDateLong(r.snapshot.date, locale)}`),
        h('td', { class: 'num', dir: 'ltr' }, m(r.estimateMinor)),
        h('td', { class: 'num', dir: 'ltr' }, m(r.paidMinor)),
        h('td', { class: 'num', dir: 'ltr' }, r.overpaidMinor ? t('zakat.ledger.overpaid', { amount: m(r.overpaidMinor) }) : m(r.outstandingMinor))))),
      h('tfoot', null, h('tr', null, h('th', null, t('zakat.ledger.totals')),
        h('th', { class: 'num', dir: 'ltr' }, m(l.totals.estimateMinor)), h('th', { class: 'num', dir: 'ltr' }, m(l.totals.paidLinkedMinor)),
        h('th', { class: 'num', dir: 'ltr', id: 'zk-outstanding' }, m(l.totals.outstandingMinor)))))
      : h('p', { class: 'empty' }, t('zakat.ledger.none')),
    l.unlinked.length ? h('p', { class: 'field__hint', id: 'zk-unlinked' }, t('zakat.ledger.unlinked', { n: l.unlinked.length, amount: m(l.totals.unlinkedMinor) })) : null);
}

/** Phase 5.2: explicit sharing (private by default; revocable). Guardians of a child stay readers. */
function zakatSharingSection(env, owner, current) {
  const { store, ctx, members, identity } = env;
  const guardians = owner.guardians || [];
  const candidates = (members || []).filter((m) => m.uid !== owner.uid && !guardians.includes(m.uid));
  const shared = current.filter((u) => u !== owner.uid && !guardians.includes(u));
  const box = h('fieldset', { class: 'fin-members', id: 'zk-share' }, h('legend', { class: 'field__label' }, t('zakat.share.who')),
    candidates.length ? candidates.map((m) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', name: 'zk-share', value: m.uid, checked: shared.includes(m.uid) }), h('span', null, m.displayName)))
      : h('p', { class: 'field__hint' }, t('finance.wallet.noMembers')));
  const save = h('button', { type: 'button', class: 'btn btn--secondary', id: 'zk-share-save', onClick: async () => {
    const picked = [...ctx.savingsRoot.querySelectorAll('input[name="zk-share"]:checked')].map((x) => x.value);
    try {
      const readers = zakatReaders({ ownerUid: owner.uid, guardianUids: guardians, sharedWith: picked });
      if (!readers.includes(identity.uid)) readers.push(identity.uid);
      await store.setZakatSharing(owner.uid, [...new Set(readers)].sort());
      toast(t(picked.length ? 'zakat.toast.shared' : 'zakat.toast.private'), { tone: 'success' });
    } catch (e) { toast(vmsg(e), { tone: 'error' }); }
  } }, t('zakat.share.save'));
  return h('section', { class: 'card fin-card' },
    h('h2', { class: 'card__title' }, t('zakat.share.title')),
    h('p', { class: 'field__hint', id: 'zk-share-state' }, shared.length ? t('zakat.share.sharedN', { n: shared.length }) : t('zakat.share.private')),
    h('p', { class: 'field__hint' }, t('zakat.share.explain')),
    box, candidates.length ? save : null);
}

/**
 * Phase 5.2: read-only view of Zakat records someone explicitly shared with me. Only their SAVED
 * records (calculations, payments, ledger) — never a live estimate, because a live calculation
 * would be built from the assets *I* can read, not theirs, and would be misleading.
 */
function sharedZakatView(env, owners, owner, setZakatOwner) {
  const { store, locale, home } = env;
  return h('div', { class: 'fin-stack zakat' },
    h('div', { class: 'fin-intro' },
      h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, t('zakat.owner')),
        h('select', { id: 'zk-owner', class: 'input input--sm', onChange: (e) => setZakatOwner(e.target.value) }, owners.map((o) => h('option', { value: o.uid, selected: o.uid === owner.uid }, o.sharedWithMe ? t('zakat.share.sharedBy', { name: o.name }) : o.name))))),
    h('p', { class: 'fin-callout', id: 'zk-shared-note' }, t('zakat.share.readOnly', { name: owner.name })),
    zakatLedgerSection(env, owner),
    h('section', { class: 'card fin-card' }, h('h2', { class: 'card__title' }, t('zakat.history')),
      (() => {
        const items = [...store.payments(owner.uid).map((p) => ({ ...p, _k: 'payment' })), ...store.snapshots(owner.uid).map((x) => ({ ...x, _k: 'snapshot' }))].sort((x, y) => (x.date < y.date ? 1 : -1));
        return items.length ? h('ul', { class: 'fin-list' }, items.map((r) => h('li', { class: 'fin-row' },
          h('span', { class: 'fin-row__date' }, formatDateLong(r.date, locale)),
          h('span', { class: 'fin-row__main' }, r._k === 'payment' ? t('zakat.paid') : t('zakat.calculation', { start: r.hawlStart || '—', end: r.hawlEnd || '—' })),
          h('span', { class: 'fin-row__amount', dir: 'ltr' }, money(r._k === 'payment' ? r.amountMinor : r.estimateMinor, home.currency))))) : h('p', { class: 'empty' }, t('zakat.noHistory'));
      })()),
    h('p', { class: 'zk-disclaimer' }, t('zakat.disclaimer')));
}
