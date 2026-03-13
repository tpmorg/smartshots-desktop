import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { basename } from '@tauri-apps/api/path';
import { readFile } from '@tauri-apps/plugin-fs';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { assertEnv } from './env';
import { SupabaseService } from './supabaseService';
import { createStore } from './store';
import {
  readPreferences,
  saveAutoSyncNewScreenshots,
  saveHideToTrayOnClose,
  saveNotificationsEnabled,
  saveReviewBacklogOnLaunch,
  saveWatcherAutostart
} from './preferences';
import {
  getRecentUploadedEntries,
  getUploadStats,
  getUnprocessedPaths,
  hasUploaded,
  hasIgnored,
  markUploadFailure,
  markUploadSuccess,
  markIgnored,
  pruneUploadHistory
} from './uploadHistory';
import './styles.css';

type WatcherEventPayload = {
  path: string;
};

type OAuthCallbackPayload = {
  url: string;
};

type AppView = 'dashboard' | 'settings';

type AppState = {
  activeView: AppView;
  isAuthenticated: boolean;
  authMessage: string;
  signedInUserLabel: string;
  watcherRunning: boolean;
  watcherMessage: string;
  uploadMessage: string;
  uploadProgress: number;
  uploadInProgress: boolean;
  notificationsEnabled: boolean;
  watcherAutostart: boolean;
  hideToTrayOnClose: boolean;
  autoSyncNewScreenshots: boolean;
  reviewBacklogOnLaunch: boolean;
  screenshotDirs: string[];
  processedTotal: number;
  lastSyncTs: number | null;
  backlogCount: number;
  backlogPaths: string[];
  backlogSelected: string[];
  recentUploadLog: Array<{ name: string; path: string; ts: number }>;
};

const authChip = document.querySelector<HTMLDivElement>('#auth-chip')!;
const signedInAs = document.querySelector<HTMLSpanElement>('#signed-in-as')!;
const watcherSummary = document.querySelector<HTMLParagraphElement>('#watcher-summary')!;
const uploadProgress = document.querySelector<HTMLDivElement>('#upload-progress')!;
const uploadProgressLabel = document.querySelector<HTMLDivElement>('#upload-progress-label')!;
const uploadProgressFill = document.querySelector<HTMLDivElement>('#upload-progress-fill')!;
const dirsList = document.querySelector<HTMLUListElement>('#dirs-list')!;
const processedTotal = document.querySelector<HTMLParagraphElement>('#processed-total')!;
const lastSyncTime = document.querySelector<HTMLParagraphElement>('#last-sync-time')!;
const backlogList = document.querySelector<HTMLUListElement>('#backlog-list')!;
const backlogEmpty = document.querySelector<HTMLDivElement>('#backlog-empty')!;
const watcherCard = document.querySelector<HTMLElement>('#watcher-card')!;
const recentUploadsList = document.querySelector<HTMLUListElement>('#recent-uploads-list')!;
const recentUploadsEmpty = document.querySelector<HTMLDivElement>('#recent-uploads-empty')!;
const viewDashboard = document.querySelector<HTMLElement>('#view-dashboard')!;
const viewSettings = document.querySelector<HTMLElement>('#view-settings')!;
const navDashboardBtn = document.querySelector<HTMLButtonElement>('#nav-dashboard-btn')!;
const navSettingsBtn = document.querySelector<HTMLButtonElement>('#nav-settings-btn')!;
const signinBtn = document.querySelector<HTMLButtonElement>('#signin-btn')!;
const signoutBtn = document.querySelector<HTMLButtonElement>('#signout-btn')!;
const watcherBtn = document.querySelector<HTMLButtonElement>('#watcher-btn')!;
const notificationsToggle = document.querySelector<HTMLInputElement>('#notifications-toggle')!;
const watcherAutostartToggle = document.querySelector<HTMLInputElement>('#watcher-autostart-toggle')!;
const hideToTrayToggle = document.querySelector<HTMLInputElement>('#hide-to-tray-toggle')!;
const autoSyncToggle = document.querySelector<HTMLInputElement>('#auto-sync-toggle')!;
const reviewBacklogToggle = document.querySelector<HTMLInputElement>('#review-backlog-toggle')!;
const backlogSelectAllBtn = document.querySelector<HTMLButtonElement>('#backlog-select-all-btn')!;
const backlogClearBtn = document.querySelector<HTMLButtonElement>('#backlog-clear-btn')!;
const backlogUploadBtn = document.querySelector<HTMLButtonElement>('#backlog-upload-btn')!;
const websiteBtn = document.querySelector<HTMLButtonElement>('#website-btn')!;
const quitBtn = document.querySelector<HTMLButtonElement>('#quit-btn')!;
const ignoreConfirmOverlay = document.querySelector<HTMLDivElement>('#ignore-confirm-overlay')!;
const ignoreConfirmFileName = document.querySelector<HTMLSpanElement>('#ignore-confirm-filename')!;
const ignoreConfirmText = document.querySelector<HTMLParagraphElement>('#ignore-confirm-text')!;
const ignoreConfirmCancelBtn = document.querySelector<HTMLButtonElement>('#ignore-confirm-cancel')!;
const ignoreConfirmIgnoreBtn = document.querySelector<HTMLButtonElement>('#ignore-confirm-ignore')!;
const imagePreviewOverlay = document.querySelector<HTMLDivElement>('#image-preview-overlay')!;
const imagePreviewCloseBtn = document.querySelector<HTMLButtonElement>('#image-preview-close')!;
const imagePreviewImage = document.querySelector<HTMLImageElement>('#image-preview-image')!;

