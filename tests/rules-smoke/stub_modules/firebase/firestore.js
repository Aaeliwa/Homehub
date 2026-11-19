// In-memory stand-in for the Firebase JS SDK used ONLY to execute the rules test file's JavaScript
// (fixtures, helpers, imports). It does NOT evaluate security rules. It mirrors the SDK's input
// validation: undefined values, non-plain objects and invalid paths are rejected like the real SDK.
export const store = new Map();
const SENT = Symbol('serverTimestamp');
export function serverTimestamp() { return { [SENT]: true }; }
function validate(v, path) {
  if (v === undefined) throw new Error(`Function setDoc() called with invalid data. Unsupported field value: undefined (found in field ${path})`);
  if (v && typeof v === 'object' && !(v instanceof Date) && !v[SENT]) {
    if (Array.isArray(v)) v.forEach((x, i) => { if (Array.isArray(x)) throw new Error(`Nested arrays are not supported (field ${path})`); validate(x, `${path}.${i}`); });
    else for (const [k, x] of Object.entries(v)) validate(x, path ? `${path}.${k}` : k);
  }
}
function segs(parent, parts) {
  const all = [...(parent && parent.__path ? parent.__path : []), ...parts];
  for (const p of all) if (typeof p !== 'string' || !p || p.includes('/')) throw new Error(`Invalid path segment: ${String(p)}`);
  return all;
}
export function doc(parent, ...parts) { const p = segs(parent, parts); const inst = parent && parent.__inst; if (parent && '__used' in parent) parent.__used = true; if (p.length % 2) throw new Error(`Invalid document reference (odd segments): ${p.join('/')}`); return { __path: p, __kind: 'doc', id: p.at(-1), path: p.join('/'), __inst: inst }; }
export function collection(parent, ...parts) { const p = segs(parent, parts); const inst = parent && parent.__inst; if (parent && '__used' in parent) parent.__used = true; if (!(p.length % 2)) throw new Error(`Invalid collection reference: ${p.join('/')}`); return { __path: p, __kind: 'col', path: p.join('/'), __inst: inst }; }
export function where(field, op, value) { if (value === undefined) throw new Error(`Function where() called with invalid data. Unsupported field value: undefined`); return { field, op, value }; }
export function query(col, ...c) { return { ...col, __kind: 'query', c }; }
const snap = (r) => ({ exists: () => store.has(r.path), data: () => store.get(r.path), id: r.id });
export async function getDoc(r) { if (r.__kind !== 'doc') throw new Error('getDoc needs a document reference'); return snap(r); }
export async function getDocs(q) { const pre = q.path + '/'; return { docs: [...store.keys()].filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map((k) => ({ id: k.split('/').at(-1), data: () => store.get(k) })) }; }
export async function setDoc(r, data, opts) { validate(data, ''); store.set(r.path, opts && opts.merge ? { ...(store.get(r.path) || {}), ...data } : { ...data }); }
export async function updateDoc(r, data) { validate(data, ''); if (!store.has(r.path)) throw Object.assign(new Error('not-found'), { code: 'not-found' }); store.set(r.path, { ...store.get(r.path), ...data }); }
export async function deleteDoc(r) { store.delete(r.path); }
export function writeBatch(fs) {
  const ops = []; let done = false;
  const own = (r) => { if (fs && r.__inst !== fs.__inst) throw new Error('FirebaseError: Provided document reference is from a different Firestore instance.'); };
  return {
    set(r, d, o) { own(r); if (done) throw new Error('batch already committed'); validate(d, ''); ops.push(() => setDoc(r, d, o)); return this; },
    update(r, d) { own(r); validate(d, ''); ops.push(() => updateDoc(r, d)); return this; },
    delete(r) { ops.push(() => deleteDoc(r)); return this; },
    async commit() { if (done) throw new Error('A write batch can no longer be used after commit() has been called.'); done = true; for (const o of ops) await o(); },
  };
}
