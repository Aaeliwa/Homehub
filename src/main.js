/**
 * HomeHub entry point.
 *
 * Wires the shared services together and renders exactly one screen per lifecycle state:
 *
 *   BOOTING / RESOLVING_CONTEXT   -> boot screen
 *   AUTH_REQUIRED / AUTHENTICATING -> login
 *   SETUP_REQUIRED / SETTING_UP    -> first-time setup
 *   READY                          -> application shell + routed page
 *   ERROR                          -> error screen with recovery actions
 *
 * Firebase-dependent code is imported dynamically so that an SDK/network failure at
 * startup shows the "HomeHub can't connect" screen instead of a blank page.
 */
import { createStore } from './core/state/store.js';
import { AppState } from './core/state/app-machine.js';
import { createSessionController } from './core/lifecycle/session-controller.js';
import { createContextScope } from './core/lifecycle/context-scope.js';
import { AppError, ErrorCode, toAppError, describeError } from './core/errors/app-error.js';
import { applyPreferences, readCachedPrefs, getResolvedTheme, getThemePreference } from './core/settings/preferences.js';
import { getLanguage } from './core/i18n/i18n.js';
import { paths } from './core/firebase/paths.js';
import { createRouter } from './core/router/router.js';
import { log } from './core/utils/logger.js';
import { registry } from './modules/index.js';
import { bootScreen } from './ui/screens/boot-screen.js';
import { loginScreen } from './ui/screens/login-screen.js';
import { setupScreen } from './ui/screens/setup-screen.js';
import { errorScreen } from './ui/screens/error-screen.js';
import { appShell } from './ui/shell/app-shell.js';
import { mountDashboard } from './ui/pages/dashboard-page.js';
import { mountSettings } from './ui/pages/settings-page.js';
import { mountModulePage } from './ui/pages/module-page.js';
import { errorText } from './ui/components/common.js';
import { toast } from './ui/components/toast.js';

document.documentElement.dataset.booted = '1';

const S = AppState;
const SCREEN_FOR = {
  [S.BOOTING]: 'boot',
  [S.RESOLVING_CONTEXT]: 'boot',
  [S.AUTH_REQUIRED]: 'login',
  [S.AUTHENTICATING]: 'login',
  [S.SETUP_REQUIRED]: 'setup',
  [S.SETTING_UP]: 'setup',
  [S.READY]: 'shell',
  [S.ERROR]: 'error',
};
const SCREENS = { boot: bootScreen, login: loginScreen, setup: setupScreen, error: errorScreen };

async function loadFirebaseServices() {
  const firebase = await import('./core/firebase/firebase.js');
  firebase.initFirebase();
  const [auth, data, repoMod, setupMod, settingsMod, famRepo, joinSvc] = await Promise.all([
    import('./core/auth/auth-service.js'),
    import('./core/data/firestore.js'),
    import('./core/home/home-repository.js'),
    import('./core/home/setup-service.js'),
    import('./core/settings/settings-service.js'),
    import('./core/family/family-repository.js'),
    import('./core/family/join-service.js'),
  ]);
  const { familyRepository } = famRepo;
  const join = {
    load: (code, opts) => joinSvc.loadInvite(familyRepository, code, opts),
    accept: (args) => joinSvc.acceptInvite(familyRepository, args),
    setDefaultHome: (uid, homeId) => data.patchDoc(['users', uid], { defaultHomeId: homeId, updatedAt: data.serverTime() }),
  };
  return {
    auth,
    watch: data.watchDoc,
    repo: repoMod.homeRepository,
    setup: setupMod,
    settings: settingsMod,
    join,
    /** Phase 5.1: atomic writer + server timestamp for the one-time legacy Home adoption. */
    data: { atomicWrite: data.atomicWrite, serverTime: data.serverTime },
  };
}