assertEnv();

const supabase = new SupabaseService();
const recentUploads = new Map<string, number>();
const inFlightUploads = new Set<string>();
const thumbnailUrlCache = new Map<string, string>();
let uploadSequence = 0;
let uploadProgressTimer: number | null = null;
let backlogRenderToken = 0;
let pendingIgnorePath: string | null = null;
const backlogQueuedAt = new Map<string, number>();
const backlogFileModifiedAt = new Map<string, number>();
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const store = createStore<AppState>({
  activeView: 'dashboard',
  isAuthenticated: false,
  authMessage: 'checking...',
  signedInUserLabel: '',
  watcherRunning: false,
  watcherMessage: 'stopped',
  uploadMessage: 'idle',
  uploadProgress: 0,
  uploadInProgress: false,
  notificationsEnabled: false,
  watcherAutostart: false,
  hideToTrayOnClose: true,
  autoSyncNewScreenshots: true,
  reviewBacklogOnLaunch: true,
  screenshotDirs: [],
  processedTotal: 0,
  lastSyncTs: null,
  backlogCount: 0,
  backlogPaths: [],
  backlogSelected: [],
  recentUploadLog: []
});

let lastDirsKey = '';
store.subscribe(render);
render(store.getState());

async function init(): Promise<void> {
  const preferences = await readPreferences();
  store.setState({
    notificationsEnabled: preferences.notificationsEnabled,
    watcherAutostart: preferences.watcherAutostart,
    hideToTrayOnClose: preferences.hideToTrayOnClose,
    autoSyncNewScreenshots: preferences.autoSyncNewScreenshots,
    reviewBacklogOnLaunch: preferences.reviewBacklogOnLaunch
  });
  await invoke('set_hide_to_tray_on_close', { enabled: preferences.hideToTrayOnClose });

  const dirs = await invoke<string[]>('get_default_screenshot_dirs');
  store.setState({ screenshotDirs: dirs });
  await pruneUploadHistory();
  const recentPersisted = await getRecentUploadedEntries(25);
  const recentUploadLog = await Promise.all(
    recentPersisted.map(async (entry) => ({
      name: await basename(entry.filePath).catch(() => entry.filePath.split(/[\\/]/).pop() ?? entry.filePath),
      path: entry.filePath,
      ts: entry.uploadedAt
    }))
  );
  const stats = await getUploadStats();
  store.setState({
    recentUploadLog,
    processedTotal: stats.totalUploaded,
    lastSyncTs: stats.lastUploadedAt
  });

  if (preferences.reviewBacklogOnLaunch) {
    await refreshBacklogCandidates();
  }

  const authed = await supabase.isAuthenticated();
  const signedInUserLabel = authed ? await getSignedInUserLabel() : '';
  store.setState({
    isAuthenticated: authed,
    authMessage: authed ? 'signed in' : 'signed out',
    signedInUserLabel
  });

  if (preferences.watcherAutostart) {
    await startWatcher();
  }

  supabase.onAuthenticationStateChanged((isAuthenticated) => {
    if (!isAuthenticated) {
      store.setState({
        isAuthenticated: false,
        authMessage: 'signed out',
        signedInUserLabel: ''
      });
      return;
    }

    void refreshSignedInUserIdentity().then((signedInUserLabel) => {
      store.setState({
        isAuthenticated: true,
        authMessage: 'signed in',
        signedInUserLabel
      });
    });
    void refreshBacklogCandidates();

    if (isAuthenticated && store.getState().watcherAutostart && !store.getState().watcherRunning) {
      void startWatcher();
    }
  });

  await onOpenUrl(async (urls) => {
    const [url] = urls;
    await handleIncomingAuthUrl(url);
  });

  const currentUrls = await getCurrent();
  if (currentUrls && currentUrls.length > 0) {
    await handleIncomingAuthUrl(currentUrls[0]);
  }

  await listen<OAuthCallbackPayload>('oauth-callback-url', async (event) => {
    await handleIncomingAuthUrl(event.payload.url);
  });

  await listenForScreenshots();
}

