import { QbittorrentAdapter, mapQbtTorrent } from './adapter';
import { TorrentStatus } from '../transmission/types';

const mockRequest = jest.fn();
const mockPost = jest.fn();
let requestInterceptor: ((req: any) => any) | null = null;

jest.mock('../../core/api/httpClient', () => ({
  createServiceClient: (config: any) => {
    // Basic auth must never be configured for qBittorrent
    expect(config.username).toBeUndefined();
    expect(config.password).toBeUndefined();
    return {
      request: mockRequest,
      post: mockPost,
      interceptors: { request: { use: (fn: any) => { requestInterceptor = fn; } } },
    };
  },
}));

const baseConfig = {
  serviceId: 'qbittorrent' as const,
  enabled: true,
  localUrl: 'http://nas:8080',
  remoteUrl: 'http://nas:8080',
  username: 'admin',
  password: 'secret',
};

const torrent = (over: Record<string, any> = {}) => ({
  hash: 'abc', name: 'Show.S01E01', state: 'downloading', progress: 0.25,
  dlspeed: 1000, upspeed: 10, eta: 120, size: 400, total_size: 500, ratio: 0.1,
  num_seeds: 3, num_leechs: 2, category: 'tv-sonarr', tags: 'a, b', priority: 1,
  save_path: '/downloads', added_on: 100, completion_on: -1, magnet_uri: 'magnet:?x',
  ...over,
});

const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

describe('mapQbtTorrent', () => {
  test('maps fields onto the shared torrent model', () => {
    const t = mapQbtTorrent(torrent() as any, 7, [
      { name: 'a.mkv', size: 100, progress: 0.5, priority: 1 },
      { name: 'b.nfo', size: 10, progress: 0, priority: 0 },
    ]);
    expect(t).toMatchObject({
      id: 7, status: TorrentStatus.Downloading, percentDone: 0.25, rateDownload: 1000,
      eta: 120, totalSize: 500, sizeWhenDone: 400, peersConnected: 5, peersSendingToUs: 3,
      peersGettingFromUs: 2, labels: ['tv-sonarr', 'a', 'b'], downloadDir: '/downloads',
      doneDate: 0, hashString: 'abc', isFinished: false,
    });
    expect(t.files[0]).toEqual({ name: 'a.mkv', length: 100, bytesCompleted: 50 });
    expect(t.fileStats.map((f) => f.wanted)).toEqual([true, false]);
  });

  test.each([
    ['stalledDL', TorrentStatus.Downloading],
    ['queuedDL', TorrentStatus.QueuedToDownload],
    ['stalledUP', TorrentStatus.Seeding],
    ['queuedUP', TorrentStatus.QueuedToSeed],
    ['checkingUP', TorrentStatus.Verifying],
    ['pausedDL', TorrentStatus.Stopped],
    ['stoppedUP', TorrentStatus.Stopped],
    ['error', TorrentStatus.Stopped],
    ['somethingNew', TorrentStatus.Stopped],
  ])('state %s maps to %s', (state, status) => {
    expect(mapQbtTorrent(torrent({ state }) as any, 1).status).toBe(status);
  });

  test('infinite eta, errors and finished state', () => {
    expect(mapQbtTorrent(torrent({ eta: 8640000 }) as any, 1).eta).toBe(-1);
    expect(mapQbtTorrent(torrent({ state: 'missingFiles' }) as any, 1).errorString).toMatch(/missing/i);
    expect(mapQbtTorrent(torrent({ state: 'stoppedUP' }) as any, 1).isFinished).toBe(true);
    expect(mapQbtTorrent(torrent({ state: 'pausedUP' }) as any, 1).isFinished).toBe(true);
  });
});

