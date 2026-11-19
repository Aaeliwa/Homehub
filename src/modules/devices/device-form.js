/**
 * Add / edit device dialog. Progressive disclosure: basic information first, "Additional
 * information" collapsed (opened automatically when editing a device that has any).
 * Nothing is written until Save. Rooms come from the shared rooms store.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { CURRENCIES } from '../../config/app-config.js';
import { openDialog } from '../../ui/components/dialog.js';
import { textField, selectField, banner, errorText, setBusy } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import {
  DEVICE_CATEGORY_IDS, DEVICE_STATUSES, DEVICE_ICONS, DEVICE_ICON_IDS, DEVICE_LIMITS,
  subtypesFor, defaultIconFor, validateDeviceInput, checkRoomAssignment,
} from './device-model.js';
import { categoryLabel, subtypeLabel, statusLabel, iconLabel } from './device-labels.js';

const EXTRA_FIELDS = ['brand', 'model', 'serialNumber', 'purchaseDate', 'installationDate', 'purchasePrice', 'warrantyExpiry', 'notes'];

export function openDeviceForm({ store, rooms, device, preset = {}, homeCurrency, container }) {
  const editing = Boolean(device);
  const base = editing ? { ...device } : null;
  const start = editing ? device : {
    name: preset.name || '', category: preset.category || 'other', subtype: preset.subtype || null,
    roomId: preset.roomId || null, status: 'operational',
  };
  let iconTouched = editing && device.icon !== defaultIconFor(device.category, device.subtype);

  const name = textField({ id: 'dev-name', label: t('devices.field.name'), value: start.name, maxlength: DEVICE_LIMITS.name, required: true });
  name.input.setAttribute('dir', 'auto');
  const category = selectField({ id: 'dev-category', label: t('devices.field.category'), value: start.category,
    options: DEVICE_CATEGORY_IDS.map((c) => ({ value: c, label: categoryLabel(c) })) });
  const subtype = selectField({ id: 'dev-subtype', label: t('devices.field.subtype'), value: start.subtype || '', options: [] });
  function fillSubtypes(selected) {
    const list = subtypesFor(category.select.value);
    subtype.select.replaceChildren(
      h('option', { value: '' }, t('devices.subtypeNone')),
      ...list.map((s) => h('option', { value: s, selected: s === selected }, subtypeLabel(s))));
    subtype.select.disabled = list.length === 0;
    if (!list.includes(selected)) subtype.select.value = '';
  }
  fillSubtypes(start.subtype || '');

  // Rooms: Unassigned + ACTIVE rooms. A current archived/missing room stays selectable
  // only for the device that already references it (rules allow keeping it).
  const activeRooms = rooms.active();
  const roomOptions = [{ value: '', label: t('devices.unassigned') }, ...activeRooms.map((r) => ({ value: r.id, label: r.name }))];
  if (editing && device.roomId && !activeRooms.some((r) => r.id === device.roomId)) {
    const r = rooms.get(device.roomId);
    roomOptions.push({ value: device.roomId, label: r ? t('devices.roomArchivedLabel', { name: r.name }) : t('devices.roomUnknown') });
  }
  const room = selectField({ id: 'dev-room', label: t('devices.field.room'), value: start.roomId || '', options: roomOptions });
  const roomError = h('p', { class: 'field__error', hidden: true });
  room.root.appendChild(roomError);
  const status = selectField({ id: 'dev-status', label: t('devices.field.status'), value: start.status,
    options: DEVICE_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })) });

  // Icon picker (radio group) — follows category/subtype until the user picks one.
  const currentIcon = editing ? (DEVICE_ICONS[device.icon] ? device.icon : defaultIconFor(device.category, device.subtype)) : defaultIconFor(start.category, start.subtype);
  const icons = h('fieldset', { class: 'icon-picker' },
    h('legend', { class: 'field__label' }, t('devices.field.icon')),
    h('div', { class: 'icon-picker__grid' }, DEVICE_ICON_IDS.map((id) => h('label', { class: 'icon-picker__opt', title: iconLabel(id) },
      h('input', { type: 'radio', name: 'dev-icon', value: id, checked: id === currentIcon, 'aria-label': iconLabel(id), onChange: () => { iconTouched = true; } }),
      h('span', { 'aria-hidden': 'true' }, DEVICE_ICONS[id])))));
  const syncIcon = () => {
    if (iconTouched) return;
    const r = icons.querySelector(`input[value="${defaultIconFor(category.select.value, subtype.select.value || null)}"]`);
    if (r) r.checked = true;
  };
  category.select.addEventListener('change', () => { fillSubtypes(''); syncIcon(); });
  subtype.select.addEventListener('change', syncIcon);

  const tf = (id, key, opts = {}) => {
    const f = textField({ id: `dev-${id}`, label: t(`devices.field.${key}`), value: (editing && device[key] != null) ? String(device[key]) : '', ...opts });
    return f;
  };
  const brand = tf('brand', 'brand', { maxlength: DEVICE_LIMITS.brand });
  const model = tf('model', 'model', { maxlength: DEVICE_LIMITS.model, dir: 'auto' });
  const serial = tf('serial', 'serialNumber', { maxlength: DEVICE_LIMITS.serialNumber, dir: 'ltr' });
  const purchaseDate = tf('purchase-date', 'purchaseDate', { type: 'date' });
  const installDate = tf('install-date', 'installationDate', { type: 'date' });
  const warranty = tf('warranty', 'warrantyExpiry', { type: 'date' });
  const price = tf('price', 'purchasePrice', { hint: t('devices.field.priceHint'), dir: 'ltr' });
  price.input.setAttribute('inputmode', 'decimal');
  const curValue = (editing && device.currency) || homeCurrency || 'EGP';
  const currency = selectField({ id: 'dev-currency', label: t('devices.field.currency'), value: curValue,
    options: [...new Set([curValue, ...CURRENCIES])].map((c) => ({ value: c, label: c })) });
  const notesEl = h('textarea', { id: 'dev-notes', class: 'input input--area', rows: 3, maxlength: DEVICE_LIMITS.notes, dir: 'auto' });
  notesEl.value = (editing && device.notes) || '';
  const notesError = h('p', { class: 'field__error', hidden: true });
  const notes = h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'dev-notes' }, t('devices.field.notes')), notesEl, notesError);

  const hasExtra = editing && EXTRA_FIELDS.some((k) => device[k] !== null && device[k] !== undefined && device[k] !== '');
  const extra = h('details', { class: 'form-section', open: hasExtra },
    h('summary', { class: 'form-section__summary' }, t('devices.additionalInfo')),
    h('div', { class: 'form-grid form-grid--tight' }, brand.root, model.root, serial.root, purchaseDate.root, installDate.root, warranty.root, price.root, currency.root),
    icons, notes);

  const messages = h('div', { class: 'gate__messages' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', form: 'device-form' }, editing ? t('common.save') : t('devices.add'));
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.cancel'));

  const fieldsByKey = { name, brand, model, serialNumber: serial, purchaseDate, installationDate: installDate, warrantyExpiry: warranty, purchasePrice: price };
  const form = h('form', {
    id: 'device-form', class: 'room-form', novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const input = {
        name: name.input.value, category: category.select.value, subtype: subtype.select.value || null,
        roomId: room.select.value || null, status: status.select.value,
        icon: (icons.querySelector('input:checked') || {}).value,
        brand: brand.input.value, model: model.input.value, serialNumber: serial.input.value,
        purchaseDate: purchaseDate.input.value, installationDate: installDate.input.value, warrantyExpiry: warranty.input.value,
        purchasePrice: price.input.value, currency: currency.select.value, notes: notesEl.value,
      };
      const { value, errors } = validateDeviceInput(input);
      const roomErr = Object.keys(errors).length ? null
        : checkRoomAssignment({ roomId: value.roomId, previousRoomId: editing ? (device.roomId ?? null) : undefined, getRoom: rooms.get });
      for (const [k, f] of Object.entries(fieldsByKey)) f.setError(errors[k] ? t(errors[k]) : '');
      notesError.textContent = errors.notes ? t(errors.notes) : ''; notesError.hidden = !errors.notes;
      roomError.textContent = roomErr ? t(roomErr) : ''; roomError.hidden = !roomErr;
      if (Object.keys(errors).some((k) => k !== 'name') && !extra.open) extra.open = true;
      if (Object.keys(errors).length || roomErr) {
        const first = errors.name ? name.input : roomErr ? room.select : form.querySelector('[aria-invalid="true"]');
        if (first) first.focus();
        return;
      }
      const restore = setBusy(submit, t('common.saving'));
      cancel.disabled = true;
      try {
        if (editing) {
          const changed = await store.update(device.id, input, base);
          toast(t(changed ? 'devices.toast.saved' : 'rooms.toast.noChanges'), { tone: changed ? 'success' : 'info' });
        } else {
          await store.create(input);
          toast(t('devices.toast.added'), { tone: 'success' });
        }
        dlg.close();
      } catch (err) {
        restore();
        cancel.disabled = false;
        const msg = err && err.detail && String(err.detail).startsWith('devices.validation.') ? t(err.detail) : errorText(err);
        messages.replaceChildren(banner('error', msg));
      }
    },
  },
  h('p', { class: 'form-section__title' }, t('devices.basicInfo')),
  name.root, h('div', { class: 'form-grid form-grid--tight' }, category.root, subtype.root, room.root, status.root),
  extra, messages);

  const dlg = openDialog({ title: editing ? t('devices.editTitle') : t('devices.addTitle'), content: form, footer: [cancel, submit], container });
  return dlg;
}
