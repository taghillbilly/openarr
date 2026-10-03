import { Linking } from 'react-native';
import { ServiceId } from '../core/theme/tokens';
import { ServiceConfig, ServiceStatus } from '../core/types/services';
import { useServerStore } from '../stores/serverStore';
import { useConnectionStore } from '../stores/connectionStore';
import { getAdapter } from './adapterFactory';
import type { EmbyItemRef, EmbyMediaItem } from './emby/adapter';

export type ProviderIdQuery = { tmdbId?: number; imdbId?: string; tvdbId?: number };

// Shared surface of the Emby and Jellyfin adapters (Home rows, watched-state
// filtering, "open in" buttons on movie/series pages)
export interface MediaServer {
  readonly id: 'emby' | 'jellyfin';
  readonly label: string;
  testConnection(): Promise<boolean>;
  getStatus(): Promise<ServiceStatus>;
  getResumeItems(limit?: number): Promise<EmbyMediaItem[]>;
  getNextUp(limit?: number): Promise<EmbyMediaItem[]>;
  getLatestUnplayed(type: 'Episode' | 'Movie', limit?: number): Promise<EmbyMediaItem[]>;
  getRecentlyPlayed(limit?: number): Promise<EmbyMediaItem[]>;
  posterUrl(item: EmbyMediaItem): string | undefined;
  imageHeaders(): Record<string, string>;
  findItem(type: 'Movie' | 'Series', ids: ProviderIdQuery): Promise<EmbyItemRef | null>;
  itemAppUrl(item: EmbyItemRef): string | null;
  itemWebUrl(item: EmbyItemRef): string;
}

export const MEDIA_SERVER_IDS: ServiceId[] = ['emby', 'jellyfin'];

// First enabled media server on the server (Emby wins if both are on)
export function findMediaServerConfig(services: ServiceConfig[] | undefined): ServiceConfig | undefined {
  if (!services) return undefined;
  for (const id of MEDIA_SERVER_IDS) {
    const cfg = services.find((s) => s.serviceId === id && s.enabled);
    if (cfg) return cfg;
  }
  return undefined;
}

export function getMediaServer(config: ServiceConfig, isLocal: boolean): MediaServer {
  return getAdapter(config, isLocal) as unknown as MediaServer;
}

export function useMediaServerConfig(): ServiceConfig | undefined {
  return useServerStore((s) => findMediaServerConfig(s.getActiveServer()?.services));
}

// App deep link first (when the app has one), web item page as fallback
export async function openMediaRef(server: MediaServer, item: EmbyItemRef): Promise<void> {
  const appUrl = server.itemAppUrl(item);
  if (appUrl) {
    try {
      await Linking.openURL(appUrl);
      return;
    } catch {}
  }
  await Linking.openURL(server.itemWebUrl(item)).catch(() => {});
}

// Finds the title in the connected media server by provider ids and opens it.
// Returns an error message, or null on success.
export async function openInMediaServer(type: 'Movie' | 'Series', ids: ProviderIdQuery): Promise<string | null> {
  const config = findMediaServerConfig(useServerStore.getState().getActiveServer()?.services);
  if (!config) return 'No media server configured, enable Emby or Jellyfin in Settings → Server.';
  const server = getMediaServer(config, useConnectionStore.getState().isLocal);
  let item;
  try {
    item = await server.findItem(type, ids);
  } catch (e: any) {
    return `${server.label} lookup failed: ${e.message}`;
  }
  if (!item) return `Not found in your ${server.label} library.`;
  await openMediaRef(server, item);
  return null;
}
