/**
 * Writes for the core settings. Two scopes, never mixed:
 *
 *   USER preferences (users/{uid}):  displayName, language, theme
 *   HOME settings  (homes/{homeId} + settings/general): name, currency, timezone,
 *                  language (home default), weekStartsOn — requires home.edit
 *
 * members/{uid}.displayName is a denormalised copy of users/{uid}.displayName so other
 * members can list names without reading private user documents. It is kept in sync here,
 * in the same batch, and nowhere else.
 */
import { paths, SETTINGS_DOCS } from '../firebase/paths.js';
import { atomicWrite, patchDoc, serverTime } from '../data/firestore.js';
import { AppError, ErrorCode } from '../errors/app-error.js';
import {
  normalizeText, validateDisplayName, validateHomeName, isCurrencyCode, isLanguage, isTheme, isWeekday,
} from '../utils/validate.js';
import { defaultRoles } from '../../modules/index.js';
import { upgradeRolePermissions } from '../permissions/roles.js';

function invalid(detail) { return new AppError(ErrorCode.VALIDATION, { detail }); }

export async function saveDisplayName({ uid, homeId, displayName }) {
  const name = normalizeText(displayName);
  const err = validateDisplayName(name);
  if (err) throw invalid(err);
  const now = serverTime();
  await atomicWrite((w) => {
    w.update(paths.user(uid), { displayName: name, updatedAt: now });
    w.update(paths.member(homeId, uid), { displayName: name, updatedAt: now });
  });
  return name;
}

export async function savePreferences(uid, { language, theme }) {
  const data = { updatedAt: serverTime() };
  if (language !== undefined) {
    if (!isLanguage(language)) throw invalid('language');
    data.language = language;
  }
  if (theme !== undefined) {
    if (!isTheme(theme)) throw invalid('theme');
    data.theme = theme;
  }
  await patchDoc(paths.user(uid), data);
}

/** Requires home.edit (rules enforce it; the UI only offers it when permitted). */
export async function saveHomeSettings({ uid, homeId, name, currency, timezone, language, weekStartsOn }) {
  const homeName = normalizeText(name);
  const nameErr = validateHomeName(homeName);
  if (nameErr) throw invalid(nameErr);
  if (!isCurrencyCode(currency)) throw invalid('currency');
  if (typeof timezone !== 'string' || !timezone || timezone.length > 64) throw invalid('timezone');
  if (!isLanguage(language)) throw invalid('language');
  if (!isWeekday(weekStartsOn)) throw invalid('weekStartsOn');
  const now = serverTime();
  await atomicWrite((w) => {
    w.update(paths.home(homeId), { name: homeName, currency, timezone, language, updatedBy: uid, updatedAt: now });
    w.update(paths.setting(homeId, SETTINGS_DOCS.general), { weekStartsOn, updatedBy: uid, updatedAt: now });
  });
}

/**
 * Owner action "Update default roles". NON-DESTRUCTIVE (Phase 3): for each seeded system
 * role, only namespaces re-defined since that role's templateVersion are replaced by the
 * current template; every other grant (including hand-customised ones) is preserved.
 * Custom (non-system) roles are never touched. Requires roles.edit.
 *
 * @param {string} homeId
 * @param {Array} currentRoles roles as read from Firestore (id, permissions, templateVersion, system)
 */
export async function refreshSystemRoles(homeId, currentRoles) {
  const now = serverTime();
  const templates = defaultRoles();
  const byId = new Map((currentRoles || []).map((r) => [r.id, r]));
  await atomicWrite((w) => {
    for (const tpl of templates) {
      const cur = byId.get(tpl.id);
      if (!cur || cur.system !== true) continue;
      if ((cur.templateVersion || 0) >= tpl.templateVersion) continue;
      w.update(paths.role(homeId, tpl.id), {
        permissions: upgradeRolePermissions({ current: cur.permissions, template: tpl.permissions, from: cur.templateVersion || 0 }),
        templateVersion: tpl.templateVersion,
        updatedAt: now,
      });
    }
  });
}
