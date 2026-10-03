import { useMemo } from 'react';
import { ServiceId } from '../core/theme/tokens';
import { ServiceConfig, ServiceStatus } from '../core/types/services';
import { useServerStore } from '../stores/serverStore';
import { useConnectionStore } from '../stores/connectionStore';
import { getAdapter } from './adapterFactory';
import type { Torrent } from './transmission/types';

export interface TransferInfo {
  downloadSpeed: number;
  uploadSpeed: number;
  // null when the client can't report it
  freeSpace: number | null;
}

// What the Torrents tab, dashboard banner and Prowlarr "send directly" need.
// Both clients speak Transmission's Torrent model (numeric ids, status enum).
export interface TorrentClient {
  readonly id: 'transmission' | 'qbittorrent';
  readonly label: string;
  testConnection(): Promise<boolean>;
  getStatus(): Promise<ServiceStatus>;
  getTorrents(ids?: number[]): Promise<Torrent[]>;
  addTorrent(args: { filename?: string }): Promise<void>;
  startTorrents(ids: number[]): Promise<void>;
  stopTorrents(ids: number[]): Promise<void>;
  removeTorrents(ids: number[], deleteLocalData: boolean): Promise<void>;
  setFilesWanted(id: number, fileIndexes: number[], wanted: boolean): Promise<void>;
  getTransferInfo(): Promise<TransferInfo>;
}

export const TORRENT_CLIENT_IDS: ServiceId[] = ['transmission', 'qbittorrent'];

// First enabled torrent client on the server (Transmission wins if both are on)
export function findTorrentClientConfig(services: ServiceConfig[] | undefined): ServiceConfig | undefined {
  if (!services) return undefined;
  for (const id of TORRENT_CLIENT_IDS) {
    const cfg = services.find((s) => s.serviceId === id && s.enabled);
    if (cfg) return cfg;
  }
  return undefined;
}

export function getTorrentClient(config: ServiceConfig, isLocal: boolean): TorrentClient {
  return getAdapter(config, isLocal) as unknown as TorrentClient;
}

export function useTorrentClient(): { config: ServiceConfig | undefined; client: TorrentClient | null } {
  const config = useServerStore((s) => findTorrentClientConfig(s.getActiveServer()?.services));
  const isLocal = useConnectionStore((s) => s.isLocal);
  const client = useMemo(() => (config ? getTorrentClient(config, isLocal) : null), [config, isLocal]);
  return { config, client };
}