describe('QbittorrentAdapter', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockPost.mockReset();
    requestInterceptor = null;
  });

  test('logs in on 403, keeps the session cookie and retries', async () => {
    const adapter = new QbittorrentAdapter(baseConfig, true);
    mockRequest
      .mockRejectedValueOnce(http(403))
      .mockResolvedValueOnce({ data: 'v5.0.0' });
    mockPost.mockResolvedValueOnce({
      status: 204, data: '',
      headers: { 'set-cookie': ['QBT_SID_8080=tok123; HttpOnly; path=/'] },
    });
    expect(await adapter.testConnection()).toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/api/v2/auth/login', 'username=admin&password=secret', expect.anything());
    const headers = { set: jest.fn() };
    requestInterceptor!({ headers });
    expect(headers.set).toHaveBeenCalledWith('Cookie', 'QBT_SID_8080=tok123');
  });

  test('accepts the legacy 200 "Ok." login and rejects "Fails."', async () => {
    const adapter = new QbittorrentAdapter(baseConfig, true);
    mockRequest.mockRejectedValueOnce(http(403)).mockResolvedValueOnce({ data: 'v4.6.7' });
    mockPost.mockResolvedValueOnce({ status: 200, data: 'Ok.', headers: { 'set-cookie': ['SID=xyz; path=/'] } });
    await expect(adapter.testConnection()).resolves.toBe(true);

    const bad = new QbittorrentAdapter(baseConfig, true);
    mockRequest.mockRejectedValueOnce(http(403));
    mockPost.mockResolvedValueOnce({ status: 200, data: 'Fails.', headers: {} });
    await expect(bad.testConnection()).rejects.toThrow(/login failed/);
  });

  test('without credentials a 403 asks for a login', async () => {
    const adapter = new QbittorrentAdapter({ ...baseConfig, username: undefined, password: undefined }, true);
    mockRequest.mockRejectedValueOnce(http(403));
    await expect(adapter.testConnection()).rejects.toThrow(/requires a login/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('ids are stable per hash and translate back to hashes', async () => {
    const adapter = new QbittorrentAdapter(baseConfig, true);
    mockRequest.mockResolvedValue({ data: [torrent({ hash: 'h1' }), torrent({ hash: 'h2' })] });
    const first = await adapter.getTorrents();
    mockRequest.mockResolvedValue({ data: [torrent({ hash: 'h2' }), torrent({ hash: 'h1' })] });
    const second = await adapter.getTorrents();
    expect(second.find((t) => t.hashString === 'h1')!.id).toBe(first.find((t) => t.hashString === 'h1')!.id);

    mockRequest.mockReset().mockResolvedValue({ data: '' });
    await adapter.removeTorrents(first.map((t) => t.id), true);
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'post', url: '/api/v2/torrents/delete', data: 'hashes=h1%7Ch2&deleteFiles=true',
    }));
  });

  test('stop falls back to the 4.x pause endpoint and remembers it', async () => {
    const adapter = new QbittorrentAdapter(baseConfig, true);
    mockRequest.mockResolvedValueOnce({ data: [torrent({ hash: 'h1' })] });
    const [t] = await adapter.getTorrents();
    mockRequest.mockReset()
      .mockRejectedValueOnce(http(404))
      .mockResolvedValue({ data: '' });
    await adapter.stopTorrents([t.id]);
    await adapter.startTorrents([t.id]);
    const urls = mockRequest.mock.calls.map((c) => c[0].url);
    expect(urls).toEqual(['/api/v2/torrents/stop', '/api/v2/torrents/pause', '/api/v2/torrents/resume']);
  });

  test('detail fetch includes files; file priority uses filePrio', async () => {
    const adapter = new QbittorrentAdapter(baseConfig, true);
    mockRequest.mockResolvedValueOnce({ data: [torrent({ hash: 'h1' })] });
    const [t] = await adapter.getTorrents();
    mockRequest.mockReset()
      .mockResolvedValueOnce({ data: [torrent({ hash: 'h1' })] })
      .mockResolvedValueOnce({ data: [{ name: 'x.mkv', size: 10, progress: 1, priority: 1 }] });
    const [detail] = await adapter.getTorrents([t.id]);
    expect(mockRequest.mock.calls[0][0].params).toEqual({ hashes: 'h1' });
    expect(detail.files).toHaveLength(1);

    mockRequest.mockReset().mockResolvedValue({ data: '' });
    await adapter.setFilesWanted(t.id, [0, 2], false);
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: '/api/v2/torrents/filePrio', data: 'hash=h1&id=0%7C2&priority=0',
    }));
  });

  test('transfer info tracks the maindata rid and free space', async () => {
    const adapter = new QbittorrentAdapter(baseConfig, true);
    mockRequest
      .mockResolvedValueOnce({ data: { dl_info_speed: 5, up_info_speed: 6 } })
      .mockResolvedValueOnce({ data: { rid: 3, server_state: { free_space_on_disk: 999 } } })
      .mockResolvedValueOnce({ data: { dl_info_speed: 7, up_info_speed: 8 } })
      .mockResolvedValueOnce({ data: { rid: 4, server_state: {} } });
    expect(await adapter.getTransferInfo()).toEqual({ downloadSpeed: 5, uploadSpeed: 6, freeSpace: 999 });
    expect(await adapter.getTransferInfo()).toEqual({ downloadSpeed: 7, uploadSpeed: 8, freeSpace: 999 });
    expect(mockRequest.mock.calls[3][0].params).toEqual({ rid: 3 });
  });
});
