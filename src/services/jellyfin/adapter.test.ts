import { JellyfinAdapter } from './adapter';

const mockGet = jest.fn();
jest.mock('../../core/api/httpClient', () => ({
  createServiceClient: () => ({ get: mockGet }),
  jellyfinAuthHeader: (t: string) => `MediaBrowser Token="${t}", Client="OpenArr"`,
}));

const config = {
  serviceId: 'jellyfin' as const,
  enabled: true,
  localUrl: 'http://nas:8096/',
  remoteUrl: 'https://jf.example.com',
  apiKey: 'k3y',
};

const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

function route(table: Record<string, any>) {
  mockGet.mockImplementation(async (url: string) => {
    if (url in table) {
      const v = table[url];
      if (v instanceof Error) throw v;
      return { data: v };
    }
    throw http(404);
  });
}

describe('JellyfinAdapter', () => {
  beforeEach(() => mockGet.mockReset());

  test('uses current user-scoped routes with userId', async () => {
    route({ '/Users': [{ Id: 'u1' }], '/UserItems/Resume': { Items: [{ Id: 'r' }] } });
    const jf = new JellyfinAdapter(config, true);
    expect(await jf.getResumeItems()).toEqual([{ Id: 'r' }]);
    expect(mockGet).toHaveBeenLastCalledWith('/UserItems/Resume', expect.objectContaining({
      params: expect.objectContaining({ userId: 'u1' }),
    }));
  });

  test('falls back to legacy /Users/{id} routes on 404 (10.8)', async () => {
    route({ '/Users': [{ Id: 'u1' }], '/Users/u1/Items/Latest': [{ Id: 'l' }] });
    const jf = new JellyfinAdapter(config, true);
    expect(await jf.getLatestUnplayed('Movie')).toEqual([{ Id: 'l' }]);
    const legacyCall = mockGet.mock.calls.find((c) => c[0] === '/Users/u1/Items/Latest')!;
    expect(legacyCall[1].params.userId).toBeUndefined();
  });

  test('non-404 errors are not retried on legacy routes', async () => {
    route({ '/Users': [{ Id: 'u1' }], '/UserItems/Resume': http(500) });
    const jf = new JellyfinAdapter(config, true);
    await expect(jf.getResumeItems()).rejects.toThrow('HTTP 500');
    expect(mockGet.mock.calls.map((c) => c[0])).not.toContain('/Users/u1/Items/Resume');
  });

  test('poster urls have no /emby prefix and auth travels in a header', () => {
    const jf = new JellyfinAdapter(config, true);
    expect(jf.posterUrl({ Id: 'm', Type: 'Movie', ImageTags: { Primary: 't' } } as any))
      .toBe('http://nas:8096/Items/m/Images/Primary?maxHeight=450&tag=t');
    expect(jf.posterUrl({ Id: 'e', Type: 'Episode', SeriesId: 's', SeriesPrimaryImageTag: 'st' } as any))
      .toBe('http://nas:8096/Items/s/Images/Primary?maxHeight=450&tag=st');
    expect(jf.imageHeaders()).toEqual({ Authorization: 'MediaBrowser Token="k3y", Client="OpenArr"' });
  });

  test('findItem matches provider ids case-insensitively and caches the index', async () => {
    route({
      '/Items': {
        Items: [
          { Id: 'a', ServerId: 'srv', Name: 'A', ProviderIds: { Tmdb: '11', Imdb: 'tt01' } },
          { Id: 'b', ServerId: 'srv', Name: 'B', ProviderIds: { Tvdb: '22' } },
        ],
      },
    });
    const jf = new JellyfinAdapter(config, false);
    expect(await jf.findItem('Movie', { tmdbId: 11 })).toEqual({ Id: 'a', ServerId: 'srv', Name: 'A' });
    expect(await jf.findItem('Movie', { imdbId: 'TT01' })).toEqual({ Id: 'a', ServerId: 'srv', Name: 'A' });
    expect(await jf.findItem('Movie', { tmdbId: 99, tvdbId: 22 })).toEqual({ Id: 'b', ServerId: 'srv', Name: 'B' });
    expect(await jf.findItem('Movie', { tmdbId: 99 })).toBeNull();
    expect(mockGet.mock.calls.filter((c) => c[0] === '/Items')).toHaveLength(1);
  });

  test('item links go to the web client of the active URL', () => {
    const jf = new JellyfinAdapter(config, false);
    expect(jf.itemAppUrl()).toBeNull();
    expect(jf.itemWebUrl({ Id: 'a', ServerId: 'srv', Name: 'A' }))
      .toBe('https://jf.example.com/web/#/details?id=a&serverId=srv');
  });

  test('status reports server name and version', async () => {
    route({ '/System/Info': { ServerName: 'nas', Version: '10.11.5' } });
    const jf = new JellyfinAdapter(config, true);
    expect((await jf.getStatus()).summary).toBe('nas · v10.11.5');
    mockGet.mockReset().mockRejectedValue(new Error('down'));
    expect((await jf.getStatus()).connection.status).toBe('error');
  });
});
