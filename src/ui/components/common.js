/** Small shared UI pieces used across screens and pages. */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { icon } from './icons.js';

export function brandMark(size = 'md') {
  return h('div', { class: ['brand-mark', `brand-mark--${size}`], 'aria-hidden': 'true' }, '🏠');
}

export function spinner(label) {
  return h('div', { class: 'spinner', role: 'progressbar', 'aria-label': label || t('common.loading') });
}

/** Inline error/notice banner for forms. `messageKey` is an i18n key. */
export function banner(tone, text) {
  return h('div', { class: ['banner', `banner--${tone}`], role: tone === 'error' ? 'alert' : 'status' },
    tone === 'error' ? icon('alert', { size: 18 }) : icon('check', { size: 18 }),
    h('span', null, text));
}

/** Translated message for an AppError: prefers error.<CODE>.body. */
export function errorText(err) {
  return t(`error.${err && err.code ? err.code : 'UNKNOWN'}.body`);
}

/** Labelled text field. Returns { root, input, setError }. */
export function textField({ id, label, type = 'text', value = '', autocomplete, maxlength, required, hint, dir }) {
  const errorEl = h('p', { class: 'field__error', id: `${id}-error`, hidden: true });
  const input = h('input', {
    id, name: id, type, value, autocomplete, maxlength, required, dir,
    class: 'input', 'aria-describedby': hint ? `${id}-hint ${id}-error` : `${id}-error`,
  });
  const root = h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    input,
    hint ? h('p', { class: 'field__hint', id: `${id}-hint` }, hint) : null,
    errorEl);
  return {
    root,
    input,
    setError(text) {
      errorEl.textContent = text || '';
      errorEl.hidden = !text;
      input.setAttribute('aria-invalid', text ? 'true' : 'false');
    },
  };
}

export function selectField({ id, label, value, options, disabled }) {
  const select = h('select', { id, name: id, class: 'input', disabled },
    options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  return {
    root: h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), select),
    select,
  };
}

/** Set a button into a busy state (spinner + disabled) and return a restore function. */
export function setBusy(button, busyLabel) {
  const original = Array.from(button.childNodes);
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.replaceChildren(h('span', { class: 'spinner spinner--inline', 'aria-hidden': 'true' }), busyLabel);
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.replaceChildren(...original);
  };
}

/** Language + theme quick toggles, used on pre-auth screens and in the header. */
export function quickToggles({ onToggleLanguage, onToggleTheme, isDark }) {
  return h('div', { class: 'quick-toggles' },
    h('button', {
      type: 'button', class: 'chip-btn', onClick: onToggleLanguage,
      'aria-label': t('prefs.switchLanguage'), title: t('prefs.switchLanguage'),
    }, icon('globe', { size: 16 }), h('span', null, t('prefs.otherLanguageShort'))),
    h('button', {
      type: 'button', class: 'chip-btn chip-btn--icon', onClick: onToggleTheme,
      'aria-label': isDark ? t('prefs.useLight') : t('prefs.useDark'),
      title: isDark ? t('prefs.useLight') : t('prefs.useDark'),
    }, icon(isDark ? 'sun' : 'moon', { size: 16 })));
}

/** Display label for a role: translated for system roles, stored name otherwise. */
export function roleLabel(role) {
  if (!role) return '';
  const key = `role.${role.id}`;
  const label = t(key);
  return label === key ? (role.name || role.id) : label;
}

/** Up to two initials for an avatar. */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
