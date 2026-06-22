import { useEffect, useState, useCallback } from 'react';
import { authFetch, apiUrl } from '../lib/authFetch';
import { useAlertStore, type Alert } from '../stores/alertStore';
import { useTicketStore, type Ticket } from '../stores/ticketStore';
import { useTelemetryStore } from '../stores/telemetryStore';
import { AlertTriangle, CheckCircle, Clock, Shield } from 'lucide-react';
import { FAULT_LABELS } from '../lib/constants';
import { formatTime } from '../lib/formatTime';
import './AlertsPage.css';

// ─── Unified Alert Detail Modal ─────────────────────────────────────
function AlertDetailModal({ alert, onClose }: {
  alert: Alert;
  onClose: () => void;
}) {
  const { acknowledgeAlert, fetchAlerts, fetchStats } = useAlertStore();
  const { updateTicket, addComment, fetchTickets } = useTicketStore();
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [isError, setIsError] = useState(false);
  const [resolution, setResolution] = useState('');
  const [localTicket, setLocalTicket] = useState<Ticket | null>(null);
  const [loadingTicket, setLoadingTicket] = useState(true);

  const loadTicket = useCallback(async () => {
    setLoadingTicket(true);
    try {
      const res = await authFetch(apiUrl(`/api/v1/tickets?alertId=${alert.id}`));
      if (res.ok) {
        const json = await res.json();
        if (json.data && json.data.length > 0) {
          const ticketId = json.data[0].id;
          const detailRes = await authFetch(apiUrl(`/api/v1/tickets/${ticketId}`));
          if (detailRes.ok) {
            const ticketDetail = await detailRes.json();
            setLocalTicket(ticketDetail);
          }
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingTicket(false);
    }
  }, [alert.id]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadTicket();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadTicket]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const refreshTicketDetail = async () => {
    if (!localTicket?.id) return;
    try {
      const detailRes = await authFetch(apiUrl(`/api/v1/tickets/${localTicket.id}`));
      if (detailRes.ok) {
        const ticketDetail = await detailRes.json();
        setLocalTicket(ticketDetail);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Status mapping
  const currentStatus = localTicket?.status === 'resolved' || localTicket?.status === 'closed'
    ? 'resolved'
    : localTicket?.status === 'escalated'
      ? 'escalated'
      : localTicket?.status === 'in_progress'
        ? 'in_progress'
        : alert.acknowledged
          ? 'acknowledged'
          : 'new';

  const handleAcknowledge = async () => {
    try {
      setIsError(false);
      await acknowledgeAlert(alert.id);
      if (localTicket?.id) {
        await updateTicket(localTicket.id, { status: 'acknowledged' });
      }
      setFeedback('Alert acknowledged');
      await fetchTickets({ limit: '200' });
      fetchAlerts({ limit: '50' });
      fetchStats();
      await refreshTicketDetail();
      setTimeout(() => setFeedback(''), 3000);
    } catch (err: any) {
      setIsError(true);
      setFeedback(err.message || 'Failed to acknowledge alert');
      setTimeout(() => {
        setFeedback('');
        setIsError(false);
      }, 5000);
    }
  };

  const handleResolve = async () => {
    if (!localTicket?.id) return;
    try {
      setIsError(false);
      await updateTicket(localTicket.id, {
        status: 'resolved',
        resolutionSummary: resolution || 'Resolved by operator',
      });
      if (resolution) {
        await addComment(localTicket.id, `Resolution: ${resolution}`);
      }
      setFeedback('Alert resolved');
      await fetchTickets({ limit: '200' });
      fetchAlerts({ limit: '50' });
      fetchStats();
      await refreshTicketDetail();
      setTimeout(() => setFeedback(''), 3000);
    } catch (err: any) {
      setIsError(true);
      setFeedback(err.message || 'Failed to resolve alert');
      setTimeout(() => {
        setFeedback('');
        setIsError(false);
      }, 5000);
    }
  };

  const handleEscalate = async () => {
    if (!localTicket?.id) return;
    try {
      setIsError(false);
      await updateTicket(localTicket.id, { status: 'escalated' });
      await addComment(localTicket.id, 'Incident escalated by operator');
      setFeedback('Alert escalated');
      await fetchTickets({ limit: '200' });
      fetchAlerts({ limit: '50' });
      fetchStats();
      await refreshTicketDetail();
      setTimeout(() => setFeedback(''), 3000);
    } catch (err: any) {
      setIsError(true);
      setFeedback(err.message || 'Failed to escalate');
      setTimeout(() => {
        setFeedback('');
        setIsError(false);
      }, 5000);
    }
  };

  const handleAddComment = async () => {
    if (!comment.trim() || !localTicket?.id) return;
    setSubmitting(true);
    try {
      await addComment(localTicket.id, comment.trim());
      setComment('');
      await refreshTicketDetail();
    } catch {
      setFeedback('Failed to add note');
      setTimeout(() => setFeedback(''), 3000);
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingTicket) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
          <Clock className="spin-icon" size={24} style={{ marginBottom: '1rem', color: 'var(--color-brand)' }} />
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>Loading ticket details...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="alert-modal-id">
              {localTicket?.id || alert.id.slice(0, 12)}
            </div>
            <h2 className="alert-modal-title">
              {FAULT_LABELS[alert.faultType]} — {alert.severity.toUpperCase()}
            </h2>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {/* Status flow */}
        <div className="status-flow">
          <div className={`status-step ${currentStatus === 'new' ? 'active' : 'done'}`}>
            <Clock size={16} />
            <span>New</span>
          </div>
          <div className="status-arrow">→</div>
          <div className={`status-step ${
            (currentStatus === 'acknowledged' || currentStatus === 'in_progress' || currentStatus === 'escalated')
              ? 'active'
              : (currentStatus === 'resolved')
                ? 'done'
                : ''
          } ${currentStatus === 'escalated' ? 'escalated' : ''}`}>
            <CheckCircle size={16} />
            <span>
              {currentStatus === 'escalated'
                ? 'Escalated'
                : currentStatus === 'in_progress'
                  ? 'In Progress'
                  : 'Acknowledged'}
            </span>
          </div>
          <div className="status-arrow">→</div>
          <div className={`status-step ${currentStatus === 'resolved' ? 'active' : ''}`}>
            <Shield size={16} />
            <span>Resolved</span>
          </div>
        </div>

        {/* Diagnostics */}
        <div className="modal-section">
          <h3>Diagnostics</h3>
          <div className="diagnostic-grid">
            <div className="diagnostic-item">
              <span className="diagnostic-item-icon">🏷️</span>
              <div>
                <div className="diagnostic-item-label">Fault Type</div>
                <div className="diagnostic-item-value">{FAULT_LABELS[alert.faultType]}</div>
              </div>
            </div>
            <div className="diagnostic-item">
              <span className="diagnostic-item-icon">⚡</span>
              <div>
                <div className="diagnostic-item-label">Detection</div>
                <div className="diagnostic-item-value" style={{ textTransform: 'capitalize' }}>
                  {(alert.detectionLayer === 'ai' || alert.detectionLayer === 'lstm') ? 'AI (InceptionTime)' : 'Rule-Based'}
                </div>
              </div>
            </div>
            <div className="diagnostic-item">
              <span className="diagnostic-item-icon">📅</span>
              <div>
                <div className="diagnostic-item-label">Time</div>
                <div className="diagnostic-item-value">{formatTime(alert.timestamp)}</div>
              </div>
            </div>
            <div className="diagnostic-item">
              <span className="diagnostic-item-icon">📊</span>
              <div>
                <div className="diagnostic-item-label">Confidence</div>
                <div className="diagnostic-item-value">{(alert.confidence * 100).toFixed(0)}%</div>
              </div>
            </div>
          </div>
        </div>

        {/* Description from ticket */}
        {localTicket?.description && (
          <div className="modal-section">
            <h3>Details</h3>
            <div className="modal-description">{localTicket.description}</div>
          </div>
        )}

        {/* Actions based on current status */}
        <div className="modal-section">
          <h3>Actions</h3>
          {currentStatus === 'new' && (
            <button className="btn-action btn-acknowledge" onClick={handleAcknowledge}>
              <CheckCircle size={16} /> Acknowledge Alert
            </button>
          )}
          {(currentStatus === 'acknowledged' || currentStatus === 'in_progress') && (
            <div className="resolve-form">
              <textarea
                placeholder="Resolution summary (optional)..."
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                rows={2}
              />
              <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                <button className="btn-action btn-resolve" onClick={handleResolve}>
                  <Shield size={16} /> Mark as Resolved
                </button>
                {localTicket?.id && (
                  <button className="btn-action btn-escalate" onClick={handleEscalate}>
                    ⚠️ Escalate Incident
                  </button>
                )}
              </div>
            </div>
          )}
          {currentStatus === 'escalated' && (
            <div className="resolve-form">
              <textarea
                placeholder="Resolution summary (optional)..."
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                rows={2}
              />
              <button className="btn-action btn-resolve" onClick={handleResolve}>
                <Shield size={16} /> Mark as Resolved
              </button>
            </div>
          )}
          {currentStatus === 'resolved' && (
            <div className="resolved-info">
              ✅ This alert has been resolved.
              {localTicket?.resolutionSummary && (
                <p style={{ marginTop: '0.5rem', color: 'var(--text-secondary)' }}>
                  {localTicket.resolutionSummary}
                </p>
              )}
            </div>
          )}
          {feedback && (
            <div className={`action-feedback ${isError ? 'error' : ''}`}>{feedback}</div>
          )}
        </div>

        {/* Comments */}
        {localTicket && (
          <div className="modal-section">
            <h3>Notes ({localTicket?.comments?.length || 0})</h3>
            <div className="comment-list">
              {localTicket?.comments?.map((c) => (
                <div key={c.id} className="comment-item">
                  <div className="comment-meta">{formatTime(c.createdAt)}</div>
                  <div className="comment-body">{c.content}</div>
                </div>
              ))}
              {(!localTicket?.comments || localTicket.comments.length === 0) && (
                <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>
                  No notes yet.
                </p>
              )}
            </div>
            <div className="comment-form" style={{ marginTop: 'var(--space-3)' }}>
              <textarea
                placeholder="Add a note..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <button onClick={handleAddComment} disabled={submitting || !comment.trim()}>
                {submitting ? '...' : 'Add Note'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function getTimeRange(period: string, customFrom: string, customTo: string) {
  const now = new Date();
  let from: Date | null = null;
  let to: Date | null = null;

  if (period === 'today') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  } else if (period === 'yesterday') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
  } else if (period === '3d') {
    from = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  } else if (period === '7d') {
    from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === 'custom') {
    if (customFrom) from = new Date(customFrom);
    if (customTo) to = new Date(customTo);
  }

  return {
    from: from ? from.toISOString() : undefined,
    to: to ? to.toISOString() : undefined,
  };
}

// ─── Main Alerts Page (merged) ──────────────────────────────────────
export default function AlertsPage() {
  const { alerts, stats, total, loading, fetchAlerts, fetchStats } = useAlertStore();
  const { recentAlerts } = useTelemetryStore();
  const [severityFilter, setSeverityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [limit, setLimit] = useState(50);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);

  const getFetchParams = useCallback(() => {
    const params: Record<string, string> = { limit: String(limit) };
    if (severityFilter) params.severity = severityFilter;
    if (statusFilter) params.status = statusFilter;

    if (selectedPeriod !== 'all') {
      const { from, to } = getTimeRange(selectedPeriod, customFrom, customTo);
      if (from) params.from = from;
      if (to) params.to = to;
    }
    return params;
  }, [limit, severityFilter, statusFilter, selectedPeriod, customFrom, customTo]);

  // Listen to WebSocket alerts for instant list refresh
  // BUG-005: Use recentAlerts.length instead of the full array reference to prevent infinite re-fetch loops
  useEffect(() => {
    if (recentAlerts.length > 0) {
      fetchAlerts(getFetchParams());
      fetchStats();
    }
  }, [recentAlerts.length, fetchAlerts, fetchStats, getFetchParams]);

  useEffect(() => {
    fetchAlerts(getFetchParams());
    fetchStats();
  }, [fetchAlerts, fetchStats, getFetchParams]);

  // Auto-refresh every 15s
  useEffect(() => {
    const interval = setInterval(() => {
      fetchAlerts(getFetchParams());
      fetchStats();
    }, 15000);
    return () => clearInterval(interval);
  }, [fetchAlerts, fetchStats, getFetchParams]);

  const getAlertStatus = (alert: Alert): 'new' | 'acknowledged' | 'in_progress' | 'escalated' | 'resolved' => {
    const ticketStatus = alert.ticketStatus;
    if (ticketStatus) {
      if (ticketStatus === 'resolved' || ticketStatus === 'closed') return 'resolved';
      if (ticketStatus === 'escalated') return 'escalated';
      if (ticketStatus === 'in_progress') return 'in_progress';
      if (ticketStatus === 'acknowledged') return 'acknowledged';
    }
    return alert.acknowledged ? 'acknowledged' : 'new';
  };

  return (
    <div className="alerts-page">
      <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>
        Alert Center
      </h1>

      {/* Stats cards — simplified 3-state */}
      <div className="alert-stats">
        <div className="alert-stat-card stat-new"
          onClick={() => { setStatusFilter(statusFilter === 'new' ? '' : 'new'); setLimit(50); }}
          style={{ cursor: 'pointer', outline: statusFilter === 'new' ? '2px solid #F59E0B' : 'none' }}
        >
          <div className="stat-icon"><Clock size={20} /></div>
          <div className={`stat-value ${stats.unacknowledged > 0 ? 'warning' : ''}`}>
            {stats.unacknowledged}
          </div>
          <div className="stat-label">New</div>
        </div>
        <div className="alert-stat-card stat-acked"
          onClick={() => { setStatusFilter(statusFilter === 'acknowledged' ? '' : 'acknowledged'); setLimit(50); }}
          style={{ cursor: 'pointer', outline: statusFilter === 'acknowledged' ? '2px solid #3B82F6' : 'none' }}
        >
          <div className="stat-icon"><CheckCircle size={20} /></div>
          <div className="stat-value">
            {stats.total - stats.unacknowledged}
          </div>
          <div className="stat-label">Acknowledged</div>
        </div>
        <div className="alert-stat-card stat-critical">
          <div className="stat-icon"><AlertTriangle size={20} /></div>
          <div className={`stat-value ${stats.critical > 0 ? 'critical' : ''}`}>
            {stats.critical}
          </div>
          <div className="stat-label">Critical / Emergency</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="alerts-toolbar">
        <div className="toolbar-filters">
          <select value={severityFilter} onChange={(e) => { setSeverityFilter(e.target.value); setLimit(50); }}>
            <option value="">All Severities</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
            <option value="emergency">Emergency</option>
          </select>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setLimit(50); }}>
            <option value="">All Status</option>
            <option value="new">New</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="escalated">Escalated</option>
            <option value="resolved">Resolved</option>
          </select>
          <select value={selectedPeriod} onChange={(e) => { setSelectedPeriod(e.target.value); setLimit(50); }}>
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="3d">Last 3 Days</option>
            <option value="7d">Last 7 Days</option>
            <option value="custom">Custom Range</option>
          </select>
        </div>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>
          Showing {alerts.length} of {total} alerts
        </span>
      </div>

      {/* Custom Period Input Row */}
      {selectedPeriod === 'custom' && (
        <div className="toolbar-custom-range">
          <input
            type="datetime-local"
            value={customFrom}
            onChange={(e) => { setCustomFrom(e.target.value); setLimit(50); }}
          />
          <span style={{ color: 'var(--text-tertiary)' }}>to</span>
          <input
            type="datetime-local"
            value={customTo}
            onChange={(e) => { setCustomTo(e.target.value); setLimit(50); }}
          />
        </div>
      )}

      {/* Alert list (card-based instead of table) */}
      <div className="alert-list">
        {alerts.length === 0 && !loading ? (
          <div className="alert-empty">
            <div className="empty-icon">🛡️</div>
            <p>No alerts found. System operating normally.</p>
          </div>
        ) : (
          alerts.map((alert) => {
            const status = getAlertStatus(alert);
            return (
              <div
                key={alert.id}
                className={`alert-card alert-card--${status}`}
                onClick={() => setSelectedAlert(alert)}
              >
                <div className="alert-card-severity">
                  <span className={`severity-dot severity-dot--${alert.severity}`} />
                </div>
                <div className="alert-card-body">
                  <div className="alert-card-title">
                    {FAULT_LABELS[alert.faultType] || `Unknown(${alert.faultType})`}
                  </div>
                  <div className="alert-card-meta">
                    <span className={`severity-badge ${alert.severity}`}>
                      {alert.severity}
                    </span>
                    <span className={`detection-badge detection-badge--${(alert.detectionLayer === 'ai' || alert.detectionLayer === 'lstm') ? 'ai' : 'rule'}`}>
                      {(alert.detectionLayer === 'ai' || alert.detectionLayer === 'lstm') ? '🧠 AI' : '📐 Rule-Based'}
                    </span>
                    <span className="alert-card-confidence" title={`AI confidence: ${(alert.confidence * 100).toFixed(1)}%`}>
                      <span className="confidence-bar" style={{ width: `${alert.confidence * 100}%` }} />
                      <span className="confidence-text">{(alert.confidence * 100).toFixed(0)}%</span>
                    </span>
                  </div>
                </div>
                <div className="alert-card-status">
                  <span className={`status-pill status-pill--${status}`}>
                    {status === 'new' && '⏳ New'}
                    {status === 'acknowledged' && '✓ ACK'}
                    {status === 'in_progress' && '⚙️ In Progress'}
                    {status === 'escalated' && '⚠️ Escalated'}
                    {status === 'resolved' && '✅ Resolved'}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Load More Button */}
      {alerts.length < total && !loading && (
        <div className="alert-load-more">
          <button className="btn-load-more" onClick={() => setLimit(prev => prev + 50)}>
            Load More Alerts
          </button>
        </div>
      )}

      {/* Modal */}
      {selectedAlert && (
        <AlertDetailModal
          alert={alerts.find((a) => a.id === selectedAlert.id) || selectedAlert}
          onClose={() => setSelectedAlert(null)}
        />
      )}
    </div>
  );
}
