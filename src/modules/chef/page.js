/**
 * Recipes (#/m/chef) — V6.1 household cookbook: library, detail with an embedded YouTube player near
 * the top, servings scaler (display-only), cooking mode and shared timers. Archived, never deleted.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { banner, errorText } from '../../ui/components/common.js';
import { confirmDialog } from '../../ui/components/dialog.js';
import { toast } from '../../ui/components/toast.js';
import { formDialog } from '../expenses/dialogs.js';
import { getChefStore } from './chef-service.js';
import { CATEGORIES, UNITS, LIMITS, titleOf, matches, scaleMilli, formatAmount, embedUrl, watchUrl, thumbUrl, isDeleted, videoSourceName } from './recipe-model.js';
import { mountTimersPanel } from './timers-panel.js';
import { previewImport, buildPrompt, TEMPLATE, EXAMPLE, IMPORT_LIMITS } from './recipe-import.js';   // V6.3

export function mount(outlet, ctx) {
  const state = ctx.getState(); const can = (p) => state.permissions.can(p);
  const lang = state.profile && state.profile.language === 'en' ? 'en' : 'ar';
  let store;
  try { store = getChefStore(ctx); } catch (e) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(e)))); return () => {}; }
  let view = 'library'; let sel = null; let servings = null; let step = 0;
  let q = ''; let cat = 'all'; let favOnly = false; let showArchived = false; let filtersOpen = false; let offPanel = null;
  const root = h('div', { class: 'page page--chef accent-orange', id: 'ck-page' }); const body = h('div', { id: 'ck-body', class: 'ck-body' });   // V6.1.1: a spaced grid (the root cause of the stacked, gap-less layout)
  root.append(body); outlet.replaceChildren(root);
  const uid = state.identity.uid;
  const msg = (e) => t(e && e.detail && /^(recipes|timers)\./.test(e.detail) ? e.detail : 'recipes.err.save');
  const run = (fn, okKey) => async (ev) => { const b = ev && ev.currentTarget; if (b) b.disabled = true; try { await fn(); if (okKey) toast(t(okKey), { tone: 'success' }); } catch (e) { toast(msg(e), { tone: 'error' }); } finally { if (b) b.disabled = false; } };
  const mins = (r) => t('recipes.minutes', { prep: r.prepMinutes, cook: r.cookMinutes });
  const catLabel = (c) => t(`recipes.cat.${c}`);

  // ---- YouTube: thumbnail first; the iframe loads only on an explicit Play (privacy-enhanced domain).
  function player(r) {
    if (!r.videoId && r.videoUrl) {   // V6.1.1: other sources are a LINK only — no iframe, no thumbnail
      return h('a', { href: r.videoUrl, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn--secondary', id: 'ck-open-source' },
        `▶ ${t('recipes.openSource', { source: videoSourceName(r.videoUrl) })}`);
    }
    if (!r.videoId) return null;
    const box = h('div', { class: 'ck-video', id: 'ck-video' });
    const show = () => box.replaceChildren(h('iframe', { src: embedUrl(r.videoId), title: t('recipes.videoTitle', { title: titleOf(r, lang) }), id: 'ck-iframe',
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin', loading: 'lazy' }));
    box.append(h('button', { type: 'button', class: 'ck-video__play', id: 'ck-play', 'aria-label': t('recipes.playVideo'), onClick: show },
      h('img', { src: thumbUrl(r.videoId), alt: '', loading: 'lazy', onError: (e) => e.currentTarget.remove() }), h('span', { class: 'ck-video__icon', 'aria-hidden': 'true' }, '▶')));   // offline / blocked thumbnail → plain placeholder
    return h('div', null, box, h('a', { href: watchUrl(r.videoId), target: '_blank', rel: 'noopener noreferrer', class: 'btn btn--ghost btn--sm', id: 'ck-open-yt' }, t('recipes.openYouTube')));
  }
  function editor(r = null) {
    const v = r || { titleEn: '', titleAr: '', description: '', category: 'main', prepMinutes: 0, cookMinutes: 0, servings: 4, videoId: '', ingredients: [], steps: [], notes: '' };
    const ingRows = h('div', { id: 'ck-ings' }); const stepRows = h('div', { id: 'ck-steps' });
    const ingRow = (g = {}) => h('div', { class: 'ck-row', dataset: { id: g.id || '' } },
      h('input', { class: 'input ck-ing-amount', value: g.amountMilli != null ? formatAmount(g.amountMilli) : '', placeholder: t('recipes.amount'), 'aria-label': t('recipes.amount') }),
      h('select', { class: 'input ck-ing-unit', 'aria-label': t('recipes.unit') }, UNITS.map((u) => h('option', { value: u, selected: u === (g.unit || '') }, u ? t(`recipes.unit.${u}`) : '—'))),
      h('input', { class: 'input ck-ing-name', value: g.name || '', placeholder: t('recipes.ingredient'), 'aria-label': t('recipes.ingredient'), maxlength: LIMITS.ingName, dir: 'auto' }),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': t('recipes.remove'), onClick: (e) => e.currentTarget.parentElement.remove() }, '✕'));
    const stepRow = (s = {}) => h('div', { class: 'ck-row', dataset: { id: s.id || '' } },
      h('textarea', { class: 'input ck-step-text', rows: 2, placeholder: t('recipes.step'), 'aria-label': t('recipes.step'), maxlength: LIMITS.step, dir: 'auto' }, s.text || ''),
      h('input', { class: 'input ck-step-min', type: 'number', min: 1, max: LIMITS.stepMinutes, value: s.minutes ?? '', placeholder: t('recipes.stepMinutes'), 'aria-label': t('recipes.stepMinutes') }),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': t('recipes.remove'), onClick: (e) => e.currentTarget.parentElement.remove() }, '✕'));
    (v.ingredients.length ? v.ingredients : [{}]).forEach((g) => ingRows.append(ingRow(g)));
    (v.steps.length ? v.steps : [{}]).forEach((s) => stepRows.append(stepRow(s)));
    const F = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), el, hint ? h('span', { class: 'field__hint' }, hint) : null);
    formDialog({ title: t(r ? 'recipes.edit' : 'recipes.new'), id: 'ck-form', submitLabel: t('common.save'), container: root,
      fields: [F(t('recipes.titleEn'), h('input', { id: 'ck-title-en', class: 'input', value: v.titleEn || '', maxlength: LIMITS.title, dir: 'ltr' })),
        F(t('recipes.titleAr'), h('input', { id: 'ck-title-ar', class: 'input', value: v.titleAr || '', maxlength: LIMITS.title, dir: 'rtl' })),
        F(t('recipes.category'), h('select', { id: 'ck-cat', class: 'input' }, CATEGORIES.map((c) => h('option', { value: c, selected: c === v.category }, catLabel(c))))),
        h('div', { class: 'form-grid form-grid--tight' },
          F(t('recipes.prep'), h('input', { id: 'ck-prep', class: 'input', type: 'number', min: 0, max: LIMITS.minutes, value: v.prepMinutes })),
          F(t('recipes.cook'), h('input', { id: 'ck-cook', class: 'input', type: 'number', min: 0, max: LIMITS.minutes, value: v.cookMinutes })),
          F(t('recipes.servings'), h('input', { id: 'ck-serv', class: 'input', type: 'number', min: 1, max: LIMITS.servings, value: v.servings }))),
        F(t('recipes.video'), h('input', { id: 'ck-video-url', class: 'input', dir: 'ltr', value: v.videoId ? watchUrl(v.videoId) : (v.videoUrl || ''), placeholder: 'https://…' }), t('recipes.videoHint')),
        F(t('recipes.description'), h('textarea', { id: 'ck-desc', class: 'input', rows: 2, maxlength: LIMITS.description, dir: 'auto' }, v.description || '')),
        h('fieldset', { class: 'form-section' }, h('legend', null, t('recipes.ingredients')), ingRows,
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-add-ing', onClick: () => ingRows.append(ingRow()) }, t('recipes.addIngredient'))),
        h('fieldset', { class: 'form-section' }, h('legend', null, t('recipes.steps')), stepRows,
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-add-step', onClick: () => stepRows.append(stepRow()) }, t('recipes.addStep'))),
        F(t('recipes.notes'), h('textarea', { id: 'ck-notes', class: 'input', rows: 2, maxlength: LIMITS.notes, dir: 'auto' }, v.notes || ''))],
      onSubmit: async () => {
        const f = root.querySelector('#ck-form'); const val = (s) => f.querySelector(s).value;
        const input = { titleEn: val('#ck-title-en'), titleAr: val('#ck-title-ar'), category: val('#ck-cat'), prepMinutes: val('#ck-prep'), cookMinutes: val('#ck-cook'),
          servings: val('#ck-serv'), video: val('#ck-video-url'), description: val('#ck-desc'), notes: val('#ck-notes'),
          ingredients: [...f.querySelectorAll('#ck-ings .ck-row')].map((x) => ({ id: x.dataset.id || undefined, amount: x.querySelector('.ck-ing-amount').value, unit: x.querySelector('.ck-ing-unit').value, name: x.querySelector('.ck-ing-name').value })),
          steps: [...f.querySelectorAll('#ck-steps .ck-row')].map((x) => ({ id: x.dataset.id || undefined, text: x.querySelector('.ck-step-text').value, minutes: x.querySelector('.ck-step-min').value })) };
        try { if (r) await store.editRecipe(r.id, input); else sel = await store.createRecipe(input); }
        catch (e) { toast(msg(e), { tone: 'error' }); return false; }
        if (!r) { view = 'detail'; servings = null; queueMicrotask(render); }   // the store emitted before sel/view changed
        return r ? 'recipes.toast.saved' : 'recipes.toast.created';
      } });
  }
  function menu(r, where) {
    const items = [
      can('chef.edit') && !r.archived ? ['edit', () => editor(r)] : null,
      can('chef.create') ? ['duplicate', async () => { sel = await store.duplicateRecipe(r.id, t('recipes.copySuffix')); view = 'detail'; servings = null; render(); toast(t('recipes.toast.duplicated'), { tone: 'success' }); }] : null,
      can('chef.delete') ? ['delete', async () => {
        if (!(await confirmDialog({ title: t('recipes.deleteTitle'), message: t('recipes.deleteBody', { title: titleOf(r, lang) }), confirmLabel: t('recipes.delete'), container: root }))) return;
        await store.deleteRecipe(r.id); if (sel === r.id) { sel = null; view = 'library'; } render(); toast(t('recipes.toast.deleted'), { tone: 'success' }); }] : null,
    ].filter(Boolean);
    if (!items.length) return null;
    const wrap = h('div', { class: `ck-menu ck-menu--${where}` });
    const btn = h('button', { type: 'button', class: 'ck-menu__btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': t('recipes.actions', { title: titleOf(r, lang) }), 'data-action': 'menu' }, '⋯');
    const list = h('div', { class: 'ck-menu__list', role: 'menu', hidden: true }, items.map(([k, fn]) => h('button', { type: 'button', role: 'menuitem', class: 'ck-menu__item', 'data-action': `menu-${k}`, tabindex: '-1',
      onClick: async (e) => { e.stopPropagation(); close(); try { await fn(); } catch (err) { toast(msg(err), { tone: 'error' }); } } }, t(`recipes.${k}`))));
    const outside = (e) => { if (!wrap.contains(e.target)) close(); };
    function open() { list.hidden = false; btn.setAttribute('aria-expanded', 'true'); document.addEventListener('click', outside, true); list.querySelector('[role=menuitem]').focus(); }
    function close(focus) { if (list.hidden) return; list.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside, true); if (focus) btn.focus(); }
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (list.hidden) open(); else close(); });
    list.addEventListener('keydown', (e) => {
      const els = [...list.querySelectorAll('[role=menuitem]')]; const i = els.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length].focus(); }
    });
    wrap.append(btn, list);
    return wrap;
  }
  function ingredientsList(r, n) {
    return h('ul', { class: 'fin-list', id: 'ck-ingredients' }, r.ingredients.map((g) => h('li', { class: 'fin-row', dataset: { ing: g.id } },
      h('span', { class: 'fin-row__amount', dir: 'ltr' }, [formatAmount(scaleMilli(g.amountMilli, r.servings, n)), g.unit ? t(`recipes.unit.${g.unit}`) : ''].filter(Boolean).join(' ')),
      h('span', { class: 'fin-row__main', dir: 'auto' }, g.name, g.note ? h('span', { class: 'fin-row__sub' }, g.note) : null))));
  }
  const timerFromStep = (r, s) => run(() => store.createTimer({ label: `${titleOf(r, lang)} — ${t('recipes.stepN', { n: r.steps.indexOf(s) + 1 })}`.slice(0, 60), durationMs: s.minutes * 60000, recipeId: r.id, stepId: s.id }), 'timers.toast.started');

  const visible = (snap) => snap.recipes.filter((r) => !isDeleted(r));
  function filteredList(snap) {
    return visible(snap).filter((r) => (showArchived ? r.archived : !r.archived) && (cat === 'all' || r.category === cat) && (!favOnly || (r.favoritedBy || []).includes(uid)) && matches(r, q))
      .sort((a, b) => titleOf(a, lang).localeCompare(titleOf(b, lang)));
  }
  function gridOf(snap) {
    const list = filteredList(snap);
    return list.length ? h('ul', { class: 'ck-grid', id: 'ck-grid' }, list.map((r) => h('li', { class: 'ck-card', dataset: { recipe: r.id } },
        h('button', { type: 'button', class: 'ck-card__open', onClick: () => { sel = r.id; view = 'detail'; servings = null; render(); } },
          r.videoId ? h('img', { class: 'ck-card__thumb', src: thumbUrl(r.videoId), alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.replaceWith(h('span', { class: 'ck-card__thumb ck-card__thumb--ph', 'aria-hidden': 'true' }, '🍲')); } })
            : h('span', { class: 'ck-card__thumb ck-card__thumb--ph', 'aria-hidden': 'true' }, '🍲'),
          h('span', { class: 'ck-card__title', dir: 'auto' }, titleOf(r, lang)),
          h('span', { class: 'ck-card__meta' }, [catLabel(r.category), mins(r), !r.videoId && r.videoUrl ? `▶ ${videoSourceName(r.videoUrl)}` : null].filter(Boolean).join(' · '))),
        h('button', { type: 'button', class: 'ck-fav', 'data-action': 'favorite', 'aria-pressed': String((r.favoritedBy || []).includes(uid)), 'aria-label': t('recipes.favorite'), onClick: run(() => store.toggleFavorite(r.id)) }, (r.favoritedBy || []).includes(uid) ? '★' : '☆'),
        menu(r, 'card'))))
      : h('p', { class: 'empty', id: 'ck-empty' }, t(visible(snap).length ? 'recipes.noMatch' : 'recipes.empty'));
  }
  function libraryView(snap) {
    const active = (cat !== 'all') + favOnly + showArchived;
    const results = h('div', { id: 'ck-results' }, gridOf(snap));
    const panelId = 'ck-filters';
    return [h('header', { class: 'page-head page-head--row' }, h('div', null, h('h1', { class: 'page-head__title' }, t('module.chef.name')), h('p', { class: 'page-head__sub' }, t('recipes.sub'))),
        can('chef.create') ? h('div', { class: 'page-head__actions' },
          h('button', { type: 'button', class: 'btn btn--secondary', id: 'ck-ai-open', onClick: () => { view = 'import'; render(); } }, t('recipes.import.open')),
          h('button', { type: 'button', class: 'btn btn--primary', id: 'ck-new', onClick: () => editor() }, t('recipes.new'))) : null),
      h('div', { class: 'ck-search' },
        h('input', { id: 'ck-search', class: 'input', type: 'search', value: q, placeholder: t('recipes.search'), 'aria-label': t('recipes.search'), dir: 'auto',
          onInput: (e) => { q = e.target.value; results.replaceChildren(gridOf(store.getSnapshot())); } }),   // only the results change: no focus loss
        h('div', { class: 'ck-filters-bar' },
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-filters-toggle', 'aria-expanded': String(filtersOpen), 'aria-controls': panelId, onClick: () => { filtersOpen = !filtersOpen; render(); } },
            `${filtersOpen ? '▾' : '▸'} ${t('recipes.filters')}`, active ? h('span', { class: 'pill ck-filters-count', id: 'ck-filters-count' }, String(active)) : null),
          active ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-filters-clear', onClick: () => { cat = 'all'; favOnly = false; showArchived = false; render(); } }, t('recipes.clearFilters')) : null),
        h('div', { class: 'ck-filters', id: panelId, hidden: !filtersOpen },
          h('select', { id: 'ck-cat-filter', class: 'input input--sm', 'aria-label': t('recipes.category'), onChange: (e) => { cat = e.target.value; render(); } },
            [h('option', { value: 'all' }, t('recipes.allCategories')), ...CATEGORIES.map((c) => h('option', { value: c, selected: c === cat }, catLabel(c)))]),
          h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', id: 'ck-fav-only', checked: favOnly, onChange: (e) => { favOnly = e.target.checked; render(); } }), h('span', null, t('recipes.favoritesOnly'))),
          h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', id: 'ck-archived', checked: showArchived, onChange: (e) => { showArchived = e.target.checked; render(); } }), h('span', null, t('recipes.showArchived'))))),
      results];
  }
  // ---------------------------------------------------------------- V6.3 AI JSON import (no AI API)
  let imp = { text: '', preview: null, nonce: '', result: null, retry: null, busy: false };
  const resetImp = () => { imp = { text: '', preview: null, nonce: '', result: null, retry: null, busy: false }; };
  const copy = async (text, okKey) => { try { await navigator.clipboard.writeText(text); toast(t(okKey), { tone: 'success' }); } catch { toast(t('recipes.import.copyManual'), { tone: 'error' }); } };
  function download(name, obj) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: name, hidden: true }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const issue = (code) => { const [k, at] = String(code).split(/:(.*)/s); return t(`recipes.import.issue.${k}`, { at: at || '' }); };
  function buildImportPreview() {
    const all = store.getSnapshot().recipes;   // V6.3.0.1: deterministic ids (no per-preview nonce); deleted ids are never reused
    imp.preview = previewImport(imp.text, { existing: all.filter((x) => !isDeleted(x)), takenIds: all.map((x) => x.id) });
    imp.result = null; imp.retry = null;
  }
  function itemCard(it) {
    const v = it.input || {}; const title = (lang === 'ar' ? v.titleAr || v.titleEn : v.titleEn || v.titleAr) || t('recipes.import.untitled', { n: it.index + 1 });
    const dup = it.dupOf ? t(it.dupOf.kind === 'file' ? 'recipes.import.dupFile' : 'recipes.import.dupBook', { n: (it.dupOf.index ?? 0) + 1, title: it.dupOf.id ? titleOf(store.recipe(it.dupOf.id) || {}, lang) : '' }) : null;
    return h('li', { class: `ck-imp-item ck-imp-item--${it.status}`, dataset: { index: it.index, status: it.status } },
      h('label', { class: 'fin-check' },
        h('input', { type: 'checkbox', name: 'ck-imp-item', value: String(it.index), checked: it.selected, disabled: it.status === 'invalid' || imp.busy,
          'aria-label': t('recipes.import.select', { title }), onChange: (e) => { it.selected = e.target.checked; render(); } }),
        h('span', { dir: 'auto' }, h('strong', null, title), ` · ${t(`recipes.import.status.${it.status}`)}`)),
      dup ? h('p', { class: 'field__hint', 'data-role': 'dup' }, dup) : null,
      it.errors.length ? h('ul', { class: 'ck-imp-issues ck-imp-issues--error', role: 'list' }, it.errors.map((x) => h('li', { dir: 'auto' }, issue(x)))) : null,
      it.warnings.length ? h('ul', { class: 'ck-imp-issues ck-imp-issues--warn', role: 'list' }, it.warnings.map((x) => h('li', { dir: 'auto' }, issue(x)))) : null,
      it.input && !it.errors.length ? h('details', { class: 'ck-imp-review' }, h('summary', null, t('recipes.import.review', { ing: v.ingredients.length, steps: v.steps.length })),
        h('p', { class: 'field__hint' }, [catLabel(v.category), t('recipes.servingsN', { n: v.servings }), t('recipes.minutes', { prep: v.prepMinutes, cook: v.cookMinutes })].join(' · ')),
        v.description ? h('p', { dir: 'auto' }, v.description) : null,
        h('ul', { class: 'ck-imp-ings' }, v.ingredients.map((g) => h('li', { dir: 'auto' }, [g.amount, g.unit ? t(`recipes.unit.${g.unit}`) : '', g.name, g.note ? `(${g.note})` : ''].filter(Boolean).join(' ')))),
        h('ol', { class: 'ck-imp-steps' }, v.steps.map((st) => h('li', { dir: 'auto' }, st.text, st.minutes ? h('span', { class: 'pill' }, `⏱ ${t('recipes.stepMin', { n: st.minutes })}`) : null))),
        v.video ? h('p', { class: 'field__hint', dir: 'ltr' }, v.video) : null,
        v.notes ? h('p', { class: 'field__hint', dir: 'auto' }, v.notes) : null) : null);
  }
  async function runImport(items) {
    if (imp.busy || !items.length) return;
    imp.busy = true; render();
    let res;
    try { res = await store.importRecipes(items, { onProgress: (r) => { const el = document.getElementById('ck-imp-progress'); if (el) el.textContent = t('recipes.import.progress', { done: r.saved + r.already + r.failed.length, total: r.total }); } }); }
    catch (e) { imp.busy = false; toast(msg(e), { tone: 'error' }); render(); return; }
    imp.busy = false; imp.result = res; imp.retry = res.failed.length ? res.failed.map(({ detail, ...x }) => x) : null;
    if (imp.preview) for (const it of imp.preview.items) if (items.some((x) => x.id === it.id) && !res.failed.some((f) => f.id === it.id)) { it.status = 'imported'; it.selected = false; }
    toast(t(res.failed.length ? 'recipes.import.partial' : 'recipes.import.done', { saved: res.saved, already: res.already, failed: res.failed.length }), { tone: res.failed.length ? 'error' : 'success' });
    render();
  }
  function importView() {
    const pv = imp.preview; const chosen = pv && pv.ok ? pv.items.filter((x) => x.selected && x.status !== 'invalid' && x.status !== 'imported') : [];
    const paste = h('textarea', { id: 'ck-imp-text', class: 'input', rows: 8, dir: 'ltr', spellcheck: 'false', placeholder: '{ "schema": "homehub.recipes", "version": 1, "items": [ … ] }', onInput: (e) => { imp.text = e.target.value; } }, imp.text);
    return [h('header', { class: 'page-head page-head--row' },
        h('div', null, h('h1', { class: 'page-head__title' }, t('recipes.import.title')), h('p', { class: 'page-head__sub' }, t('recipes.import.sub'))),
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'ck-imp-back', onClick: () => { resetImp(); view = 'library'; render(); } }, t('recipes.import.back'))),
      h('section', { class: 'card ck-imp-card', id: 'ck-imp-step1', 'aria-labelledby': 'ck-imp-s1' },
        h('h2', { class: 'card__title', id: 'ck-imp-s1' }, t('recipes.import.step1')),
        h('p', { class: 'field__hint' }, t('recipes.import.step1Hint')),
        h('div', { class: 'ck-imp-actions' },
          h('button', { type: 'button', class: 'btn btn--secondary', id: 'ck-imp-copy-prompt', onClick: () => copy(buildPrompt(), 'recipes.import.promptCopied') }, t('recipes.import.copyPrompt')),
          h('button', { type: 'button', class: 'btn btn--secondary', id: 'ck-imp-copy-template', onClick: () => copy(JSON.stringify(TEMPLATE, null, 2), 'recipes.import.templateCopied') }, t('recipes.import.copyTemplate')),
          h('button', { type: 'button', class: 'btn btn--ghost', id: 'ck-imp-download', onClick: () => download('homehub-recipes-example.json', EXAMPLE) }, t('recipes.import.download')))),
      h('section', { class: 'card ck-imp-card', id: 'ck-imp-step2', 'aria-labelledby': 'ck-imp-s2' },
        h('h2', { class: 'card__title', id: 'ck-imp-s2' }, t('recipes.import.step2')),
        h('p', { class: 'field__hint' }, t('recipes.import.step2Hint', { kb: IMPORT_LIMITS.bytes / 1024, n: IMPORT_LIMITS.items })),
        paste,
        h('div', { class: 'ck-imp-actions' },
          h('label', { class: 'btn btn--ghost' }, t('recipes.import.upload'), h('input', { type: 'file', id: 'ck-imp-file', accept: 'application/json,.json', hidden: true, onChange: (e) => {
            const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
            if (f.size > IMPORT_LIMITS.bytes) { imp.preview = { ok: false, error: 'tooLarge', items: [] }; render(); return; }
            f.text().then((txt_) => { imp.text = txt_; buildImportPreview(); render(); }); } })),
          h('button', { type: 'button', class: 'btn btn--primary', id: 'ck-imp-preview', onClick: () => { imp.text = paste.value; buildImportPreview(); render(); } }, t('recipes.import.preview')))),
      pv ? h('section', { class: 'card ck-imp-card', id: 'ck-imp-step3', 'aria-labelledby': 'ck-imp-s3' },
        h('h2', { class: 'card__title', id: 'ck-imp-s3' }, t('recipes.import.step3')),
        !pv.ok ? h('p', { class: 'banner banner--error', id: 'ck-imp-error', role: 'alert' }, t(`recipes.import.err.${pv.error}`, { detail: pv.detail || '', kb: IMPORT_LIMITS.bytes / 1024, n: IMPORT_LIMITS.items }))
          : h('div', null,
            h('p', { class: 'cl-progress__text', id: 'ck-imp-counts' }, t('recipes.import.counts', { ready: pv.items.filter((x) => x.status === 'ready').length, dup: pv.items.filter((x) => x.status === 'duplicate').length, invalid: pv.items.filter((x) => x.status === 'invalid').length })),
            h('ul', { class: 'ck-imp-list', id: 'ck-imp-list' }, pv.items.map(itemCard)),
            h('div', { class: 'ck-imp-actions' },
              h('button', { type: 'button', class: 'btn btn--primary', id: 'ck-imp-confirm', disabled: !chosen.length || imp.busy, onClick: () => runImport(chosen.map((x) => ({ id: x.id, input: x.input }))) }, t('recipes.import.confirm', { n: chosen.length })),
              imp.retry ? h('button', { type: 'button', class: 'btn btn--secondary', id: 'ck-imp-retry', disabled: imp.busy, onClick: () => runImport(imp.retry) }, t('recipes.import.retry', { n: imp.retry.length })) : null),
            h('p', { class: 'cl-setup__progress', id: 'ck-imp-progress', role: 'status', 'aria-live': 'polite' },
              imp.result ? t(imp.result.failed.length ? 'recipes.import.partial' : 'recipes.import.done', { saved: imp.result.saved, already: imp.result.already, failed: imp.result.failed.length }) : ''))) : null];
  }
  function detailView(r) {
    const n = servings || r.servings;
    return [h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-back', onClick: () => { view = 'library'; render(); } }, `← ${t('recipes.back')}`)),
      player(r),
      h('header', { class: 'page-head' }, h('h1', { class: 'page-head__title', dir: 'auto', id: 'ck-title' }, titleOf(r, lang)),
        h('p', { class: 'page-head__sub' }, [catLabel(r.category), mins(r), r.archived ? t('recipes.archived') : null].filter(Boolean).join(' · ')),
        r.description ? h('p', { dir: 'auto' }, r.description) : null),
      h('div', { class: 'cl-item__actions', id: 'ck-actions' },
        !r.archived ? h('button', { type: 'button', class: 'btn btn--primary', id: 'ck-cook', onClick: () => { view = 'cook'; step = 0; render(); } }, t('recipes.cookingMode')) : null,
        can('chef.edit') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-archive', onClick: run(() => store.archiveRecipe(r.id, !r.archived), r.archived ? 'recipes.toast.restored' : 'recipes.toast.archived') }, t(r.archived ? 'recipes.restore' : 'recipes.archive')) : null,
        menu(r, 'detail')),
      h('section', { class: 'card fin-card' }, h('h2', { class: 'card__title' }, t('recipes.ingredients')),
        h('div', { class: 'ck-serv', role: 'group', 'aria-label': t('recipes.servings') },
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-serv-dec', 'aria-label': t('recipes.fewer'), disabled: n <= 1, onClick: () => { servings = Math.max(1, n - 1); render(); } }, '−'),
          h('span', { id: 'ck-serv-n', 'aria-live': 'polite' }, t('recipes.servingsN', { n })),
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-serv-inc', 'aria-label': t('recipes.more'), disabled: n >= LIMITS.servings, onClick: () => { servings = Math.min(LIMITS.servings, n + 1); render(); } }, '+')),
        r.ingredients.length ? ingredientsList(r, n) : h('p', { class: 'empty' }, t('recipes.noIngredients'))),
      h('section', { class: 'card fin-card' }, h('h2', { class: 'card__title' }, t('recipes.steps')),
        h('ol', { class: 'ck-steps', id: 'ck-steps-list' }, r.steps.map((s) => h('li', { dataset: { step: s.id } }, h('p', { dir: 'auto' }, s.text),
          s.minutes ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'step-timer', onClick: timerFromStep(r, s) }, t('recipes.startTimer', { n: s.minutes })) : null)))),
      r.notes ? h('section', { class: 'card fin-card' }, h('h2', { class: 'card__title' }, t('recipes.notes')), h('p', { dir: 'auto' }, r.notes)) : null].filter(Boolean);
  }
  function cookView(r) {
    const s = r.steps[step]; const panel = h('section', { class: 'card fin-card', id: 'ck-cook-timers' });
    const out = [h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'ck-exit', onClick: () => { view = 'detail'; render(); } }, `← ${t('recipes.exitCooking')}`),
        h('h1', { class: 'page-head__title', dir: 'auto' }, titleOf(r, lang))),
      player(r),
      r.steps.length ? h('section', { class: 'ck-cook', id: 'ck-cook-step', 'aria-live': 'polite' },
        h('p', { class: 'muted' }, t('recipes.stepOf', { n: step + 1, total: r.steps.length })),
        h('p', { class: 'ck-cook__text', dir: 'auto' }, s.text),
        s.minutes ? h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'step-timer', onClick: timerFromStep(r, s) }, t('recipes.startTimer', { n: s.minutes })) : null,
        h('div', { class: 'ck-cook__nav' },
          h('button', { type: 'button', class: 'btn btn--secondary', id: 'ck-prev', disabled: step === 0, onClick: () => { step -= 1; render(); } }, t('recipes.prev')),
          h('button', { type: 'button', class: 'btn btn--primary', id: 'ck-next', disabled: step >= r.steps.length - 1, onClick: () => { step += 1; render(); } }, t('recipes.next'))))
        : h('p', { class: 'empty' }, t('recipes.noSteps')),
      h('details', { class: 'form-section', id: 'ck-cook-ings' }, h('summary', { class: 'form-section__summary' }, t('recipes.ingredients')), ingredientsList(r, servings || r.servings)),
      panel].filter(Boolean);
    queueMicrotask(() => { if (panel.isConnected) offPanel = mountTimersPanel(panel, store, { recipeId: r.id }); });
    return out;
  }
  function render() {
    if (offPanel) { offPanel(); offPanel = null; }
    const snap = store.getSnapshot();
    if (snap.status === 'error') { body.replaceChildren(banner('error', errorText(snap.error))); return; }
    if (snap.status !== 'ready') { body.replaceChildren(h('p', { class: 'muted', role: 'status' }, t('common.loading'))); return; }
    const r = sel ? store.recipe(sel) : null;
    if ((view === 'detail' || view === 'cook') && (!r || isDeleted(r))) { view = 'library'; sel = null; }   // V6.3: 'import' needs no selected recipe
    if (view === 'import') { if (!can('chef.create')) view = 'library'; else { body.replaceChildren(...importView()); return; } }
    if (view === 'library') body.replaceChildren(...libraryView(snap));
    else body.replaceChildren(...(view === 'detail' ? detailView(r) : cookView(r)));
  }
  // Re-render on data changes only (the timers panel ticks itself); cooking mode keeps its step.
  let last = null;
  const off = store.subscribe((s) => { if (view === 'import' && imp.busy) return; const key = s.status + JSON.stringify(s.recipes.map((x) => [x.id, x.rev, (x.favoritedBy || []).length, !!x.deletedAt])); if (key !== last) { last = key; render(); } });
  return () => { off(); if (offPanel) offPanel(); };
}
