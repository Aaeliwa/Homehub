/**
 * Add / edit room dialog. Writes nothing until the user presses the submit button.
 * The form validates with the same model the store uses; the rules validate again.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { openDialog } from '../../ui/components/dialog.js';
import { textField, selectField, banner, errorText, setBusy } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import {
  ROOM_TYPES, ROOM_ICONS, ROOM_ICON_IDS, ROOM_LIMITS, FLOOR_SUGGESTION_KEYS,
  defaultIconForType, validateRoomInput,
} from './room-model.js';
import { typeLabel, iconLabel } from './room-labels.js';

/**
 * @param {object} o
 * @param {object} o.store      rooms store
 * @param {object} [o.room]     room to edit (omit to create)
 * @param {object} [o.preset]   { type, name } starting values for a new room
 * @param {Element} o.container
 */
export function openRoomForm({ store, room, preset = {}, container }) {
  const editing = Boolean(room);
  const base = editing ? { ...room } : null; // what the user saw when the form opened
  const start = editing ? room : { type: preset.type || 'living_room', name: preset.name || '', floor: null, notes: null };
  let iconTouched = editing && room.icon !== defaultIconForType(room.type);

  const name = textField({ id: 'room-name', label: t('rooms.field.name'), value: start.name, maxlength: ROOM_LIMITS.name, required: true });
  name.input.setAttribute('dir', 'auto');
  const type = selectField({
    id: 'room-type', label: t('rooms.field.type'), value: start.type,
    options: ROOM_TYPES.map((rt) => ({ value: rt.id, label: typeLabel(rt.id) })),
  });

  // Icon picker: a native radio group (keyboard arrows work; each option is labelled).
  const currentIcon = editing ? (ROOM_ICONS[room.icon] ? room.icon : defaultIconForType(room.type)) : defaultIconForType(start.type);
  const iconError = h('p', { class: 'field__error', hidden: true });
  const icons = h('fieldset', { class: 'icon-picker' },
    h('legend', { class: 'field__label' }, t('rooms.field.icon')),
    h('div', { class: 'icon-picker__grid' },
      ROOM_ICON_IDS.map((id) => h('label', { class: 'icon-picker__opt', title: iconLabel(id) },
        h('input', {
          type: 'radio', name: 'room-icon', value: id, checked: id === currentIcon, 'aria-label': iconLabel(id),
          onChange: () => { iconTouched = true; },
        }),
        h('span', { 'aria-hidden': 'true' }, ROOM_ICONS[id])))),
    iconError);
  const selectIcon = (id) => { const r = icons.querySelector(`input[value="${id}"]`); if (r) r.checked = true; };
  type.select.addEventListener('change', () => { if (!iconTouched) selectIcon(defaultIconForType(type.select.value)); });

  const floor = textField({ id: 'room-floor', label: t('rooms.field.floor'), value: start.floor || '', maxlength: ROOM_LIMITS.floor, hint: t('rooms.field.floorHint') });
  floor.input.setAttribute('list', 'room-floor-suggestions');
  floor.input.setAttribute('dir', 'auto');
  const floorList = h('datalist', { id: 'room-floor-suggestions' }, FLOOR_SUGGESTION_KEYS.map((k) => h('option', { value: t(`rooms.floor.${k}`) })));

  const notesId = 'room-notes';
  const notesError = h('p', { class: 'field__error', id: `${notesId}-error`, hidden: true });
  const notes = h('textarea', { id: notesId, class: 'input input--area', rows: 3, maxlength: ROOM_LIMITS.notes, dir: 'auto', 'aria-describedby': `${notesId}-error` });
  notes.value = start.notes || '';
  const notesField = h('div', { class: 'field' }, h('label', { class: 'field__label', for: notesId }, t('rooms.field.notes')), notes, notesError);

  const messages = h('div', { class: 'gate__messages' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', form: 'room-form' }, editing ? t('common.save') : t('rooms.add'));
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.cancel'));

  const setErr = (field, el, key) => {
    const text = key ? t(key) : '';
    if (field) field.setError(text);
    else { el.textContent = text; el.hidden = !text; }
  };

  const form = h('form', {
    id: 'room-form', class: 'room-form', novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const input = {
        name: name.input.value,
        type: type.select.value,
        icon: (icons.querySelector('input:checked') || {}).value,
        floor: floor.input.value,
        notes: notes.value,
      };
      const { errors } = validateRoomInput(input);
      setErr(name, null, errors.name);
      setErr(null, iconError, errors.icon);
      setErr(floor, null, errors.floor);
      setErr(null, notesError, errors.notes);
      if (Object.keys(errors).length) {
        if (errors.name) name.input.focus();
        return;
      }
      const restore = setBusy(submit, t('common.saving'));
      cancel.disabled = true;
      try {
        if (editing) {
          const changed = await store.update(room.id, input, base);
          toast(t(changed ? 'rooms.toast.saved' : 'rooms.toast.noChanges'), { tone: changed ? 'success' : 'info' });
        } else {
          await store.create(input);
          toast(t('rooms.toast.added'), { tone: 'success' });
        }
        dlg.close();
      } catch (err) {
        restore();
        cancel.disabled = false;
        messages.replaceChildren(banner('error', errorText(err)));
      }
    },
  }, name.root, type.root, icons, floor.root, floorList, notesField, messages);

  const dlg = openDialog({
    title: editing ? t('rooms.editTitle') : t('rooms.addTitle'),
    content: form,
    footer: [cancel, submit],
    container,
  });
  return dlg;
}
