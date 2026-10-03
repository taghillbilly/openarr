import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii, typography } from '../../../core/theme/tokens';
import { CachedImage } from '../../../core/components/CachedImage';
import { posterUrl } from '../../tmdb/types';
import type { SeerrAdapter } from '../adapter';
import { SeerrMediaDetails, SeerrRequest, SeerrRequestStatus } from '../types';
import { requestState, requestedByName, seasonsLabel, timeAgo } from '../requestState';

interface RequestRowProps {
  request: SeerrRequest;
  adapter: SeerrAdapter;
  busy: boolean;
  onApprove: (req: SeerrRequest) => void;
  onDecline: (req: SeerrRequest, title: string) => void;
}

function RequestRowInner({ request, adapter, busy, onApprove, onDecline }: RequestRowProps) {
  const [details, setDetails] = useState<SeerrMediaDetails | null>(null);
  const { tmdbId } = request.media;

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    adapter.getMediaDetails(request.type, tmdbId)
      .then((d) => { if (!cancelled) setDetails(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [adapter, request.type, tmdbId]);

  const state = requestState(request);
  const title = details?.title ?? 'Loading...';
  const by = requestedByName(request);
  const seasons = seasonsLabel(request);
  const isPending = request.status === SeerrRequestStatus.Pending;

  return (
    <View style={styles.row}>
      <View style={styles.poster}>
        <CachedImage uri={posterUrl(details?.posterPath ?? null, 'w185')} style={styles.posterImg} />
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={2}>
            {title}{details?.year ? <Text style={styles.year}> ({details.year})</Text> : null}
          </Text>
          <View style={[styles.statePill, { borderColor: `${state.color}55`, backgroundColor: `${state.color}1a` }]}>
            <Text style={[styles.stateText, { color: state.color }]}>{state.label}</Text>
          </View>
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {request.type === 'movie' ? 'Movie' : 'TV'}{request.is4k ? ' · 4K' : ''}{seasons ? ` · ${seasons}` : ''}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {by ? `${by} · ` : ''}{timeAgo(request.createdAt)}
        </Text>
        {isPending && (
          <View style={styles.actions}>
            {busy ? <ActivityIndicator size="small" color={colors.primary} style={styles.spinner} /> : (
              <>
                <Pressable style={[styles.btn, styles.approve]} onPress={() => onApprove(request)}
                  accessibilityRole="button" accessibilityLabel={`Approve ${title}`}>
                  <Ionicons name="checkmark" size={16} color="#0f1023" />
                  <Text style={styles.approveText}>Approve</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.decline]} onPress={() => onDecline(request, title)}
                  accessibilityRole="button" accessibilityLabel={`Decline ${title}`}>
                  <Ionicons name="close" size={16} color={colors.error} />
                  <Text style={styles.declineText}>Decline</Text>
                </Pressable>
              </>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

// Poll ticks hand back fresh objects for unchanged requests
export const RequestRow = React.memo(RequestRowInner, (prev, next) =>
  prev.busy === next.busy && prev.adapter === next.adapter
  && prev.onApprove === next.onApprove && prev.onDecline === next.onDecline
  && prev.request.id === next.request.id && prev.request.status === next.request.status
  && prev.request.media?.status === next.request.media?.status);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.md, marginHorizontal: spacing.xl, marginBottom: spacing.sm, backgroundColor: colors.surfaceCard, borderWidth: 1, borderColor: colors.surfaceCardBorder, borderRadius: radii.lg, padding: spacing.md },
  poster: { width: 60, height: 90, borderRadius: radii.sm, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden' },
  posterImg: { width: '100%', height: '100%' },
  body: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: 4 },
  title: { ...typography.bodyBold, color: colors.textPrimary, flex: 1 },
  year: { ...typography.caption, color: colors.textMuted },
  statePill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radii.round, borderWidth: 1 },
  stateText: { ...typography.badge, textTransform: 'uppercase', letterSpacing: 0.3 },
  meta: { ...typography.micro, color: colors.textSecondary, marginTop: 2 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  spinner: { paddingVertical: 6 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: radii.md },
  approve: { backgroundColor: colors.primary },
  approveText: { ...typography.caption, fontWeight: '700', color: '#0f1023' },
  decline: { backgroundColor: 'rgba(233, 69, 96, 0.1)', borderWidth: 1, borderColor: 'rgba(233, 69, 96, 0.35)' },
  declineText: { ...typography.caption, fontWeight: '700', color: colors.error },
});
