import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, RefreshControl } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { colors, spacing, typography } from '../../../core/theme/tokens';
import { FilterChips } from '../../../core/components/FilterChips';
import { EmptyState } from '../../../core/components/EmptyState';
import { ErrorState } from '../../../core/components/ErrorState';
import { useThemedAlert } from '../../../core/components/ThemedAlert';
import { usePolling } from '../../../core/hooks/usePolling';
import { useActiveServer, useServiceConfig } from '../../../core/hooks/useServer';
import { useToastStore } from '../../../core/hooks/useToast';
import { logError } from '../../../core/utils/log';
import { useStatusStore } from '../../../stores/statusStore';
import { getSeerrAdapter } from '../../adapterFactory';
import { RequestRow } from '../components/RequestRow';
import { SeerrRequest, SeerrRequestCount, SeerrRequestFilter } from '../types';

const PAGE_SIZE = 100;

const FILTERS: { id: SeerrRequestFilter; label: string; countKey?: keyof SeerrRequestCount }[] = [
  { id: 'pending', label: 'Pending', countKey: 'pending' },
  { id: 'processing', label: 'Processing', countKey: 'processing' },
  { id: 'available', label: 'Available', countKey: 'available' },
  { id: 'approved', label: 'Approved' },
  { id: 'all', label: 'All', countKey: 'total' },
];

export function RequestsScreen() {
  const config = useServiceConfig('seerr');
  const { server, isLocal } = useActiveServer();
  const adapter = useMemo(() => (config?.enabled ? getSeerrAdapter(config, isLocal) : null), [config, isLocal]);
  const showToast = useToastStore((s) => s.show);
  const { alert } = useThemedAlert();

  const [filter, setFilter] = useState<SeerrRequestFilter>('pending');
  const [requests, setRequests] = useState<SeerrRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<SeerrRequestCount | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());

  // A filter or server switch supersedes any fetch still in flight
  const fetchSeq = useRef(0);
  useEffect(() => { setCounts(null); }, [adapter]);

  const fetchRequests = useCallback(async () => {
    if (!adapter) return;
    const seq = ++fetchSeq.current;
    try {
      const [page, count] = await Promise.all([
        adapter.getRequests(filter, PAGE_SIZE),
        adapter.getRequestCount().catch(() => null),
      ]);
      if (seq !== fetchSeq.current) return;
      setRequests(page.results);
      setTotal(page.pageInfo?.results ?? page.results.length);
      if (count) setCounts(count);
      setError(null);
    } catch (e: any) {
      if (seq !== fetchSeq.current) return;
      logError('Seerr requests', e);
      setError(e.response?.status ? `Seerr answered HTTP ${e.response.status}` : 'Could not reach Seerr');
    } finally {
      if (seq === fetchSeq.current) setLoaded(true);
    }
  }, [adapter, filter]);

  usePolling(fetchRequests, 30000, !!adapter);

  // usePolling keeps its timer across callback changes, so a filter or server
  // switch fetches right away instead of waiting out the interval. The mount
  // run is skipped since usePolling already fetches immediately.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    setRequests([]); setTotal(0); setLoaded(false); setError(null);
    fetchRequests();
  }, [fetchRequests]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchRequests();
    setRefreshing(false);
  }, [fetchRequests]);

  // Keeps the Home/Dashboard pending count in step with what was just done here
  const refreshStatuses = useCallback(() => {
    const enabled = server?.services.filter((s) => s.enabled) ?? [];
    useStatusStore.getState().refresh(enabled, isLocal, true).catch(() => {});
  }, [server, isLocal]);

  const act = useCallback(async (req: SeerrRequest, action: 'approve' | 'decline') => {
    if (!adapter) return;
    setBusyIds((prev) => new Set(prev).add(req.id));
    try {
      if (action === 'approve') await adapter.approveRequest(req.id);
      else await adapter.declineRequest(req.id);
      showToast(action === 'approve' ? 'Request approved' : 'Request declined', 'success');
      await fetchRequests();
      refreshStatuses();
    } catch (e: any) {
      logError(`Seerr ${action}`, e);
      const status = e.response?.status;
      showToast(status === 403 ? 'This API key cannot manage requests' : `Could not ${action} the request`, 'error');
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(req.id); return next; });
    }
  }, [adapter, fetchRequests, refreshStatuses, showToast]);

  const onApprove = useCallback((req: SeerrRequest) => { act(req, 'approve'); }, [act]);
  const onDecline = useCallback((req: SeerrRequest, title: string) => {
    alert('Decline request?', `${title} will not be downloaded.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Decline', style: 'destructive', onPress: () => { act(req, 'decline'); } },
    ]);
  }, [act, alert]);

  const chips = useMemo(() => FILTERS.map((f) => ({
    id: f.id, label: f.label, count: f.countKey && counts ? counts[f.countKey] : undefined,
  })), [counts]);

  if (!adapter) {
    return (
      <View style={styles.container}>
        <EmptyState icon="🎟️" title="Seerr not connected" message="Add Seerr (or Overseerr/Jellyseerr) to this server in Settings to manage requests." />
      </View>
    );
  }

  const emptyMessage = filter === 'pending' ? 'Nothing is waiting for approval.' : 'No requests match this filter.';

  return (
    <View style={styles.container}>
      <FilterChips chips={chips} activeId={filter} onSelect={(id) => setFilter(id as SeerrRequestFilter)} />
      {error && requests.length === 0 ? (
        <ErrorState message={error} onRetry={onRefresh} />
      ) : (
        <FlashList
          data={requests}
          keyExtractor={(item) => String(item.id)}
          extraData={busyIds}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          contentContainerStyle={{ paddingBottom: 20 }}
          ListEmptyComponent={loaded
            ? <EmptyState icon="🎟️" title="No requests" message={emptyMessage} />
            : <Text style={styles.note}>Loading requests...</Text>}
          ListFooterComponent={total > requests.length
            ? <Text style={styles.note}>Showing the latest {requests.length} of {total}</Text>
            : null}
          renderItem={({ item }) => (
            <RequestRow request={item} adapter={adapter} busy={busyIds.has(item.id)}
              onApprove={onApprove} onDecline={onDecline} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent', paddingTop: spacing.md },
  note: { ...typography.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg },
});
