/**
 * Shared Firestore data-access layer. UI code never calls the Firestore SDK directly;
 * repositories (core/home/*, future modules' repositories) go through these helpers.
 *
 * - Documents are returned as plain objects `{ id, ...data }` or `null` when missing.
 * - Errors are normalised to AppError.
 * - serverTimestamp() is the only clock used for createdAt/updatedAt (rules require it).
 */
import * as sdk from '../firebase/sdk.js';
import { getFirebase } from '../firebase/firebase.js';
import { toAppError } from '../errors/app-error.js';
import { pathToString } from '../firebase/paths.js';

const db = () => getFirebase().db;
const docRef = (segments) => sdk.doc(db(), ...segments);
const colRef = (segments) => sdk.collection(db(), ...segments);

// serverTimestamps: 'estimate' — a just-written document shows a local estimate instead of
// null until the server confirms, so UI never sees half-formed timestamps.
const SNAP_OPTS = { serverTimestamps: 'estimate' };

function toPlain(snap) {
  return snap.exists() ? { id: snap.id, ...snap.data(SNAP_OPTS) } : null;
}

export const serverTime = () => sdk.serverTimestamp();

/** Generate a new random document id inside a collection without writing anything. */
export function newDocId(collectionSegments) {
  return sdk.doc(colRef(collectionSegments)).id;
}

export async function readDoc(segments) {
  try {
    return toPlain(await sdk.getDoc(docRef(segments)));
  } catch (err) {
    throw toAppError(err);
  }
}

export async function readCollection(segments) {
  try {
    const snap = await sdk.getDocs(colRef(segments));
    return snap.docs.map((d) => ({ id: d.id, ...d.data(SNAP_OPTS) }));
  } catch (err) {
    throw toAppError(err);
  }
}

/** Live document listener. Returns an unsubscribe function. */
export function watchDoc(segments, onValue, onError) {
  return sdk.onSnapshot(
    docRef(segments),
    (snap) => onValue(toPlain(snap)),
    (err) => onError && onError(toAppError(err)),
  );
}

/**
 * Live listener on a whole collection (no query constraints, so no index needed).
 * onValue receives an array of plain documents. Returns an unsubscribe function.
 */
export function watchCollection(segments, onValue, onError) {
  return sdk.onSnapshot(
    colRef(segments),
    (snap) => onValue(snap.docs.map((d) => ({ id: d.id, ...d.data(SNAP_OPTS) }))),
    (err) => onError && onError(toAppError(err)),
  );
}

/**
 * V6.4 B: BOUNDED live listener — one equality constraint + a document limit (no orderBy, so no index).
 * Used where a household collection can grow (shared contacts); callers show a notice at the limit.
 */
export function watchWhereLimited(segments, [field, op, value], max, onValue, onError) {
  return sdk.onSnapshot(
    sdk.query(colRef(segments), sdk.where(field, op, value), sdk.limit(max)),
    (snap) => onValue(snap.docs.map((d) => ({ id: d.id, ...d.data(SNAP_OPTS) }))),
    (err) => onError && onError(toAppError(err)),
  );
}
/** V6.4 B: one-shot bounded read with one equality constraint (e.g. recently deleted contacts). */
export async function readWhereLimited(segments, [field, op, value], max) {
  try {
    const snap = await sdk.getDocs(sdk.query(colRef(segments), sdk.where(field, op, value), sdk.limit(max)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data(SNAP_OPTS) }));
  } catch (err) { throw toAppError(err); }
}

/**
 * V6.5 P02: BOUNDED live listener WITH snapshot metadata (includeMetadataChanges). onValue(docs, meta):
 *   meta.fromCache        — the snapshot came from the local cache (not confirmed by the server)
 *   meta.hasPendingWrites — the snapshot contains local writes the server has not acknowledged yet
 *   meta.pendingIds       — ids of the documents with pending local writes
 * Nothing here treats navigator.onLine as server confirmation. Existing helpers are unchanged.
 */
export function watchWhereLimitedMeta(segments, [field, op, value], max, onValue, onError) {
  return sdk.onSnapshot(
    sdk.query(colRef(segments), sdk.where(field, op, value), sdk.limit(max)),
    { includeMetadataChanges: true },
    (snap) => onValue(snap.docs.map((d) => ({ id: d.id, ...d.data(SNAP_OPTS) })), {
      fromCache: !!(snap.metadata && snap.metadata.fromCache),
      hasPendingWrites: !!(snap.metadata && snap.metadata.hasPendingWrites),
      pendingIds: snap.docs.filter((d) => d.metadata && d.metadata.hasPendingWrites).map((d) => d.id),
    }),
    (err) => onError && onError(toAppError(err)),
  );
}
/** V6.5 P02: one-shot BOUNDED, ORDERED read: one equality constraint + orderBy + limit (needs a composite index). */
export async function readWhereOrderedLimited(segments, [field, op, value], [orderField, direction], max) {
  try {
    const snap = await sdk.getDocs(sdk.query(colRef(segments), sdk.where(field, op, value), sdk.orderBy(orderField, direction), sdk.limit(max)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data(SNAP_OPTS) }));
  } catch (err) { throw toAppError(err); }
}
/**
 * V6.5 P02: SERVER-CONFIRMED document read (getDocFromServer): never answered from the local cache; rejects when the
 * server cannot be reached. Used to reconcile an ambiguous write (did MY movement land?).
 */
export async function readDocServer(segments) {
  try {
    return toPlain(await sdk.getDocFromServer(docRef(segments)));
  } catch (err) {
    throw toAppError(err);
  }
}

/**
 * Live listener on a collection filtered by ONE equality/array-contains constraint
 * ([field, op, value]). Phase 4: needed so finance queries are provably within the rules
 * (rules are not filters). Single-field constraints need no composite index.
 */
export function watchWhere(segments, [field, op, value], onValue, onError) {
  return sdk.onSnapshot(
    sdk.query(colRef(segments), sdk.where(field, op, value)),
    (snap) => onValue(snap.docs.map((d) => ({ id: d.id, ...d.data(SNAP_OPTS) }))),
    (err) => onError && onError(toAppError(err)),
  );
}

/** Create a new document with a Firestore-generated id. Resolves to the new id. */
export async function createDoc(collectionSegments, data) {
  const ref = sdk.doc(colRef(collectionSegments));
  try {
    await sdk.setDoc(ref, data);
  } catch (err) {
    throw toAppError(err);
  }
  return ref.id;
}

export async function patchDoc(segments, data) {
  try {
    await sdk.updateDoc(docRef(segments), data);
  } catch (err) {
    throw toAppError(err);
  }
}

/**
 * Atomic multi-document write. `build` receives a small writer with set/update that
 * accept path segments; all writes commit together or not at all.
 */
export async function atomicWrite(build) {
  const batch = sdk.writeBatch(db());
  const writer = {
    set: (segments, data) => { batch.set(docRef(segments), data); return writer; },
    update: (segments, data) => { batch.update(docRef(segments), data); return writer; },
    // Phase 5.6: used ONLY for owner-only reminder presentation state (a static test enforces this).
    // Every module collection's rules still say `allow delete: if false`.
    delete: (segments) => { batch.delete(docRef(segments)); return writer; },
  };
  build(writer);
  try {
    await batch.commit();
  } catch (err) {
    throw toAppError(err);
  }
}

export { pathToString };
