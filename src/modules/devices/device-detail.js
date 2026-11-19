/**
 * Device details dialog. Shows metadata, the room (resolved from the shared rooms store,
 * archived rooms labelled), and the LIVE Cleaning (Phase 5.4d) and Maintenance (Phase 5.5) sections —
 * each supplied by its module through that module's service, so Devices imports no module internals.
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { openDialog, confirmDialog } from '../../ui/components/dialog.js';
import { icon } from '../../ui/components/icons.js';
import { errorText } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import { iconFor } from './device-model.js';
import { categoryLabel, subtypeLabel, statusLabel, roomLabel, formatPrice, formatCalendarDate } from './device-labels.js';
import { openDeviceForm } from './device-form.js';

export async function archiveDevice({ store, device, container }) {
  const ok = await confirmDialog({
    title: t('devices.archiveTitle', { name: device.name }),
    message: t('devices.archiveBody'),
    confirmLabel: t('devices.archive'),
    container,
  });
  if (!ok) return false;
  try { await store.archive(device.id); toast(t('devices.toast.archived'), { tone: 'success' }); return true; }
  catch (err) { toast(errorText(err), { tone: 'error', timeout: 5000 }); return false; }
}

export async function restoreDevice({ store, device }) {
  try { await store.restore(device.id); toast(t('devices.toast.restored'), { tone: 'success' }); }
  catch (err) { toast(errorText(err), { tone: 'error', timeout: 5000 }); }
}

export function openDeviceDetail({ store, rooms, device, permissions, homeCurrency, container, onRoomClick, cleaningSection = null, maintenanceSection = null, onNavigate = null }) {
  const cleaningSlot = h('div', { id: 'dev-cleaning-slot' });
  const maintenanceSlot = h('div', { id: 'dev-maintenance-slot' });
  const active = device.active === true;
  const locale = getLocale();
  const none = t('rooms.none');
  const row = (label, value, opts = {}) => h('div', null, h('dt', null, label), h('dd', opts, value || none));
  const room = device.roomId ? rooms.get(device.roomId) : null;
  const roomText = roomLabel(device.roomId, rooms.get);
  const roomValue = room && room.active && onRoomClick
    ? h('button', { type: 'button', class: 'text-link link-like', onClick: () => { dlg.close(); onRoomClick(room); } }, roomText)
    : roomText;

  const content = h('div', { class: 'room-detail' },
    h('div', { class: 'room-detail__hero' },
      h('span', { class: 'room-detail__icon', 'aria-hidden': 'true' }, iconFor(device)),
      h('div', null,
        h('p', { class: 'room-detail__name', dir: 'auto' }, device.name),
        h('p', { class: 'room-detail__type' }, [categoryLabel(device.category), subtypeLabel(device.subtype)].filter(Boolean).join(' · ')),
        h('span', { class: ['status-pill', `status-pill--${device.status}`] }, statusLabel(device.status)),
        !active ? h('span', { class: 'pill pill--warn' }, t('rooms.status.archived')) : null)),
    h('dl', { class: 'facts' },
      row(t('devices.field.room'), roomValue),
      row(t('devices.field.brand'), device.brand, { dir: 'auto' }),
      row(t('devices.field.model'), device.model, { dir: 'auto' }),
      row(t('devices.field.serialNumber'), device.serialNumber, { dir: 'ltr' }),
      row(t('devices.field.purchaseDate'), formatCalendarDate(device.purchaseDate, locale)),
      row(t('devices.field.purchasePrice'), formatPrice(device.purchasePrice, device.currency || homeCurrency, locale)),
      row(t('devices.field.installationDate'), formatCalendarDate(device.installationDate, locale)),
      row(t('devices.field.warrantyExpiry'), formatCalendarDate(device.warrantyExpiry, locale))),
    h('div', { class: 'room-detail__notes' },
      h('p', { class: 'field__label' }, t('devices.field.notes')),
      h('p', { class: 'room-detail__notes-text', dir: 'auto' }, device.notes || none)),
    cleaningSlot,
    // Phase 5.5: Maintenance is live (supplied by the Maintenance module through its service).
    maintenanceSlot);

  const footer = [];
  if (active && permissions.can('devices.delete')) {
    footer.push(h('button', { type: 'button', class: 'btn btn--danger-ghost', onClick: async () => { dlg.close(); await archiveDevice({ store, device, container }); } },
      icon('archive', { size: 18 }), t('devices.archive')));
  }
  if (!active && permissions.can('devices.restore')) {
    footer.push(h('button', { type: 'button', class: 'btn btn--secondary', onClick: async () => { dlg.close(); await restoreDevice({ store, device }); } },
      icon('restore', { size: 18 }), t('rooms.restore')));
  }
  if (active && permissions.can('devices.edit')) {
    footer.push(h('button', { type: 'button', class: 'btn btn--primary', onClick: () => { dlg.close(); openDeviceForm({ store, rooms, device: store.get(device.id) || device, homeCurrency, container }); } },
      icon('edit', { size: 18 }), t('rooms.edit')));
  }
  let closed = false; let disposeCleaning = null; let disposeMaintenance = null;
  const dlg = openDialog({ title: t('devices.detailTitle'), content, footer, container, onClose: () => { closed = true; if (disposeCleaning) disposeCleaning(); if (disposeMaintenance) disposeMaintenance(); } });
  if (cleaningSection) {
    // Navigating from the section closes this dialog first (no orphaned dialog / listener).
    Promise.resolve(cleaningSection(device, (path) => { dlg.close(); if (onNavigate) onNavigate(path); }))
      .then((sec) => { if (!sec) return; if (closed) { sec.dispose(); return; } disposeCleaning = sec.dispose; cleaningSlot.replaceChildren(sec.el); })
      .catch(() => { /* no cleaning access: the section is simply omitted */ });
  }
  if (maintenanceSection) {
    Promise.resolve(maintenanceSection(device, (path) => { dlg.close(); if (onNavigate) onNavigate(path); }))
      .then((sec) => { if (!sec) return; if (closed) { sec.dispose(); return; } disposeMaintenance = sec.dispose; maintenanceSlot.replaceChildren(sec.el); })
      .catch(() => { /* no maintenance access: the section is simply omitted */ });
  }
  return dlg;
}
