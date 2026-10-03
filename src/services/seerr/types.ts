// Seerr (merged Overseerr/Jellyseerr) API v1 shapes, trimmed to what the app reads

export enum SeerrRequestStatus {
  Pending = 1,
  Approved = 2,
  Declined = 3,
  Failed = 4,
  Completed = 5,
}

export enum SeerrMediaStatus {
  Unknown = 1,
  Pending = 2,
  Processing = 3,
  PartiallyAvailable = 4,
  Available = 5,
}

export type SeerrMediaType = 'movie' | 'tv';

export interface SeerrUser {
  id: number;
  displayName?: string;
  username?: string;
  email?: string;
}

export interface SeerrRequest {
  id: number;
  status: SeerrRequestStatus;
  type: SeerrMediaType;
  is4k: boolean;
  createdAt: string;
  media: { id: number; tmdbId: number; tvdbId?: number; mediaType: SeerrMediaType; status: SeerrMediaStatus };
  requestedBy?: SeerrUser;
  seasons?: { id: number; seasonNumber: number }[];
}

export interface SeerrRequestPage {
  pageInfo: { pages: number; pageSize: number; results: number; page: number };
  results: SeerrRequest[];
}

export interface SeerrRequestCount {
  total: number;
  movie: number;
  tv: number;
  pending: number;
  approved: number;
  declined: number;
  processing: number;
  available: number;
}

export type SeerrRequestFilter = 'pending' | 'approved' | 'processing' | 'available' | 'all';

// Request list items only carry a tmdb id; title/poster come from a details lookup
export interface SeerrMediaDetails {
  title: string;
  year?: string;
  posterPath: string | null;
}