signinBtn.addEventListener('click', async () => {
  store.setState({ authMessage: 'opening browser...' });

  try {
    const redirectTo = await invoke<string>('get_oauth_redirect_url');
    await supabase.beginOAuthSignInWithRedirect(redirectTo);
  } catch (error) {
    store.setState({ authMessage: `failed (${String(error)})` });
  }
});

signoutBtn.addEventListener('click', async () => {
  try {
    await supabase.signOut();
    store.setState({
      isAuthenticated: false,
      authMessage: 'signed out',
      signedInUserLabel: ''
    });
  } catch (error) {
    store.setState({ authMessage: `sign-out failed (${String(error)})` });
  }
});

watcherBtn.addEventListener('click', async () => {
  if (store.getState().watcherRunning) {
    await stopWatcher();
  } else {
    await startWatcher();
  }
});

navDashboardBtn.addEventListener('click', () => {
  store.setState({ activeView: 'dashboard' });
});

navSettingsBtn.addEventListener('click', () => {
  store.setState({ activeView: 'settings' });
});

notificationsToggle.addEventListener('change', async () => {
  if (notificationsToggle.checked) {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }

    store.setState({ notificationsEnabled: permissionGranted });
    notificationsToggle.checked = permissionGranted;
    await saveNotificationsEnabled(permissionGranted);
    return;
  }

  store.setState({ notificationsEnabled: false });
  await saveNotificationsEnabled(false);
});

watcherAutostartToggle.addEventListener('change', async () => {
  const enabled = watcherAutostartToggle.checked;
  store.setState({ watcherAutostart: enabled });
  await saveWatcherAutostart(enabled);
});

hideToTrayToggle.addEventListener('change', async () => {
  const enabled = hideToTrayToggle.checked;
  store.setState({ hideToTrayOnClose: enabled });
  await invoke('set_hide_to_tray_on_close', { enabled });
  await saveHideToTrayOnClose(enabled);
});

autoSyncToggle.addEventListener('change', async () => {
  const enabled = autoSyncToggle.checked;
  store.setState({ autoSyncNewScreenshots: enabled });
  await saveAutoSyncNewScreenshots(enabled);
});

reviewBacklogToggle.addEventListener('change', async () => {
  const enabled = reviewBacklogToggle.checked;
  store.setState({ reviewBacklogOnLaunch: enabled });
  await saveReviewBacklogOnLaunch(enabled);
});

