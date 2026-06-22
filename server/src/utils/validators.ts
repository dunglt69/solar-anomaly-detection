/**
 * Shared input validators for EnergiaMind server routes.
 * Extracted from auth.ts and admin.ts to avoid duplication (SMELL-003).
 */

// Password complexity: min 8 chars, at least 1 uppercase, 1 lowercase, 1 digit, 1 special
export function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one digit';
  const specialChars = `!@#$%^&*()_+-=[]{};':"|,.<>/?\\`;
  if (![...password].some(char => specialChars.includes(char))) return 'Password must contain at least one special character';
  return null; // valid
}

// IP address format validation (IPv4 or IPv6)
export function validateIPAddress(ip: string): boolean {
  // IPv4: 4 octets 0-255
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (ipv4Match) {
    return ipv4Match.slice(1, 5).every(octet => {
      const n = Number(octet);
      return n >= 0 && n <= 255;
    });
  }

  // IPv6: must contain at least one ':', 2-39 chars, only hex digits and colons
  // At most 8 groups of hex digits separated by colons, allows :: shorthand
  if (ip.length < 2 || ip.length > 39) return false;
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return false;
  // Must have at least 2 colons (e.g., ::1) or valid full format
  const colonCount = (ip.match(/:/g) || []).length;
  if (colonCount < 2) return false;
  // Reject more than one '::' occurrence
  const doubleColons = (ip.match(/::/g) || []).length;
  if (doubleColons > 1) return false;
  // Each group between colons must be 1-4 hex digits (or empty for ::)
  const groups = ip.split(':');
  return groups.every(g => g.length <= 4);
}
