import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { openUrl } from '@tauri-apps/plugin-opener';
import { basename } from '@tauri-apps/api/path';
import { readFile } from '@tauri-apps/plugin-fs';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import imageCompression from 'browser-image-compression';
import { config } from './env';

export type AuthChangeHandler = (isAuthenticated: boolean) => void;
export type SignedInUserInfo = {
  id: string;
  email: string | null;
  name: string | null;
};
export type UploadResult = {
  endpoint: string;
  responseStatus: number;
  contentType: string;
  sizeBytes: number;
};

const MIN_COMPRESSION_GAIN = 0.03;
const WEBP_ATTEMPTS = [
  { maxWidthOrHeight: 3000, initialQuality: 0.94 },
  { maxWidthOrHeight: 2560, initialQuality: 0.92 },
  { maxWidthOrHeight: 2560, initialQuality: 0.88 },
  { maxWidthOrHeight: 2200, initialQuality: 0.84 }
];
const JPEG_ATTEMPTS = [
  { maxWidthOrHeight: 3000, initialQuality: 0.92 },
  { maxWidthOrHeight: 2560, initialQuality: 0.89 },
  { maxWidthOrHeight: 2200, initialQuality: 0.85 }
];

export class SupabaseService {
  private supabase: SupabaseClient;
  private authHandlers = new Set<AuthChangeHandler>();

  constructor() {
    this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        detectSessionInUrl: false,
        persistSession: true,
        autoRefreshToken: true
      }
    });

    this.supabase.auth.onAuthStateChange((_event, session) => {
      const authed = Boolean(session?.access_token);
      this.authHandlers.forEach((handler) => handler(authed));
    });
  }

  onAuthenticationStateChanged(handler: AuthChangeHandler): () => void {
    this.authHandlers.add(handler);
    return () => this.authHandlers.delete(handler);
  }

  async isAuthenticated(): Promise<boolean> {
    const { data } = await this.supabase.auth.getSession();
    return Boolean(data.session?.access_token);
  }

  async getCurrentUserInfo(): Promise<SignedInUserInfo | null> {
    const { data, error } = await this.supabase.auth.getUser();
    if (error || !data.user) {
      return null;
    }

    const name = data.user.user_metadata?.full_name || data.user.user_metadata?.name || null;
    return {
      id: data.user.id,
      email: data.user.email ?? null,
      name
    };
  }

  async beginOAuthSignIn(): Promise<void> {
    return this.beginOAuthSignInWithRedirect(config.oauthRedirect);
  }

  async beginOAuthSignInWithRedirect(redirectTo: string): Promise<void> {
    const { data, error } = await this.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent'
        }
      }
    });

    if (error) {
      throw error;
    }

    if (!data.url) {
      throw new Error('OAuth URL was not returned by Supabase');
    }

    await openUrl(data.url);
  }

  async signInWithPassword(email: string, password: string): Promise<void> {
    const { error } = await this.supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      throw error;
    }
  }

  async handleAuthCallback(url: string): Promise<boolean> {
    try {
      const callbackUrl = new URL(url);
      const code = callbackUrl.searchParams.get('code');

      if (code) {
        const { error } = await this.supabase.auth.exchangeCodeForSession(code);
        return !error;
      }

      const fragment = callbackUrl.hash.replace(/^#/, '');
      const params = new URLSearchParams(fragment);

      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token') ?? '';

      if (!accessToken) {
        return false;
      }

      const { error } = await this.supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });

      return !error;
    } catch {
      return false;
    }
  }

  async signOut(): Promise<void> {
    const { error } = await this.supabase.auth.signOut();
    if (error) {
      throw error;
    }
  }

  async uploadScreenshot(filePath: string): Promise<UploadResult> {
    const accessToken = await this.getValidAccessToken();
    if (!accessToken) {
      throw new Error('Not authenticated');
    }

    const sourceBytes = await readFile(filePath);
    const fileName = await basename(filePath);

    const originalType = guessContentType(fileName);
    const sourceBlob = new Blob([sourceBytes], { type: originalType });
    const sourceFile = new File([sourceBlob], fileName, { type: sourceBlob.type });
    const compressedFile = await compressForUpload(sourceFile);
    const uploadType = compressedFile.type || originalType || 'application/octet-stream';
    const uploadSource = getUploadSource();
    const metadata = {
      timestamp: Date.now(),
      source: uploadSource,
      page_url: '',
      page_title: 'Screenshot',
      image_url: ''
    };

    const response = await this.uploadToApi({
      accessToken,
      file: compressedFile,
      metadata
    });

    if (response.status === 401 || response.status === 403) {
      const refreshedToken = await this.refreshAccessToken();
      if (!refreshedToken) {
        const body = await safeReadBody(response);
        throw new Error(`API upload failed (${response.status}): ${body}`);
      }

      const retryResponse = await this.uploadToApi({
        accessToken: refreshedToken,
        file: compressedFile,
        metadata
      });

      if (!retryResponse.ok) {
        const body = await safeReadBody(retryResponse);
        throw new Error(`API upload failed (${retryResponse.status}): ${body}`);
      }

      return {
        endpoint: '/api/screenshots',
        responseStatus: retryResponse.status,
        contentType: uploadType,
        sizeBytes: compressedFile.size
      };
    }

    if (!response.ok) {
      const body = await safeReadBody(response);
      throw new Error(`API upload failed (${response.status}): ${body}`);
    }

    return {
      endpoint: '/api/screenshots',
      responseStatus: response.status,
      contentType: uploadType,
      sizeBytes: compressedFile.size
    };
  }

  private async getValidAccessToken(): Promise<string | null> {
    const { data } = await this.supabase.auth.getSession();
    const session = data.session;

    if (!session?.user) {
      return null;
    }

    if (session.access_token) {
      const userCheck = await this.supabase.auth.getUser(session.access_token);
      if (!userCheck.error && userCheck.data.user) {
        if (!session.expires_at) {
          return session.access_token;
        }

        const expiresAtMs = Number(session.expires_at) * 1000;
        const safeUntilMs = Date.now() + 20_000;
        if (!Number.isNaN(expiresAtMs) && expiresAtMs > safeUntilMs) {
          return session.access_token;
        }
      }
    }

    const refreshedByGetUser = await this.supabase.auth.refreshSession();
    if (refreshedByGetUser.data.session?.access_token) {
      return refreshedByGetUser.data.session.access_token;
    }

    if (!session.expires_at) {
      return session.access_token;
    }

    const expiresAtMs = Number(session.expires_at) * 1000;
    const safeUntilMs = Date.now() + 20_000;
    if (!Number.isNaN(expiresAtMs) && expiresAtMs > safeUntilMs) {
      return session.access_token;
    }

    const refreshed = await this.supabase.auth.refreshSession();
    return refreshed.data.session?.access_token ?? null;
  }

  private async refreshAccessToken(): Promise<string | null> {
    const refreshed = await this.supabase.auth.refreshSession();
    return refreshed.data.session?.access_token ?? null;
  }

  private async uploadToApi(args: {
    accessToken: string;
    file: File;
    metadata: Record<string, unknown>;
  }): Promise<Response> {
    const formData = new FormData();
    formData.append('screenshots', args.file, args.file.name);
    formData.append('metadata', JSON.stringify(args.metadata));
    formData.append('source', getUploadSource());

    return nativeFetch(`${config.apiBaseUrl}/api/screenshots`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        Accept: 'application/json'
      },
      body: formData
    });
  }
}

function guessContentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpeg') || lower.endsWith('.jpg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

async function compressForUpload(sourceFile: File): Promise<File> {
  let bestCandidate: File = sourceFile;

  for (const attempt of WEBP_ATTEMPTS) {
    const compressed = await imageCompression(sourceFile, {
      maxSizeMB: 3,
      maxWidthOrHeight: attempt.maxWidthOrHeight,
      useWebWorker: true,
      initialQuality: attempt.initialQuality,
      fileType: 'image/webp',
      preserveExif: false
    });
    const candidate = toUploadFile(compressed, sourceFile.name, 'image/webp');
    if (candidate.size < bestCandidate.size) {
      bestCandidate = candidate;
    }
  }

  for (const attempt of JPEG_ATTEMPTS) {
    const compressed = await imageCompression(sourceFile, {
      maxSizeMB: 3,
      maxWidthOrHeight: attempt.maxWidthOrHeight,
      useWebWorker: true,
      initialQuality: attempt.initialQuality,
      fileType: 'image/jpeg',
      preserveExif: false
    });
    const candidate = toUploadFile(compressed, sourceFile.name, 'image/jpeg');
    if (candidate.size < bestCandidate.size) {
      bestCandidate = candidate;
    }
  }

  const gainRatio = 1 - bestCandidate.size / sourceFile.size;
  if (gainRatio < MIN_COMPRESSION_GAIN) {
    return sourceFile;
  }

  return bestCandidate;
}

function toUploadFile(blob: Blob, originalName: string, fallbackType: 'image/webp' | 'image/jpeg'): File {
  const type = blob.type || fallbackType;
  const extension = type === 'image/webp' ? 'webp' : 'jpg';
  const dotIndex = originalName.lastIndexOf('.');
  const baseName = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
  return new File([blob], `${baseName}.${extension}`, { type });
}

function getUploadSource(): 'mac_app' | 'win_app' | 'desktop_app' {
  const userAgent = navigator.userAgent || '';

  if (userAgent.includes('Mac')) {
    return 'mac_app';
  }

  if (userAgent.includes('Windows')) {
    return 'win_app';
  }

  return 'desktop_app';
}

function randomBase36(length: number): string {
  let out = '';
  while (out.length < length) {
    out += Math.random().toString(36).slice(2);
  }
  return out.slice(0, length);
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || '{}';
  } catch {
    return '{}';
  }
}
