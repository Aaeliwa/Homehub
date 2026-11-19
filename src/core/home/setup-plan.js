/**
 * Pure plan of the first-time setup batch (no Firebase imports, unit-testable).
 * setup-service.js commits exactly these writes atomically.
 */
import { APP, DEFAULTS } from '../../config/app-config.js';
import { paths, SETTINGS_DOCS } from '../firebase/paths.js';
import { AppError, ErrorCode } from '../errors/app-error.js';
import { normalizeText, validateDisplayName, validateHomeName, isLanguage, isTheme } from '../utils/validate.js';
import { OWNER_ROLE_ID } from '../permissions/roles.js';

/**
 * Pure: compute every document the setup batch writes. `now` is the timestamp sentinel.
 * Returned as [{ path, data, mode: 'set'|'update' }] for testing and for the batch.
 */
export function buildSetupWrites({ identity, existingProfile, displayName, homeName, language, theme, homeId, roles, now }) {
  const name = normalizeText(displayName);
  const home = normalizeText(homeName);
  const nameErr = validateDisplayName(name);
  const homeErr = validateHomeName(home);
  if (nameErr || homeErr) throw new AppError(ErrorCode.VALIDATION, { detail: nameErr || homeErr });
  if (!roles.some((r) => r.id === OWNER_ROLE_ID)) throw new AppError(ErrorCode.SETUP_FAILED, { detail: 'owner role missing' });

  const uid = identity.uid;
  const writes = [];

  writes.push({ mode: 'set', path: paths.home(homeId), data: {
    name: home,
    createdBy: uid,
    updatedBy: uid,
    currency: DEFAULTS.currency,
    timezone: DEFAULTS.timezone,
    language: DEFAULTS.language,
    schemaVersion: APP.schemaVersion,
    createdAt: now,
    updatedAt: now,
  } });

  writes.push({ mode: 'set', path: paths.member(homeId, uid), data: {
    uid,
    email: identity.email,
    displayName: name,
    roleId: OWNER_ROLE_ID,
    status: 'active',
    addedBy: uid,
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
  } });

  for (const role of roles) {
    writes.push({ mode: 'set', path: paths.role(homeId, role.id), data: {
      name: role.name,
      rank: role.rank,
      permissions: role.permissions,
      system: role.system,
      templateVersion: role.templateVersion,
      createdAt: now,
      updatedAt: now,
    } });
  }

  writes.push({ mode: 'set', path: paths.setting(homeId, SETTINGS_DOCS.general), data: {
    weekStartsOn: DEFAULTS.weekStartsOn,
    schemaVersion: APP.schemaVersion,
    updatedBy: uid,
    createdAt: now,
    updatedAt: now,
  } });

  if (existingProfile) {
    writes.push({ mode: 'update', path: paths.user(uid), data: {
      displayName: name,
      defaultHomeId: homeId,
      updatedAt: now,
    } });
  } else {
    writes.push({ mode: 'set', path: paths.user(uid), data: {
      email: identity.email,
      displayName: name,
      defaultHomeId: homeId,
      language: isLanguage(language) ? language : DEFAULTS.language,
      theme: isTheme(theme) ? theme : DEFAULTS.theme,
      schemaVersion: APP.schemaVersion,
      createdAt: now,
      updatedAt: now,
    } });
  }
  return writes;
}
