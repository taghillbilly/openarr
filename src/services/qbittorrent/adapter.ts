import { AxiosInstance, AxiosRequestConfig } from 'axios';
import { createServiceClient } from '../../core/api/httpClient';
import { ServiceConfig, ServiceStatus } from '../../core/types/services';
import { Torrent, TorrentFile, TorrentFileStat, TorrentStatus } from '../transmission/types';
import type { TorrentClient, TransferInfo } from '../torrentClient';
import type { QbtFile, QbtTorrent } from './types';

// qBittorrent reports "no ETA" as 100 days
const QBT_INFINITE_ETA = 8640000;

const STATE_MAP: Record<string, TorrentStatus> = {
  downloading: TorrentStatus.Downloading,
  forcedDL: TorrentStatus.Downloading,
  metaDL: TorrentStatus.Downloading,
  forcedMetaDL: TorrentStatus.Downloading,
  stalledDL: TorrentStatus.Downloading,
  allocating: TorrentStatus.Downloading,
  queuedDL: TorrentStatus.QueuedToDownload,
  uploading: TorrentStatus.Seeding,
  forcedUP: TorrentStatus.Seeding,
  stalledUP: TorrentStatus.Seeding,
  queuedUP: TorrentStatus.QueuedToSeed,
  checkingDL: TorrentStatus.Verifying,
  checkingUP: TorrentStatus.Verifying,
  checkingResumeData: TorrentStatus.Verifying,
  moving: TorrentStatus.Verifying,
};

const ERROR_STATES: Record<string, string> = {
  error: 'Torrent error, check qBittorrent for details',
  missingFiles: 'Files are missing',
};

const FINISHED_STATES = new Set(['pausedUP', 'stoppedUP']);