backlogSelectAllBtn.addEventListener('click', () => {
  const paths = store.getState().backlogPaths;
  store.setState({ backlogSelected: [...paths] });
});

backlogClearBtn.addEventListener('click', () => {
  store.setState({ backlogSelected: [] });
});

backlogUploadBtn.addEventListener('click', async () => {
  const state = store.getState();
  if (!state.isAuthenticated) {
    store.setState({ uploadMessage: 'sign in to upload backlog' });
    return;
  }

  if (state.backlogSelected.length === 0) {
    store.setState({ uploadMessage: 'select at least one screenshot' });
    return;
  }

  backlogUploadBtn.disabled = true;
  try {
    for (const path of state.backlogSelected) {
      await uploadOneScreenshot(path, 'backlog');
    }
  } finally {
    backlogUploadBtn.disabled = false;
  }
});

backlogList.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') {
    return;
  }

  const path = target.dataset.path;
  if (!path) {
    return;
  }

  const selected = new Set(store.getState().backlogSelected);
  if (target.checked) {
    selected.add(path);
  } else {
    selected.delete(path);
  }

  store.setState({ backlogSelected: [...selected] });
});

backlogList.addEventListener('click', async (event) => {
  const target = event.target;
  const thumbnail = target instanceof HTMLElement
    ? target.closest('img.backlog-thumb') as HTMLImageElement | null
    : null;
  if (thumbnail) {
    event.preventDefault();
    openImagePreview(thumbnail.src);
    return;
  }
});

backlogList.addEventListener('click', async (event) => {
  const target = event.target;
  const button = target instanceof HTMLElement
    ? target.closest('button[data-action="ignore"]') as HTMLButtonElement | null
    : null;
  if (!button) {
    return;
  }

  event.preventDefault();
  const path = button.dataset.path;
  if (!path) {
    store.setState({ uploadMessage: 'ignore failed (missing item path)' });
    return;
  }

  await handleIgnoreBacklogItem(path);
});

ignoreConfirmCancelBtn.addEventListener('click', () => {
  const pending = pendingIgnorePath;
  hideIgnoreConfirm();
});

ignoreConfirmIgnoreBtn.addEventListener('click', async () => {
  const path = pendingIgnorePath;
  if (!path) {
    return;
  }

  await confirmIgnoreFromModal(path);
});

ignoreConfirmOverlay.addEventListener('click', (event) => {
  if (event.target === ignoreConfirmOverlay) {
    ignoreConfirmCancelBtn.click();
  }
});

imagePreviewCloseBtn.addEventListener('click', () => {
  closeImagePreview();
});

imagePreviewOverlay.addEventListener('click', (event) => {
  if (event.target === imagePreviewOverlay) {
    closeImagePreview();
  }
});

async function handleIgnoreBacklogItem(path: string): Promise<void> {
  try {
    const fileName = await basename(path).catch(() => path.split(/[\\/]/).pop() ?? path);
    showIgnoreConfirm(fileName, path);
  } catch (error) {
    console.error('[smartshots] failed to ignore', { path, error });
    store.setState({ uploadMessage: `ignore failed (${String(error)})` });
  }
}

websiteBtn.addEventListener('click', async () => {
  await invoke('open_website');
});

quitBtn.addEventListener('click', async () => {
  await invoke('quit_app');
});

async function listenForScreenshots(): Promise<void> {
  const unlisten = await listen<WatcherEventPayload>('screenshot-created', async (event) => {
    const filePath = event.payload.path;
    if (shouldSkipUpload(filePath)) {
      return;
    }

    if (await hasUploaded(filePath)) {
      store.setState({ uploadMessage: `skipped duplicate: ${filePath}` });
      return;
    }

    if (await hasIgnored(filePath)) {
      store.setState({ uploadMessage: `skipped ignored screenshot: ${filePath}` });
      return;
    }

    const state = store.getState();
    if (!state.isAuthenticated) {
      addBacklogPaths([filePath]);
      store.setState({ uploadMessage: `queued while signed out: ${filePath}` });
      return;
    }

    if (!state.autoSyncNewScreenshots) {
      addBacklogPaths([filePath]);
      store.setState({ uploadMessage: `queued for review: ${filePath}` });
      return;
    }

    await uploadOneScreenshot(filePath, 'watcher');
  });

  window.addEventListener('beforeunload', () => {
    unlisten();
  });
}

