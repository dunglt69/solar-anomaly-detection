/**
 * EnergiaMind — Hardware Signature & Device Info Utility
 *
 * Generates a stable hardware signature for device binding.
 * Uses stable hardware components (CPU, RAM, GPU, screen, platform, timezone)
 * instead of volatile browser fingerprints (canvas, fonts, etc.).
 */

// ─── Hardware Signature (for device binding) ─────────────────────────

export interface HardwareSignature {
  cpuCores: number;
  ram: number | null;     // navigator.deviceMemory (Chrome only)
  screen: string;          // "1920x1080"
  platform: string;        // "Win32", "MacIntel", "Linux x86_64"
  timezone: string;        // "Asia/Ho_Chi_Minh"
  gpu: string;             // WebGL renderer string
  colorDepth: number;      // screen.colorDepth
  touchPoints: number;     // navigator.maxTouchPoints
}

let cachedHwSignature: HardwareSignature | null = null;

/**
 * Collect stable hardware characteristics for device binding.
 * These components rarely change unless hardware is swapped.
 */
export function getHardwareSignature(): HardwareSignature {
  if (cachedHwSignature) return cachedHwSignature;

  // CPU cores
  const cpuCores = navigator.hardwareConcurrency || 0;

  // Device memory (Chrome-only; null on Firefox/Safari)
  const ram = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null;

  // Screen resolution
  const screenStr = `${screen.width || 0}x${screen.height || 0}`;

  // Platform
  const platform = navigator.platform || 'unknown';

  // Timezone
  let timezone = 'unknown';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  } catch { /* fallback */ }

  // GPU (WebGL renderer)
  let gpu = 'unknown';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const glCtx = gl as WebGLRenderingContext;
      const debugInfo = glCtx.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        gpu = glCtx.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'unknown';
      }
    }
  } catch { /* ignored */ }

  // Color depth
  const colorDepth = screen.colorDepth || 24;

  // Touch points (0 = desktop, >0 = touch device)
  const touchPoints = navigator.maxTouchPoints || 0;

  cachedHwSignature = {
    cpuCores,
    ram,
    screen: screenStr,
    platform,
    timezone,
    gpu,
    colorDepth,
    touchPoints,
  };

  return cachedHwSignature;
}

// ─── Human-readable Device Info ──────────────────────────────────────

export interface DeviceInfo {
  browser: string;
  os: string;
  screenRes: string;
  gpu: string;
}

let cachedDeviceInfo: DeviceInfo | null = null;

/**
 * Returns human-readable device information parsed from
 * the UserAgent string, screen dimensions, and WebGL renderer.
 */
export function getDeviceInfo(): DeviceInfo {
  if (cachedDeviceInfo) return cachedDeviceInfo;

  const ua = navigator.userAgent || '';

  // ─── Parse browser ──────────────────────────────────────────────
  let browser = 'Unknown';
  if (ua.includes('Edg/')) {
    const m = ua.match(/Edg\/([\d.]+)/);
    browser = `Edge ${m?.[1] ?? ''}`.trim();
  } else if (ua.includes('OPR/') || ua.includes('Opera')) {
    const m = ua.match(/OPR\/([\d.]+)/);
    browser = `Opera ${m?.[1] ?? ''}`.trim();
  } else if (ua.includes('Chrome/') && !ua.includes('Chromium')) {
    const m = ua.match(/Chrome\/([\d.]+)/);
    browser = `Chrome ${m?.[1] ?? ''}`.trim();
  } else if (ua.includes('Firefox/')) {
    const m = ua.match(/Firefox\/([\d.]+)/);
    browser = `Firefox ${m?.[1] ?? ''}`.trim();
  } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    const m = ua.match(/Version\/([\d.]+)/);
    browser = `Safari ${m?.[1] ?? ''}`.trim();
  }

  // ─── Parse OS ───────────────────────────────────────────────────
  let os = 'Unknown';
  if (ua.includes('Windows NT 10')) os = 'Windows 10/11';
  else if (ua.includes('Windows NT 6.3')) os = 'Windows 8.1';
  else if (ua.includes('Windows NT 6.1')) os = 'Windows 7';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS X')) {
    const m = ua.match(/Mac OS X ([\d_]+)/);
    os = `macOS ${m?.[1]?.replace(/_/g, '.') ?? ''}`.trim();
  } else if (ua.includes('Android')) {
    const m = ua.match(/Android ([\d.]+)/);
    os = `Android ${m?.[1] ?? ''}`.trim();
  } else if (ua.includes('iPhone') || ua.includes('iPad')) {
    const m = ua.match(/OS ([\d_]+)/);
    os = `iOS ${m?.[1]?.replace(/_/g, '.') ?? ''}`.trim();
  } else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('CrOS')) os = 'Chrome OS';

  // ─── Screen resolution ──────────────────────────────────────────
  const screenRes = `${screen.width || '?'}×${screen.height || '?'}`;

  // ─── GPU (WebGL renderer) ───────────────────────────────────────
  let gpu = 'Unknown';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const glCtx = gl as WebGLRenderingContext;
      const debugInfo = glCtx.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        gpu = glCtx.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'Unknown';
      }
    }
  } catch { /* ignored */ }

  cachedDeviceInfo = { browser, os, screenRes, gpu };
  return cachedDeviceInfo;
}

// ─── Legacy compatibility ────────────────────────────────────────────
// getDeviceFingerprint is no longer used for blocking/binding.
// Device binding now uses HardwareSignature + server-issued cookie.
export async function getDeviceFingerprint(): Promise<string> {
  const hw = getHardwareSignature();
  return `hw-${hw.cpuCores}-${hw.platform}-${hw.timezone}`;
}
