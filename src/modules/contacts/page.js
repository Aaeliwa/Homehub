/**
 * Shared Contacts (#/m/contacts) — V6.4 Batch B / C, V6.4.1 Stage A. One household directory: list (search,
 * category and favourite filters; Call / WhatsApp on each tile), details with Call / WhatsApp / Copy per
 * number, editor dialog, categories, .vcf import / export and AI JSON import / export. Management actions live
 * in "⋮" menus only (list: Import / Export .vcf, AI JSON, Categories, Deleted; details: Edit, Export, Delete).
 * Details and sub-views are in-page history entries (contacts-nav.js): Back returns exactly one step.
 * All text is rendered with textContent (h()), never as HTML. Every write goes through the store (confirmed,
 * revisioned) and is re-checked by the Firestore rules.
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { banner, errorText } from '../../ui/components/common.js';
import { confirmDialog } from '../../ui/components/dialog.js';
import { toast } from '../../ui/components/toast.js';
import { formDialog } from '../expenses/dialogs.js';
import { getContactsStore } from './contacts-service.js';
import { CONTACT_LIMITS, PHONE_LABELS, phonesOf, telUri, whatsappTarget, categoryLabel, categoryLabels, liveCategoryIds, searchMatch, sortContacts } from './contact-model.js';
import { parseVcf, exportVcf, vcfFileName, VCF_LIMITS } from './vcard.js';
import { buildPreview, planImport, allowedActions, countPreview, separateOp } from './contacts-import.js';
import { MEDIA_LIMITS, MENU_KINDS, menusOf, normalizeHttpsUrl, showsMenu, restaurantCategoryIds } from './contact-media.js';
import { avatarEl, menuSection, openImageViewer } from './media-ui.js';
import { icon } from '../../ui/components/icons.js';
import { createContactsNav, takeContactsFocus } from './contacts-nav.js';
import { getCalendarStore } from '../calendar/calendar-service.js';
import { setCalendarFocus } from '../calendar/calendar-focus.js';
import { eventForm, reminderText } from '../calendar/calendar-ui.js';
import { calendarItems, sortItems, CONTACT_HORIZON } from '../../core/upcoming/upcoming-model.js';
import { todayIn, formatDateLong } from '../expenses/calendar.js';
import { ellipsisMenu, paint, waIcon, chooseNumber } from './contacts-ui.js';
import { parseContactsJson, exportContactsJson, jsonFileName, exampleText, schemaText, aiPrompt, conflictPairs, JSON_LIMITS } from './contacts-json.js';

export function mount(outlet, ctx) {
  const state = ctx.getState(); const can = (p) => state.permissions.can(p);
  let store;
  try { store = getContactsStore(ctx); } catch (e) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(e)))); return () => {}; }
  // V6.4.1 Stage B: contact activities come from the SHARED Calendar store (household + my private events;
  // no per-contact listener). Without calendar.view there is no activity UI at all.
  let cal = null; try { cal = getCalendarStore(ctx, { optional: true }); } catch { cal = null; }
  const A = { view: !!cal, create: !!cal && can('calendar.create'), edit: !!cal && can('calendar.edit') };
  const homeToday = () => todayIn(state.home.timezone);
  const P = { create: can('contacts.create'), edit: can('contacts.edit'), del: can('contacts.delete'), imp: can('contacts.import'), exp: can('contacts.export'), cats: can('contacts.manageCategories') };
  let view = 'list'; let sel = null; let q = ''; let cat = 'all'; let favOnly = false; let imp = null; let deleted = null;
  // V6.4 C: Menu section state survives re-renders (per contact); the viewer lives outside the page body
  let menu = { id: null, open: false, previews: new Set() }; let viewer = null; let detailKey = null;
  const menuState = (id) => { if (menu.id !== id) menu = { id, open: false, previews: new Set() }; return menu; };
  // V6.4.1: in-page history (details / sub-views); the list's filters + scroll ride on the list entry
  let pendingScroll = null; let saveTimer = null; let json = null;
  const listState = () => ({ q, cat, fav: favOnly, y: Math.round(window.scrollY || 0) });
  const nav = createContactsNav({ onChange: (n, saved) => applyNav(n, saved) });
  const allowed = (v) => v === 'detail' || (v === 'import' && P.imp) || (v === 'json' && (P.imp || P.exp)) || (v === 'categories' && P.cats) || (v === 'deleted' && P.del);
  function applyNav(n, saved) {
    backPending = false;
    if (n && !allowed(n.v)) { goBack(); return; }
    if (!n) {
      if (saved) { q = saved.q; cat = saved.cat; favOnly = saved.fav; pendingScroll = saved.y; }
      view = 'list'; sel = null; if (!(imp && imp.busy)) imp = null; json = null; deleted = null;
    } else {
      view = n.v; sel = n.id || null;
      if (n.v === 'import' && !(imp && imp.kind === 'vcf')) imp = { kind: 'vcf', stage: 'pick' };
      if (n.v === 'json') { if (!json) json = { scope: 'all', picked: new Set(), text: '' }; if (!(imp && imp.kind === 'json')) imp = null; }
      if (n.v === 'deleted') deleted = null;
    }
    render();
  }
  /** list → a sub-view: ONE history entry (Back returns to this list with its filters and scroll). */
  function openView(v, id) {
    if (v === 'import') imp = { kind: 'vcf', stage: 'pick' };
    if (v === 'json') { json = { scope: 'all', picked: new Set(), text: '' }; imp = null; }
    if (v === 'deleted') deleted = null;
    nav.open(id ? { v, id } : { v }, listState());
    view = v; sel = id || null; render(); window.scrollTo(0, 0);
  }
  const openDetail = (id) => openView('detail', id);
  // ONE step back, even when several paths ask at once (e.g. Delete: the handler AND the re-render that finds
  // the contact gone) — a second history.back() before the popstate arrives would skip the list.
  let backPending = false;
  const goBack = () => { if (backPending) return; if (nav.current()) backPending = true; nav.back(); };
  const saveListSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (view === 'list') nav.replaceList(listState()); }, 400); };
  { const saved = nav.savedList(); const init = nav.current();
    if (saved && !init) { q = saved.q; cat = saved.cat; favOnly = saved.fav; pendingScroll = saved.y; }
    if (init && allowed(init.v)) { view = init.v; sel = init.id || null; if (init.v === 'import') imp = { kind: 'vcf', stage: 'pick' }; if (init.v === 'json') json = { scope: 'all', picked: new Set(), text: '' }; } }
  { const f = takeContactsFocus(state.home.id); if (f && !nav.current()) { nav.open({ v: 'detail', id: f.contactId }, listState()); view = 'detail'; sel = f.contactId; } }
  const root = h('div', { class: 'page page--contacts accent-rose', id: 'ct-page' }); const body = h('div', { class: 'ct-body', id: 'ct-body' });
  root.append(body); outlet.replaceChildren(root);
  const msg = (e) => t(e && e.detail && /^contacts\./.test(e.detail) ? e.detail : e && /permission/i.test(String(e.code)) ? 'contacts.err.denied' : 'contacts.err.save');
  const run = (fn, okKey) => async (ev) => { const b = ev && ev.currentTarget; if (b) b.disabled = true; try { const r = await fn(); if (okKey && r !== false) toast(t(okKey), { tone: 'success' }); } catch (e) { toast(msg(e), { tone: 'error' }); } finally { if (b && b.isConnected) b.disabled = false; } };
  const cats = () => store.getSnapshot().categories;
  const catById = (id) => cats().find((c) => c.id === id) || null;
  const catName = (id) => categoryLabel(catById(id), t);
  const labelText = (l) => (PHONE_LABELS.includes(l) ? t(`contacts.label.${l}`) : l);

  // ------------------------------------------------------------------ list
  function header() {
    const sn = store.getSnapshot();
    // the management actions exist ONLY in this menu, ONLY on the list, ONLY with their permissions
    const menu = view === 'list' && sn.status === 'ready' ? ellipsisMenu({ id: 'ct-more-btn', label: t('contacts.menu.manage'), items: [
      P.imp && { id: 'ct-import', label: t('contacts.import.open'), disabled: sn.truncated, title: sn.truncated ? t('contacts.import.truncated') : null, onSelect: () => openView('import') },
      P.exp && { id: 'ct-export', label: t('contacts.export.open'), onSelect: () => exportDialog() },
      (P.imp || P.exp) && { id: 'ct-json', label: t('contacts.json.open'), onSelect: () => openView('json') },
      P.cats && { id: 'ct-cats', label: t('contacts.cats.open'), onSelect: () => openView('categories') },
      P.del && { id: 'ct-deleted', label: t('contacts.deleted.open'), onSelect: () => openView('deleted') },
    ] }) : null;
    return h('header', { class: 'page-head page-head--row ct-head' },
      h('div', { class: 'ct-head__text' }, h('h1', { class: 'page-head__title' }, t('module.contacts.name')), h('p', { class: 'page-head__sub' }, t('contacts.sub'))),
      menu);
  }
  function chips(c) {
    const ids = liveCategoryIds(c, cats());
    return ids.length ? h('span', { class: 'ct-chips' }, ids.map((id) => h('span', { class: 'pill', dataset: { cat: id } }, catName(id)))) : null;
  }
  function favButton(c, extraClass = '') {
    const on = c.favorite === true;
    const label = t(on ? 'contacts.unfavorite' : 'contacts.favorite', { name: c.name });
    if (!P.edit) return on ? h('span', { class: `ct-fav is-on ${extraClass}`, 'aria-label': t('contacts.isFavorite'), role: 'img' }, '★') : null;
    return h('button', { type: 'button', class: ['ct-fav', on && 'is-on', extraClass], 'aria-pressed': String(on), 'aria-label': label, title: label, dataset: { action: 'favorite' },
      onClick: run(() => store.setFavorite(c.id, !on)) }, on ? '★' : '☆');
  }
  const callTargets = (c) => phonesOf(c).map((p) => ({ label: labelText(p.label), number: p.number, href: telUri(p.number) })).filter((x) => x.href);
  const waTargets = (c) => phonesOf(c).filter((p) => !whatsappTarget(p.number).error).map((p) => ({ label: labelText(p.label), number: p.number }));
  /** Tile action: never opens the details (stopPropagation for pointer AND keyboard activation). */
  const stop = (e) => { e.stopPropagation(); };
  function callAction(c) {
    const list = callTargets(c); if (!list.length) return null;
    const aria = list.length === 1 ? t('contacts.callX', { name: c.name, number: list[0].number }) : t('contacts.callChoose', { name: c.name });
    if (list.length === 1) return h('a', { class: 'ct-act ct-act--call', href: list[0].href, 'aria-label': aria, title: aria, dataset: { action: 'call' }, onClick: stop, onKeydown: stop }, icon('phone', { size: 20 }));
    return h('button', { type: 'button', class: 'ct-act ct-act--call', 'aria-label': aria, title: aria, 'aria-haspopup': 'dialog', dataset: { action: 'call' }, onKeydown: stop,
      onClick: (e) => { stop(e); chooseNumber({ title: t('contacts.chooseCall', { name: c.name }), items: list, action: 'call', container: root }); } }, icon('phone', { size: 20 }));
  }
  function waAction(c, extraClass = '') {
    const list = waTargets(c); if (!list.length) return null;
    const aria = list.length === 1 ? t('contacts.waX', { name: c.name, number: list[0].number }) : t('contacts.waChoose', { name: c.name });
    return h('button', { type: 'button', class: ['ct-act ct-act--wa', extraClass], 'aria-label': aria, title: aria, dataset: { action: 'whatsapp' }, 'aria-haspopup': list.length > 1 ? 'dialog' : null, onKeydown: stop,
      onClick: (e) => { stop(e); if (list.length === 1) openWhatsApp(list[0].number, c.name); else chooseNumber({ title: t('contacts.chooseWa', { name: c.name }), items: list, action: 'whatsapp', container: root, onPick: (x) => openWhatsApp(x.number, c.name) }); } },
      waIcon());
  }
  function card(c) {
    const first = phonesOf(c)[0];
    return h('li', { class: 'ct-card', dataset: { id: c.id },
      // a tap anywhere on the tile (outside its own buttons / links) opens the details
      onClick: (e) => { if (e.target.closest('a, button, input, select')) return; openDetail(c.id); } },
      h('button', { type: 'button', class: 'ct-card__open', 'aria-label': t('contacts.openX', { name: c.name }), onClick: () => openDetail(c.id) },
        avatarEl(c.name, c.avatarUrl),
        h('span', { class: 'ct-card__text' },
          h('span', { class: 'ct-card__name', dir: 'auto' }, c.name),
          c.organization ? h('span', { class: 'ct-card__sub', dir: 'auto' }, c.organization) : null,
          first ? h('span', { class: 'ct-card__sub ct-num', dir: 'ltr' }, first.number) : null,
          chips(c))),
      h('span', { class: 'ct-card__acts' }, callAction(c), waAction(c), favButton(c)));
  }
  /** The list's current filter (also the "current filtered subset" of the JSON export). */
  const matches = (c) => (!favOnly || c.favorite === true) && (cat === 'all' || (c.categoryIds || []).includes(cat))
    && searchMatch(c, q, liveCategoryIds(c, store.getSnapshot().categories).map(catName));
  function listView(snap) {
    const locale = getLocale();
    const search = h('input', { type: 'search', class: 'input', id: 'ct-search', value: q, placeholder: t('contacts.search'), 'aria-label': t('contacts.search'), autocomplete: 'off',
      onInput: (e) => { q = e.target.value; renderList(); saveListSoon(); } });
    const list = h('ul', { class: 'ct-list', id: 'ct-list' });
    const empty = h('p', { class: 'empty', id: 'ct-empty' });
    function renderList() {
      const now = sortContacts(store.getSnapshot().contacts.filter(matches), locale);
      list.replaceChildren(...now.map(card));
      empty.hidden = now.length > 0;
      empty.textContent = store.getSnapshot().contacts.length ? t('contacts.noMatch') : t('contacts.empty');
      const sn = store.getSnapshot();
      count.textContent = t(sn.truncated ? 'contacts.countTruncated' : 'contacts.count', { n: now.length, total: sn.contacts.length });
    }
    const count = h('p', { class: 'field__hint', id: 'ct-count', 'aria-live': 'polite' });
    const out = h('div', { class: 'ct-stack' },
      // rev 2 (B3): capacity is always visible; an incomplete (truncated) directory is never presented as complete
      snap.truncated ? h('div', { id: 'ct-truncated' }, banner('error', t('contacts.truncated', { n: snap.capacity })))
        : snap.atLimit ? h('div', { id: 'ct-atlimit' }, banner('info', t('contacts.atLimit', { n: snap.capacity }))) : null,
      h('p', { class: 'field__hint', id: 'ct-capacity' }, t(snap.truncated ? 'contacts.capacityOver' : 'contacts.capacity', { used: snap.contacts.length, cap: snap.capacity })),
      h('div', { class: 'ct-toolbar' },
        search,
        // category + Favourites always side by side (one row, also at 320 px; the select truncates)
        h('div', { class: 'ct-filters' },
          h('select', { class: 'input ct-filters__cat', id: 'ct-cat', 'aria-label': t('contacts.filterCategory'), onChange: (e) => { cat = e.target.value; renderList(); saveListSoon(); } },
            h('option', { value: 'all', selected: cat === 'all' }, t('contacts.allCategories')),
            snap.categories.map((k) => h('option', { value: k.id, selected: cat === k.id }, categoryLabel(k, t)))),
          h('button', { type: 'button', class: ['btn', 'btn--secondary', 'ct-favfilter', favOnly && 'is-on'], id: 'ct-fav-filter', 'aria-pressed': String(favOnly), 'aria-label': t('contacts.favoritesOnly'),
            onClick: (e) => { favOnly = !favOnly; e.currentTarget.setAttribute('aria-pressed', String(favOnly)); e.currentTarget.classList.toggle('is-on', favOnly); renderList(); saveListSoon(); } },
            h('span', { 'aria-hidden': 'true' }, '★'), h('span', { class: 'ct-favfilter__text' }, ` ${t('contacts.favoritesOnly')}`)))),
      upcomingPanel(),
      count,
      P.create ? h('button', { type: 'button', class: 'btn btn--primary ct-new', id: 'ct-new', disabled: snap.atLimit, title: snap.atLimit ? t('contacts.err.atLimit') : null, onClick: () => editor(null) }, `＋ ${t('contacts.new')}`) : null,
      list, empty);
    renderList();
    return out;
  }

  // ------------------------------------------------------------------ details
  function openWhatsApp(number, name) {
    const r = whatsappTarget(number);
    if (r.url) { window.open(r.url, '_blank', 'noopener,noreferrer'); return; }
    if (!r.needCountry) { toast(t('contacts.wa.invalid'), { tone: 'error' }); return; }
    // National number: ASK for the country calling code — never guess it.
    const cc = h('input', { class: 'input', id: 'ct-wa-cc', inputmode: 'numeric', maxlength: 4, placeholder: '20', autocomplete: 'off', 'aria-describedby': 'ct-wa-preview' });
    const preview = h('p', { class: 'field__hint', id: 'ct-wa-preview', dir: 'ltr', 'aria-live': 'polite' }, '');
    cc.addEventListener('input', () => { const x = whatsappTarget(number, cc.value); preview.textContent = x.digits ? `+${x.digits}` : ''; });
    formDialog({ title: t('contacts.wa.countryTitle', { name }), id: 'ct-wa-form', submitLabel: t('contacts.wa.open'), container: root,
      fields: [h('p', { class: 'field__hint' }, t('contacts.wa.countryHint', { number })), h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('contacts.wa.country')), cc), preview],
      onSubmit: async () => {
        const x = whatsappTarget(number, cc.value);
        if (!x.url) throw Object.assign(new Error('cc'), { detail: x.needCountry ? 'contacts.wa.needCountry' : 'contacts.wa.invalid' });
        window.open(x.url, '_blank', 'noopener,noreferrer');
      } });
  }
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast(t('contacts.copied'), { tone: 'success' }); } catch { toast(t('contacts.copyManual'), { tone: 'error' }); } };
  function detailView(c) {
    const phones = phonesOf(c);
    return h('section', { class: 'card fin-card ct-detail', id: 'ct-detail', dataset: { id: c.id } },
      h('div', { class: 'ct-detail__head' },
        // V6.4.1: a strong Back (≥ 44 px; the chevron flips in RTL) — one history step back to the list
        h('button', { type: 'button', class: 'btn btn--secondary ct-backbtn', id: 'ct-back', onClick: goBack }, icon('back', { size: 20 }), h('span', null, t('contacts.backToList'))),
        h('span', { class: 'ct-detail__tools' }, favButton(c, 'ct-fav--lg'),
          ellipsisMenu({ id: 'ct-detail-menu', label: t('contacts.menu.contact', { name: c.name }), items: [
            P.edit && { id: 'ct-edit', label: t('contacts.edit'), onSelect: () => editor(c) },
            P.exp && { id: 'ct-export-one', label: t('contacts.export.one'), onSelect: () => exportNow([c], c.name) },
            P.del && { id: 'ct-delete', label: t('contacts.delete'), tone: 'danger', onSelect: () => removeContact(c) },
          ] }))),
      h('div', { class: 'ct-detail__id' },
        avatarEl(c.name, c.avatarUrl, { lg: true, id: 'ct-avatar' }),
        h('div', { class: 'ct-detail__names' }, h('h2', { class: 'ct-detail__name', id: 'ct-name', dir: 'auto' }, c.name),
          c.organization ? h('p', { class: 'ct-card__sub', dir: 'auto' }, c.organization) : null, chips(c))),
      phones.length ? h('ul', { class: 'ct-phones', id: 'ct-phones' }, phones.map((p, i) => {
        const tel = telUri(p.number); const wa = whatsappTarget(p.number);
        return h('li', { class: 'ct-phone', dataset: { index: String(i) } },
          h('span', { class: 'ct-phone__text' }, h('span', { class: 'ct-phone__label' }, labelText(p.label)), h('span', { class: 'ct-num', dir: 'ltr' }, p.number)),
          h('span', { class: 'ct-phone__actions' },
            tel ? h('a', { class: 'btn btn--primary btn--sm ct-callbtn', href: tel, id: `ct-call-${i}`, 'aria-label': t('contacts.callX', { name: c.name, number: p.number }) }, icon('phone', { size: 16 }), h('span', null, t('contacts.call'))) : null,
            !wa.error ? h('button', { type: 'button', class: 'ct-act ct-act--wa ct-act--lg', id: `ct-wa-${i}`, dataset: { needCountry: String(!!wa.needCountry) },
              'aria-label': t('contacts.waX', { name: c.name, number: p.number }), title: t('contacts.waX', { name: c.name, number: p.number }), onClick: () => openWhatsApp(p.number, c.name) }, waIcon()) : null,
            h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: `ct-copy-${i}`, onClick: () => copy(p.number) }, t('contacts.copy'))));
      })) : h('p', { class: 'empty' }, t('contacts.noPhones')),
      // V6.4 C: Restaurants (by category KEY — a rename keeps it). Removing the category hides the section;
      // the menu links stay stored and reappear when Restaurants is assigned again.
      showsMenu(liveCategoryIds(c, cats()), cats()) ? menuSection(c, { state: menuState(c.id), canEdit: P.edit, onChange: () => { detailKey = null; render(); },
        openViewer: (items, k) => { viewer = openImageViewer(items, k); } }) : null,
      h('dl', { class: 'facts ct-facts' },
        c.email ? h('div', null, h('dt', null, t('contacts.f.email')), h('dd', { dir: 'ltr' }, h('a', { class: 'text-link', href: `mailto:${encodeURIComponent(c.email).replace(/%40/g, '@')}`, id: 'ct-email' }, c.email))) : null,
        c.address ? h('div', null, h('dt', null, t('contacts.f.address')), h('dd', { dir: 'auto', class: 'ct-pre' }, c.address)) : null,
        c.notes ? h('div', { class: 'ct-facts__wide' }, h('dt', null, t('contacts.f.notes')), h('dd', { dir: 'auto', class: 'ct-pre', id: 'ct-notes' }, c.notes)) : null),
      // (V6.4.1: the dialer explanation was removed; Edit / Export / Delete live in the "⋮" menu above)
      A.view ? activitySection(c) : null,
    );
  }

  // ------------------------------------------------------------------ V6.4.1 Stage B: activities
  const calEvents = () => { const k = cal && cal.getSnapshot(); return k && k.status === 'ready' ? k.events : null; };
  const whenText = (it) => [it.bucket === 'today' ? t('upcoming.today') : formatDateLong(it.startDate, getLocale()), it.time].filter(Boolean).join(' · ');
  const openInCalendar = (it) => { setCalendarFocus({ homeId: state.home.id, date: it.startDate, eventId: it.id }); ctx.navigate('/m/calendar'); };
  /** List page: upcoming activities across contacts (overdue + next 30 days). Hidden when there are none. */
  function upcomingPanel() {
    const evs = calEvents();
    const items = evs ? sortItems(calendarItems(evs.filter((e) => e.kind === 'contactActivity'), { today: homeToday(), horizonDays: CONTACT_HORIZON })) : [];
    if (!items.length) return h('section', { class: 'ct-upcoming', id: 'ct-upcoming', hidden: true });
    const MAX = 5;
    return h('section', { class: 'card ct-upcoming', id: 'ct-upcoming', 'aria-labelledby': 'ct-upcoming-title' },
      h('h2', { class: 'card__title ct-upcoming__title', id: 'ct-upcoming-title' }, t('contacts.act.upcoming')),
      h('ul', { class: 'up-list' }, items.slice(0, MAX).map((it) => {
        const c = store.contact(it.contactId);
        return h('li', { class: `up-item up-item--${it.bucket}`, dataset: { key: it.key, bucket: it.bucket } },
          h('button', { type: 'button', class: 'up-item__btn', onClick: () => (c ? openDetail(c.id) : openInCalendar(it)) },
            h('span', { class: 'up-item__title', dir: 'auto' }, it.title),
            h('span', { class: 'up-item__meta' }, [c ? c.name : t('contacts.act.removedContact'), whenText(it), it.private ? `🔒 ${t('calendar.private')}` : null].filter(Boolean).join(' · ')),
            it.bucket === 'overdue' ? h('span', { class: 'pill pill--warn' }, t('upcoming.overdue')) : null));
      })),
      items.length > MAX ? h('p', { class: 'field__hint' }, t('contacts.act.more', { n: items.length - MAX })) : null);
  }
  /** Details: this contact's activities (overdue + next 30 days) and "Add activity". */
  function activitySection(c) {
    const evs = calEvents();
    const items = evs ? sortItems(calendarItems(evs, { today: homeToday(), horizonDays: CONTACT_HORIZON, contactId: c.id })) : [];
    const mine = (it) => { const e = cal.event(it.id); return e && (e.audience === 'household' || e.createdBy === state.identity.uid); };
    return h('section', { class: 'ct-acts', id: 'ct-activities', 'aria-labelledby': 'ct-act-title' },
      h('div', { class: 'card__head' }, h('h3', { class: 'card__title', id: 'ct-act-title' }, t('contacts.act.title')),
        A.create ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'ct-act-add',
          onClick: () => eventForm({ store: cal, container: root, preset: { kind: 'contactActivity', contactId: c.id, contactName: c.name, startDate: homeToday(), status: 'planned', reminderMinutes: null } }) }, `＋ ${t('contacts.act.add')}`) : null),
      !evs ? h('p', { class: 'muted', role: 'status' }, t('common.loading'))
        : items.length ? h('ul', { class: 'up-list', id: 'ct-act-list' }, items.map((it) => h('li', { class: `up-item up-item--${it.bucket}`, dataset: { key: it.key, bucket: it.bucket, event: it.id } },
          h('span', { class: 'up-item__text' }, h('span', { class: 'up-item__title', dir: 'auto' }, it.title),
            h('span', { class: 'up-item__meta' }, [whenText(it), it.reminderMinutes !== null ? `🔔 ${reminderText(it.reminderMinutes)}` : null, it.private ? `🔒 ${t('calendar.private')}` : null].filter(Boolean).join(' · ')),
            it.bucket === 'overdue' ? h('span', { class: 'pill pill--warn' }, t('upcoming.overdue')) : null),
          h('span', { class: 'up-item__actions' },
            A.edit && mine(it) ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'done', onClick: run(() => cal.setStatus(it.id, 'done'), 'contacts.act.doneToast') }, t('calendar.markDone')) : null,
            h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'calendar', onClick: () => openInCalendar(it) }, t('contacts.act.inCalendar'))))))
          : h('p', { class: 'empty', id: 'ct-act-empty' }, t('contacts.act.none')));
  }
  const actKey = (id) => { const evs = calEvents(); return evs ? evs.filter((e) => e.contactId === id).map((e) => `${e.id}:${e.rev}`).join(',') + homeToday() : 'loading'; };
  async function removeContact(c) {
    if (!(await confirmDialog({ title: t('contacts.deleteTitle', { name: c.name }), message: t('contacts.deleteBody'), confirmLabel: t('contacts.delete'), container: root }))) return;
    try { await store.deleteContact(c.id); toast(t('contacts.deleted.done'), { tone: 'success' }); if (view === 'detail' && sel === c.id) goBack(); } catch (e) { toast(msg(e), { tone: 'error' }); }
  }

  // ------------------------------------------------------------------ editor
  function editor(c) {
    const baseRev = c ? c.rev : null;
    const rows = h('div', { class: 'ct-edit-phones', id: 'ct-f-phones' });
    const addRow = (p = { label: 'mobile', number: '' }) => {
      if (rows.children.length >= CONTACT_LIMITS.phones) { toast(t('contacts.v.tooManyPhones'), { tone: 'error' }); return; }
      const custom = !PHONE_LABELS.includes(p.label);
      const sel2 = h('select', { class: 'input input--sm', 'data-role': 'label', 'aria-label': t('contacts.f.phoneLabel') },
        PHONE_LABELS.map((l) => h('option', { value: l, selected: !custom && p.label === l }, labelText(l))), h('option', { value: '__custom', selected: custom }, t('contacts.label.custom')));
      const customInput = h('input', { class: 'input input--sm', 'data-role': 'custom', maxlength: CONTACT_LIMITS.phoneLabel, value: custom ? p.label : '', hidden: !custom, 'aria-label': t('contacts.label.custom') });
      sel2.addEventListener('change', () => { customInput.hidden = sel2.value !== '__custom'; });
      const row = h('div', { class: 'ct-edit-phone' }, sel2, customInput,
        h('input', { class: 'input', 'data-role': 'number', type: 'tel', inputmode: 'tel', dir: 'ltr', maxlength: CONTACT_LIMITS.phoneNumber, value: p.number, 'aria-label': t('contacts.f.number'), placeholder: '+20 100 000 0000' }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('contacts.removePhone'), onClick: () => row.remove() }, '✕'));
      rows.append(row);
    };
    for (const p of c ? phonesOf(c) : []) addRow(p);
    if (!rows.children.length) addRow();
    const field = (id, label, value, attrs = {}) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label),
      attrs.area ? h('textarea', { class: 'input input--area', id, maxlength: attrs.max, dir: 'auto' }, value || '') : h('input', { class: 'input', id, value: value || '', maxlength: attrs.max, dir: attrs.dir || 'auto', type: attrs.type || 'text' }));
    const catBoxes = h('fieldset', { class: 'ct-edit-cats', id: 'ct-f-cats' }, h('legend', { class: 'field__label' }, t('contacts.f.categories')),
      cats().length ? cats().map((k) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', name: 'ct-cat', value: k.id, checked: !!(c && (c.categoryIds || []).includes(k.id)) }), ` ${categoryLabel(k, t)}`))
        : h('p', { class: 'field__hint' }, t('contacts.cats.none')));
    const fav = h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', id: 'ct-f-fav', checked: !!(c && c.favorite) }), ` ${t('contacts.f.favorite')}`);
    // ---- V6.4 C picture link: preview / replace / remove; nothing is uploaded
    const avInput = h('input', { class: 'input', id: 'ct-f-avatar', type: 'url', inputmode: 'url', dir: 'ltr', maxlength: MEDIA_LIMITS.rawInput, autocomplete: 'off', spellcheck: 'false',
      value: (c && c.avatarUrl) || '', placeholder: 'https://…', 'aria-describedby': 'ct-f-avatar-msg ct-f-avatar-hint' });
    const avPreview = h('span', { class: 'ct-avatar-preview', id: 'ct-f-avatar-preview' });
    const avMsg = h('p', { class: 'field__hint', id: 'ct-f-avatar-msg', 'aria-live': 'polite' });
    const nameNow = () => (document.getElementById('ct-f-name') || {}).value || (c && c.name) || '';
    const showAvatar = () => {
      const r = normalizeHttpsUrl(avInput.value);
      avMsg.textContent = r.error ? t(r.error) : ''; avMsg.classList.toggle('ct-warn', !!r.error);
      const el = avatarEl(nameNow(), r.url || null, { lg: true });
      const img = el.querySelector('img'); if (img) img.addEventListener('error', () => { avMsg.textContent = t('contacts.f.avatarBroken'); avMsg.classList.add('ct-warn'); });
      avPreview.replaceChildren(el); avRemove.hidden = !avInput.value;
    };
    let avTimer = null;
    avInput.addEventListener('input', () => { clearTimeout(avTimer); avTimer = setTimeout(showAvatar, 600); });
    avInput.addEventListener('change', showAvatar);
    const avRemove = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ct-f-avatar-remove', hidden: !(c && c.avatarUrl), onClick: () => { avInput.value = ''; showAvatar(); avInput.focus(); } }, t('contacts.f.avatarRemove'));
    const avatarField = h('div', { class: 'field ct-edit-avatar' },
      h('label', { class: 'field__label', for: 'ct-f-avatar' }, t('contacts.f.avatar')),
      h('div', { class: 'ct-edit-avatar__row' }, avPreview, avInput, avRemove), avMsg,
      h('p', { class: 'field__hint', id: 'ct-f-avatar-hint' }, t('contacts.f.avatarHint')));
    showAvatar();
    // ---- V6.4 C menu links (Restaurants): ordered rows; hidden — but KEPT and saved unchanged — when the
    // Restaurants category is not selected
    const mRows = h('ol', { class: 'ct-edit-menus', id: 'ct-f-menu-rows' });
    const renumber = () => [...mRows.children].forEach((r, k, all) => { r.querySelector('[data-role=up]').disabled = k === 0; r.querySelector('[data-role=down]').disabled = k === all.length - 1; });
    const addMenu = (m = { kind: 'auto', label: '', url: '' }) => {
      if (mRows.children.length >= MEDIA_LIMITS.menus) { toast(t('contacts.v.tooManyMenus'), { tone: 'error' }); return; }
      const row = h('li', { class: 'ct-edit-menu' },
        h('select', { class: 'input input--sm', 'data-role': 'kind', 'aria-label': t('contacts.f.menuKind') },
          ['auto', ...MENU_KINDS].map((k) => h('option', { value: k, selected: m.kind === k }, t(`contacts.kind.${k}`)))),
        h('input', { class: 'input input--sm', 'data-role': 'label', maxlength: MEDIA_LIMITS.menuLabel, value: m.label, dir: 'auto', placeholder: t('contacts.f.menuLabel'), 'aria-label': t('contacts.f.menuLabel') }),
        h('input', { class: 'input', 'data-role': 'url', type: 'url', inputmode: 'url', dir: 'ltr', maxlength: MEDIA_LIMITS.rawInput, value: m.url, placeholder: 'https://…', 'aria-label': t('contacts.f.menuUrl'), spellcheck: 'false' }),
        h('span', { class: 'ct-edit-menu__btns' },
          h('button', { type: 'button', class: 'icon-btn', 'data-role': 'up', 'aria-label': t('contacts.menuUp'), title: t('contacts.menuUp'), onClick: (e) => { if (row.previousElementSibling) { mRows.insertBefore(row, row.previousElementSibling); renumber(); e.currentTarget.disabled ? row.querySelector('[data-role=down]').focus() : e.currentTarget.focus(); } } }, '↑'),
          h('button', { type: 'button', class: 'icon-btn', 'data-role': 'down', 'aria-label': t('contacts.menuDown'), title: t('contacts.menuDown'), onClick: (e) => { if (row.nextElementSibling) { mRows.insertBefore(row.nextElementSibling, row); renumber(); e.currentTarget.disabled ? row.querySelector('[data-role=up]').focus() : e.currentTarget.focus(); } } }, '↓'),
          h('button', { type: 'button', class: 'icon-btn', 'data-role': 'remove', 'aria-label': t('contacts.menuRemove'), title: t('contacts.menuRemove'), onClick: () => { row.remove(); renumber(); } }, '✕')));
      mRows.append(row); renumber();
    };
    for (const m of c ? menusOf(c) : []) addMenu(m);
    const restIds = restaurantCategoryIds(cats());
    const menuBox = h('fieldset', { class: 'ct-edit-menus-box', id: 'ct-f-menus' }, h('legend', { class: 'field__label' }, t('contacts.f.menus')),
      h('p', { class: 'field__hint' }, t('contacts.f.menusHint')), mRows,
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ct-add-menu', onClick: () => { addMenu(); mRows.lastElementChild.querySelector('[data-role=url]').focus(); } }, `＋ ${t('contacts.addMenu')}`));
    const kept = h('p', { class: 'field__hint', id: 'ct-f-menus-kept' });
    const syncMenus = () => {
      const on = [...catBoxes.querySelectorAll('input[name="ct-cat"]:checked')].some((x) => restIds.includes(x.value));
      menuBox.hidden = !on; const n = mRows.children.length;
      kept.hidden = on || !n; kept.textContent = n ? t('contacts.f.menusKept', { n }) : '';
    };
    catBoxes.addEventListener('change', syncMenus); syncMenus();
    formDialog({ title: t(c ? 'contacts.editTitle' : 'contacts.newTitle'), id: 'ct-form', submitLabel: t('common.save'), container: root,
      fields: [field('ct-f-name', `${t('contacts.f.name')} *`, c && c.name, { max: CONTACT_LIMITS.name }),
        h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('contacts.f.phones')), rows,
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ct-add-phone', onClick: () => addRow() }, `＋ ${t('contacts.addPhone')}`)),
        field('ct-f-org', t('contacts.f.organization'), c && c.organization, { max: CONTACT_LIMITS.organization }),
        field('ct-f-email', t('contacts.f.email'), c && c.email, { max: CONTACT_LIMITS.email, dir: 'ltr', type: 'email' }),
        field('ct-f-address', t('contacts.f.address'), c && c.address, { max: CONTACT_LIMITS.address, area: true }),
        field('ct-f-notes', t('contacts.f.notes'), c && c.notes, { max: CONTACT_LIMITS.notes, area: true }),
        avatarField, catBoxes, menuBox, kept, fav],
      onSubmit: async () => {
        const form = document.getElementById('ct-form');
        const input = {
          name: form.querySelector('#ct-f-name').value, organization: form.querySelector('#ct-f-org').value, email: form.querySelector('#ct-f-email').value,
          address: form.querySelector('#ct-f-address').value, notes: form.querySelector('#ct-f-notes').value, favorite: form.querySelector('#ct-f-fav').checked,
          categoryIds: [...form.querySelectorAll('input[name="ct-cat"]:checked')].map((x) => x.value),
          phones: [...form.querySelectorAll('.ct-edit-phone')].map((r) => { const l = r.querySelector('[data-role=label]').value; return { label: l === '__custom' ? r.querySelector('[data-role=custom]').value : l, number: r.querySelector('[data-role=number]').value }; }),
          // V6.4 C: always sent from the editor (hidden menu rows included, so they are never dropped)
          avatarUrl: avInput.value.trim() || null,
          menus: [...form.querySelectorAll('.ct-edit-menu')].map((r) => ({ kind: r.querySelector('[data-role=kind]').value, label: r.querySelector('[data-role=label]').value, url: r.querySelector('[data-role=url]').value })),
        };
        if (c) { const changed = await store.updateContact(c.id, input, { baseRev }); return changed ? 'contacts.saved' : undefined; }
        const id = await store.createContact(input); openDetail(id);
        return 'contacts.created';
      } });
  }

  // ------------------------------------------------------------------ export
  function download(text, name, type = 'text/vcard;charset=utf-8') {
    const blob = new Blob([text], { type });
    const a = h('a', { href: URL.createObjectURL(blob), download: name, hidden: true });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function exportNow(list, base) {
    if (!list.length) { toast(t('contacts.export.nothing'), { tone: 'error' }); return; }
    const partial = store.getSnapshot().truncated && list.length > 1;
    if (!(await confirmDialog({ title: t('contacts.export.warnTitle', { n: list.length }), message: partial ? `${t('contacts.export.truncated', { n: store.getSnapshot().capacity })} ${t('contacts.export.warn')}` : t('contacts.export.warn'), confirmLabel: t('contacts.export.download'), tone: 'primary', container: root }))) return;
    download(exportVcf(list, { categoryName: (id) => (catById(id) ? catName(id) : null) }), vcfFileName(base));
    toast(t('contacts.export.done', { n: list.length }), { tone: 'success' });
  }
  function exportDialog() {
    const scope = h('select', { class: 'input', id: 'ct-export-scope' }, h('option', { value: 'all' }, t('contacts.export.all')),
      h('option', { value: 'fav' }, t('contacts.favoritesOnly')), cats().map((k) => h('option', { value: k.id }, t('contacts.export.category', { name: categoryLabel(k, t) }))));
    formDialog({ title: t('contacts.export.title'), id: 'ct-export-form', submitLabel: t('contacts.export.next'), container: root,
      fields: [h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('contacts.export.scope')), scope),
        h('p', { class: 'field__hint', id: 'ct-export-fields' }, t('contacts.export.fields'))],
      onSubmit: async () => {
        const all = store.getSnapshot().contacts; const v = scope.value;
        const list = sortContacts(v === 'all' ? all : v === 'fav' ? all.filter((c) => c.favorite === true) : all.filter((c) => (c.categoryIds || []).includes(v)), getLocale());
        setTimeout(() => exportNow(list, v === 'all' ? t('contacts.export.fileAll') : v === 'fav' ? t('contacts.favoritesOnly') : catName(v)), 0);
      } });
  }

  // ------------------------------------------------------------------ import
  async function readFile(file) {
    if (file.size > VCF_LIMITS.bytes) { imp = { kind: 'vcf', stage: 'pick', error: 'tooLarge' }; render(); return; }
    const buf = await file.arrayBuffer();
    const parsed = parseVcf(buf);
    const snap = store.getSnapshot();
    const preview = buildPreview(parsed, { contacts: snap.contacts, categories: snap.categories, labelsOf: categoryLabels });
    imp = { kind: 'vcf', stage: 'preview', fileName: file.name, preview, extra: new Set(), result: null, busy: false };
    if (parsed.fileErrors.length && !parsed.records.length) imp = { kind: 'vcf', stage: 'pick', error: parsed.fileErrors[0] };
    render();
  }
  function importView() {
    const back = backButton('ct-imp-back');
    const pick = h('section', { class: 'card fin-card', id: 'ct-imp-pick' },
      h('h2', { class: 'card__title' }, t('contacts.import.title')),
      h('p', { class: 'field__hint' }, t('contacts.import.hint', { kb: Math.round(VCF_LIMITS.bytes / 1024), n: VCF_LIMITS.records })),
      h('label', { class: 'btn btn--secondary ct-file' }, t('contacts.import.choose'),
        h('input', { type: 'file', id: 'ct-imp-file', accept: '.vcf,text/vcard,text/x-vcard', hidden: true, onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f) readFile(f); } })),
      imp.error ? h('div', { id: 'ct-imp-error' }, banner('error', t(`contacts.import.err.${imp.error}`))) : null);
    if (store.getSnapshot().truncated) return h('div', { class: 'ct-stack', id: 'ct-import-view' }, back, h('div', { id: 'ct-imp-error' }, banner('error', t('contacts.import.truncated'))));
    if (imp.stage === 'pick') return h('div', { class: 'ct-stack', id: 'ct-import-view' }, back, pick);
    return h('div', { class: 'ct-stack', id: 'ct-import-view' }, back, previewBlock());
  }
  /** The shared preview / confirm / result block (.vcf AND AI JSON — same duplicate, plan and write pipeline). */
  function previewBlock() {
    const isJson = imp.kind === 'json';
    const p = imp.preview; const c = countPreview(p.items);
    const items = p.items.map((it) => {
      const acts = allowedActions(it);
      const actSel = h('select', { class: 'input input--sm', id: `ct-imp-act-${it.index}`, 'aria-label': t('contacts.import.action', { name: it.value.name || `#${it.index + 1}` }), disabled: acts.length === 1 || imp.busy,
        onChange: (e) => { it.action = e.target.value; if (it.action === 'merge' && !it.targetId) it.targetId = it.matches[0] && it.matches[0].id; render(); } },
        acts.map((a) => h('option', { value: a, selected: it.action === a }, t(`contacts.import.act.${a}`))));
      const targetSel = it.action === 'merge' && it.matches.length > 1 ? h('select', { class: 'input input--sm', id: `ct-imp-target-${it.index}`, 'aria-label': t('contacts.import.target'),
        onChange: (e) => { it.targetId = e.target.value; it.take = new Set(); render(); } }, it.matches.map((m) => h('option', { value: m.id, selected: it.targetId === m.id }, `${m.name} (${t(`contacts.import.by.${m.by}`)})`))) : null;
      const notes = [
        ...it.errors.map((e) => h('li', { class: 'ct-imp-err' }, t(`contacts.import.e.${e}`))),
        ...it.warnings.map((w) => h('li', null, t(`contacts.import.w.${w}`))),
        it.unsupported.length ? h('li', null, t('contacts.import.unsupported', { list: it.unsupported.join(', ') })) : null,
        it.unknownCategories.length ? h('li', null, t('contacts.import.unknownCats', { list: it.unknownCategories.join(', ') })) : null,
        it.status === 'inFile' ? h('li', null, t('contacts.import.inFile', { n: it.inFileOf + 1 })) : null,
        it.status === 'imported' ? h('li', null, t(it.edited ? 'contacts.import.priorEdited' : 'contacts.import.priorSame')) : null,
        it.matches.length && it.status !== 'inFile' ? h('li', null, t('contacts.import.matches', { list: it.matches.map((m) => `${m.name} (${t(`contacts.import.by.${m.by}`)})`).join(' · ') })) : null,
        isJson && (it.unknownFields || []).length ? h('li', { class: 'ct-imp-err' }, t('contacts.json.unknownFields', { list: it.unknownFields.join(', ') })) : null,
        isJson && it.value.avatarUrl ? h('li', null, t('contacts.json.hasPicture')) : null,
        isJson && (it.value.menus || []).length ? h('li', null, t('contacts.json.hasMenus', { n: it.value.menus.length })) : null,
      ].filter(Boolean);
      // AI JSON merge: every conflicting field (incl. picture / menus) is KEPT unless explicitly ticked here
      const target = it.action === 'merge' && it.targetId ? store.contact(it.targetId) : null;
      const takes = isJson && target ? conflictPairs(target, it.value, t) : [];
      if (!it.take) it.take = new Set();
      const takeBox = takes.length ? h('fieldset', { class: 'ct-take', id: `ct-imp-take-${it.index}` }, h('legend', { class: 'field__label' }, t('contacts.json.takeTitle')),
        takes.map((x) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', value: x.field, checked: it.take.has(x.field), disabled: imp.busy,
          onChange: (e) => { if (e.target.checked) it.take.add(x.field); else it.take.delete(x.field); } }),
        ` ${t('contacts.json.take', { field: t(`contacts.json.field.${x.field}`), current: x.current, file: x.file })}`))) : null;
      return h('li', { class: 'ct-imp-item', dataset: { status: it.status, index: String(it.index) } },
        h('div', { class: 'ct-imp-item__head' },
          h('span', { class: 'ct-imp-item__name', dir: 'auto' }, it.value.name || t('contacts.import.noName', { n: it.index + 1 })),
          h('span', { class: `pill ct-st--${it.status}` }, t(`contacts.import.st.${it.status}`))),
        it.value.phones.length ? h('p', { class: 'ct-card__sub ct-num', dir: 'ltr' }, it.value.phones.map((x) => x.slice(x.indexOf('|') + 1)).join(' · ')) : null,
        notes.length ? h('ul', { class: 'ct-imp-notes' }, notes) : null,
        h('div', { class: 'ct-imp-item__act' }, actSel, targetSel), takeBox);
    });
    const extra = cats().length ? h('fieldset', { class: 'ct-edit-cats', id: 'ct-imp-cats' }, h('legend', { class: 'field__label' }, t('contacts.import.assign')),
      cats().map((k) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', value: k.id, checked: imp.extra.has(k.id), disabled: imp.busy, onChange: (e) => { if (e.target.checked) imp.extra.add(k.id); else imp.extra.delete(k.id); } }), ` ${categoryLabel(k, t)}`))) : null;
    const r = imp.result;
    const confirm = h('button', { type: 'button', class: 'btn btn--primary', id: 'ct-imp-confirm', disabled: !c.selected || imp.busy || !!r,
      onClick: () => commit(planImport(p.items, { contacts: store.getSnapshot().contacts, extraCategoryIds: [...imp.extra], source: isJson ? 'json' : 'vcf' })) },
      t('contacts.import.confirm', { n: c.selected }));
    const progress = h('p', { class: 'field__hint', id: 'ct-imp-progress', 'aria-live': 'polite' }, imp.progress || '');
    return h('section', { class: 'card fin-card', id: 'ct-imp-preview', dataset: { kind: imp.kind } },
        h('h2', { class: 'card__title' }, t('contacts.import.previewTitle', { file: imp.fileName })),
        h('p', { class: 'field__hint', id: 'ct-imp-counts' }, t('contacts.import.counts', c)),
        (() => { const sn = store.getSnapshot(); const adds = p.items.filter((x) => x.action === 'create' || x.action === 'separate').length; const room = Math.max(0, sn.capacity - sn.contacts.length);
          return h('p', { class: ['field__hint', adds > room && 'ct-warn'], id: 'ct-imp-capacity' }, t(adds > room ? 'contacts.import.overCapacity' : 'contacts.import.capacity', { adds, room })); })(),
        h('p', { class: 'field__hint' }, t('contacts.import.privacy')),
        p.fileErrors.length ? banner('info', p.fileErrors.map((e) => t(`contacts.import.err.${e}`)).join(' ')) : null,
        h('ul', { class: 'ct-imp-list', id: 'ct-imp-list' }, items), extra,
        h('div', { class: 'cl-item__actions' }, confirm,
          h('button', { type: 'button', class: 'btn btn--ghost', id: 'ct-imp-other', disabled: imp.busy, onClick: () => { imp = isJson ? null : { kind: 'vcf', stage: 'pick' }; render(); } }, t('contacts.import.another'))),
        progress,
        r ? h('div', { id: 'ct-imp-result', class: 'ct-imp-result' },
          banner(r.failed.length || r.stale.length || r.kept.length || r.deleted.length || r.hidden.length ? 'info' : 'success', t('contacts.import.result', { created: r.created, merged: r.merged, already: r.already, unchanged: r.unchanged, stale: r.stale.length, failed: r.failed.length })),
          // rev 2: occupied import ids — never overwritten, restored or copied without an explicit choice
          ...[['kept', r.kept], ['deleted', r.deleted], ['hidden', r.hidden]].filter(([, l]) => l.length).map(([k, l]) =>
            h('p', { class: 'field__hint', id: `ct-imp-${k}` }, t(`contacts.import.occupied.${k}`, { n: l.length, list: l.map((x) => x.name).join(' · ') }))),
          r.kept.length + r.deleted.length + r.hidden.length ? h('button', { type: 'button', class: 'btn btn--ghost', id: 'ct-imp-separate',
            onClick: () => { const taken = new Set(store.getSnapshot().contacts.map((x) => x.id)); commit([...r.kept, ...r.deleted, ...r.hidden].map((x) => separateOp(x, taken))); } },
            t('contacts.import.addSeparate', { n: r.kept.length + r.deleted.length + r.hidden.length })) : null,
          r.failed.length ? h('button', { type: 'button', class: 'btn btn--secondary', id: 'ct-imp-retry', onClick: () => commit(r.failed.map(({ detail, ...op }) => op)) }, t('contacts.import.retry', { n: r.failed.length })) : null,
          r.stale.length ? h('button', { type: 'button', class: 'btn btn--secondary', id: 'ct-imp-review', onClick: () => { const s = store.getSnapshot(); const again = new Set(r.stale.map((x) => x.index));
            imp.preview = buildPreview({ records: imp.preview.items.filter((x) => again.has(x.index)).map((x) => ({ index: x.index, version: x.version, ok: true, value: { ...x.value, phones: x.value.phones.map((y) => ({ label: y.slice(0, y.indexOf('|')), number: y.slice(y.indexOf('|') + 1) })), categoryNames: [] }, errors: [], warnings: x.warnings, unsupported: x.unsupported, mediaSkipped: x.mediaSkipped })), fileErrors: [] },
              { contacts: s.contacts, categories: s.categories, labelsOf: categoryLabels });
            imp.result = null; render(); } }, t('contacts.import.review', { n: r.stale.length })) : null) : null);
  }
  async function commit(ops) {
    imp.busy = true; imp.result = null; render();
    try {
      imp.result = await store.importContacts(ops, { onProgress: (x) => { imp.progress = t('contacts.import.progress', { done: x.done, total: x.total });
        const el = document.getElementById('ct-imp-progress'); if (el) el.textContent = imp.progress; } });
    } catch (e) { toast(msg(e), { tone: 'error' }); }
    imp.busy = false; render();
  }

  // ------------------------------------------------------------------ AI JSON import / export (local only)
  const backButton = (id) => h('button', { type: 'button', class: 'btn btn--secondary ct-backbtn', id, onClick: goBack }, icon('back', { size: 20 }), h('span', null, t('contacts.backToList')));
  async function copyText(text, okKey) {
    try { await navigator.clipboard.writeText(text); toast(t(okKey), { tone: 'success' }); } catch { toast(t('contacts.json.copyFailed'), { tone: 'error' }); }
  }
  function jsonExportList() {
    const all = store.getSnapshot().contacts; const v = json.scope;
    const list = v === 'all' ? all : v === 'filtered' ? all.filter(matches) : v === 'fav' ? all.filter((c) => c.favorite === true)
      : v === 'picked' ? all.filter((c) => json.picked.has(c.id)) : all.filter((c) => (c.categoryIds || []).includes(v));
    return sortContacts(list, getLocale());
  }
  async function exportJson() {
    const list = jsonExportList();
    if (!list.length) { toast(t('contacts.export.nothing'), { tone: 'error' }); return; }
    const partial = store.getSnapshot().truncated && json.scope !== 'picked';
    // personal information may be pasted into an external AI service — say so BEFORE anything is produced
    if (!(await confirmDialog({ title: t('contacts.json.warnTitle', { n: list.length }), message: `${partial ? `${t('contacts.export.truncated', { n: store.getSnapshot().capacity })} ` : ''}${t('contacts.json.warn')}`,
      confirmLabel: t('contacts.json.download'), tone: 'primary', container: root }))) return;
    download(exportContactsJson(list, { categoryName: (id) => (catById(id) ? catName(id) : null), locale: getLocale() }), jsonFileName(t('contacts.json.fileBase')), 'application/json;charset=utf-8');
    toast(t('contacts.export.done', { n: list.length }), { tone: 'success' });
  }
  function previewJson(input, fileName) {
    const parsed = parseContactsJson(input);
    if (parsed.fileErrors.length) { imp = { kind: 'json', stage: 'pick', error: parsed.fileErrors[0], unknown: parsed.unknown || [] }; render(); return; }
    const snap = store.getSnapshot();
    imp = { kind: 'json', stage: 'preview', fileName, preview: buildPreview(parsed, { contacts: snap.contacts, categories: snap.categories, labelsOf: categoryLabels }), extra: new Set(), result: null, busy: false };
    render();
    const el = document.getElementById('ct-imp-preview'); if (el) el.scrollIntoView({ block: 'start' });
  }
  function jsonView() {
    const sn = store.getSnapshot(); const all = sn.contacts;
    const ai = h('section', { class: 'card fin-card', id: 'ct-json-ai' },
      h('h2', { class: 'card__title' }, t('contacts.json.aiTitle')),
      h('p', { class: 'field__hint' }, t('contacts.json.aiHint')),
      h('div', { class: 'cl-item__actions' },
        h('button', { type: 'button', class: 'btn btn--secondary', id: 'ct-json-copy-prompt', onClick: () => copyText(aiPrompt(), 'contacts.json.promptCopied') }, t('contacts.json.copyPrompt')),
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'ct-json-copy-schema', onClick: () => copyText(schemaText(), 'contacts.json.schemaCopied') }, t('contacts.json.copySchema')),
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'ct-json-example', onClick: () => download(exampleText(), 'homehub-contacts-example.json', 'application/json;charset=utf-8') }, t('contacts.json.example'))));
    const exp = P.exp ? (() => {
      const scope = h('select', { class: 'input', id: 'ct-json-scope', onChange: (e) => { json.scope = e.target.value; render(); } },
        [['all', t('contacts.export.all')], ['filtered', t('contacts.json.filtered', { n: all.filter(matches).length })], ['fav', t('contacts.favoritesOnly')], ['picked', t('contacts.json.picked')],
          ...cats().map((k) => [k.id, t('contacts.export.category', { name: categoryLabel(k, t) })])].map(([v, l]) => h('option', { value: v, selected: json.scope === v }, l)));
      const pick = json.scope === 'picked' ? h('fieldset', { class: 'ct-json-pick', id: 'ct-json-pick' }, h('legend', { class: 'field__label' }, t('contacts.json.pickTitle', { n: json.picked.size })),
        sortContacts(all, getLocale()).map((c) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', value: c.id, checked: json.picked.has(c.id),
          onChange: (e) => { if (e.target.checked) json.picked.add(c.id); else json.picked.delete(c.id); const lg = document.querySelector('#ct-json-pick legend'); if (lg) lg.textContent = t('contacts.json.pickTitle', { n: json.picked.size }); } }), ' ', h('span', { dir: 'auto' }, c.name)))) : null;
      return h('section', { class: 'card fin-card', id: 'ct-json-export-card' },
        h('h2', { class: 'card__title' }, t('contacts.json.exportTitle')),
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('contacts.export.scope')), scope), pick,
        h('p', { class: 'field__hint' }, t('contacts.json.exportFields')),
        h('button', { type: 'button', class: 'btn btn--primary', id: 'ct-json-export', onClick: () => exportJson() }, t('contacts.json.exportBtn')));
    })() : null;
    const busy = imp && imp.busy;
    const importCard = P.imp ? (sn.truncated ? h('section', { class: 'card fin-card', id: 'ct-json-import-card' }, h('div', { id: 'ct-json-error' }, banner('error', t('contacts.import.truncated'))))
      : (() => {
        const area = h('textarea', { class: 'input input--area ct-json-text', id: 'ct-json-text', dir: 'ltr', spellcheck: 'false', autocomplete: 'off', 'aria-label': t('contacts.json.paste'), placeholder: '{ "schema": "homehub.contacts", "version": 1, "items": [ … ] }',
          onInput: (e) => { json.text = e.target.value; } }, json.text || '');
        const err = imp && imp.kind === 'json' && imp.error ? h('div', { id: 'ct-json-error' }, banner('error', `${t(`contacts.json.err.${imp.error}`, { kb: Math.round(JSON_LIMITS.bytes / 1024), n: JSON_LIMITS.items })}${imp.unknown && imp.unknown.length ? ` (${imp.unknown.join(', ')})` : ''}`)) : null;
        return h('section', { class: 'card fin-card', id: 'ct-json-import-card' },
          h('h2', { class: 'card__title' }, t('contacts.json.importTitle')),
          h('p', { class: 'field__hint' }, t('contacts.json.importHint', { kb: Math.round(JSON_LIMITS.bytes / 1024), n: JSON_LIMITS.items })),
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('contacts.json.paste')), area),
          h('div', { class: 'cl-item__actions' },
            h('button', { type: 'button', class: 'btn btn--primary', id: 'ct-json-preview-btn', disabled: busy, onClick: () => {
              const text = (document.getElementById('ct-json-text') || {}).value || '';
              if (new TextEncoder().encode(text).length > JSON_LIMITS.bytes) { imp = { kind: 'json', stage: 'pick', error: 'tooLarge' }; render(); return; }
              json.text = text; previewJson(text, t('contacts.json.pasted'));
            } }, t('contacts.json.preview')),
            h('label', { class: 'btn btn--secondary ct-file' }, t('contacts.json.chooseFile'),
              h('input', { type: 'file', id: 'ct-json-file', accept: '.json,application/json', hidden: true, disabled: busy, onChange: async (e) => {
                const f = e.target.files && e.target.files[0]; if (!f) return;
                if (f.size > JSON_LIMITS.bytes) { imp = { kind: 'json', stage: 'pick', error: 'tooLarge' }; render(); return; }
                previewJson(new Uint8Array(await f.arrayBuffer()), f.name);
              } }))),
          h('p', { class: 'field__hint' }, t('contacts.json.noWrites')), err);
      })()) : null;
    return h('div', { class: 'ct-stack', id: 'ct-json-view' }, backButton('ct-json-back'),
      h('p', { class: 'field__hint', id: 'ct-json-local' }, t('contacts.json.localOnly')),
      ai, exp, importCard, imp && imp.kind === 'json' && imp.stage === 'preview' ? previewBlock() : null);
  }

  // ------------------------------------------------------------------ categories / deleted
  function categoriesView() {
    const list = cats();
    return h('section', { class: 'card fin-card', id: 'ct-cats-view' },
      backButton('ct-cats-back'),
      h('h2', { class: 'card__title' }, t('contacts.cats.title')),
      h('p', { class: 'field__hint' }, t('contacts.cats.hint')),
      list.length ? h('ul', { class: 'fin-list', id: 'ct-cat-list' }, list.map((k) => h('li', { class: 'fin-row fin-row--wrap', dataset: { cat: k.id } },
        h('span', { class: 'fin-row__main' }, h('span', { class: 'fin-row__note', dir: 'auto' }, categoryLabel(k, t)),
          h('span', { class: 'fin-row__sub' }, t('contacts.cats.used', { n: store.getSnapshot().contacts.filter((c) => (c.categoryIds || []).includes(k.id)).length }))),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'rename', onClick: () => catDialog(k) }, t('contacts.cats.rename')),
        h('button', { type: 'button', class: 'btn btn--danger-ghost btn--sm', 'data-action': 'remove', onClick: async () => {
          if (!(await confirmDialog({ title: t('contacts.cats.removeTitle', { name: categoryLabel(k, t) }), message: t('contacts.cats.removeBody'), confirmLabel: t('contacts.cats.remove'), container: root }))) return;
          try { await store.deleteCategory(k.id); toast(t('contacts.cats.removed'), { tone: 'success' }); if (cat === k.id) cat = 'all'; } catch (e) { toast(msg(e), { tone: 'error' }); }
        } }, t('contacts.cats.remove'))))) : h('p', { class: 'empty', id: 'ct-cats-empty' }, t('contacts.cats.none')),
      h('div', { class: 'cl-item__actions' },
        h('button', { type: 'button', class: 'btn btn--primary', id: 'ct-cat-new', onClick: () => catDialog(null) }, `＋ ${t('contacts.cats.new')}`),
        h('button', { type: 'button', class: 'btn btn--secondary', id: 'ct-cat-suggest', onClick: run(async () => { const n = await store.addSuggestedCategories(); toast(t('contacts.cats.suggested', { n }), { tone: 'success' }); return false; }) }, t('contacts.cats.addSuggested'))));
  }
  function catDialog(k) {
    const input = h('input', { class: 'input', id: 'ct-cat-name', maxlength: CONTACT_LIMITS.categoryName, value: k ? categoryLabel(k, t) : '', dir: 'auto' });
    formDialog({ title: t(k ? 'contacts.cats.renameTitle' : 'contacts.cats.newTitle'), id: 'ct-cat-form', submitLabel: t('common.save'), container: root,
      fields: [h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('contacts.cats.name')), input)],
      onSubmit: async () => { if (k) await store.renameCategory(k.id, { name: input.value }); else await store.createCategory({ name: input.value }); return 'contacts.cats.saved'; } });
  }
  function deletedView() {
    if (deleted === null) { deleted = 'loading'; store.loadDeleted().then((d) => { deleted = d; render(); }, (e) => { deleted = { error: e }; render(); }); }
    const back = backButton('ct-del-back');
    const content = deleted === 'loading' ? h('p', { class: 'muted', role: 'status' }, t('common.loading'))
      : deleted.error ? banner('error', errorText(deleted.error))
        : deleted.items.length ? h('ul', { class: 'fin-list', id: 'ct-del-list' }, deleted.items.map((c) => h('li', { class: 'fin-row fin-row--wrap', dataset: { id: c.id } },
          h('span', { class: 'fin-row__main' }, h('span', { class: 'fin-row__note', dir: 'auto' }, c.name)),
          h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-action': 'restore', onClick: run(async () => { await store.restoreContact(c); deleted = null; render(); }, 'contacts.deleted.restored') }, t('contacts.deleted.restore')))))
          : h('p', { class: 'empty', id: 'ct-del-empty' }, t('contacts.deleted.none'));
    const more = deleted && deleted.more ? h('p', { class: 'field__hint', id: 'ct-del-more' }, t('contacts.deleted.more', { n: CONTACT_LIMITS.deletedList })) : null;
    return h('section', { class: 'card fin-card', id: 'ct-deleted-view' }, back, h('h2', { class: 'card__title' }, t('contacts.deleted.title')), h('p', { class: 'field__hint' }, t('contacts.deleted.hint')), content, more);
  }

  // ------------------------------------------------------------------ render
  function render() {
    const snap = store.getSnapshot();
    if (snap.status === 'denied') { paint(body, header(), banner('error', t('contacts.err.noAccess'))); return; }
    if (snap.status === 'error') { paint(body, header(), banner('error', errorText(snap.error))); return; }
    if (snap.status !== 'ready') { paint(body, header(), h('p', { class: 'muted', role: 'status', id: 'ct-loading' }, t('common.loading'))); return; }
    if (view === 'detail') {
      const c = store.contact(sel);
      if (!c) {
        // the contact is gone (deleted elsewhere, or a stale history entry): one step back to the list
        detailKey = null; if (nav.current() && nav.current().v === 'detail') { goBack(); return; }
        view = 'list'; sel = null;
      } else {
        // same contact revision + same categories → nothing to redraw (open menu previews are not reloaded)
        const key = JSON.stringify([c.id, c.rev, snap.categories.map((k) => [k.id, k.rev, k.name]), snap.atLimit, snap.truncated, A.view ? actKey(c.id) : 0]);
        if (key === detailKey && body.querySelector('#ct-detail')) return;
        detailKey = key; paint(body, header(), detailView(c)); return;
      }
    }
    detailKey = null;
    menu = { id: null, open: false, previews: new Set() };   // leaving a contact collapses its menu: no requests until opened again
    if (view === 'import' && imp && P.imp) { paint(body, header(), importView()); return; }
    if (view === 'json' && json && (P.imp || P.exp)) {
      const ta = document.activeElement && document.activeElement.id === 'ct-json-text';
      paint(body, header(), jsonView());
      if (ta) { const el = document.getElementById('ct-json-text'); if (el) el.focus(); }
      return;
    }
    if (view === 'categories' && P.cats) { paint(body, header(), categoriesView()); return; }
    if (view === 'deleted' && P.del) { paint(body, header(), deletedView()); return; }
    view = 'list';
    const focusSearch = document.activeElement && document.activeElement.id === 'ct-search';
    paint(body, header(), listView(snap));
    if (focusSearch) { const s = document.getElementById('ct-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    if (pendingScroll !== null) {
      const y = pendingScroll;
      pendingScroll = null;
      console.log('CT_SCROLL_RESTORE', { savedY: y, beforeY: window.scrollY, maxY: document.documentElement.scrollHeight - window.innerHeight });
      requestAnimationFrame(() => {
        window.scrollTo(0, y);
        console.log('CT_SCROLL_APPLIED', { targetY: y, actualY: window.scrollY });
      });
    }
  }
  const off = store.subscribe(() => { if (imp && imp.busy) return; render(); });
  // Stage B: activity changes redraw only the list (panel) and details — never an import / JSON / form in progress
  const offCal = cal ? cal.subscribe(() => { if ((view === 'list' || view === 'detail') && !(imp && imp.busy)) render(); }) : () => {};
  return () => { off(); offCal(); nav.dispose(); for (const m of body.querySelectorAll('.ct-more')) m.ctMore.close(false); clearTimeout(saveTimer); if (viewer) viewer.finish('unmount'); };   // route change / household switch / sign-out / re-render
}