async function handleIncomingAuthUrl(url: string | undefined): Promise<void> {
  if (!url) return;

  const ok = await supabase.handleAuthCallback(url);
  if (!ok) {
    store.setState({ authMessage: 'callback failed' });
    return;
  }

  const signedInUserLabel = await getSignedInUserLabel();
  store.setState({
    isAuthenticated: true,
    authMessage: 'signed in',
    signedInUserLabel
  });
  await refreshBacklogCandidates();

  if (store.getState().watcherAutostart && !store.getState().watcherRunning) {
    await startWatcher();
  }
}

function showIgnoreConfirm(fileName: string, path: string): void {
  pendingIgnorePath = path;
  ignoreConfirmFileName.textContent = fileName;
  ignoreConfirmText.textContent = `Remove ${fileName} from the queue? This will not delete the image file.`;
  ignoreConfirmOverlay.hidden = false;
}

function hideIgnoreConfirm(): void {
  ignoreConfirmOverlay.hidden = true;
  pendingIgnorePath = null;
  ignoreConfirmFileName.textContent = '';
  ignoreConfirmText.textContent = '';
}

async function confirmIgnoreFromModal(path: string): Promise<void> {
  const fileName = ignoreConfirmFileName.textContent || path.split(/[\\/]/).pop() || path;

  hideIgnoreConfirm();

  try {
    await markIgnored(path);
    removeBacklogPaths([path]);
    store.setState({ uploadMessage: `removed from queue: ${fileName}` });
  } catch (error) {
    console.error('[smartshots] failed to ignore', { path, error });
    store.setState({ uploadMessage: `remove failed (${String(error)})` });
  }
}

async function getSignedInUserLabel(): Promise<string> {
  const userInfo = await supabase.getCurrentUserInfo();
  if (!userInfo) {
    return '';
  }

  return userInfo.name || userInfo.email || `User (${userInfo.id.slice(0, 8)})`;
}

async function refreshSignedInUserIdentity(): Promise<string> {
  return getSignedInUserLabel();
}

async function startWatcher(): Promise<void> {
  try {
    await invoke('start_screenshot_watcher');
    store.setState({ watcherRunning: true, watcherMessage: 'running' });
  } catch (error) {
    store.setState({ watcherMessage: `error (${String(error)})` });
  }
}

async function stopWatcher(): Promise<void> {
  try {
    await invoke('stop_screenshot_watcher');
    store.setState({ watcherRunning: false, watcherMessage: 'stopped' });
  } catch (error) {
    store.setState({ watcherMessage: `error (${String(error)})` });
  }
}

