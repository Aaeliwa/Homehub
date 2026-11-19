/**
 * Devices page (#/m/devices). Everything renders from two shared, scope-bound stores:
 * the Devices store (one devices listener) and the Rooms store (one rooms listener).
 * Search, filters and sorting run client-side on the loaded collection — no queries per
 * keystroke.
 */
import { h } from '../../core/utils/dom.js';
import { t, tp, formatNumber } from '../../core/i18n/i18n.js';
import { icon } from '../../ui/components/icons.js';
import { banner, errorText } from '../../ui/components/common.js';
import { getDevicesStore } from './devices-service.js';
import { getRoomsStore } from '../rooms/rooms-service.js';
import { iconFor, DEVICE_CATEGORY_IDS, DEVICE_STATUSES, SORT_MODES, QUICK_TEMPLATES, DEVICE_ICONS, defaultIconFor } from './device-model.js';
import { categoryLabel, subtypeLabel, statusLabel, roomLabel } from './device-labels.js';
import { openDeviceForm } from './device-form.js';
import { openDeviceDetail, restoreDevice } from './device-detail.js';
import { deviceCleaningSection } from '../cleaning/cleaning-service.js';   // Phase 5.4d: via the Cleaning service
import { deviceMaintenanceSection } from '../maintenance/maintenance-service.js';   // Phase 5.5: via the Maintenance service

