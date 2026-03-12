import { load } from '@tauri-apps/plugin-store';

type UploadRecord = {
  filePath: string;
  status: 'uploaded' | 'failed' | 'ignored';
  uploadedAt?: number;
  lastAttemptAt: number;
  attempts: number;
  lastError?: string;
};

type UploadHistoryData = {
  version: number;
  byPath: Record<string, UploadRecord>;
};

const STORE_FILE = 'upload-history.json';
const STORE_KEY = 'uploadHistory';
const HISTORY_VERSION = 1;
const MAX_HISTORY_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 5000;

type Cache = {
  store: Awaited<ReturnType<typeof load>>;
  data: UploadHistoryData;
};

let cachePromise: Promise<Cache> | null = null;

function normalizePath(path: string): string {
  return path.trim().toLowerCase();
}

async function getCache(): Promise<Cache> {
  if (cachePromise) {
    return cachePromise;
  }

  cachePromise = (async () => {
    const store = await load(STORE_FILE);
    const raw = await store.get(STORE_KEY);

    const data = normalizeData(raw);
    return { store, data };
  })();

  return cachePromise;
}

function normalizeData(raw: unknown): UploadHistoryData {
  if (!raw || typeof raw !== 'object') {
    return { version: HISTORY_VERSION, byPath: {} };
  }

  const rawObj = raw as Partial<UploadHistoryData>;
  const byPath = rawObj.byPath && typeof rawObj.byPath === 'object' ? rawObj.byPath : {};

  return {
    version: HISTORY_VERSION,
    byPath: byPath as Record<string, UploadRecord>
  };
}

async function persist(cache: Cache): Promise<void> {
  await cache.store.set(STORE_KEY, cache.data);
  await cache.store.save();
}

export async function hasUploaded(filePath: string): Promise<boolean> {
  const cache = await getCache();
  const record = cache.data.byPath[normalizePath(filePath)];
  return record?.status === 'uploaded';
}

export async function hasIgnored(filePath: string): Promise<boolean> {
  const cache = await getCache();
  const record = cache.data.byPath[normalizePath(filePath)];
  return record?.status === 'ignored';
}

export async function markUploadSuccess(filePath: string): Promise<void> {
  const cache = await getCache();
  const key = normalizePath(filePath);
  const prev = cache.data.byPath[key];
  const now = Date.now();

  cache.data.byPath[key] = {
    filePath,
    status: 'uploaded',
    uploadedAt: now,
    lastAttemptAt: now,
    attempts: (prev?.attempts ?? 0) + 1
  };

  await pruneUploadHistoryInternal(cache);
  await persist(cache);
}

export async function markUploadFailure(filePath: string, error: string): Promise<void> {
  const cache = await getCache();
  const key = normalizePath(filePath);
  const prev = cache.data.byPath[key];
  const now = Date.now();

  cache.data.byPath[key] = {
    filePath,
    status: 'failed',
    uploadedAt: prev?.uploadedAt,
    lastAttemptAt: now,
    attempts: (prev?.attempts ?? 0) + 1,
    lastError: error.slice(0, 500)
  };

  await pruneUploadHistoryInternal(cache);
  await persist(cache);
}

export async function markIgnored(filePath: string): Promise<void> {
  const cache = await getCache();
  const key = normalizePath(filePath);
  const prev = cache.data.byPath[key];
  const now = Date.now();

  cache.data.byPath[key] = {
    filePath,
    status: 'ignored',
    uploadedAt: prev?.uploadedAt,
    lastAttemptAt: now,
    attempts: (prev?.attempts ?? 0) + 1
  };

  await pruneUploadHistoryInternal(cache);
  await persist(cache);
}

export async function getUnprocessedPaths(paths: string[]): Promise<string[]> {
  const cache = await getCache();

  const out: string[] = [];
  for (const path of paths) {
    const record = cache.data.byPath[normalizePath(path)];
    if (record?.status === 'uploaded' || record?.status === 'ignored') {
      continue;
    }
    out.push(path);
  }

  return out;
}

export async function pruneUploadHistory(): Promise<void> {
  const cache = await getCache();
  const changed = await pruneUploadHistoryInternal(cache);
  if (changed) {
    await persist(cache);
  }
}

async function pruneUploadHistoryInternal(cache: Cache): Promise<boolean> {
  const now = Date.now();
  const entries = Object.entries(cache.data.byPath);
  let changed = false;

  for (const [key, record] of entries) {
    const ts = record.uploadedAt ?? record.lastAttemptAt;
    if (!ts || now - ts > MAX_HISTORY_AGE_MS) {
      delete cache.data.byPath[key];
      changed = true;
    }
  }

  const remaining = Object.entries(cache.data.byPath);
  if (remaining.length > MAX_HISTORY_ENTRIES) {
    remaining
      .sort((a, b) => {
        const aTs = a[1].uploadedAt ?? a[1].lastAttemptAt ?? 0;
        const bTs = b[1].uploadedAt ?? b[1].lastAttemptAt ?? 0;
        return bTs - aTs;
      })
      .slice(MAX_HISTORY_ENTRIES)
      .forEach(([key]) => {
        delete cache.data.byPath[key];
        changed = true;
      });
  }

  return changed;
}
