/** Small form-dialog helper shared by the finance tabs (validation messages, busy state). */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { openDialog } from '../../ui/components/dialog.js';
import { banner, errorText, setBusy } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';

export const vmsg = (err) => (err && err.detail && /^(finance|calendar|contacts)\./.test(String(err.detail)) ?   // V6.2: + calendar.*  V6.4 B: + contacts.*
  t(String(err.detail).split(',')[0]) : errorText(err));

/**
 * formDialog({ title, id, fields: Node[], submitLabel, onSubmit: async () => toastKey|void, container })
 * onSubmit may throw; the message is shown inside the dialog and the form stays open.
 */
export function formDialog({ title, id, fields, submitLabel, onSubmit, container }) {
  const messages = h('div', { class: 'gate__messages' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', form: id }, submitLabel);
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.cancel'));
  const form = h('form', {
    id, class: 'room-form', novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const restore = setBusy(submit, t('common.saving'));
      try {
        const key = await onSubmit();
        if (key === false) { restore(); return; }
        if (key) toast(t(key), { tone: 'success' });
        dlg.close();
      } catch (err) { restore(); messages.replaceChildren(banner('error', vmsg(err))); }
    },
  }, ...fields, messages);
  const dlg = openDialog({ title, content: form, footer: [cancel, submit], container });
  return dlg;
}

export const val = (root, sel) => root.querySelector(sel).value;
