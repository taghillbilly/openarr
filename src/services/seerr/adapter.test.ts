import { SeerrAdapter } from './adapter';
import { requestState, seasonsLabel, timeAgo } from './requestState';
import { SeerrMediaStatus, SeerrRequest, SeerrRequestStatus } from './types';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockClient = { get: mockGet, post: mockPost, defaults: { baseURL: '' } };
jest.mock('../../core/api/httpClient', () => ({
  createServiceClient: (config: any) => {
    mockClient.defaults.baseURL = config.localUrl;
    return mockClient;
  },
}));

const config = {
  serviceId: 'seerr' as const,
  enabled: true,
  localUrl: 'http://nas:5055/',
  remoteUrl: 'https://requests.example.com',
  apiKey: 'k3y',
};

const COUNT = { total: 9, movie: 5, tv: 4, pending: 3, approved: 4, declined: 1, processing: 2, available: 3 };

function req(over: Partial<SeerrRequest> = {}): SeerrRequest {
  return {
    id: 1, status: SeerrRequestStatus.Pending, type: 'movie', is4k: false, createdAt: '2026-10-01T00:00:00Z',
    media: { id: 10, tmdbId: 603, mediaType: 'movie', status: SeerrMediaStatus.Pending },
    ...over,
  };
}

describe('SeerrAdapter', () => {
  beforeEach(() => { mockGet.mockReset(); mockPost.mockReset(); });

  test('appends /api/v1 to the pasted web UI address once', () => {
    new SeerrAdapter(config, true);
    expect(mockClient.defaults.baseURL).toBe('http://nas:5055/api/v1');
    new SeerrAdapter({ ...config, localUrl: 'http://nas:5055/api/v1' }, true);
    expect(mockClient.defaults.baseURL).toBe('http://nas:5055/api/v1');
  });

  test('status is one cheap count call with pending as the metric', async () => {
    mockGet.mockResolvedValue({ data: COUNT });
    const status = await new SeerrAdapter(config, true).getStatus();
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/request/count');
    expect(status.connection.status).toBe('connected');
    expect(status.summary).toBe('3 pending · 2 processing');
    expect(status.metric).toEqual({ value: 3, label: 'pending' });
  });

  test('status reports errors instead of throwing', async () => {
    mockGet.mockRejectedValue(new Error('Network Error'));
    const status = await new SeerrAdapter(config, true).getStatus();
    expect(status.connection.status).toBe('error');
  });

  test('lists requests with the filter and newest first', async () => {
    mockGet.mockResolvedValue({ data: { pageInfo: { pages: 1, pageSize: 50, results: 1, page: 1 }, results: [req()] } });
    const page = await new SeerrAdapter(config, true).getRequests('pending');
    expect(page.results).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledWith('/request', { params: { take: 50, skip: 0, filter: 'pending', sort: 'added' } });
  });

  test('approve and decline post to the request status routes', async () => {
    mockPost.mockResolvedValue({ data: req({ status: SeerrRequestStatus.Approved }) });
    const seerr = new SeerrAdapter(config, true);
    await seerr.approveRequest(7);
    await seerr.declineRequest(8);
    expect(mockPost.mock.calls.map((c) => c[0])).toEqual(['/request/7/approve', '/request/8/decline']);
  });

  test('media details are cached and map movie/tv title fields', async () => {
    mockGet.mockImplementation(async (url: string) => ({
      data: url.startsWith('/movie')
        ? { title: 'The Matrix', releaseDate: '1999-03-31', posterPath: '/m.jpg' }
        : { name: 'Severance', firstAirDate: '2022-02-18', posterPath: null },
    }));
    const seerr = new SeerrAdapter(config, true);
    expect(await seerr.getMediaDetails('movie', 603)).toEqual({ title: 'The Matrix', year: '1999', posterPath: '/m.jpg' });
    await seerr.getMediaDetails('movie', 603);
    expect(await seerr.getMediaDetails('tv', 95396)).toEqual({ title: 'Severance', year: '2022', posterPath: null });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  test('failed details lookups are retried rather than cached', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ data: { title: 'X' } });
    const seerr = new SeerrAdapter(config, true);
    await expect(seerr.getMediaDetails('movie', 1)).rejects.toThrow('boom');
    await new Promise((r) => setImmediate(r));
    expect((await seerr.getMediaDetails('movie', 1)).title).toBe('X');
  });
});

describe('request presentation', () => {
  test('approved requests show where the media is at', () => {
    expect(requestState(req()).label).toBe('Pending');
    expect(requestState(req({ status: SeerrRequestStatus.Declined })).label).toBe('Declined');
    const approved = (status: SeerrMediaStatus) =>
      requestState(req({ status: SeerrRequestStatus.Approved, media: { ...req().media, status } })).label;
    expect(approved(SeerrMediaStatus.Processing)).toBe('Processing');
    expect(approved(SeerrMediaStatus.Available)).toBe('Available');
    expect(approved(SeerrMediaStatus.Pending)).toBe('Approved');
  });

  test('season labels stay short', () => {
    expect(seasonsLabel(req())).toBeUndefined();
    const tv = (n: number[]) => req({ type: 'tv', seasons: n.map((s) => ({ id: s, seasonNumber: s })) });
    expect(seasonsLabel(tv([2, 1]))).toBe('Seasons 1, 2');
    expect(seasonsLabel(tv([3]))).toBe('Season 3');
    expect(seasonsLabel(tv([1, 2, 3, 4, 5]))).toBe('5 seasons');
  });

  test('timeAgo', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(timeAgo('2026-10-03T11:30:00Z', now)).toBe('30m ago');
    expect(timeAgo('2026-10-03T07:00:00Z', now)).toBe('5h ago');
    expect(timeAgo('2026-09-30T12:00:00Z', now)).toBe('3d ago');
  });
});
