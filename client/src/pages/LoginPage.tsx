import { useState, useEffect, type FormEvent } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Sun, Eye, EyeOff, AlertCircle, Loader2 } from 'lucide-react';
import './LoginPage.css';

interface Turnstile {
  render: (
    container: string | HTMLElement,
    options: {
      sitekey: string;
      theme?: 'light' | 'dark' | 'auto';
      callback?: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    }
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}

type WindowWithTurnstile = Window & typeof globalThis & {
  turnstile?: Turnstile;
};

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const { login, isLoading, error, clearError } = useAuthStore();
  const [turnstileToken, setTurnstileToken] = useState<string>('');
  const [widgetId, setWidgetId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || '0x4AAAAAADooqatF2O8ZnH9g';
    let currentWidgetId: string | null = null;

    const renderWidget = () => {
      const turnstile = (window as WindowWithTurnstile).turnstile;
      if (turnstile && active && !currentWidgetId) {
        try {
          const id = turnstile.render('#turnstile-widget', {
            sitekey: siteKey,
            theme: 'dark',
            callback: (token: string) => {
              if (active) {
                setTurnstileToken(token);
                clearError();
              }
            },
            'expired-callback': () => {
              if (active) setTurnstileToken('');
            },
            'error-callback': () => {
              if (active) setTurnstileToken('');
            },
          });
          currentWidgetId = id;
          setWidgetId(id);
        } catch (err) {
          console.error('Turnstile render error:', err);
        }
      }
    };

    const win = window as WindowWithTurnstile;

    if (win.turnstile) {
      renderWidget();
    } else {
      const interval = setInterval(() => {
        if (win.turnstile) {
          renderWidget();
          clearInterval(interval);
        }
      }, 500);
      return () => {
        active = false;
        clearInterval(interval);
        if (currentWidgetId && win.turnstile) {
          try {
            win.turnstile.remove(currentWidgetId);
          } catch { /* ignore */ }
        }
      };
    }

    return () => {
      active = false;
      if (currentWidgetId && win.turnstile) {
        try {
          win.turnstile.remove(currentWidgetId);
        } catch { /* ignore */ }
      }
    };
  }, [clearError]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    try {
      await login(username.trim(), password, turnstileToken);
    } catch {
      const win = window as WindowWithTurnstile;
      // Reset Turnstile on failure so user gets a fresh CAPTCHA session
      if (widgetId && win.turnstile) {
        win.turnstile.reset(widgetId);
        setTurnstileToken('');
      }
    }
  }

  return (
    <div className="login-page">
      <div className="login-ambient" />

      <div className="login-card">
        {/* Logo */}
        <div className="login-logo">
          <div className="login-logo-icon">
            <Sun size={28} strokeWidth={2} />
          </div>
          <h1 className="login-title">EnergiaMind</h1>
          <p className="login-subtitle">Solar Monitoring & Anomaly Detection</p>
        </div>

        {/* Error */}
        {error && (
          <div className="login-error" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button onClick={clearError} className="login-error-dismiss" aria-label="Dismiss error">×</button>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="username" className="form-label">Username</label>
            <input
              id="username"
              type="text"
              className="form-input"
              value={username}
              onChange={(e) => { setUsername(e.target.value); clearError(); }}
              placeholder="Enter username"
              autoComplete="username"
              autoFocus
              disabled={isLoading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="password" className="form-label">Password</label>
            <div className="input-with-icon">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                className="form-input"
                value={password}
                onChange={(e) => { setPassword(e.target.value); clearError(); }}
                placeholder="Enter password"
                autoComplete="current-password"
                disabled={isLoading}
              />
              <button
                type="button"
                className="input-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div className="form-group" style={{ display: 'flex', justifyContent: 'center', margin: 'var(--space-4) 0' }}>
            <div id="turnstile-widget" />
          </div>

          <button
            type="submit"
            className="login-button"
            disabled={isLoading || !username.trim() || !password.trim()}
          >
            {isLoading ? (
              <>
                <Loader2 size={18} className="spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <span>Sign In</span>
            )}
          </button>
        </form>

        {/* Security Notice */}
        <div className="login-legal">
          <p style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', lineHeight: 1.6, textAlign: 'center', margin: '0 0 var(--space-2)' }}>
            <strong style={{ color: 'var(--status-warning)', fontSize: '0.7rem' }}>WARNING</strong>
            <br />
            This system is the property of <strong>EnergiaMind Corp.</strong> and is restricted to authorized employees. 
            Access controls, device validation, and security monitoring are active. 
            All activity, including IP address, hardware telemetry, and browser metrics, is recorded for security auditing.
          </p>
          <p style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', lineHeight: 1.5, textAlign: 'center', margin: '0 0 var(--space-2)' }}>
            Hệ thống này thuộc sở hữu của <strong>EnergiaMind Corp.</strong> và giới hạn cho nhân viên được ủy quyền. 
            Các cơ chế kiểm soát truy cập, xác thực thiết bị và giám sát bảo mật đang hoạt động. 
            Mọi hoạt động bao gồm địa chỉ IP, thông số thiết bị và trình duyệt đều được ghi lại phục vụ mục đích kiểm toán bảo mật.
          </p>
          <p style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', lineHeight: 1.4, textAlign: 'center', margin: '0' }}>
            Unauthorized access is strictly prohibited and may be prosecuted under the <em>Law on Cybersecurity (No. 24/2018/QH14)</em> and <em>Article 289 of the Penal Code</em> of the Socialist Republic of Vietnam.
            <br />
            Truy cập trái phép bị nghiêm cấm và có thể bị truy tố theo <em>Luật An ninh mạng (Số 24/2018/QH14)</em> và <em>Điều 289 Bộ luật Hình sự</em> nước CHXHCN Việt Nam.
          </p>
        </div>

        <div className="login-footer">
          <p>© {new Date().getFullYear()} EnergiaMind Corp. All rights reserved.</p>
        </div>
      </div>
    </div>
  );
}
