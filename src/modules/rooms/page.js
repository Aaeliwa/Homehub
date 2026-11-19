/**
 * Rooms page (#/m/rooms). Module page contract: mount(outlet, ctx) -> unmount.
 *
 * Reads live data from the scope-bound rooms store (shared with the dashboard widget);
 * every write goes through the store → repository → shared data layer.
 */
import { h } from '../../core/utils/dom.js';
import { t, tp, formatNumber } from '../../core/i18n/i18n.js';
import { icon } from '../../ui/components/icons.js';
import { banner, errorText } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import { getRoomsStore } from './rooms-service.js';
import { iconFor, QUICK_TEMPLATES, ROOM_ICONS, defaultIconForType } from './room-model.js';
import { typeLabel } from './room-labels.js';
import { openRoomForm } from './room-form.js';
import { openRoomDetail, restoreRoom } from './room-detail.js';

export function mount(outlet, ctx) {
  const { permissions } = ctx.getState();
  const can = {
    create: permissions.can('rooms.create'),
    edit: permissions.can('rooms.edit'),
    del: permissions.can('rooms.delete'),
    restore: permissions.can('rooms.restore'),
  };

  let store;
  try {
    store = getRoomsStore(ctx);
  } catch (err) {
    outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(err))));
    return () => {};
  }

  let view = 'active'; // 'active' | 'archived'
  const root = h('div', { class: 'page page--rooms accent-indigo' });
  const subtitle = h('p', { class: 'page-head__sub' });
  const tabs = h('div', { class: 'view-switch', role: 'group', 'aria-label': t('rooms.viewLabel') });
  const status = h('div', { 'aria-live': 'polite' });
  const list = h('ul', { class: 'room-grid', 'aria-label': t('module.rooms.name') });
  const empty = h('div');

  const openForm = (opts = {}) => openRoomForm({ store, container: root, ...opts });

  root.append(
    h('header', { class: 'page-head page-head--row' },
      h('div', null,
        h('h1', { class: 'page-head__title' }, t('module.rooms.name')),
        subtitle),
      can.create ? h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openForm() },
        icon('plus', { size: 18 }), t('rooms.add')) : null),
    tabs, status, list, empty);
  outlet.replaceChildren(root);

  function tabButton(id, label) {
    return h('button', {
      type: 'button', class: 'view-switch__btn', 'aria-pressed': String(view === id),
      onClick: () => { view = id; render(store.getSnapshot()); },
    }, label);
  }

  function roomCard(room, index, total) {
    const archived = room.active === false;
    const tools = [];
    if (!archived && can.edit && total > 1) {
      tools.push(
        h('button', {
          type: 'button', class: 'icon-btn', disabled: index === 0,
          'aria-label': t('rooms.moveUp', { name: room.name }), title: t('rooms.moveUpShort'),
          onClick: (e) => move(e, room, 'up'),
        }, icon('arrowUp', { size: 18 })),
        h('button', {
          type: 'button', class: 'icon-btn', disabled: index === total - 1,
          'aria-label': t('rooms.moveDown', { name: room.name }), title: t('rooms.moveDownShort'),
          onClick: (e) => move(e, room, 'down'),
        }, icon('arrowDown', { size: 18 })));
    }
    if (archived && can.restore) {
      tools.push(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onClick: () => restoreRoom({ store, room }) },
        icon('restore', { size: 16 }), t('rooms.restore')));
    }
    return h('li', { class: ['room-card', archived && 'room-card--archived'], dataset: { roomId: room.id } },
      h('button', {
        type: 'button', class: 'room-card__main',
        onClick: () => openRoomDetail({ store, room, permissions, container: root, ctx }),
      },
      h('span', { class: 'room-card__icon', 'aria-hidden': 'true' }, iconFor(room)),
      h('span', { class: 'room-card__text' },
        h('span', { class: 'room-card__name', dir: 'auto' }, room.name),
        h('span', { class: 'room-card__meta' },
          typeLabel(room.type),
          room.floor ? h('span', { class: 'room-card__floor', dir: 'auto' }, room.floor) : null)),
      archived ? h('span', { class: 'pill pill--warn' }, t('rooms.status.archived')) : null),
      tools.length ? h('div', { class: 'room-card__tools' }, tools) : null);
  }

  async function move(e, room, direction) {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await store.move(room.id, direction);
      // Keep keyboard focus on the same control of the moved room.
      requestAnimationFrame(() => {
        const card = list.querySelector(`[data-room-id="${CSS.escape(room.id)}"]`);
        const target = card && card.querySelector(`.icon-btn[aria-label="${CSS.escape(btn.getAttribute('aria-label'))}"]`);
        if (target && !target.disabled) target.focus();
      });
    } catch (err) {
      toast(errorText(err), { tone: 'error', timeout: 5000 });
      btn.disabled = false;
    }
  }

  function emptyState() {
    if (view === 'archived') return h('p', { class: 'empty' }, t('rooms.archivedEmpty'));
    return h('section', { class: 'card empty-state' },
      h('span', { class: 'empty-state__mark', 'aria-hidden': 'true' }, '🚪'),
      h('h2', { class: 'empty-state__title' }, t('rooms.emptyTitle')),
      h('p', { class: 'empty-state__body' }, can.create ? t('rooms.emptyBody') : t('rooms.emptyBodyReadOnly')),
      can.create ? h('div', { class: 'empty-state__actions' },
        h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openForm() }, icon('plus', { size: 18 }), t('rooms.add')),
        h('p', { class: 'field__hint' }, t('rooms.quickHint')),
        h('div', { class: 'quick-rooms' }, QUICK_TEMPLATES.map((type) => h('button', {
          type: 'button', class: 'chip-btn quick-rooms__btn',
          onClick: () => openForm({ preset: { type, name: typeLabel(type) } }),
        }, h('span', { 'aria-hidden': 'true' }, ROOM_ICONS[defaultIconForType(type)]), typeLabel(type))))) : null);
  }

  function render(snap) {
    const activeList = store.active();
    const archivedList = store.archived();
    if (view === 'archived' && !archivedList.length) view = 'active';

    subtitle.textContent = snap.status === 'ready' ? tp('rooms.count', activeList.length) : '';
    tabs.replaceChildren(...(archivedList.length
      ? [tabButton('active', t('rooms.tabActive', { n: formatNumber(activeList.length) })), tabButton('archived', t('rooms.tabArchived', { n: formatNumber(archivedList.length) }))]
      : []));

    if (snap.status === 'error') status.replaceChildren(banner('error', errorText(snap.error)));
    else if (snap.status !== 'ready') status.replaceChildren(h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') }));
    else status.replaceChildren();

    const rooms = view === 'archived' ? archivedList : activeList;
    list.replaceChildren(...rooms.map((r, i) => roomCard(r, i, rooms.length)));
    list.hidden = !rooms.length;
    empty.replaceChildren(snap.status === 'ready' && !rooms.length ? emptyState() : '');
  }

  const unsubscribe = store.subscribe(render);
  return () => unsubscribe();
}