export function mapQbtTorrent(t: QbtTorrent, id: number, files?: QbtFile[]): Torrent {
  const labels = [
    ...(t.category ? [t.category] : []),
    ...(t.tags ? t.tags.split(',').map((s) => s.trim()).filter(Boolean) : []),
  ];
  const mappedFiles: TorrentFile[] = (files ?? []).map((f) => ({
    name: f.name,
    length: f.size,
    bytesCompleted: Math.round(f.size * f.progress),
  }));
  const fileStats: TorrentFileStat[] = (files ?? []).map((f) => ({ wanted: f.priority > 0, priority: f.priority }));
  return {
    id,
    name: t.name,
    status: STATE_MAP[t.state] ?? TorrentStatus.Stopped,
    percentDone: t.progress,
    rateDownload: t.dlspeed,
    rateUpload: t.upspeed,
    eta: t.eta >= QBT_INFINITE_ETA || t.eta < 0 ? -1 : t.eta,
    totalSize: t.total_size ?? t.size,
    uploadRatio: t.ratio,
    peersConnected: (t.num_seeds ?? 0) + (t.num_leechs ?? 0),
    labels,
    queuePosition: t.priority ?? -1,
    downloadDir: t.save_path ?? '',
    errorString: ERROR_STATES[t.state] ?? '',
    addedDate: t.added_on ?? 0,
    doneDate: t.completion_on && t.completion_on > 0 ? t.completion_on : 0,
    files: mappedFiles,
    fileStats,
    hashString: t.hash,
    isFinished: FINISHED_STATES.has(t.state),
    magnetLink: t.magnet_uri ?? '',
    sizeWhenDone: t.size,
    peersGettingFromUs: t.num_leechs ?? 0,
    peersSendingToUs: t.num_seeds ?? 0,
  };
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

export class QbittorrentAdapter implements TorrentClient {
  readonly id = 'qbittorrent' as const;
  readonly label = 'qBittorrent';
  private client: AxiosInstance;
  private username?: string;
  private password?: string;
  private cookie: string | null = null;
  private loginPromise: Promise<void> | null = null;
  // The UI works with numeric ids (Transmission's model); qBittorrent keys
  // torrents by info hash, so hand out stable session-local ids per hash.
  private idByHash = new Map<string, number>();
  private hashById = new Map<number, string>();
  private nextId = 1;
  // WebAPI 2.11 (qBittorrent 5) renamed pause/resume to stop/start
  private legacyPauseApi: boolean | null = null;
  private mainDataRid = 0;
  private freeSpace: number | null = null;

  constructor(config: ServiceConfig, isLocal: boolean) {
    // Credentials go through the cookie login, never as HTTP basic auth
    this.client = createServiceClient({ ...config, username: undefined, password: undefined }, isLocal);
    this.username = config.username;
    this.password = config.password;
    this.client.interceptors.request.use((req) => {
      if (this.cookie) req.headers.set('Cookie', this.cookie);
      return req;
    });
  }

  private idFor(hash: string): number {
    let id = this.idByHash.get(hash);
    if (id === undefined) {
      id = this.nextId++;
      this.idByHash.set(hash, id);
      this.hashById.set(id, hash);
    }
    return id;
  }

  private hashes(ids: number[]): string {
    return ids.map((id) => this.hashById.get(id)).filter(Boolean).join('|');
  }

  private login(): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = (async () => {
        const res = await this.client.post('/api/v2/auth/login',
          form({ username: this.username ?? '', password: this.password ?? '' }),
          { headers: FORM_HEADERS, validateStatus: () => true });
        const body = typeof res.data === 'string' ? res.data.trim() : '';
        if (res.status === 403) throw new Error('qBittorrent banned this IP after too many failed logins');
        // 4.x answers 200 "Ok."/"Fails."; 5.x answers 204 or 401
        const ok = res.status >= 200 && res.status < 300 && body !== 'Fails.';
        if (!ok) throw new Error('qBittorrent login failed, check username/password');
        // React Native's cookie jar usually handles this, but keep our own
        // copy so auth survives jar quirks (cookie name varies by version)
        const setCookie = res.headers?.['set-cookie'];
        const raw = Array.isArray(setCookie) ? setCookie.join(';') : setCookie;
        const match = typeof raw === 'string' ? raw.match(/([A-Za-z0-9_]*SID[A-Za-z0-9_]*=[^;,\s]+)/) : null;
        if (match) this.cookie = match[1];
      })().finally(() => { this.loginPromise = null; });
    }
    return this.loginPromise;
  }

  // Requests run unauthenticated first (works when the Web UI bypasses auth
  // for the LAN); a 401/403 triggers one login and a retry.
  private async request<T = any>(method: 'get' | 'post', url: string, opts: AxiosRequestConfig = {}): Promise<T> {
    const send = () => this.client.request<T>({ method, url, ...opts });
    try {
      return (await send()).data;
    } catch (e: any) {
      const status = e.response?.status;
      if ((status === 401 || status === 403) && this.username) {
        this.cookie = null;
        await this.login();
        return (await send()).data;
      }
      if (status === 401 || status === 403) {
        throw new Error('qBittorrent requires a login, add your Web UI username/password');
      }
      throw e;
    }
  }

  private post<T = any>(url: string, params: Record<string, string>): Promise<T> {
    return this.request<T>('post', url, { data: form(params), headers: FORM_HEADERS });
  }

  async testConnection(): Promise<boolean> {
    await this.request('get', '/api/v2/app/version');
    return true;
  }

  async getStatus(): Promise<ServiceStatus> {
    try {
      const active = await this.request<QbtTorrent[]>('get', '/api/v2/torrents/info', { params: { filter: 'active' } });
      const count = Array.isArray(active) ? active.length : 0;
      return {
        serviceId: 'qbittorrent',
        connection: { status: 'connected', isLocal: true, lastChecked: Date.now() },
        summary: `${count} active`,
        metric: { value: count, label: 'active' },
      };
    } catch (e: any) {
      return {
        serviceId: 'qbittorrent',
        connection: { status: 'error', isLocal: true, lastChecked: Date.now(), error: e.message },
        summary: 'Connection failed',
      };
    }
  }

  async getTorrents(ids?: number[]): Promise<Torrent[]> {
    const params: Record<string, string> = {};
    if (ids) {
      const hashes = this.hashes(ids);
      if (!hashes) return [];
      params.hashes = hashes;
    }
    const list = await this.request<QbtTorrent[]>('get', '/api/v2/torrents/info', { params });
    if (!ids) return list.map((t) => mapQbtTorrent(t, this.idFor(t.hash)));
    // Detail view: include per-file progress
    return Promise.all(list.map(async (t) => {
      const files = await this.request<QbtFile[]>('get', '/api/v2/torrents/files', { params: { hash: t.hash } })
        .catch(() => [] as QbtFile[]);
      return mapQbtTorrent(t, this.idFor(t.hash), files);
    }));
  }

  async addTorrent(args: { filename?: string; downloadDir?: string; paused?: boolean }): Promise<void> {
    if (!args.filename) throw new Error('No torrent URL');
    const params: Record<string, string> = { urls: args.filename };
    if (args.downloadDir) params.savepath = args.downloadDir;
    if (args.paused) { params.paused = 'true'; params.stopped = 'true'; }
    // multipart is what the docs specify; keep the body tiny and text-only
    const body = new FormData();
    Object.entries(params).forEach(([k, v]) => body.append(k, v));
    const result = await this.request<string>('post', '/api/v2/torrents/add', { data: body });
    if (typeof result === 'string' && result.trim() === 'Fails.') {
      throw new Error('qBittorrent rejected the torrent');
    }
  }

  private async pauseResume(action: 'start' | 'stop', ids: number[]): Promise<void> {
    const hashes = this.hashes(ids);
    if (!hashes) return;
    const legacy = action === 'start' ? 'resume' : 'pause';
    if (this.legacyPauseApi === true) {
      await this.post(`/api/v2/torrents/${legacy}`, { hashes });
      return;
    }
    try {
      await this.post(`/api/v2/torrents/${action}`, { hashes });
      this.legacyPauseApi = false;
    } catch (e: any) {
      if (e.response?.status !== 404) throw e;
      this.legacyPauseApi = true;
      await this.post(`/api/v2/torrents/${legacy}`, { hashes });
    }
  }

  startTorrents(ids: number[]): Promise<void> {
    return this.pauseResume('start', ids);
  }

  stopTorrents(ids: number[]): Promise<void> {
    return this.pauseResume('stop', ids);
  }

  async removeTorrents(ids: number[], deleteLocalData: boolean): Promise<void> {
    const hashes = this.hashes(ids);
    if (!hashes) return;
    await this.post('/api/v2/torrents/delete', { hashes, deleteFiles: String(deleteLocalData) });
  }

  async setFilesWanted(id: number, fileIndexes: number[], wanted: boolean): Promise<void> {
    const hash = this.hashById.get(id);
    if (!hash || fileIndexes.length === 0) return;
    await this.post('/api/v2/torrents/filePrio', {
      hash, id: fileIndexes.join('|'), priority: wanted ? '1' : '0',
    });
  }

  async getTransferInfo(): Promise<TransferInfo> {
    const info = await this.request<{ dl_info_speed: number; up_info_speed: number }>('get', '/api/v2/transfer/info');
    // Free space only comes with sync/maindata; after the first call the rid
    // makes it an incremental diff, so polling stays cheap
    try {
      const data = await this.request<any>('get', '/api/v2/sync/maindata', { params: { rid: this.mainDataRid } });
      if (typeof data?.rid === 'number') this.mainDataRid = data.rid;
      const free = data?.server_state?.free_space_on_disk;
      // -1 until qBittorrent's periodic disk check has run on the save path
      if (typeof free === 'number') this.freeSpace = free >= 0 ? free : null;
    } catch {
      this.mainDataRid = 0;
    }
    return { downloadSpeed: info.dl_info_speed ?? 0, uploadSpeed: info.up_info_speed ?? 0, freeSpace: this.freeSpace };
  }
}
