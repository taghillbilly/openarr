import { createServiceClient, createTransmissionClient } from './httpClient';

// We need to test the client creation logic
describe('createServiceClient', () => {
  test('creates client with local URL when isLocal is true', () => {
    const config = {
      serviceId: 'sonarr' as const,
      enabled: true,
      localUrl: 'http://192.168.1.100:8989',
      remoteUrl: 'https://sonarr.example.com',
      apiKey: 'test-api-key',
    };
    const client = createServiceClient(config, true);
    expect(client.defaults.baseURL).toBe('http://192.168.1.100:8989');
  });

  test('creates client with remote URL when isLocal is false', () => {
    const config = {
      serviceId: 'sonarr' as const,
      enabled: true,
      localUrl: 'http://192.168.1.100:8989',
      remoteUrl: 'https://sonarr.example.com',
      apiKey: 'test-api-key',
    };
    const client = createServiceClient(config, false);
    expect(client.defaults.baseURL).toBe('https://sonarr.example.com');
  });

  test('appends basePath to URL', () => {
    const config = {
      serviceId: 'sonarr' as const,
      enabled: true,
      localUrl: 'http://192.168.1.100',
      remoteUrl: 'https://example.com',
      basePath: '/sonarr',
    };
    const client = createServiceClient(config, true);
    expect(client.defaults.baseURL).toBe('http://192.168.1.100/sonarr');
  });

  test('sets basic auth when username and password provided', () => {
    const config = {
      serviceId: 'sonarr' as const,
      enabled: true,
      localUrl: 'http://localhost:8989',
      remoteUrl: 'http://localhost:8989',
      username: 'admin',
      password: 'secret',
    };
    const client = createServiceClient(config, true);
    expect(client.defaults.auth).toEqual({ username: 'admin', password: 'secret' });
  });

  test('sets custom headers', () => {
    const config = {
      serviceId: 'sonarr' as const,
      enabled: true,
      localUrl: 'http://localhost:8989',
      remoteUrl: 'http://localhost:8989',
      customHeaders: { 'X-Custom': 'value' },
    };
    const client = createServiceClient(config, true);
    expect(client.defaults.headers.common['X-Custom']).toBe('value');
  });
});

describe('createTransmissionClient', () => {
  test('creates client with transmission URL', () => {
    const config = {
      serviceId: 'transmission' as const,
      enabled: true,
      localUrl: 'http://192.168.1.100:9091/transmission/rpc',
      remoteUrl: 'http://192.168.1.100:9091/transmission/rpc',
    };
    const client = createTransmissionClient(config, true);
    expect(client.defaults.baseURL).toBe('http://192.168.1.100:9091/transmission/rpc');
  });
});

describe('per-service auth headers', () => {
  const headersFor = async (serviceId: any) => {
    const client = createServiceClient({ serviceId, enabled: true, localUrl: 'http://h', remoteUrl: 'http://h', apiKey: 'k' }, true);
    let sent: any;
    client.defaults.adapter = async (cfg: any) => { sent = cfg.headers; return { data: '', status: 200, statusText: 'OK', headers: {}, config: cfg }; };
    await client.get('/x');
    return sent;
  };

  test('jellyfin uses the MediaBrowser Authorization header, not X-Emby-Token', async () => {
    const h = await headersFor('jellyfin');
    expect(h.get('Authorization')).toBe('MediaBrowser Token="k", Client="OpenArr"');
    expect(h.get('X-Emby-Token')).toBeUndefined();
  });

  test('emby keeps X-Emby-Token', async () => {
    expect((await headersFor('emby')).get('X-Emby-Token')).toBe('k');
  });
});