function start() {
  const root = document.getElementById('app');
  const store = createStore();
  applyPreferences(readCachedPrefs());

  let session = null;
  let services = null;
  let router = null;
  let view = { key: null, kind: null, instance: null };
  let shell = null;      // { key, instance }
  let page = null;       // { key, instance }
  let scope = null;      // context scope for the current READY (uid, homeId) — Phase 2

  /** One scope per READY (uid, homeId); disposed (listeners stopped) whenever that ends. */
  function syncScope(state) {
    const ready = state.status === S.READY && state.identity && state.home;
    const key = ready ? `${state.identity.uid}/${state.home.id}` : null;
    if (scope && scope.key !== key) { scope.dispose(); scope = null; log.debug('Context scope disposed'); }
    if (!scope && key) { scope = createContextScope({ uid: state.identity.uid, homeId: state.home.id }); log.debug('Context scope created'); }
  }

  // ---- preferences (language/theme) -------------------------------------------------
  const prefs = {
    get isDark() { return getResolvedTheme() === 'dark'; },
    onToggleLanguage: () => prefs.set({ language: getLanguage() === 'ar' ? 'en' : 'ar' }),
    onToggleTheme: () => prefs.set({ theme: getResolvedTheme() === 'dark' ? 'light' : 'dark' }),
    async set(change) {
      applyPreferences(change);
      render();
      const s = store.get();
      if (s.status !== S.READY || !services) return;
      try {
        await services.settings.savePreferences(s.identity.uid, change);
        session.updateProfile(change);
      } catch (err) {
        toast(errorText(toAppError(err)), { tone: 'error' });
      }
    },
  };

  // ---- rendering ---------------------------------------------------------------------
  let bellOff = null;   // Phase 5.6: the Reminders bell controller of the current shell
  function teardownShell() {
    if (bellOff) { bellOff(); bellOff = null; }
    if (page && page.instance.destroy) page.instance.destroy();
    if (shell && shell.instance.destroy) shell.instance.destroy();
    page = null;
    shell = null;
  }

  function pageContext() {
    return {
      getState: store.get,
      scope,
      registry,
      session,
      prefs,
      navigate: (p) => router.navigate(p),
      services: {
        listMembers: services.repo.listMembers,
        listRoles: services.repo.listRoles,
        saveDisplayName: services.settings.saveDisplayName,
        saveHomeSettings: services.settings.saveHomeSettings,
        refreshSystemRoles: services.settings.refreshSystemRoles,
        loadInvite: services.join.load,
      },
    };
  }

  function lazyPage(outlet, load, mount) {
    let alive = true; let inner = null;
    load().then((m) => { if (alive) inner = mount(m) || {}; })
      .catch((err) => { log.error('Page failed to load', describeError(err)); if (alive) toast(errorText(toAppError(err)), { tone: 'error' }); });
    return { destroy() { alive = false; if (inner && inner.destroy) inner.destroy(); } };
  }

  function mountPage(outlet, route) {
    const ctx = pageContext();
    if (route.name === 'settings') return mountSettings(outlet, ctx);
    if (route.name === 'module') return mountModulePage(outlet, ctx, route.params.moduleId, route.params.view || null);
    // Phase 4A pages depend on Firebase-backed services, so they load lazily (like module
    // pages). A static import here would make an unreachable SDK break the whole app instead
    // of showing the "HomeHub can't connect" screen.
    if (route.name === 'family') return lazyPage(outlet, () => import('./ui/pages/family-page.js'), (m) => m.mountFamily(outlet, ctx));
    if (route.name === 'join') return lazyPage(outlet, () => import('./ui/pages/join-page.js'), (m) => m.mountJoin(outlet, ctx, route.params.code));
    if (route.name === 'reminders') return lazyPage(outlet, () => import('./ui/pages/reminders-page.js'), (m) => m.mountReminders(outlet, ctx));   // Phase 5.6
    return mountDashboard(outlet, ctx);
  }

  function renderShell(state) {
    const route = router.current();
    const base = [getLanguage(), getThemePreference(), getResolvedTheme(), state.role.id, state.permissions.grants.join(',')].join('|');
    const shellKey = `${base}|${route.path}`;
    if (!shell || shell.key !== shellKey) {
      const routeChanged = !page || !shell || !shell.key.endsWith(`|${route.path}`);
      teardownShell();
      const instance = appShell({ state, registry, session, prefs, route });
      shell = { key: shellKey, instance };
      root.replaceChildren(instance.el);
      view = { key: 'shell', kind: 'shell', instance };
      page = { key: shellKey, instance: mountPage(instance.outlet, route) || {} };
      // Phase 5.6: the bell's live count loads lazily (Firebase-backed) and is disposed with this shell.
      // Lightweight bell: the live count (and its listeners) runs ONLY where that data is already open —
      // Dashboard, Reminders, Cleaning, Maintenance. Elsewhere the bell is a plain link: no extra reads.
      const countHere = route.name === 'dashboard' || route.name === 'reminders'
        || (route.name === 'module' && (route.params.moduleId === 'cleaning' || route.params.moduleId === 'maintenance'));
      if (instance.bellEl && countHere) {
        import('./ui/reminders/bell.js').then((m) => { if (shell && shell.instance === instance) bellOff = m.mountBell(instance.bellEl, pageContext()); })
          .catch((err) => log.warn('Reminders bell unavailable', describeError(err)));
      }
      document.title = `${state.home.name} | HomeHub`;
      if (routeChanged) { window.scrollTo(0, 0); instance.outlet.focus({ preventScroll: true }); }
      return;
    }
    shell.instance.update(state);
    if (page.instance.update) page.instance.update(state);
    document.title = `${state.home.name} | HomeHub`;
  }

  function render() {
    const state = store.get();
    const kind = SCREEN_FOR[state.status];
    if (kind === 'shell') { renderShell(state); return; }

    teardownShell();
    const route = router ? router.current() : { name: 'dashboard', path: '/dashboard', params: {} };
    const key = [kind, getLanguage(), getResolvedTheme(), kind === 'error' && state.error ? state.error.code : '', route.name === 'join' ? route.path : ''].join('|');
    if (view.key !== key) {
      const instance = SCREENS[kind]({ state, session, prefs, route, join: services ? services.join : null, navigate: (p) => router.navigate(p) });
      root.replaceChildren(instance.el);
      view = { key, kind, instance };
      document.title = 'HomeHub';
      if (instance.focus) instance.focus();
    }
    view.instance.update(state);
  }

  store.subscribe((state, prev) => {
    syncScope(state);
    if (state.status === S.AUTH_REQUIRED && prev.status !== S.AUTH_REQUIRED && router
        && router.current().path !== '/dashboard' && router.current().name !== 'join') {
      router.replace('/dashboard'); // next sign-in starts on the dashboard (an invite link is kept)
    }
    render();
  });
  router = createRouter(() => render());
  render();

  // ---- Firebase ----------------------------------------------------------------------
  loadFirebaseServices()
    .then((svc) => {
      services = svc;
      session = createSessionController({
        store,
        auth: svc.auth,
        repo: svc.repo,
        setup: svc.setup,
        watch: svc.watch,
        paths,
        applyPreferences,
        join: svc.join,
        adoption: {
          adopt: (args) => import('./core/home/legacy-adoption-service.js').then((m) => m.adoptLegacyHome({
            ...args, repo: svc.repo, write: (fn) => svc.data.atomicWrite(fn), now: () => svc.data.serverTime(),
          })),
        },
      });
      session.start();
    })
    .catch((err) => {
      const e = err instanceof AppError ? err : new AppError(ErrorCode.FIREBASE_INIT_FAILED, { cause: err });
      log.error('Startup failed:', describeError(e));
      store.transition(S.ERROR, { error: new AppError(ErrorCode.FIREBASE_INIT_FAILED, { cause: e }) });
    });

  window.addEventListener('unhandledrejection', (event) => {
    log.error('Unhandled promise rejection:', describeError(event.reason));
  });
  log.info('App started');
}

start();
