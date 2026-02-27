import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { assertEnv } from './env';
import { SupabaseService } from './supabaseService';
import { createStore } from './store';
import { readPreferences, saveHideToTrayOnClose, saveNotificationsEnabled, saveWatcherAutostart } from './preferences';
import './styles.css';

type WatcherEventPayload = {
  path: string;
};

type OAuthCallbackPayload = {
  url: string;
};

type AppState = {
  isAuthenticated: boolean;
  authMessage: string;
  watcherRunning: boolean;
  watcherMessage: string;
  uploadMessage: string;
  uploadProgress: number;
  uploadInProgress: boolean;
  notificationsEnabled: boolean;
  watcherAutostart: boolean;
  hideToTrayOnClose: boolean;
  screenshotDirs: string[];
};

const authStatus = document.querySelector<HTMLParagraphElement>('#auth-status')!;
const watcherStatus = document.querySelector<HTMLParagraphElement>('#watcher-status')!;
const uploadStatus = document.querySelector<HTMLParagraphElement>('#upload-status')!;
const uploadProgress = document.querySelector<HTMLDivElement>('#upload-progress')!;
const uploadProgressLabel = document.querySelector<HTMLDivElement>('#upload-progress-label')!;
const uploadProgressFill = document.querySelector<HTMLDivElement>('#upload-progress-fill')!;
const dirsList = document.querySelector<HTMLUListElement>('#dirs-list')!;
const signinBtn = document.querySelector<HTMLButtonElement>('#signin-btn')!;
const signoutBtn = document.querySelector<HTMLButtonElement>('#signout-btn')!;
const watcherBtn = document.querySelector<HTMLButtonElement>('#watcher-btn')!;
const notificationsToggle = document.querySelector<HTMLInputElement>('#notifications-toggle')!;
const watcherAutostartToggle = document.querySelector<HTMLInputElement>('#watcher-autostart-toggle')!;
const hideToTrayToggle = document.querySelector<HTMLInputElement>('#hide-to-tray-toggle')!;
const websiteBtn = document.querySelector<HTMLButtonElement>('#website-btn')!;
const quitBtn = document.querySelector<HTMLButtonElement>('#quit-btn')!;

assertEnv();
const supabase = new SupabaseService();
const recentUploads = new Map<string, number>();
const inFlightUploads = new Set<string>();
let uploadSequence = 0;
let uploadProgressTimer: number | null = null;
const store = createStore<AppState>({
  isAuthenticated: false,
  authMessage: 'checking...',
  watcherRunning: false,
  watcherMessage: 'stopped',
  uploadMessage: 'idle',
  uploadProgress: 0,
  uploadInProgress: false,
  notificationsEnabled: false,
  watcherAutostart: false,
  hideToTrayOnClose: true,
  screenshotDirs: []
});

let lastDirsKey = '';
store.subscribe(render);
render(store.getState());

async function init(): Promise<void> {
  const preferences = await readPreferences();
  store.setState({
    notificationsEnabled: preferences.notificationsEnabled,
    watcherAutostart: preferences.watcherAutostart,
    hideToTrayOnClose: preferences.hideToTrayOnClose
  });
  await invoke('set_hide_to_tray_on_close', { enabled: preferences.hideToTrayOnClose });

  const dirs = await invoke<string[]>('get_default_screenshot_dirs');
  store.setState({ screenshotDirs: dirs });

  const authed = await supabase.isAuthenticated();
  store.setState({
    isAuthenticated: authed,
    authMessage: authed ? 'signed in' : 'signed out'
  });

  if (authed && preferences.watcherAutostart) {
    await startWatcher();
  }

  supabase.onAuthenticationStateChanged((isAuthenticated) => {
    store.setState({
      isAuthenticated,
      authMessage: isAuthenticated ? 'signed in' : 'signed out'
    });

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
    await stopWatcher();
    await supabase.signOut();
    store.setState({
      isAuthenticated: false,
      authMessage: 'signed out'
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

    inFlightUploads.add(filePath);
    rememberRecent(filePath);
    const seq = ++uploadSequence;
    beginUploadProgress(seq);
    setUploadStatus(seq, `processing ${filePath}`);

    try {
      await delay(700);
      const result = await supabase.uploadScreenshot(filePath);
      setUploadStatus(seq, `uploaded via ${result.endpoint} (HTTP ${result.responseStatus})`);
      completeUploadProgress(seq);
      console.info('[smartshots] upload ok', {
        filePath,
        endpoint: result.endpoint,
        responseStatus: result.responseStatus,
        sizeBytes: result.sizeBytes,
        contentType: result.contentType
      });

      if (store.getState().notificationsEnabled) {
        await sendNotification({
          title: 'Smartshots',
          body: 'Screenshot uploaded successfully.'
        });
      }
    } catch (error) {
      setUploadStatus(seq, `failed (${toErrorMessage(error)})`);
      failUploadProgress(seq);
      console.error('[smartshots] upload failed', { filePath, error });

      if (store.getState().notificationsEnabled) {
        await sendNotification({
          title: 'Smartshots',
          body: 'Screenshot upload failed. Open app for details.'
        });
      }
    } finally {
      inFlightUploads.delete(filePath);
    }
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

  store.setState({
    isAuthenticated: true,
    authMessage: 'signed in'
  });

  if (store.getState().watcherAutostart && !store.getState().watcherRunning) {
    await startWatcher();
  }
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
  authStatus.innerHTML = `<strong>Auth:</strong> ${escapeHtml(state.authMessage)}`;
  watcherStatus.innerHTML = `<strong>Watcher:</strong> ${escapeHtml(state.watcherMessage)}`;
  uploadStatus.innerHTML = `<strong>Uploads:</strong> ${escapeHtml(state.uploadMessage)}`;
  uploadProgress.hidden = !state.uploadInProgress && state.uploadProgress <= 0;
  uploadProgressLabel.textContent = state.uploadInProgress
    ? `Uploading... ${Math.round(state.uploadProgress)}%`
    : state.uploadProgress > 0
      ? `Upload complete`
      : 'Uploading...';
  uploadProgressFill.style.width = `${Math.max(0, Math.min(100, state.uploadProgress))}%`;

  signinBtn.hidden = state.isAuthenticated;
  signoutBtn.hidden = !state.isAuthenticated;
  watcherBtn.textContent = state.watcherRunning ? 'Stop watcher' : 'Start watcher';
  watcherBtn.disabled = !state.isAuthenticated;
  notificationsToggle.checked = state.notificationsEnabled;
  watcherAutostartToggle.checked = state.watcherAutostart;
  hideToTrayToggle.checked = state.hideToTrayOnClose;

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
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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
