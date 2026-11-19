/**
 * Single Firebase initialisation point. initFirebase() is idempotent; the app, auth and
 * firestore instances are created exactly once per page. Feature modules must NEVER call
 * initializeApp themselves — they use the shared services (auth-service, data/firestore).
 */
import * as sdk from './sdk.js';
import { firebaseConfig } from '../../config/firebase-config.js';
import { AppError, ErrorCode } from '../errors/app-error.js';
import { log } from '../utils/logger.js';

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];
let instance = null;

export function initFirebase() {
  if (instance) return instance;
  const missing = REQUIRED_KEYS.filter((k) => !firebaseConfig[k]);
  if (missing.length) {
    throw new AppError(ErrorCode.FIREBASE_INIT_FAILED, { detail: `config missing: ${missing.join(', ')}` });
  }
  try {
    const app = sdk.initializeApp(firebaseConfig);
    instance = Object.freeze({ app, auth: sdk.getAuth(app), db: sdk.getFirestore(app) });
  } catch (cause) {
    throw new AppError(ErrorCode.FIREBASE_INIT_FAILED, { cause });
  }
  log.info('Firebase initialized', `(project: ${firebaseConfig.projectId})`);
  return instance;
}

export function getFirebase() {
  if (!instance) throw new AppError(ErrorCode.FIREBASE_INIT_FAILED, { detail: 'getFirebase() before initFirebase()' });
  return instance;
}