function render(state: AppState): void {
  const isAuthed = state.isAuthenticated;
  const onDashboard = state.activeView === 'dashboard';
  const onSettings = state.activeView === 'settings';

  signedInAs.textContent = state.signedInUserLabel ? `Signed in as ${state.signedInUserLabel}` : '';
  signedInAs.hidden = !isAuthed || !state.signedInUserLabel;
  watcherCard.classList.toggle('card--active', state.watcherRunning);
  watcherSummary.innerHTML = state.watcherRunning
    ? '<span class="watcher-pulse"></span>Active'
    : 'Stopped';
  authChip.textContent = isAuthed ? 'Signed In' : 'Signed Out';
  authChip.classList.toggle('auth-chip--ok', isAuthed);
  viewDashboard.hidden = !onDashboard;
  viewSettings.hidden = !onSettings;
  navDashboardBtn.classList.toggle('nav-item--active', onDashboard);
  navSettingsBtn.classList.toggle('nav-item--active', onSettings);
  uploadProgress.classList.toggle('upload-progress--active', state.uploadInProgress);
  uploadProgress.classList.toggle(
    'upload-progress--complete',
    !state.uploadInProgress && state.uploadProgress >= 100
  );

  uploadProgress.hidden = !state.uploadInProgress && state.uploadProgress <= 0;
  uploadProgressLabel.textContent = state.uploadInProgress
    ? `Uploading... ${Math.round(state.uploadProgress)}%`
    : state.uploadProgress > 0
      ? 'Upload complete'
      : 'Uploading...';
  uploadProgressFill.style.width = `${Math.max(0, Math.min(100, state.uploadProgress))}%`;
  processedTotal.textContent = String(state.processedTotal);
  lastSyncTime.textContent = state.lastSyncTs ? formatLastSync(state.lastSyncTs) : 'No sync yet';

  signinBtn.hidden = state.isAuthenticated;
  signoutBtn.hidden = !state.isAuthenticated;
  watcherBtn.textContent = state.watcherRunning ? 'Stop watcher' : 'Start watcher';
  watcherBtn.disabled = false;

  notificationsToggle.checked = state.notificationsEnabled;
  watcherAutostartToggle.checked = state.watcherAutostart;
  hideToTrayToggle.checked = state.hideToTrayOnClose;
  autoSyncToggle.checked = state.autoSyncNewScreenshots;
  reviewBacklogToggle.checked = state.reviewBacklogOnLaunch;

  const dirsKey = state.screenshotDirs.join('|');
  if (dirsKey !== lastDirsKey) {
    dirsList.replaceChildren();
    state.screenshotDirs.forEach((dir) => {
      const li = document.createElement('li');
      li.textContent = dir;
      dirsList.appendChild(li);
    });
    lastDirsKey = dirsKey;
  }

  backlogEmpty.hidden = state.backlogPaths.length > 0;
  backlogList.classList.toggle('backlog-list--scroll', state.backlogPaths.length > 1);
  backlogUploadBtn.disabled = state.backlogSelected.length === 0 || !state.isAuthenticated;
  renderRecentUploads(state.recentUploadLog);
  void renderBacklogList(state.backlogPaths, state.backlogSelected);
}

async function renderBacklogList(paths: string[], selectedPaths: string[]): Promise<void> {
  const token = ++backlogRenderToken;
  const selectedSet = new Set(selectedPaths);

  const listElements = await Promise.all(
    paths.map(async (path) => {
      const li = document.createElement('li');
      li.className = 'backlog-item';

      const img = document.createElement('img');
      img.className = 'backlog-thumb';
      img.alt = 'Screenshot preview';
      img.src = await getThumbnailUrl(path);
      img.dataset.path = path;

      const meta = document.createElement('div');
      meta.className = 'backlog-meta';

      const nameEl = document.createElement('p');
      nameEl.className = 'backlog-name';
      nameEl.textContent = await basename(path).catch(() => path.split(/[\\/]/).pop() ?? path);

      const timeEl = document.createElement('p');
      timeEl.className = 'backlog-time';
      timeEl.textContent = await formatBacklogDate(path);
      meta.appendChild(nameEl);
      meta.appendChild(timeEl);

      const actions = document.createElement('div');
      actions.className = 'backlog-actions';

      const ignoreBtn = document.createElement('button');
      ignoreBtn.type = 'button';
      ignoreBtn.className = 'secondary ignore-btn';
      ignoreBtn.dataset.action = 'ignore';
      ignoreBtn.dataset.path = path;
      ignoreBtn.textContent = 'Remove';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.path = path;
      checkbox.checked = selectedSet.has(path);

      actions.appendChild(ignoreBtn);
      actions.appendChild(checkbox);

      li.appendChild(img);
      li.appendChild(meta);
      li.appendChild(actions);
      return li;
    })
  );

  if (token !== backlogRenderToken) {
    return;
  }

  backlogList.replaceChildren(...listElements);
}

