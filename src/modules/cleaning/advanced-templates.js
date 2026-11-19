/**
 * Advanced Cleaning → Templates and AI import tabs (Phase 5.4c). Uses ONLY the shared cleaning store.
 * Templates are definitions; applying / importing creates ordinary cleaningTasks (one confirmed write
 * each). No AI service is called: the prompt is copied by the user; pasted JSON is untrusted input.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { toast } from '../../ui/components/toast.js';
import { formDialog } from '../expenses/dialogs.js';
import { ROOM_TEMPLATES, DEVICE_TEMPLATES } from './cleaning-templates.js';
import { generatableAs, ROOM_TYPE_MAP, DEVICE_SUBTYPE_MAP } from './cleaning-integration.js';
import { buildApplyPlan, templateFromBuiltIn, validateTemplate } from './cleaning-custom.js';
import { parsePlan, buildImportPreview, buildPrompt, SAMPLE_PLAN, AREA_TYPES, DEVICE_TYPES, IMPORT_LIMITS } from './cleaning-ai-import.js';

const WHEN = ['afterDays', 'afterMonths', 'weekly', 'monthly', 'afterUse', 'inSeason', 'seasonStart', 'seasonEnd'];
const DEVICE_WHEN = ['afterUse', 'inSeason', 'seasonStart', 'seasonEnd'];
/** "When" choice ↔ recurrence + trigger + target (exactly the combinations the model and rules accept). */
export function whenToDef(when, { n = 1, weekday = 5, day = 1, target = 'room' } = {}) {
  const N = Number(n) || 1;
  switch (when) {
    case 'afterDays': return { recurrence: { kind: 'after', unit: 'day', interval: N }, trigger: null, target };
    case 'afterMonths': return { recurrence: { kind: 'after', unit: 'month', interval: N }, trigger: null, target };
    case 'weekly': return { recurrence: { kind: 'weeks', interval: 1, weekdays: [Number(weekday)] }, trigger: null, target };
    case 'monthly': return { recurrence: { kind: 'months', interval: 1, dayOfMonth: Number(day) }, trigger: null, target };
    case 'afterUse': return { recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse' }, target: 'device' };
    case 'inSeason': return { recurrence: { kind: 'after', unit: 'day', interval: N }, trigger: { kind: 'seasonal', phase: 'active' }, target: 'device' };
    case 'seasonStart': return { recurrence: { kind: 'onSeason' }, trigger: { kind: 'seasonal', phase: 'start' }, target: 'device' };
    case 'seasonEnd': return { recurrence: { kind: 'onSeason' }, trigger: { kind: 'seasonal', phase: 'end' }, target: 'device' };
    default: return null;
  }
}
export function defToWhen(tp) {
  const r = tp.recurrence || {}; const tr = tp.trigger;
  if (tr && tr.kind === 'afterUse') return { when: 'afterUse' };
  if (tr && tr.phase === 'start') return { when: 'seasonStart' };
  if (tr && tr.phase === 'end') return { when: 'seasonEnd' };
  if (tr && tr.phase === 'active') return { when: 'inSeason', n: r.interval || 1 };
  if (r.kind === 'weeks') return { when: 'weekly', weekday: (r.weekdays || [5])[0] };
  if (r.kind === 'months') return { when: 'monthly', day: r.dayOfMonth || 1 };
  if (r.kind === 'after' && r.unit === 'month') return { when: 'afterMonths', n: r.interval };
  if (r.kind === 'days') return { when: 'afterDays', n: r.interval };
  return { when: 'afterDays', n: r.interval || 1 };
}
const whenLabel = (tp) => { const w = defToWhen(tp); return t(`cleaning.tpl.when.${w.when}`, { n: w.n, weekday: t(`cleaning.wd.${w.weekday ?? 0}`), day: w.day }); };

export function createTemplateViews(env) {
  const { store, can, root, render, lang, roomList, deviceList, today, roomLabel } = env;
  // View state survives re-renders (live data updates rebuild the DOM): pasted text and UNticked items are kept.
  let applyState = null; let importState = { text: '', preview: null, mapping: {}, result: null, off: new Set() };
  let promptOpts = { lang, roomTypes: new Set(), names: false, deviceTypes: new Set(), minutes: '', style: '', problems: '', wantTemplates: false };

  function editDialog(tp, preset = null) {
    const base = tp || preset || { pack: '', title: '', titleEn: '', instructions: '', minutes: 10, priority: 'normal', target: 'room', recurrence: { kind: 'after', unit: 'day', interval: 7 }, trigger: null };
    const w = defToWhen(base);
    const inp = (id, v, extra = {}) => h('input', { id, class: 'input', value: v == null ? '' : v, dir: 'auto', ...extra });
    const sel = (id, opts, v) => h('select', { id, class: 'input' }, opts.map(([k, l]) => h('option', { value: k, selected: String(k) === String(v) }, l)));
    const f = (label, el) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), el);
    formDialog({ title: t(tp ? 'cleaning.tpl.edit' : 'cleaning.tpl.new'), id: 'cl-tpl-form', submitLabel: t('common.save'), container: root,
      fields: [
        f(t('cleaning.tpl.pack'), inp('tpl-pack', base.pack, { maxlength: 60, placeholder: t('cleaning.tpl.packHint') })),
        f(t('cleaning.tpl.titleAr'), inp('tpl-title', base.title, { maxlength: 120, required: true })),
        f(t('cleaning.tpl.titleEn'), inp('tpl-title-en', base.titleEn, { maxlength: 120 })),
        f(t('cleaning.tpl.when'), sel('tpl-when', WHEN.map((k) => [k, t(`cleaning.tpl.whenOpt.${k}`)]), w.when)),
        f(t('cleaning.tpl.n'), inp('tpl-n', w.n || 7, { type: 'number', min: 1, max: 365 })),
        f(t('cleaning.weekdays'), sel('tpl-weekday', [0, 1, 2, 3, 4, 5, 6].map((d) => [d, t(`cleaning.wd.${d}`)]), w.weekday ?? 5)),
        f(t('cleaning.dayOfMonth'), inp('tpl-day', w.day || 1, { type: 'number', min: 1, max: 31 })),
        f(t('cleaning.tpl.target'), sel('tpl-target', [['room', t('cleaning.tpl.targetRoom')], ['home', t('cleaning.tpl.targetHome')]], base.target === 'home' ? 'home' : 'room')),
        f(t('cleaning.adv.stat.minutes'), inp('tpl-min', base.minutes, { type: 'number', min: 1, max: 600 })),
        f(t('cleaning.tpl.priority'), sel('tpl-pri', ['low', 'normal', 'high'].map((p) => [p, t(`cleaning.priority.${p}`)]), base.priority)),
        f(t('cleaning.instructions'), h('textarea', { id: 'tpl-ins', class: 'input', rows: 2, maxlength: 1000, dir: 'auto' }, base.instructions || '')),
        h('p', { class: 'field__hint' }, t('cleaning.tpl.unsupportedNote'))],
      onSubmit: async () => {
        const q = (id) => root.querySelector(`#${id}`).value;
        const def = whenToDef(q('tpl-when'), { n: q('tpl-n'), weekday: q('tpl-weekday'), day: q('tpl-day'), target: q('tpl-target') });
        const input = { pack: q('tpl-pack'), title: q('tpl-title'), titleEn: q('tpl-title-en'), instructions: q('tpl-ins'), minutes: Number(q('tpl-min')), priority: q('tpl-pri'), ...def };
        const { errors } = validateTemplate(input);
        if (Object.keys(errors).length) { toast(t(Object.values(errors)[0]), { tone: 'error' }); return false; }
        try { if (tp) await store.changeTemplate(tp.id, input); else await store.createTemplate(input); }
        catch (e) { toast(e && e.detail && /^cleaning\./.test(e.detail) ? t(e.detail) : t('cleaning.tpl.err.save'), { tone: 'error' }); return false; }
        return 'cleaning.tpl.saved';   // shown only after the server confirmed
      } });
  }

  function templatesTab(snap) {
    store.ensureTemplates();
    if (snap.templates === undefined) return h('p', { class: 'muted', role: 'status' }, t('common.loading'));
    const list = snap.templates; const packs = new Map();
    for (const tp of list) { if (!packs.has(tp.pack)) packs.set(tp.pack, []); packs.get(tp.pack).push(tp); }
    const edit = can('cleaning.edit'); const create = can('cleaning.create');
    return h('div', { id: 'cl-tpl' },
      h('p', { class: 'field__hint' }, t('cleaning.tpl.explain')),
      edit ? h('button', { type: 'button', class: 'btn btn--primary', id: 'cl-tpl-new', onClick: () => editDialog(null) }, t('cleaning.tpl.new')) : null,
      applyState ? applyView() : null,
      packs.size ? h('ul', { class: 'cl-list', id: 'cl-tpl-list' }, [...packs.entries()].map(([pack, tps]) => h('li', { class: 'cl-room', dataset: { pack } },
        h('div', { class: 'cl-room__head' }, h('strong', null, pack), h('span', { class: 'pill' }, t('cleaning.tpl.custom'))),
        h('div', { class: 'cl-room__body' },
          h('ul', { class: 'cl-list' }, tps.map((tp) => h('li', { class: `cl-item${tp.active ? '' : ' cl-item--archived'}`, dataset: { template: tp.id, active: String(tp.active) } },
            h('div', { class: 'cl-item__main' }, h('p', { class: 'cl-item__title', dir: 'auto' }, lang === 'en' && tp.titleEn ? tp.titleEn : tp.title),
              h('p', { class: 'cl-item__meta' }, [whenLabel(tp), t(`cleaning.tpl.targetOf.${tp.target}`), `~${tp.minutes} ${t('cleaning.adv.min')}`, tp.active ? null : t('cleaning.tpl.archived')].filter(Boolean).join(' · '))),
            edit ? h('div', { class: 'cl-item__actions' },
              tp.active ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'edit', onClick: () => editDialog(tp) }, t('cleaning.tpl.editBtn')) : null,
              h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'duplicate', onClick: async () => { try { await store.duplicateTemplate(tp.id); toast(t('cleaning.tpl.saved'), { tone: 'success' }); } catch { toast(t('cleaning.tpl.err.save'), { tone: 'error' }); } } }, t('cleaning.tpl.duplicate')),
              h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': tp.active ? 'archive' : 'reactivate', onClick: async () => {
                try { await store.changeTemplate(tp.id, tp.active ? 'archive' : 'reactivate'); toast(t(tp.active ? 'cleaning.tpl.archivedOk' : 'cleaning.tpl.reactivatedOk'), { tone: 'success' }); }
                catch (e) { toast(e && e.detail && /^cleaning\./.test(e.detail) ? t(e.detail) : t('cleaning.tpl.err.save'), { tone: 'error' }); } } }, t(tp.active ? 'cleaning.tpl.archive' : 'cleaning.tpl.reactivate'))) : null))),
          create && tps.some((x) => x.active) ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-action': 'apply', onClick: () => { applyState = { pack, kind: null, targetId: null, plan: null, result: null, off: new Set() }; render(); } }, t('cleaning.tpl.applyPack')) : null))))
        : h('p', { class: 'empty', id: 'cl-tpl-empty' }, t('cleaning.tpl.none')),
      builtInSection(edit));
  }

  function builtInSection(edit) {
    const row = (kind, T, tt) => { const how = kind === 'room' ? 'periodic' : generatableAs(T, tt);
      return h('li', { class: 'fin-row', dataset: { builtin: `${T.key}:${tt.key}` } },
        h('span', { class: 'fin-row__main', dir: 'auto' }, lang === 'en' ? tt.titleEn : tt.titleAr, h('span', { class: 'fin-row__sub' }, how ? '' : t('cleaning.tpl.unsupportedTrigger', { kind: tt.trigger }))),
        edit && how ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'copy-builtin', onClick: () => editDialog(null, templateFromBuiltIn(kind, T, tt, how)) }, t('cleaning.tpl.copyBuiltIn')) : null); };
    return h('details', { class: 'form-section', id: 'cl-tpl-builtin' }, h('summary', { class: 'form-section__summary' }, t('cleaning.tpl.builtIn')),
      ...[...ROOM_TEMPLATES.map((T) => ['room', T]), ...DEVICE_TEMPLATES.map((T) => ['device', T])].map(([kind, T]) => h('details', { class: 'form-section' },
        h('summary', { class: 'form-section__summary' }, `${T.icon} ${lang === 'en' ? T.nameEn : T.nameAr} · ${t('cleaning.tpl.builtInBadge')}`),
        h('ul', { class: 'fin-list' }, T.tasks.map((tt) => row(kind, T, tt))))));
  }

  function applyView() {
    const s = store.getSnapshot(); const tps = (s.templates || []).filter((x) => x.pack === applyState.pack && x.active);
    const kinds = [...new Set(tps.map((x) => x.target))];
    if (!applyState.kind) applyState.kind = kinds[0];
    const options = applyState.kind === 'room' ? roomList().filter((r) => r.active !== false) : applyState.kind === 'device' ? deviceList().filter((d) => d.active !== false) : [{ id: 'home', name: t('cleaning.tpl.targetHome') }];
    if (!applyState.targetId && options[0]) applyState.targetId = options[0].id;
    const target = { kind: applyState.kind, item: applyState.kind === 'home' ? null : options.find((o) => o.id === applyState.targetId) || null };
    const plan = buildApplyPlan({ templates: tps, target, tasks: s.tasks, lang, uid: env.uid, now: store.now(), today: today() });
    return h('section', { class: 'card fin-card', id: 'cl-tpl-apply' },
      h('h3', { class: 'card__title' }, t('cleaning.tpl.applyTitle', { pack: applyState.pack })),
      kinds.length > 1 ? h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.tpl.target')),
        h('select', { class: 'input', id: 'cl-tpl-apply-kind', onChange: (e) => { applyState.kind = e.target.value; applyState.targetId = null; render(); } }, kinds.map((k) => h('option', { value: k, selected: k === applyState.kind }, t(`cleaning.tpl.targetOf.${k}`))))) : null,
      applyState.kind !== 'home' ? h('label', { class: 'field' }, h('span', { class: 'field__label' }, t(`cleaning.tpl.targetOf.${applyState.kind}`)),
        h('select', { class: 'input', id: 'cl-tpl-apply-target', onChange: (e) => { applyState.targetId = e.target.value; render(); } }, options.map((o) => h('option', { value: o.id, selected: o.id === applyState.targetId }, o.name)))) : null,
      h('ul', { class: 'cl-setup__list', id: 'cl-tpl-apply-list' }, plan.map((it) => h('li', { dataset: { status: it.status, id: it.id } },
        it.status === 'create' ? h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', name: 'cl-tpl-apply-item', value: it.id, checked: !applyState.off.has(it.id), onChange: (e) => { if (e.target.checked) applyState.off.delete(it.id); else applyState.off.add(it.id); } }), h('span', { dir: 'auto' }, it.data.title))
          : h('span', null, `${lang === 'en' && it.template.titleEn ? it.template.titleEn : it.template.title} — ${t(it.status === 'invalid' ? it.reason : `cleaning.tpl.status.${it.status}`)}`)))),
      h('p', { class: 'cl-setup__progress', id: 'cl-tpl-apply-progress', role: 'status', 'aria-live': 'polite', hidden: true }),
      h('div', { class: 'cl-item__actions' },
        h('button', { type: 'button', class: 'btn btn--primary', id: 'cl-tpl-apply-confirm', disabled: !plan.some((x) => x.status === 'create'), onClick: async (e) => {
          const writes = plan.filter((x) => x.status === 'create' && !applyState.off.has(x.id)).map((x) => ({ id: x.id, data: x.data }));
          if (!writes.length) return;
          e.currentTarget.disabled = true; const p = root.querySelector('#cl-tpl-apply-progress');
          const r = await store.createManyConfirmed('cleaningTasks', writes, { onProgress: (q) => { if (p) { p.hidden = false; p.textContent = t('cleaning.setup.progress', { saved: q.saved, total: q.total }); } } });
          toast(t(r.failed.length || r.remaining ? 'cleaning.tpl.applyPartial' : 'cleaning.tpl.applyOk', { saved: r.saved, total: r.total, failed: r.failed.length + r.remaining, existing: r.alreadyExisted }), { tone: r.failed.length || r.remaining ? 'error' : 'success' });
          if (!r.failed.length && !r.remaining) applyState = null;
          render();
        } }, t('cleaning.tpl.applyConfirm')),
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'cl-tpl-apply-cancel', onClick: () => { applyState = null; render(); } }, t('common.cancel'))));
  }

  // ---------------------------------------------------------------- AI import
  function importTab(snap) {
    store.ensureTemplates();
    const rooms = roomList().filter((r) => r.active !== false); const devices = deviceList().filter((d) => d.active !== false);
    const roomTypes = [...new Set(rooms.map((r) => ROOM_TYPE_MAP[r.type]).filter(Boolean))];
    const devTypes = [...new Set(devices.map((d) => DEVICE_SUBTYPE_MAP[d.subtype]).filter(Boolean))];
    const chk = (set, v, id) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', id, checked: set.has(v), onChange: (e) => { if (e.target.checked) set.add(v); else set.delete(v); refresh(); } }), h('span', null, v));
    const prompt = () => buildPrompt({ lang: promptOpts.lang, roomTypes: [...promptOpts.roomTypes], roomNames: promptOpts.names ? rooms.filter((r) => promptOpts.roomTypes.has(ROOM_TYPE_MAP[r.type])).map((r) => r.name) : [],
      deviceTypes: [...promptOpts.deviceTypes], minutesPerDay: Number(promptOpts.minutes) || null, style: promptOpts.style || null,
      problems: promptOpts.problems.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 10).map((x) => x.slice(0, 200)), wantTemplates: promptOpts.wantTemplates && can('cleaning.edit') });
    const promptBox = h('textarea', { id: 'cl-ai-prompt', class: 'input', rows: 8, readonly: true, dir: 'ltr' }, '');
    const refresh = () => { promptBox.value = prompt(); };
    const paste = h('textarea', { id: 'cl-ai-json', class: 'input', rows: 8, dir: 'ltr', spellcheck: 'false', placeholder: '{ "schemaVersion": 1, … }', onInput: (e) => { importState.text = e.target.value; } }, importState.text);
    // V6.3 layout: three clearly separated cards (privacy · build the prompt · paste the answer), one grid
    // for the prompt options, and one action row per step (wraps on narrow screens; RTL-safe).
    const el = h('div', { id: 'cl-ai', class: 'cl-ai' },
      h('section', { class: 'card fin-card cl-ai__card', id: 'cl-ai-privacy' }, h('h3', { class: 'card__title' }, t('cleaning.ai.privacyTitle')), h('p', { class: 'field__hint' }, t('cleaning.ai.privacy'))),
      h('section', { class: 'card fin-card cl-ai__card', id: 'cl-ai-step1', 'aria-labelledby': 'cl-ai-step1-title' },
        h('h3', { class: 'card__title', id: 'cl-ai-step1-title' }, t('cleaning.ai.step1')),
        h('div', { class: 'cl-ai__grid' },
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.ai.language')),
            h('select', { class: 'input', id: 'cl-ai-lang', onChange: (e) => { promptOpts.lang = e.target.value; refresh(); } }, [['ar', 'العربية'], ['en', 'English']].map(([k, l]) => h('option', { value: k, selected: k === promptOpts.lang }, l)))),
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.ai.minutes')), h('input', { id: 'cl-ai-min', class: 'input', type: 'number', min: 5, max: 240, value: promptOpts.minutes, onInput: (e) => { promptOpts.minutes = e.target.value; refresh(); } }))),
        roomTypes.length ? h('fieldset', { class: 'field cl-ai__set' }, h('legend', { class: 'field__label' }, t('cleaning.ai.roomTypes')), h('div', { class: 'cl-ai__checks' }, ...roomTypes.map((v) => chk(promptOpts.roomTypes, v, `cl-ai-rt-${v}`)))) : null,
        h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', id: 'cl-ai-names', checked: promptOpts.names, onChange: (e) => { promptOpts.names = e.target.checked; refresh(); } }), h('span', null, t('cleaning.ai.includeNames'))),
        devTypes.length ? h('fieldset', { class: 'field cl-ai__set' }, h('legend', { class: 'field__label' }, t('cleaning.ai.deviceTypes')), h('div', { class: 'cl-ai__checks' }, ...devTypes.map((v) => chk(promptOpts.deviceTypes, v, `cl-ai-dt-${v}`)))) : null,
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.ai.problems')), h('textarea', { id: 'cl-ai-problems', class: 'input', rows: 3, dir: 'auto', onInput: (e) => { promptOpts.problems = e.target.value; refresh(); } }, promptOpts.problems)),
        can('cleaning.edit') ? h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', id: 'cl-ai-want-tpl', checked: promptOpts.wantTemplates, onChange: (e) => { promptOpts.wantTemplates = e.target.checked; refresh(); } }), h('span', null, t('cleaning.ai.wantTemplates'))) : null,
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.ai.promptLabel')), promptBox),
        h('div', { class: 'cl-ai__actions' },
          h('button', { type: 'button', class: 'btn btn--secondary', id: 'cl-ai-copy', onClick: async () => {
            try { await navigator.clipboard.writeText(promptBox.value); toast(t('cleaning.ai.copied'), { tone: 'success' }); }
            catch { promptBox.select(); toast(t('cleaning.ai.copyManual'), { tone: 'error' }); } } }, t('cleaning.ai.copy')))),
      h('section', { class: 'card fin-card cl-ai__card', id: 'cl-ai-step2', 'aria-labelledby': 'cl-ai-step2-title' },
        h('h3', { class: 'card__title', id: 'cl-ai-step2-title' }, t('cleaning.ai.step2')),
        h('p', { class: 'field__hint' }, t('cleaning.ai.pasteHint', { kb: IMPORT_LIMITS.bytes / 1024 })),
        paste,
        h('div', { class: 'cl-ai__actions' },
          h('label', { class: 'btn btn--ghost btn--sm' }, t('cleaning.ai.openFile'), h('input', { type: 'file', accept: 'application/json,.json', id: 'cl-ai-file', hidden: true, onChange: (e) => {
            const file = e.target.files && e.target.files[0]; if (!file) return;
            if (file.size > IMPORT_LIMITS.bytes) { toast(t('cleaning.ai.err.tooLarge'), { tone: 'error' }); return; }
            const rd = new FileReader(); rd.onload = () => { importState.text = String(rd.result || ''); importState.preview = null; render(); }; rd.readAsText(file); } })),
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'cl-ai-sample', onClick: () => { importState.text = JSON.stringify(SAMPLE_PLAN, null, 2); importState.preview = null; importState.off = new Set(); render(); } }, t('cleaning.ai.sample')),
          h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'cl-ai-preview', onClick: () => { importState.text = paste.value; importState.mapping = {}; importState.result = null; importState.off = new Set(); buildPreview(); render(); } }, t('cleaning.ai.preview')))),
      importState.preview ? previewView() : null);
    queueMicrotask(refresh);
    return el;
  }
  function buildPreview() {
    const parsed = parsePlan(importState.text);
    if (!parsed.ok) { importState.preview = { errors: parsed.errors }; return; }
    const s = store.getSnapshot();
    importState.preview = { parsed: parsed.data, items: buildImportPreview({ parsed: parsed.data, rooms: roomList(), devices: deviceList(), tasks: s.tasks, templates: s.templates || [], mapping: importState.mapping,
      lang, uid: env.uid, now: store.now(), today: today(), canCreateTasks: can('cleaning.create'), canEditTemplates: can('cleaning.edit') }) };
  }
  function previewView() {
    const pv = importState.preview;
    if (pv.errors) return h('div', { class: 'banner banner--error', id: 'cl-ai-errors', role: 'alert' }, pv.errors.map((e) => t(`cleaning.ai.err.${e}`)).join(' · '));
    const reason = (r) => { const [code, extra] = String(r).split(':'); const key = `cleaning.ai.reason.${code}`; return /^cleaning\./.test(r) ? t(r) : t(key, { detail: extra || '' }); };
    const counts = { create: 0, duplicate: 0, invalid: 0 }; for (const it of pv.items) counts[it.status]++;
    return h('section', { class: 'card fin-card', id: 'cl-ai-preview-list' },
      h('h3', { class: 'card__title' }, t('cleaning.ai.step3')),
      h('p', { class: 'cl-progress__text', id: 'cl-ai-counts' }, t('cleaning.ai.counts', counts)),
      h('ul', { class: 'cl-setup__list' }, pv.items.map((it) => h('li', { dataset: { key: it.key, status: it.status, kind: it.kind } },
        it.status === 'create' ? h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', name: 'cl-ai-item', value: it.key, checked: !importState.off.has(it.key), onChange: (e) => { if (e.target.checked) importState.off.delete(it.key); else importState.off.add(it.key); } }),
          h('span', { dir: 'auto' }, `${t(`cleaning.ai.kind.${it.kind}`)}: ${it.data.title}${it.kind === 'task' ? ` → ${it.targetLabel}` : ''}`))
          : h('span', { dir: 'auto' }, `${t(`cleaning.ai.kind.${it.kind}`)}: ${it.title} — ${it.status === 'duplicate' ? t('cleaning.ai.duplicate') : (it.reasons || []).map(reason).join('، ')}`),
        it.kind === 'task' && it.norm && it.status !== 'duplicate' ? h('select', { class: 'input input--sm', 'aria-label': t('cleaning.tpl.target'), onChange: (e) => { importState.mapping[it.key] = e.target.value; buildPreview(); render(); } },
          (it.norm.targetKind === 'room' ? roomList() : deviceList()).filter((x) => x.active !== false).map((x) => h('option', { value: x.id, selected: x.id === it.targetId }, x.name))) : null))),
      h('p', { class: 'cl-setup__progress', id: 'cl-ai-progress', role: 'status', 'aria-live': 'polite', hidden: !importState.result }, importState.result ? t('cleaning.ai.result', importState.result) : ''),
      h('div', { class: 'cl-item__actions' },
        h('button', { type: 'button', class: 'btn btn--primary', id: 'cl-ai-confirm', disabled: !counts.create, onClick: async (e) => {
          const chosen = pv.items.filter((x) => x.status === 'create' && !importState.off.has(x.key));
          if (!chosen.length) return;
          e.currentTarget.disabled = true; const p = root.querySelector('#cl-ai-progress');
          const onProgress = (q) => { if (p) { p.hidden = false; p.textContent = t('cleaning.setup.progress', { saved: q.saved, total: q.total }); } };
          const rt = await store.createManyConfirmed('cleaningTasks', chosen.filter((x) => x.kind === 'task').map((x) => ({ id: x.id, data: x.data })), { onProgress });
          const rp = await store.createManyConfirmed('cleaningCustomTemplates', chosen.filter((x) => x.kind === 'template').map((x) => ({ id: x.id, data: x.data })), { onProgress });
          importState.result = { saved: rt.saved + rp.saved, total: rt.total + rp.total, existing: rt.alreadyExisted + rp.alreadyExisted, failed: rt.failed.length + rp.failed.length + rt.remaining + rp.remaining };
          toast(t(importState.result.failed ? 'cleaning.ai.partial' : 'cleaning.ai.done', importState.result), { tone: importState.result.failed ? 'error' : 'success' });
          buildPreview(); render();   // the preview now shows saved items as duplicates; only failed ones remain selectable (safe retry)
        } }, t('cleaning.ai.confirm')),
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'cl-ai-cancel', onClick: () => { importState = { text: '', preview: null, mapping: {}, result: null, off: new Set() }; render(); } }, t('common.cancel'))));
  }
  return { templatesTab, importTab };
}
