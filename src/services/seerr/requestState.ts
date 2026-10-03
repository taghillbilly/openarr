import { colors } from '../../core/theme/tokens';
import { SeerrMediaStatus, SeerrRequest, SeerrRequestStatus } from './types';

export interface RequestState { label: string; color: string }

// Approved requests are only interesting for where the download is at, so
// they report the media's status instead of "Approved"
export function requestState(req: SeerrRequest): RequestState {
  switch (req.status) {
    case SeerrRequestStatus.Pending: return { label: 'Pending', color: colors.warning };
    case SeerrRequestStatus.Declined: return { label: 'Declined', color: colors.error };
    case SeerrRequestStatus.Failed: return { label: 'Failed', color: colors.error };
    case SeerrRequestStatus.Completed: return { label: 'Available', color: colors.success };
  }
  switch (req.media?.status) {
    case SeerrMediaStatus.Available: return { label: 'Available', color: colors.success };
    case SeerrMediaStatus.PartiallyAvailable: return { label: 'Partial', color: colors.info };
    case SeerrMediaStatus.Processing: return { label: 'Processing', color: colors.info };
    default: return { label: 'Approved', color: colors.info };
  }
}

export function requestedByName(req: SeerrRequest): string | undefined {
  const u = req.requestedBy;
  return u?.displayName || u?.username || u?.email || undefined;
}

export function seasonsLabel(req: SeerrRequest): string | undefined {
  if (req.type !== 'tv' || !req.seasons?.length) return undefined;
  const nums = req.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b);
  return nums.length > 4
    ? `${nums.length} seasons`
    : `Season${nums.length > 1 ? 's' : ''} ${nums.join(', ')}`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