function renderRecentUploads(log: Array<{ name: string; path: string; ts: number }>): void {
  recentUploadsEmpty.hidden = log.length > 0;
  recentUploadsList.hidden = log.length === 0;
  const timestampFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });

  recentUploadsList.replaceChildren(
    ...[...log].reverse().map((entry) => {
      const li = document.createElement('li');
      li.className = 'recent-upload-item';

      const name = document.createElement('span');
      name.className = 'recent-upload-name';
      name.textContent = entry.name;

      const time = document.createElement('span');
      time.className = 'recent-upload-time';
      time.textContent = timestampFormatter.format(new Date(entry.ts));

      li.appendChild(name);
      li.appendChild(time);
      return li;
    })
  );
}

async function getThumbnailUrl(path: string): Promise<string> {
  const cached = thumbnailUrlCache.get(path);
  if (cached) {
    return cached;
  }

  try {
    const bytes = await readFile(path);
    const blob = new Blob([bytes], { type: guessContentType(path) });
    const url = URL.createObjectURL(blob);
    thumbnailUrlCache.set(path, url);
    return url;
  } catch {
    return '';
  }
}

function guessContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

async function uploadOneScreenshot(filePath: string, source: 'watcher' | 'backlog'): Promise<void> {
  if (inFlightUploads.has(filePath)) {
    return;
  }

  inFlightUploads.add(filePath);
  rememberRecent(filePath);
  const seq = ++uploadSequence;
  beginUploadProgress(seq);
  setUploadStatus(seq, `processing ${filePath}`);

  try {
    await delay(700);
    const result = await supabase.uploadScreenshot(filePath);
    await markUploadSuccess(filePath);

    setUploadStatus(seq, `uploaded via ${result.endpoint} (HTTP ${result.responseStatus})`);
    completeUploadProgress(seq);

    removeBacklogPaths([filePath]);

    const uploadedName = await basename(filePath);
    store.setState((s) => ({
      processedTotal: s.processedTotal + 1,
      lastSyncTs: Date.now(),
      recentUploadLog: [...s.recentUploadLog.slice(-4), { name: uploadedName, path: filePath, ts: Date.now() }]
    }));

    console.info('[smartshots] upload ok', {
      filePath,
      endpoint: result.endpoint,
      responseStatus: result.responseStatus,
      sizeBytes: result.sizeBytes,
      contentType: result.contentType,
      source
    });

    if (store.getState().notificationsEnabled) {
      await sendNotification({
        title: 'Smartshots',
        body: 'Screenshot uploaded successfully.'
      });
    }
  } catch (error) {
    const message = toErrorMessage(error);
    await markUploadFailure(filePath, message);
    setUploadStatus(seq, `failed (${message})`);
    failUploadProgress(seq);
    console.error('[smartshots] upload failed', { filePath, error, source });

    if (store.getState().notificationsEnabled) {
      await sendNotification({
        title: 'Smartshots',
        body: 'Screenshot upload failed. Open app for details.'
      });
    }
  } finally {
    inFlightUploads.delete(filePath);
  }
}

async function refreshBacklogCandidates(): Promise<void> {
  try {
    const candidates = await invoke<string[]>('list_recent_screenshots', { maxItems: 250, lookbackHours: 168 });
    const unprocessed = await getUnprocessedPaths(candidates);
    addBacklogPaths(unprocessed);

    if (unprocessed.length > 0) {
      store.setState({ uploadMessage: `backlog found: ${unprocessed.length} screenshot(s) pending review` });
    }
  } catch (error) {
    console.warn('[smartshots] backlog scan failed', error);
  }
}

function addBacklogPaths(paths: string[]): void {
  if (paths.length === 0) {
    return;
  }

  const now = Date.now();
  paths.forEach((path) => {
    if (!backlogQueuedAt.has(path)) {
      backlogQueuedAt.set(path, now);
    }
  });

  store.setState((state) => {
    const merged = new Set(state.backlogPaths);
    paths.forEach((path) => merged.add(path));
    const nextPaths = [...merged];

    const selected = state.backlogSelected.filter((path) => merged.has(path));
    return {
      backlogPaths: nextPaths,
      backlogSelected: selected,
      backlogCount: nextPaths.length
    };
  });
}