export function mount(outlet, ctx) {
  const { permissions, home } = ctx.getState();
  const can = { create: permissions.can('devices.create'), restore: permissions.can('devices.restore') };
  let store; let rooms;
  try { store = getDevicesStore(ctx); rooms = getRoomsStore(ctx); }
  catch (err) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(err)))); return () => {}; }

  const filter = { view: 'active', query: '', room: 'all', category: 'all', status: 'all' };
  let sort = 'name';
  const pending = store.takePendingFilter();
  if (pending && pending.room) filter.room = pending.room;

  const root = h('div', { class: 'page page--devices accent-cyan' });
  const subtitle = h('p', { class: 'page-head__sub' });
  const tabs = h('div', { class: 'view-switch', role: 'group', 'aria-label': t('devices.viewLabel') });
  const status = h('div', { 'aria-live': 'polite' });
  const resultInfo = h('p', { class: 'result-info', 'aria-live': 'polite' });
  const list = h('ul', { class: 'room-grid device-grid', 'aria-label': t('module.devices.name') });
  const empty = h('div');
  const formOpts = () => ({ store, rooms, homeCurrency: home.currency, container: root });

  // ---- toolbar -------------------------------------------------------------------------
  const search = h('input', {
    type: 'search', id: 'dev-search', class: 'input', placeholder: t('devices.searchPlaceholder'), autocomplete: 'off',
    'aria-label': t('devices.search'), onInput: (e) => { filter.query = e.target.value; render(); },
  });
  const sel = (id, label, options, value, onChange) => {
    const s = h('select', { id, class: 'input input--sm', 'aria-label': label, onChange: (e) => onChange(e.target.value) },
      options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
    return h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, label), s);
  };
  const roomSelectSlot = h('span', { class: 'toolbar__slot' });
  function renderRoomSelect() {
    const opts = [{ value: 'all', label: t('devices.filter.allRooms') }, { value: 'unassigned', label: t('devices.unassigned') },
      ...rooms.active().map((r) => ({ value: r.id, label: r.name }))];
    // Archived rooms still referenced by devices remain filterable.
    const referenced = new Set(store.all().map((d) => d.roomId).filter(Boolean));
    for (const r of rooms.archived()) if (referenced.has(r.id)) opts.push({ value: r.id, label: t('devices.roomArchivedLabel', { name: r.name }) });
    if (!opts.some((o) => o.value === filter.room)) filter.room = 'all';
    roomSelectSlot.replaceChildren(sel('dev-filter-room', t('devices.field.room'), opts, filter.room, (v) => { filter.room = v; render(); }));
  }
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'toolbar__search' }, icon('search', { size: 18 }), search),
    h('div', { class: 'toolbar__filters' },
      roomSelectSlot,
      sel('dev-filter-category', t('devices.field.category'),
        [{ value: 'all', label: t('devices.filter.allCategories') }, ...DEVICE_CATEGORY_IDS.map((c) => ({ value: c, label: categoryLabel(c) }))],
        'all', (v) => { filter.category = v; render(); }),
      sel('dev-filter-status', t('devices.field.status'),
        [{ value: 'all', label: t('devices.filter.allStatuses') }, ...DEVICE_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))],
        'all', (v) => { filter.status = v; render(); }),
      sel('dev-sort', t('devices.sort.label'), SORT_MODES.map((m) => ({ value: m, label: t(`devices.sort.${m}`) })), sort, (v) => { sort = v; render(); })));

  root.append(
    h('header', { class: 'page-head page-head--row' },
      h('div', null, h('h1', { class: 'page-head__title' }, t('module.devices.name')), subtitle),
      can.create ? h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openDeviceForm(formOpts()) }, icon('plus', { size: 18 }), t('devices.add')) : null),
    tabs, toolbar, status, resultInfo, list, empty);
  outlet.replaceChildren(root);

  const tabButton = (id, label) => h('button', {
    type: 'button', class: 'view-switch__btn', 'aria-pressed': String(filter.view === id),
    onClick: () => { filter.view = id; render(); },
  }, label);

  const roomOrderMap = () => new Map(rooms.active().concat(rooms.archived()).map((r, i) => [r.id, i]));

  function card(d) {
    const archived = d.active === false;
    return h('li', { class: ['room-card', 'device-card', archived && 'room-card--archived'], dataset: { deviceId: d.id } },
      h('button', {
        type: 'button', class: 'room-card__main',
        onClick: () => openDeviceDetail({ ...formOpts(), device: d, permissions, onRoomClick: () => ctx.navigate('/m/rooms'),
          cleaningSection: (dev, nav) => deviceCleaningSection(ctx, dev, { onNavigate: nav }),
          maintenanceSection: (dev, nav) => deviceMaintenanceSection(ctx, dev, { onNavigate: nav }), onNavigate: (path) => ctx.navigate(path) }),
      },
      h('span', { class: 'room-card__icon', 'aria-hidden': 'true' }, iconFor(d)),
      h('span', { class: 'room-card__text' },
        h('span', { class: 'room-card__name', dir: 'auto' }, d.name),
        h('span', { class: 'room-card__meta' }, subtypeLabel(d.subtype) || categoryLabel(d.category)),
        h('span', { class: 'device-card__room' }, icon('pin', { size: 14 }), h('span', { dir: 'auto' }, roomLabel(d.roomId, rooms.get)))),
      h('span', { class: ['status-pill', `status-pill--${d.status}`] }, statusLabel(d.status))),
      archived && can.restore ? h('div', { class: 'room-card__tools' },
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onClick: () => restoreDevice({ store, device: d }) }, icon('restore', { size: 16 }), t('rooms.restore'))) : null);
  }

  function emptyState(totalActive) {
    if (filter.view === 'archived') return h('p', { class: 'empty' }, t('devices.archivedEmpty'));
    if (totalActive > 0) {
      return h('div', { class: 'card empty-state empty-state--compact' },
        h('p', { class: 'empty-state__body' }, t('devices.noMatches')),
        h('button', { type: 'button', class: 'btn btn--secondary', onClick: clearFilters }, t('devices.clearFilters')));
    }
    return h('section', { class: 'card empty-state' },
      h('span', { class: 'empty-state__mark', 'aria-hidden': 'true' }, '🔌'),
      h('h2', { class: 'empty-state__title' }, t('devices.emptyTitle')),
      h('p', { class: 'empty-state__body' }, can.create ? t('devices.emptyBody') : t('devices.emptyBodyReadOnly')),
      can.create ? h('div', { class: 'empty-state__actions' },
        h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openDeviceForm(formOpts()) }, icon('plus', { size: 18 }), t('devices.add')),
        h('p', { class: 'field__hint' }, t('devices.quickHint')),
        h('div', { class: 'quick-rooms' }, QUICK_TEMPLATES.map((tpl) => h('button', {
          type: 'button', class: 'chip-btn quick-rooms__btn',
          onClick: () => openDeviceForm({ ...formOpts(), preset: { ...tpl, name: subtypeLabel(tpl.subtype) } }),
        }, h('span', { 'aria-hidden': 'true' }, DEVICE_ICONS[defaultIconFor(tpl.category, tpl.subtype)]), subtypeLabel(tpl.subtype))))) : null);
  }

  function clearFilters() {
    Object.assign(filter, { query: '', room: 'all', category: 'all', status: 'all' });
    search.value = '';
    root.querySelectorAll('.toolbar select').forEach((s) => { if (s.id !== 'dev-sort') s.value = 'all'; });
    render();
  }

  function render() {
    const snap = store.getSnapshot();
    const active = store.active();
    const archived = store.archived();
    if (filter.view === 'archived' && !archived.length) filter.view = 'active';
    subtitle.textContent = snap.status === 'ready' ? tp('devices.count', active.length) : '';
    tabs.replaceChildren(...(archived.length
      ? [tabButton('active', t('rooms.tabActive', { n: formatNumber(active.length) })), tabButton('archived', t('rooms.tabArchived', { n: formatNumber(archived.length) }))]
      : []));
    renderRoomSelect();
    toolbar.hidden = snap.status !== 'ready' || (active.length + archived.length === 0);
    if (snap.status === 'error') status.replaceChildren(banner('error', errorText(snap.error)));
    else if (snap.status !== 'ready') status.replaceChildren(h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') }));
    else status.replaceChildren();

    const order = roomOrderMap();
    const results = store.query(filter, sort, { roomOrder: (id) => order.get(id) ?? Infinity, categoryLabel });
    const base = filter.view === 'archived' ? archived.length : active.length;
    resultInfo.textContent = snap.status === 'ready' && base && results.length !== base ? t('devices.showing', { n: formatNumber(results.length), total: formatNumber(base) }) : '';
    list.replaceChildren(...results.map(card));
    list.hidden = !results.length;
    empty.replaceChildren(snap.status === 'ready' && !results.length ? emptyState(active.length) : '');
  }

  const offDevices = store.subscribe(render);
  const offRooms = rooms.subscribe(render);
  return () => { offDevices(); offRooms(); };
}
