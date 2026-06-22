import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldOff, Wifi, Smartphone, Clock } from 'lucide-react';
import './BlockedPage.css';

/**
 * Calculates a human-readable duration string from now until the given ISO date.
 * Returns null if the date is in the past.
 */
function formatRemainingTime(isoDate: string): string | null {
  const expiresAt = new Date(isoDate).getTime();
  const now = Date.now();
  const diff = expiresAt - now;

  if (diff <= 0) return null;

  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ${hours % 24} hour${hours % 24 !== 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ${minutes % 60} minute${minutes % 60 !== 1 ? 's' : ''}`;
  return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
}

export default function BlockedPage() {
  const [searchParams] = useSearchParams();
  const reason = searchParams.get('reason') || 'ip_blocked';
  const expiresAt = searchParams.get('expiresAt');

  const [remaining, setRemaining] = useState<string | null>(null);

  // Update remaining time every 30 seconds
  useEffect(() => {
    if (!expiresAt) return;

    const update = () => setRemaining(formatRemainingTime(expiresAt));
    update();

    const interval = setInterval(update, 30_000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const isIpBlocked = reason === 'ip_blocked';
  const isDeviceBlocked = reason === 'device_blocked';

  return (
    <div className="blocked-page">
      <div className="blocked-ambient" />

      <div className="blocked-card">
        {/* Warning Icon */}
        <div className="blocked-icon">
          <ShieldOff size={32} strokeWidth={2} />
        </div>

        {/* Heading */}
        <h1 className="blocked-title">Security Policy Violation</h1>
        <p className="blocked-subtitle">
          Suspicious login activity has been detected from your {isIpBlocked ? 'IP address' : 'device'}. Access to this system has been restricted.
        </p>

        {/* Reason */}
        <div className="blocked-reason">
          {isIpBlocked && (
            <>
              <Wifi size={16} />
              <span>Your IP address has been restricted</span>
            </>
          )}
          {isDeviceBlocked && (
            <>
              <Smartphone size={16} />
              <span>Your device has been restricted</span>
            </>
          )}
        </div>

        {/* Expiry / Duration */}
        {expiresAt && remaining ? (
          <div className="blocked-expiry">
            <Clock size={14} />
            <span>Restriction expires in {remaining}</span>
          </div>
        ) : expiresAt && !remaining ? (
          <div className="blocked-expiry" style={{ color: 'var(--color-healthy)', background: 'var(--color-healthy-bg)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
            <Clock size={14} />
            <span>Restriction has expired — try refreshing the page</span>
          </div>
        ) : (
          <p className="blocked-permanent">Your {isIpBlocked ? 'IP address' : 'device'} has been permanently blocked.</p>
        )}

        <div className="blocked-divider" />

        {/* Warning */}
        <p className="blocked-contact" style={{ color: 'var(--status-critical)', fontWeight: 600, fontSize: '0.8rem' }}>
          This action has been logged and reported. Repeated violations will result in a permanent ban. Unauthorized access is a criminal offense under the <em>Law on Cybersecurity (No. 24/2018/QH14)</em>, the <em>Law on Network Information Security (No. 86/2015/QH13)</em>, and <em>Articles 285–289 of the Penal Code</em> of the Socialist Republic of Vietnam. Violators may face criminal prosecution and will be held fully liable for any financial and operational damages caused.
        </p>

        {/* Contact */}
        <p className="blocked-contact">
          If you believe this is an error, please contact your system administrator to request a review of this restriction.
        </p>

        {/* Footer */}
        <div className="blocked-footer">
          <p>© {new Date().getFullYear()} EnergiaMind Corp. All rights reserved.</p>
        </div>
      </div>
    </div>
  );
}
