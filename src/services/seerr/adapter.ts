import { AxiosInstance } from 'axios';
import { createServiceClient } from '../../core/api/httpClient';
import { ServiceConfig, ServiceStatus } from '../../core/types/services';
import {
  SeerrMediaDetails, SeerrMediaType, SeerrRequest, SeerrRequestCount, SeerrRequestFilter, SeerrRequestPage,
} from './types';

// Request rows reference media by tmdb id only, so titles need one details
// call each. Seerr caches TMDB server-side; this keeps repeat polls free.
const DETAILS_CACHE_MAX = 500;

export class SeerrAdapter {
  readonly id = 'seerr' as const;
  private client: AxiosInstance;
  private details = new Map<string, Promise<SeerrMediaDetails>>();

  constructor(config: ServiceConfig, isLocal: boolean) {
    this.client = createServiceClient(config, isLocal);
    // Users paste the web UI address; the API lives under /api/v1
    const base = (this.client.defaults.baseURL ?? '').replace(/\/+$/, '');
    if (!base.endsWith('/api/v1')) this.client.defaults.baseURL = `${base}/api/v1`;
  }

  // Needs auth (unlike /status), so a wrong key fails the test
  async testConnection(): Promise<boolean> {
    await this.client.get('/request/count');
    return true;
  }

  async getStatus(): Promise<ServiceStatus> {
    try {
      const count = await this.getRequestCount();
      const parts = [`${count.pending} pending`];
      if (count.processing > 0) parts.push(`${count.processing} processing`);
      return {
        serviceId: 'seerr',
        connection: { status: 'connected', isLocal: true, lastChecked: Date.now() },
        summary: parts.join(' · '),
        metric: { value: count.pending, label: 'pending' },
      };
    } catch (e: any) {
      return { serviceId: 'seerr', connection: { status: 'error', isLocal: true, lastChecked: Date.now(), error: e.message }, summary: 'Connection failed' };
    }
  }

  async getRequestCount(): Promise<SeerrRequestCount> {
    const { data } = await this.client.get<SeerrRequestCount>('/request/count');
    return data;
  }

  async getRequests(filter: SeerrRequestFilter, take = 50, skip = 0): Promise<SeerrRequestPage> {
    const { data } = await this.client.get<SeerrRequestPage>('/request', {
      params: { take, skip, filter, sort: 'added' },
    });
    return { pageInfo: data?.pageInfo, results: data?.results ?? [] };
  }

  async approveRequest(id: number): Promise<SeerrRequest> {
    const { data } = await this.client.post<SeerrRequest>(`/request/${id}/approve`);
    return data;
  }

  async declineRequest(id: number): Promise<SeerrRequest> {
    const { data } = await this.client.post<SeerrRequest>(`/request/${id}/decline`);
    return data;
  }

  getMediaDetails(type: SeerrMediaType, tmdbId: number): Promise<SeerrMediaDetails> {
    const key = `${type}:${tmdbId}`;
    const cached = this.details.get(key);
    if (cached) return cached;
    if (this.details.size >= DETAILS_CACHE_MAX) {
      // Map iterates in insertion order, so this drops the oldest entry
      this.details.delete(this.details.keys().next().value!);
    }
    const p = this.client.get(`/${type}/${tmdbId}`).then(({ data }) => ({
      title: (type === 'movie' ? data?.title : data?.name) ?? `TMDB ${tmdbId}`,
      year: ((type === 'movie' ? data?.releaseDate : data?.firstAirDate) as string | undefined)?.slice(0, 4) || undefined,
      posterPath: data?.posterPath ?? null,
    }));
    this.details.set(key, p);
    p.catch(() => { if (this.details.get(key) === p) this.details.delete(key); });
    return p;
  }
}