function removeBacklogPaths(paths: string[]): void {
  if (paths.length === 0) {
    return;
  }

  const toRemove = new Set(paths);
  paths.forEach((path) => {
    backlogQueuedAt.delete(path);
    backlogFileModifiedAt.delete(path);
  });
  store.setState((state) => {
    const nextPaths = state.backlogPaths.filter((path) => !toRemove.has(path));
    const nextSelected = state.backlogSelected.filter((path) => !toRemove.has(path));
    return {
      backlogPaths: nextPaths,
      backlogSelected: nextSelected,
      backlogCount: nextPaths.length
    };
  });
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function formatBacklogDate(path: string): Promise<string> {
  const modifiedTs = await getBacklogFileModifiedAt(path);
  const ts = modifiedTs ?? backlogQueuedAt.get(path) ?? Date.now();
  const d = new Date(ts);
  const weekday = WEEKDAY_SHORT[d.getDay()] ?? '---';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const meridiem = d.getHours() >= 12 ? 'PM' : 'AM';
  const hour12 = d.getHours() % 12 || 12;
  return `${weekday} ${month}/${day}/${year} ${hour12}:${minutes}${meridiem}`;
}

async function getBacklogFileModifiedAt(path: string): Promise<number | null> {
  const cached = backlogFileModifiedAt.get(path);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const ts = await invoke<number | null>('get_screenshot_modified_ms', { path });
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      backlogFileModifiedAt.set(path, ts);
      return ts;
    }
  } catch {
    // fall back to queue timestamp if metadata lookup fails
  }

  return null;
}

function openImagePreview(src: string): void {
  imagePreviewImage.src = src;
  imagePreviewOverlay.hidden = false;
}

function closeImagePreview(): void {
  imagePreviewOverlay.hidden = true;
  imagePreviewImage.src = '';
}

function formatLastSync(ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const meridiem = d.getHours() >= 12 ? 'PM' : 'AM';
  const hour12 = d.getHours() % 12 || 12;
  return `${month}/${day}/${year} ${hour12}:${minutes}${meridiem}`;
}

void init();

function beginUploadProgress(seq: number): void {
  clearUploadProgressTimer();
  if (seq !== uploadSequence) return;

  store.setState({
    uploadInProgress: true,
    uploadProgress: 8
  });

  uploadProgressTimer = window.setInterval(() => {
    if (seq !== uploadSequence) {
      clearUploadProgressTimer();
      return;
    }

    const current = store.getState().uploadProgress;
    if (current >= 90) {
      return;
    }

    const increment = Math.max(1, Math.round((90 - current) * 0.12));
    store.setState({ uploadProgress: Math.min(90, current + increment) });
  }, 220);
}

function completeUploadProgress(seq: number): void {
  if (seq !== uploadSequence) return;
  clearUploadProgressTimer();
  store.setState({
    uploadInProgress: false,
    uploadProgress: 100
  });

  window.setTimeout(() => {
    if (seq !== uploadSequence) return;
    store.setState({ uploadProgress: 0 });
  }, 1200);
}

function failUploadProgress(seq: number): void {
  if (seq !== uploadSequence) return;
  clearUploadProgressTimer();
  store.setState({
    uploadInProgress: false,
    uploadProgress: 0
  });
}

function clearUploadProgressTimer(): void {
  if (uploadProgressTimer !== null) {
    window.clearInterval(uploadProgressTimer);
    uploadProgressTimer = null;
  }
}

function shouldSkipUpload(path: string): boolean {
  if (inFlightUploads.has(path)) {
    return true;
  }

  const ts = recentUploads.get(path);
  if (!ts) return false;
  return Date.now() - ts < 8000;
}

function rememberRecent(path: string): void {
  const now = Date.now();
  recentUploads.set(path, now);

  for (const [key, ts] of recentUploads.entries()) {
    if (now - ts > 15000) {
      recentUploads.delete(key);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setUploadStatus(seq: number, message: string): void {
  if (seq !== uploadSequence) {
    return;
  }
  store.setState({ uploadMessage: message });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
