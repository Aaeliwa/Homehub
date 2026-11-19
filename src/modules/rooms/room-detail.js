/**
 * Room details dialog: the room's fields, its status, and honest placeholders for the
 * integrations that later phases will add (no fake counts, no Firestore structures).
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { openDialog, confirmDialog } from '../../ui/components/dialog.js';
import { icon } from '../../ui/components/icons.js';
import { errorText } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import { iconFor } from './room-model.js';
import { typeLabel } from './room-labels.js';
import { openRoomForm } from './room-form.js';
import { getDevicesStore } from '../devices/devices-service.js';
import { tp } from '../../core/i18n/i18n.js';

/**
 * "Devices in this room" — Rooms CONSUMES the Devices module interface (shared,
 * scope-bound store; no Firestore query of its own). Returns { el, stop }.
 */
function devicesSection({ ctx, room, close }) {
  let devices;
  try { devices = getDevicesStore(ctx); } catch { return null; }
  const text = h('span', { class: 'room-future__name' }, t('common.loading'));
  const link = h('button', {
    type: 'button', class: 'text-link link-like',
    onClick: () => { devices.setPendingFilter({ room: room.id }); close(); ctx.navigate('/m/devices'); },
  }, t('rooms.devices.view'));
  const el = h('div', { class: 'room-future__row room-devices' },
    h('span', { class: 'room-future__glyph', 'aria-hidden': 'true' }, '🔌'), text, link);
  const stop = devices.subscribe((snap) => {
    if (snap.status !== 'ready') return;
    const n = devices.inRoom(room.id).length;
    text.textContent = n ? tp('rooms.devices.count', n) : t('rooms.devices.none');
  });
  return { el, stop };
}

// Devices is live since Phase 3 (shown through the Devices module interface below).
// Phase 5.4d: Cleaning is live; Phase 5.5: Maintenance is live too — nothing is "coming later" here any more.

export async function confirmArchive({ store, room, container }) {
  const ok = await confirmDialog({
    title: t('rooms.archiveTitle', { name: room.name }),
    message: t('rooms.archiveBody'),
    confirmLabel: t('rooms.archive'),
    container,
  });
  if (!ok) return false;
  try {
    await store.archive(room.id);
    toast(t('rooms.toast.archived'), { tone: 'success' });
    return true;
  } catch (err) {
    toast(errorText(err), { tone: 'error', timeout: 5000 });
    return false;
  }
}

export async function restoreRoom({ store, room }) {
  try {
    await store.restore(room.id);
    toast(t('rooms.toast.restored'), { tone: 'success' });
  } catch (err) {
    toast(errorText(err), { tone: 'error', timeout: 5000 });
  }
}

export function openRoomDetail({ store, room, permissions, container, ctx }) {
  const active = room.active === true;
  const devSection = ctx && permissions.can('devices.view') ? devicesSection({ ctx, room, close: () => dlg.close() }) : null;
  const row = (label, value, opts = {}) => h('div', null, h('dt', null, label), h('dd', opts, value));

  const content = h('div', { class: 'room-detail' },
    h('div', { class: 'room-detail__hero' },
      h('span', { class: 'room-detail__icon', 'aria-hidden': 'true' }, iconFor(room)),
      h('div', null,
        h('p', { class: 'room-detail__name', dir: 'auto' }, room.name),
        h('p', { class: 'room-detail__type' }, typeLabel(room.type)))),
    h('dl', { class: 'facts' },
      row(t('rooms.field.floor'), room.floor || t('rooms.none'), { dir: 'auto' }),
      row(t('rooms.field.status'), active ? t('rooms.status.active') : t('rooms.status.archived'))),
    h('div', { class: 'room-detail__notes' },
      h('p', { class: 'field__label' }, t('rooms.field.notes')),
      h('p', { class: 'room-detail__notes-text', dir: 'auto' }, room.notes || t('rooms.none'))),
    h('section', { class: 'room-future', 'aria-label': t('rooms.related.label') }, devSection ? devSection.el : null));

  const footer = [];
  if (active && permissions.can('rooms.delete')) {
    footer.push(h('button', {
      type: 'button', class: 'btn btn--danger-ghost',
      onClick: async () => { dlg.close(); await confirmArchive({ store, room, container }); },
    }, icon('archive', { size: 18 }), t('rooms.archive')));
  }
  if (!active && permissions.can('rooms.restore')) {
    footer.push(h('button', {
      type: 'button', class: 'btn btn--secondary',
      onClick: async () => { dlg.close(); await restoreRoom({ store, room }); },
    }, icon('restore', { size: 18 }), t('rooms.restore')));
  }
  if (active && permissions.can('rooms.edit')) {
    footer.push(h('button', {
      type: 'button', class: 'btn btn--primary',
      onClick: () => { dlg.close(); openRoomForm({ store, room: store.get(room.id) || room, container }); },
    }, icon('edit', { size: 18 }), t('rooms.edit')));
  }

  const dlg = openDialog({ title: t('rooms.detailTitle'), content, footer, container, onClose: () => devSection && devSection.stop() });
  return dlg;
}
