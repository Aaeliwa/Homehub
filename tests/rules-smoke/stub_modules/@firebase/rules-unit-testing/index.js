// Stand-in: rules are NOT evaluated. assertSucceeds/assertFails only run the promise so JS-level
// errors (ReferenceError, invalid data, bad references) surface. Outcome assertions are skipped.
import { store } from 'firebase/firestore';
export const smoke = { jsErrors: [] };
const JS = /is not defined|is not a function|Cannot read prop|invalid data|Unsupported field value|Invalid path|Invalid document reference|Invalid collection reference|Nested arrays|needs a document|batch already|can no longer be used|different Firestore instance|already been started|invalid data/i;
async function run(p, kind) { try { await p; } catch (e) { if (JS.test(String(e && e.message))) throw e; } }
export const assertSucceeds = (p) => run(p, 'succeeds');
export const assertFails = (p) => run(p, 'fails');
export async function initializeTestEnvironment(cfg) {
  if (!cfg || !cfg.projectId || !cfg.firestore || typeof cfg.firestore.rules !== 'string') throw new Error('initializeTestEnvironment: invalid config');
  let n = 0;
  // Faithful to the real library (Phase 5.1.2):
  //  - each CONTEXT owns one app; calling context.firestore() again after that instance has been
  //    used throws "Firestore has already been started…";
  //  - withSecurityRulesDisabled() resolves to undefined (it does NOT return the callback's value).
  const ctx = () => {
    let inst = null;
    return { firestore: () => {
      if (inst && inst.__used) throw new Error('FirebaseError: Firestore has already been started and its settings can no longer be changed.');
      inst = { __path: [], __inst: ++n, __used: false };
      return inst;
    } };
  };
  return {
    authenticatedContext: (uid, claims) => { if (!uid) throw new Error('uid required'); return ctx(); },
    unauthenticatedContext: ctx,
    withSecurityRulesDisabled: async (fn) => { await fn(ctx()); },
    clearFirestore: async () => store.clear(),
    cleanup: async () => {},
  };
}
