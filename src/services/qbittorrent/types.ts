// Subset of qBittorrent WebUI API v2 payloads that OpenArr reads

export interface QbtTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  size: number;
  total_size?: number;
  ratio: number;
  num_seeds?: number;
  num_leechs?: number;
  category?: string;
  tags?: string;
  priority?: number;
  save_path?: string;
  added_on?: number;
  completion_on?: number;
  magnet_uri?: string;
}

export interface QbtFile {
  index?: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}
