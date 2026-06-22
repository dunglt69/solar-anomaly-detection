import { useState } from 'react';
import { getDeviceInfo } from '../utils/fingerprint';
import './AccessDeniedPage.css';

export default function AccessDeniedPage() {
  const [deviceInfo] = useState(() => getDeviceInfo());
  const [timestamp] = useState(() => new Date().toISOString());
  const [incidentId] = useState(() => `INC-${Date.now().toString(36).toUpperCase()}`);

  return (
    <div className="access-denied-page">
      <div className="access-denied-container">
        {/* Shield Icon */}
        <div className="access-denied-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <line x1="4.5" y1="4.5" x2="19.5" y2="19.5" />
          </svg>
        </div>

        <h1 className="access-denied-title">Access Denied</h1>
        <p className="access-denied-subtitle">
          Unauthorized login attempt detected. This device is not registered to the account used
          and has been denied access to the EnergiaMind monitoring system.
        </p>

        {/* Detected Device Info */}
        <div className="access-denied-details">
          <h3>Detected Device Information</h3>
          <div className="access-denied-detail-row">
            <span className="access-denied-detail-label">Timestamp</span>
            <span className="access-denied-detail-value">
              {new Date(timestamp).toLocaleString('en-US', {
                year: 'numeric',
                month: 'short',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
              })}
            </span>
          </div>
          {deviceInfo && (
            <>
              <div className="access-denied-detail-row">
                <span className="access-denied-detail-label">Browser</span>
                <span className="access-denied-detail-value">{deviceInfo.browser}</span>
              </div>
              <div className="access-denied-detail-row">
                <span className="access-denied-detail-label">Operating System</span>
                <span className="access-denied-detail-value">{deviceInfo.os}</span>
              </div>
              <div className="access-denied-detail-row">
                <span className="access-denied-detail-label">Display</span>
                <span className="access-denied-detail-value">{deviceInfo.screenRes}</span>
              </div>
              <div className="access-denied-detail-row">
                <span className="access-denied-detail-label">GPU</span>
                <span className="access-denied-detail-value">{deviceInfo.gpu}</span>
              </div>
            </>
          )}
          <div className="access-denied-detail-row">
            <span className="access-denied-detail-label">Incident ID</span>
            <span className="access-denied-detail-value">{incidentId}</span>
          </div>
        </div>

        {/* Warning */}
        <div className="access-denied-warning">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <p>
              This incident has been logged and reported to the security team. Repeated unauthorized
              access attempts will result in account lockout and may be subject to legal action.
            </p>
            <p style={{ fontStyle: 'italic', fontSize: '0.8rem', opacity: 0.8 }}>
              Sự cố này đã được ghi lại và báo cáo cho đội ngũ an ninh. Nỗ lực truy cập trái phép liên tục sẽ dẫn đến khóa tài khoản và có thể bị truy tố trước pháp luật.
            </p>
          </div>
        </div>

        {/* Legal Notice */}
        <div className="access-denied-legal">
          <p>
            This system is the property of <strong>EnergiaMind Corp.</strong> and is restricted
            to authorized personnel only. All activity — including IP address, device hardware
            signature, and browser information — is monitored, recorded, and subject to audit.
          </p>
          <p style={{ marginTop: 8 }}>
            Hệ thống này thuộc sở hữu của <strong>EnergiaMind Corp.</strong> và chỉ dành cho nhân sự được ủy quyền. Mọi hoạt động — bao gồm địa chỉ IP, chữ ký phần cứng thiết bị và thông tin trình duyệt — đều được giám sát, ghi lại và kiểm toán.
          </p>
          <p style={{ marginTop: 12 }}>
            Unauthorized access is strictly prohibited and may be prosecuted under the{' '}
            <strong>Law on Cybersecurity (No. 24/2018/QH14)</strong>,{' '}
            and <strong>Article 289 of the Penal Code</strong> of the Socialist Republic of Vietnam,
            in addition to full liability for any financial and operational damages caused.
          </p>
          <p style={{ marginTop: 8 }}>
            Truy cập trái phép bị nghiêm cấm hoàn toàn và có thể bị truy tố theo{' '}
            <strong>Luật An ninh mạng (Số 24/2018/QH14)</strong>{' '}
            và <strong>Điều 289 Bộ luật Hình sự</strong> nước Cộng hòa Xã hội Chủ nghĩa Việt Nam, bên cạnh việc phải chịu trách nhiệm hoàn toàn đối với mọi thiệt hại tài chính và hoạt động gây ra.
          </p>
        </div>

        <div className="access-denied-footer">
          If you believe this is an error, contact your system administrator to reset your device binding.
          <br />
          Nếu bạn cho rằng đây là lỗi, hãy liên hệ với quản trị viên hệ thống để đặt lại liên kết thiết bị.
          <div className="access-denied-id" style={{ marginTop: 8 }}>REF: {incidentId}</div>
        </div>
      </div>
    </div>
  );
}
