import { AxiosInstance, AxiosRequestConfig } from 'axios';
import { createServiceClient, jellyfinAuthHeader } from '../../core/api/httpClient';
import { ServiceConfig, ServiceStatus } from '../../core/types/services';
import type { EmbyItemRef, EmbyMediaItem } from '../emby/adapter';
import type { MediaServer, ProviderIdQuery } from '../mediaServer';

// Jellyfin forked from Emby, so item payloads match EmbyMediaItem. The
// differences that matter here: auth must use the MediaBrowser Authorization
// header (Jellyfin 12 disables X-Emby-Token), the /emby path prefix is gone,
// user-scoped routes moved to ?userId= query params (10.9+), and /Items has no
// provider-id filter, so lookups go through a cached provider-id index.

const INDEX_TTL_MS = 10 * 60 * 1000;

interface IndexEntry { Id: string; ServerId: string; Name: string; ProviderIds?: Record<string, string> }

export class JellyfinAdapter implements MediaServer {
  readonly id = 'jellyfin' as const;
  readonly label = 'Jellyfin';
  private client: AxiosInstance;
  readonly baseUrl: string;
  private apiKey: string;
  private userId: string | null = null;
  private userIdPromise: Promise<string | null> | null = null;
  private index: Partial<Record<'Movie' | 'Series', { at: number; items: Promise<IndexEntry[]> }>> = {};

  constructor(config: ServiceConfig, isLocal: boolean) {
    this.client = createServiceClient(config, isLocal);
    this.baseUrl = (isLocal ? config.localUrl : config.remoteUrl).replace(/\/+$/, '');
    this.apiKey = config.apiKey ?? '';
  }

  // Watched state is per-user; use the first server user (single-user setups).
  private getUserId(): Promise<string | null> {
    if (this.userId) return Promise.resolve(this.userId);
    if (!this.userIdPromise) {
      this.userIdPromise = this.client.get('/Users')
        .then(({ data }) => { this.userId = data?.[0]?.Id ?? null; return this.userId; })
        .finally(() => { this.userIdPromise = null; });
    }
    return this.userIdPromise;
  }

  // Current route first; 10.8 and older only know the /Users/{id}/... form
  private async getWithFallback(url: string, legacyUrl: string, config: AxiosRequestConfig): Promise<any> {
    try {
      return (await this.client.get(url, config)).data;
    } catch (e: any) {
      if (e.response?.status !== 404) throw e;
      const { userId: _drop, ...params } = (config.params ?? {}) as Record<string, any>;
      return (await this.client.get(legacyUrl, { ...config, params })).data;
    }
  }

  async getResumeItems(limit = 12): Promise<EmbyMediaItem[]> {
    const userId = await this.getUserId();
    if (!userId) return [];
    const data = await this.getWithFallback('/UserItems/Resume', `/Users/${userId}/Items/Resume`, {
      params: { userId, Limit: limit, MediaTypes: 'Video' },
    });
    return data?.Items ?? [];
  }

  async getNextUp(limit = 12): Promise<EmbyMediaItem[]> {
    const userId = await this.getUserId();
    if (!userId) return [];
    const { data } = await this.client.get('/Shows/NextUp', { params: { userId, Limit: limit } });
    return data?.Items ?? [];
  }

  // Bare array response, episodes grouped under their series
  async getLatestUnplayed(type: 'Episode' | 'Movie', limit = 12): Promise<EmbyMediaItem[]> {
    const userId = await this.getUserId();
    if (!userId) return [];
    const data = await this.getWithFallback('/Items/Latest', `/Users/${userId}/Items/Latest`, {
      params: { userId, IncludeItemTypes: type, Limit: limit, IsPlayed: false, GroupItems: true, Fields: 'ProviderIds' },
    });
    return Array.isArray(data) ? data : [];
  }

  async getRecentlyPlayed(limit = 300): Promise<EmbyMediaItem[]> {
    const userId = await this.getUserId();
    if (!userId) return [];
    const data = await this.getWithFallback('/Items', `/Users/${userId}/Items`, {
      params: {
        userId, IncludeItemTypes: 'Episode,Movie', Filters: 'IsPlayed', Recursive: true,
        Limit: limit, SortBy: 'DatePlayed', SortOrder: 'Descending', Fields: 'ProviderIds',
      },
    });
    return data?.Items ?? [];
  }

  posterUrl(item: EmbyMediaItem): string | undefined {
    const isEpisode = item.Type === 'Episode' && item.SeriesId;
    const imageItemId = isEpisode ? item.SeriesId : item.Id;
    const tag = isEpisode ? item.SeriesPrimaryImageTag : item.ImageTags?.Primary;
    if (!tag) return undefined;
    return `${this.baseUrl}/Items/${imageItemId}/Images/Primary?maxHeight=450&tag=${tag}`;
  }

  imageHeaders(): Record<string, string> {
    return { Authorization: jellyfinAuthHeader(this.apiKey) };
  }

  async testConnection(): Promise<boolean> {
    await this.client.get('/System/Info');
    return true;
  }

  async getStatus(): Promise<ServiceStatus> {
    try {
      const { data } = await this.client.get('/System/Info');
      return {
        serviceId: 'jellyfin',
        connection: { status: 'connected', isLocal: true, lastChecked: Date.now() },
        summary: data?.ServerName ? `${data.ServerName} · v${data.Version}` : 'Connected',
      };
    } catch (e: any) {
      return { serviceId: 'jellyfin', connection: { status: 'error', isLocal: true, lastChecked: Date.now(), error: e.message }, summary: 'Connection failed' };
    }
  }

  // Slim library listing (ids + provider ids only), shared by lookups for a
  // few minutes so tapping through several titles costs one request
  private getIndex(type: 'Movie' | 'Series'): Promise<IndexEntry[]> {
    const cached = this.index[type];
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.items;
    const items = this.client.get('/Items', {
      params: {
        Recursive: true, IncludeItemTypes: type, Fields: 'ProviderIds',
        EnableImages: false, EnableUserData: false,
      },
    }).then(({ data }) => (data?.Items ?? []) as IndexEntry[]);
    this.index[type] = { at: Date.now(), items };
    items.catch(() => { if (this.index[type]?.items === items) delete this.index[type]; });
    return items;
  }

  async findItem(type: 'Movie' | 'Series', ids: ProviderIdQuery): Promise<EmbyItemRef | null> {
    const wanted: [string, string][] = [];
    if (ids.tmdbId) wanted.push(['tmdb', String(ids.tmdbId)]);
    if (ids.imdbId) wanted.push(['imdb', ids.imdbId.toLowerCase()]);
    if (ids.tvdbId) wanted.push(['tvdb', String(ids.tvdbId)]);
    if (wanted.length === 0) return null;

    const items = await this.getIndex(type);
    // Same priority as Emby: tmdb, then imdb, then tvdb
    for (const [provider, value] of wanted) {
      const hit = items.find((it) => {
        const pids = it.ProviderIds ?? {};
        const key = Object.keys(pids).find((k) => k.toLowerCase() === provider);
        return key !== undefined && String(pids[key]).toLowerCase() === value;
      });
      if (hit) return { Id: hit.Id, ServerId: hit.ServerId, Name: hit.Name };
    }
    return null;
  }

  // The Jellyfin Android app has no item deep link; the web client opens in
  // the browser (or the app, if it claims the server's URL)
  itemAppUrl(): string | null {
    return null;
  }

  itemWebUrl(item: EmbyItemRef): string {
    return `${this.baseUrl}/web/#/details?id=${item.Id}&serverId=${item.ServerId}`;
  }
}
