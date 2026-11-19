/**
 * Core settings only (no module settings in Phase 1):
 *   - Profile & preferences (USER scope, users/{uid})
 *   - Home (HOME scope, homes/{homeId} + settings/general) — editable with home.edit
 *   - Members & roles (read-only overview)
 *   - Account
 */
import { h } from '../../core/utils/dom.js';
import { t, getLanguage, getLocale } from '../../core/i18n/i18n.js';
import { APP, CURRENCIES, LIMITS } from '../../config/app-config.js';
import { ROLE_TEMPLATE_VERSION, OWNER_ROLE_ID } from '../../core/permissions/roles.js';
import { getThemePreference } from '../../core/settings/preferences.js';
import { validateDisplayName, validateHomeName } from '../../core/utils/validate.js';
import { textField, selectField, setBusy, roleLabel, errorText, banner } from '../components/common.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';

function section(id, title, description, ...content) {
  return h('section', { class: 'card settings-section', 'aria-labelledby': id },
    h('div', { class: 'card__head card__head--stack' },
      h('h2', { class: 'card__title', id }, title),
      description ? h('p', { class: 'card__hint' }, description) : null),
    ...content);
}

function weekdays() {
  const fmt = new Intl.DateTimeFormat(getLocale(), { weekday: 'long', timeZone: 'UTC' });
  return [6, 0, 1, 2, 3, 4, 5].map((i) => ({ value: i, label: fmt.format(new Date(Date.UTC(2023, 0, 1 + i))) }));
}

function timezones(current) {
  let list = [];
  try { list = Intl.supportedValuesOf('timeZone'); } catch { list = ['Africa/Cairo', 'UTC']; }
  if (!list.includes(current)) list = [current, ...list];
  return list.map((z) => ({ value: z, label: z }));
}

/** Segmented single-choice control (radio group). */
function segmented({ name, label, value, options, onChange }) {
  return h('fieldset', { class: 'segmented' },
    h('legend', { class: 'field__label' }, label),
    h('div', { class: 'segmented__track' },
      options.map((o) => h('label', { class: 'segmented__opt' },
        h('input', {
          type: 'radio', name, value: o.value, checked: o.value === value,
          onChange: (e) => e.target.checked && onChange(o.value),
        }),
        h('span', null, o.label)))));
}

async function run(button, busyLabel, fn, successKey) {
  const restore = setBusy(button, busyLabel);
  try {
    await fn();
    toast(t(successKey), { tone: 'success' });
    return true;
  } catch (err) {
    toast(errorText(err), { tone: 'error', timeout: 5000 });
    return false;
  } finally {
    restore();
  }
}

