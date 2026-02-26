import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { openUrl } from '@tauri-apps/plugin-opener';
import { basename } from '@tauri-apps/api/path';
import { readFile } from '@tauri-apps/plugin-fs';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import imageCompression from 'browser-image-compression';
import { config } from './env';

export type AuthChangeHandler = (isAuthenticated: boolean) => void;
export type UploadResult = {
  endpoint: string;
  responseStatus: number;
  contentType: string;
  sizeBytes: number;
};

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
    const { data } = await this.supabase.auth.getSession();
    const session = data.session;

    if (!session?.user) {
      throw new Error('Not authenticated');
    }

    const sourceBytes = await readFile(filePath);
    const fileName = await basename(filePath);

    const originalExtension = getExtension(fileName);
    const originalType = guessContentType(fileName);
    const sourceBlob = new Blob([sourceBytes], { type: originalType });
    const sourceFile = new File([sourceBlob], fileName, { type: sourceBlob.type });

    const compressed = await imageCompression(sourceFile, {
      maxSizeMB: 2,
      maxWidthOrHeight: 2560,
      useWebWorker: true,
      initialQuality: 0.85
    });

    const uploadType = compressed.type || originalType || 'application/octet-stream';
    const compressedFile = new File([compressed], fileName, { type: uploadType });
    const metadata = {
      timestamp: Date.now(),
      source: 'tauri-desktop-app',
      page_url: '',
      page_title: 'Screenshot',
      image_url: ''
    };

    const response = await this.uploadToApi({
      accessToken: session.access_token,
      file: compressedFile,
      metadata
    });

    if (response.status === 401) {
      const refreshed = await this.supabase.auth.refreshSession();
      const refreshedToken = refreshed.data.session?.access_token;

      if (!refreshedToken) {
        throw new Error('Unauthorized and token refresh failed');
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

  private async uploadToApi(args: {
    accessToken: string;
    file: File;
    metadata: Record<string, unknown>;
  }): Promise<Response> {
    const formData = new FormData();
    formData.append('screenshots', args.file, args.file.name);
    formData.append('metadata', JSON.stringify(args.metadata));
    formData.append('source', 'desktop_app');

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

function getExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) {
    return 'bin';
  }
  return name.slice(idx + 1).toLowerCase();
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