export function mountSettings(outlet, ctx) {
  const state = ctx.getState();
  const { identity, profile, home, homeSettings, role, permissions } = state;
  const canEditHome = permissions.can('home.edit');

  // ---- Profile ------------------------------------------------------------------------
  const name = textField({ id: 'st-name', label: t('settings.displayName'), value: profile.displayName, maxlength: LIMITS.displayName, autocomplete: 'name' });
  const saveName = h('button', { type: 'submit', class: 'btn btn--primary' }, t('common.save'));
  const profileForm = h('form', {
    class: 'form-row', novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const err = validateDisplayName(name.input.value);
      name.setError(err ? t(err) : '');
      if (err) return;
      await run(saveName, t('common.saving'), async () => {
        const saved = await ctx.services.saveDisplayName({ uid: identity.uid, homeId: home.id, displayName: name.input.value });
        name.input.value = saved;
        ctx.session.updateProfile({ displayName: saved });
      }, 'settings.saved');
    },
  }, name.root, saveName);

  const prefsBlock = h('div', { class: 'prefs' },
    segmented({
      name: 'st-lang', label: t('settings.language'), value: getLanguage(),
      options: [{ value: 'ar', label: t('lang.ar') }, { value: 'en', label: t('lang.en') }],
      onChange: (language) => ctx.prefs.set({ language }),
    }),
    segmented({
      name: 'st-theme', label: t('settings.theme'), value: getThemePreference(),
      options: [{ value: 'system', label: t('theme.system') }, { value: 'light', label: t('theme.light') }, { value: 'dark', label: t('theme.dark') }],
      onChange: (theme) => ctx.prefs.set({ theme }),
    }));

  // ---- Home ---------------------------------------------------------------------------
  let homeBlock;
  if (canEditHome) {
    const hName = textField({ id: 'st-home', label: t('settings.homeName'), value: home.name, maxlength: LIMITS.homeName });
    const currency = selectField({ id: 'st-currency', label: t('settings.currency'), value: home.currency,
      options: [...new Set([home.currency, ...CURRENCIES])].map((c) => ({ value: c, label: c })) });
    const tz = selectField({ id: 'st-tz', label: t('settings.timezone'), value: home.timezone, options: timezones(home.timezone) });
    tz.select.setAttribute('dir', 'ltr');
    const hLang = selectField({ id: 'st-home-lang', label: t('settings.homeLanguage'), value: home.language,
      options: [{ value: 'ar', label: t('lang.ar') }, { value: 'en', label: t('lang.en') }] });
    const week = selectField({ id: 'st-week', label: t('settings.weekStartsOn'), value: homeSettings ? homeSettings.weekStartsOn : 6, options: weekdays() });
    const saveHome = h('button', { type: 'submit', class: 'btn btn--primary' }, t('common.save'));
    homeBlock = h('form', {
      class: 'form-grid', novalidate: true,
      onSubmit: async (e) => {
        e.preventDefault();
        const err = validateHomeName(hName.input.value);
        hName.setError(err ? t(err) : '');
        if (err) return;
        const weekStartsOn = Number(week.select.value);
        await run(saveHome, t('common.saving'), async () => {
          await ctx.services.saveHomeSettings({
            uid: identity.uid, homeId: home.id, name: hName.input.value,
            currency: currency.select.value, timezone: tz.select.value, language: hLang.select.value, weekStartsOn,
          });
          ctx.session.updateHomeSettings({ weekStartsOn });
        }, 'settings.saved');
      },
    }, hName.root, currency.root, tz.root, hLang.root, week.root, h('div', { class: 'form-grid__actions' }, saveHome));
  } else {
    homeBlock = h('div', null,
      h('dl', { class: 'facts' },
        h('div', null, h('dt', null, t('settings.homeName')), h('dd', null, home.name)),
        h('div', null, h('dt', null, t('settings.currency')), h('dd', null, home.currency)),
        h('div', null, h('dt', null, t('settings.timezone')), h('dd', { dir: 'ltr' }, home.timezone)),
        h('div', null, h('dt', null, t('settings.homeLanguage')), h('dd', null, t(`lang.${home.language}`)))),
      h('p', { class: 'muted-note' }, icon('lock', { size: 16 }), t('settings.homeReadOnly')));
  }

  // ---- Members & roles ------------------------------------------------------------------
  const membersList = h('div', { class: 'list' });
  const rolesList = h('div', { class: 'list' });
  const rolesNotice = h('div');

  const page = h('div', { class: 'page page--settings' },
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-head__title' }, t('settings.title')),
      h('p', { class: 'page-head__sub' }, t('settings.subtitle'))),
    h('div', { class: 'settings-grid' },
      section('st-profile', t('settings.profile'), t('settings.profileHint'), profileForm, prefsBlock),
      section('st-homesec', t('settings.home'), t('settings.homeHint'), homeBlock),
      // Phase 4A: Family & Members lives on its own page; this card links to it.
      section('st-family', t('settings.family'), t('settings.familyHint'),
        h('a', { class: 'btn btn--secondary', href: '#/family', id: 'settings-family' }, t('settings.familyOpen'))),
      permissions.can('members.view') ? section('st-members', t('settings.members'), t('settings.membersHint'), membersList) : null,
      permissions.can('roles.view') ? section('st-roles', t('settings.roles'), t('settings.rolesHint'), rolesNotice, rolesList) : null,
      section('st-account', t('settings.account'), null,
        h('dl', { class: 'facts' },
          h('div', null, h('dt', null, t('login.email')), h('dd', { dir: 'ltr' }, identity.email)),
          h('div', null, h('dt', null, t('dashboard.yourRole')), h('dd', null, roleLabel(role)))),
        h('div', { class: 'form-row' },
          h('button', { type: 'button', class: 'btn btn--danger-ghost', onClick: () => ctx.session.signOut() }, icon('logout', { size: 18 }), t('common.signOut'))),
        h('p', { class: 'muted-note' }, t('settings.versionLine', { version: APP.version, phase: APP.phase })))));

  outlet.replaceChildren(page);

  let alive = true;
  if (permissions.can('members.view')) {
    membersList.replaceChildren(h('p', { class: 'empty' }, t('common.loading')));
    ctx.services.listMembers(home.id).then((members) => {
      if (!alive) return;
      membersList.replaceChildren(...members
        .sort((a, b) => (a.uid === identity.uid ? -1 : b.uid === identity.uid ? 1 : String(a.displayName).localeCompare(b.displayName)))
        .map((m) => h('div', { class: 'list__row' },
          h('div', { class: 'list__main' },
            h('p', { class: 'list__title' }, m.displayName, m.uid === identity.uid ? h('span', { class: 'pill' }, t('settings.you')) : null),
            h('p', { class: 'list__sub', dir: 'ltr' }, m.email)),
          h('div', { class: 'list__meta' },
            h('span', { class: 'pill pill--role' }, roleLabel({ id: m.roleId, name: m.roleId })),
            m.status !== 'active' ? h('span', { class: 'pill pill--warn' }, t(`status.${m.status}`)) : null))));
    }).catch((err) => { if (alive) membersList.replaceChildren(banner('error', errorText(err))); });
  }

  if (permissions.can('roles.view')) {
    rolesList.replaceChildren(h('p', { class: 'empty' }, t('common.loading')));
    ctx.services.listRoles(home.id).then((roles) => {
      if (!alive) return;
      roles.sort((a, b) => b.rank - a.rank);
      rolesList.replaceChildren(...roles.map((r) => h('details', { class: 'role' },
        h('summary', { class: 'role__summary' },
          h('span', { class: 'role__name' }, roleLabel(r)),
          h('span', { class: 'role__count' }, r.id === OWNER_ROLE_ID ? t('settings.allPermissions') : t('settings.permissionCount', { n: r.permissions.length }))),
        h('p', { class: 'role__desc' }, t(`roleDesc.${r.id}`)),
        h('ul', { class: 'role__perms', dir: 'ltr' }, r.permissions.map((p) => h('li', null, p))))));

      const outdated = roles.some((r) => r.system && (r.templateVersion || 0) < ROLE_TEMPLATE_VERSION);
      if (outdated && permissions.can('roles.edit')) {
        const btn = h('button', { type: 'button', class: 'btn btn--secondary' }, t('settings.updateRoles'));
        btn.addEventListener('click', () => run(btn, t('common.saving'), () => ctx.services.refreshSystemRoles(home.id, roles), 'settings.rolesUpdated'));
        rolesNotice.replaceChildren(h('div', { class: 'banner banner--info' }, h('span', null, t('settings.rolesOutdated')), btn));
      }
    }).catch((err) => { if (alive) rolesList.replaceChildren(banner('error', errorText(err))); });
  }

  return { destroy() { alive = false; } };
}
