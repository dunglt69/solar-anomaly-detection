import { describe, it, expect } from 'vitest';
import { validatePassword, validateIPAddress } from '../utils/validators.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Comprehensive Validator Test Suite
// Pure functions — no DB needed, no afterEach cleanup required.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Validators — Comprehensive Test Suite', () => {

  // ─── SECTION 1: validatePassword (50 cases) ────────────────────────────────

  describe('validatePassword', () => {

    // ── 1A: Valid passwords → returns null ────────────────────────────────────

    describe('Valid passwords (returns null)', () => {

      it('Case 1: Exactly 8 chars meeting all requirements → null', () => {
        expect(validatePassword('Abcdefg1!')).toBeNull();
      });

      it('Case 2: 10 chars with all requirements → null', () => {
        expect(validatePassword('MyP@ssw0rd')).toBeNull();
      });

      it('Case 3: Long password (63 chars) → null', () => {
        const pw = 'A' + 'a'.repeat(60) + '1!';
        expect(pw.length).toBe(63);
        expect(validatePassword(pw)).toBeNull();
      });

      it('Case 4: Password with space (not forbidden) → null', () => {
        expect(validatePassword('Pass word1!')).toBeNull();
      });

      it('Case 5: Emoji password with valid chars → null', () => {
        // 'Ab1!😀😀😀😀'.length is 12 (emoji are 2 UTF-16 code units each)
        expect(validatePassword('Ab1!😀😀😀😀')).toBeNull();
      });

      it('Case 6: Password with multiple specials → null', () => {
        expect(validatePassword('Abc1!@#$')).toBeNull();
      });

      it('Case 7: All character classes at minimum → null', () => {
        expect(validatePassword('Aa1!aaaa')).toBeNull();
      });

      it('Case 8: 128-char password → null', () => {
        const pw = 'Aa1!' + 'b'.repeat(124);
        expect(pw.length).toBe(128);
        expect(validatePassword(pw)).toBeNull();
      });

      // ── Special char coverage (Cases 9–37) ─────────────────────────────

      const specialChars = [
        '!', '@', '#', '$', '%', '^', '&', '*', '(', ')',
        '_', '+', '-', '=', '[', ']', '{', '}', ';', "'",
        ':', '"', '\\', '|', ',', '.', '<', '>', '/', '?',
      ];

      specialChars.forEach((char, idx) => {
        it(`Case ${9 + idx}: Special char '${char === '\\' ? '\\\\' : char}' as only special → null`, () => {
          const pw = `Abcdefg1${char}`;
          expect(validatePassword(pw)).toBeNull();
        });
      });
    });

    // ── 1B: Invalid passwords → returns error string ─────────────────────────

    describe('Invalid passwords (returns error string)', () => {

      it('Case 39: Empty string → too short', () => {
        const result = validatePassword('');
        expect(result).toBe('Password must be at least 8 characters');
      });

      it('Case 40: 5 chars (too short) → too short', () => {
        const result = validatePassword('Abc1!');
        expect(result).toBe('Password must be at least 8 characters');
      });

      it('Case 41: 7 chars (one below minimum) → too short', () => {
        const result = validatePassword('Abcde1!');
        expect(result).toBe('Password must be at least 8 characters');
      });

      it('Case 42: Missing digit → digit error', () => {
        const result = validatePassword('Abcdefg!');
        expect(result).toBe('Password must contain at least one digit');
      });

      it('Case 43: Missing lowercase → lowercase error', () => {
        const result = validatePassword('ABCDEFG1!');
        expect(result).toBe('Password must contain at least one lowercase letter');
      });

      it('Case 44: Missing uppercase → uppercase error', () => {
        const result = validatePassword('abcdefg1!');
        expect(result).toBe('Password must contain at least one uppercase letter');
      });

      it('Case 45: Missing special char → special error', () => {
        const result = validatePassword('Abcdefg1A');
        expect(result).toBe('Password must contain at least one special character');
      });

      it('Case 46: Only lowercase letters → uppercase error (first check that fails after length)', () => {
        const result = validatePassword('abcdefgh');
        expect(result).toBe('Password must contain at least one uppercase letter');
      });

      it('Case 47: Only digits → uppercase error', () => {
        const result = validatePassword('12345678');
        expect(result).toBe('Password must contain at least one uppercase letter');
      });

      it('Case 48: Only special chars → uppercase error', () => {
        const result = validatePassword('!!!!!!!!!');
        expect(result).toBe('Password must contain at least one uppercase letter');
      });

      it('Case 49: Uppercase + lowercase only → digit error', () => {
        const result = validatePassword('AAAAaaaa');
        expect(result).toBe('Password must contain at least one digit');
      });

      it('Case 50: 8 spaces → uppercase error', () => {
        const result = validatePassword(' '.repeat(8));
        expect(result).toBe('Password must contain at least one uppercase letter');
      });

      it('Case 51: 8 tabs → uppercase error', () => {
        const result = validatePassword('\t'.repeat(8));
        expect(result).toBe('Password must contain at least one uppercase letter');
      });

      it('Case 52: Accented uppercase (À) does not satisfy [A-Z] → uppercase error', () => {
        // 'À' is not in ASCII A-Z range, so uppercase check fails
        const result = validatePassword('Àbcdefg1!');
        // 'À' is not matched by [A-Z], but 'b' matches [a-z], '1' matches [0-9]
        // Length is 9, passes. First failing check: [A-Z] → uppercase error
        expect(result).toBe('Password must contain at least one uppercase letter');
      });

      it('Case 53: Single character → too short', () => {
        const result = validatePassword('A');
        expect(result).toBe('Password must be at least 8 characters');
      });
    });

    // ── 1C: Return value type checks ─────────────────────────────────────────

    describe('Return value semantics', () => {

      it('Case 54: Valid password returns exactly null (not undefined, not empty string)', () => {
        const result = validatePassword('MyP@ssw0rd');
        expect(result).toBeNull();
        expect(result).not.toBeUndefined();
        expect(result).not.toBe('');
      });

      it('Case 55: Invalid password returns a string (not boolean, not null)', () => {
        const result = validatePassword('');
        expect(typeof result).toBe('string');
        expect(result).not.toBeNull();
        expect((result as string).length).toBeGreaterThan(0);
      });

      it('Case 56: Error messages are human-readable (contain "Password must")', () => {
        const tooShort = validatePassword('Abc1!');
        expect(tooShort).toContain('Password must');

        const noUpper = validatePassword('abcdefg1!');
        expect(noUpper).toContain('Password must');

        const noLower = validatePassword('ABCDEFG1!');
        expect(noLower).toContain('Password must');

        const noDigit = validatePassword('Abcdefg!');
        expect(noDigit).toContain('Password must');

        const noSpecial = validatePassword('Abcdefg1A');
        expect(noSpecial).toContain('Password must');
      });

      it('Case 57: Validation checks run in order — length → uppercase → lowercase → digit → special', () => {
        // A single char 'a' should fail on length first, not uppercase
        expect(validatePassword('a')).toBe('Password must be at least 8 characters');
        // 8 lowercase → fails uppercase (not digit or special)
        expect(validatePassword('abcdefgh')).toBe('Password must contain at least one uppercase letter');
        // 8 uppercase → fails lowercase (not digit or special)
        expect(validatePassword('ABCDEFGH')).toBe('Password must contain at least one lowercase letter');
        // Uppercase + lowercase → fails digit (not special)
        expect(validatePassword('ABCDabcd')).toBe('Password must contain at least one digit');
        // Uppercase + lowercase + digit → fails special
        expect(validatePassword('ABCDabc1')).toBe('Password must contain at least one special character');
      });

      it('Case 58: Exactly at boundary — 8 chars valid → null', () => {
        expect(validatePassword('Abcdef1!')).toBeNull();
      });
    });
  });

  // ─── SECTION 2: validateIPAddress (30 cases) ───────────────────────────────

  describe('validateIPAddress', () => {

    // ── 2A: Valid IPv4 addresses ─────────────────────────────────────────────

    describe('Valid IPv4 addresses', () => {

      it('Case 59: 0.0.0.0 (all zeros) → true', () => {
        expect(validateIPAddress('0.0.0.0')).toBe(true);
      });

      it('Case 60: 255.255.255.255 (max octets) → true', () => {
        expect(validateIPAddress('255.255.255.255')).toBe(true);
      });

      it('Case 61: 192.168.1.1 (private Class C) → true', () => {
        expect(validateIPAddress('192.168.1.1')).toBe(true);
      });

      it('Case 62: 10.0.0.1 (private Class A) → true', () => {
        expect(validateIPAddress('10.0.0.1')).toBe(true);
      });

      it('Case 63: 127.0.0.1 (loopback) → true', () => {
        expect(validateIPAddress('127.0.0.1')).toBe(true);
      });

      it('Case 64: 1.1.1.1 (Cloudflare DNS) → true', () => {
        expect(validateIPAddress('1.1.1.1')).toBe(true);
      });
    });

    // ── 2B: Invalid IPv4 addresses ───────────────────────────────────────────

    describe('Invalid IPv4 addresses', () => {

      it('Case 65: 256.1.1.1 (octet > 255) → false', () => {
        expect(validateIPAddress('256.1.1.1')).toBe(false);
      });

      it('Case 66: 1.1.1 (only 3 octets) → false', () => {
        expect(validateIPAddress('1.1.1')).toBe(false);
      });

      it('Case 67: 1.1.1.1.1 (5 octets) → false', () => {
        expect(validateIPAddress('1.1.1.1.1')).toBe(false);
      });

      it('Case 68: -1.0.0.0 (negative) → false', () => {
        expect(validateIPAddress('-1.0.0.0')).toBe(false);
      });

      it('Case 69: 1.1.1.a (letter in octet) → false', () => {
        expect(validateIPAddress('1.1.1.a')).toBe(false);
      });

      it('Case 70: Empty string → false', () => {
        expect(validateIPAddress('')).toBe(false);
      });

      it('Case 71: "not-an-ip" → false', () => {
        expect(validateIPAddress('not-an-ip')).toBe(false);
      });

      it('Case 72: Trailing space "1.1.1.1 " → false', () => {
        expect(validateIPAddress('1.1.1.1 ')).toBe(false);
      });

      it('Case 73: 300.300.300.300 (all octets > 255) → false', () => {
        expect(validateIPAddress('300.300.300.300')).toBe(false);
      });
    });

    // ── 2C: Valid IPv6 addresses ─────────────────────────────────────────────

    describe('Valid IPv6 addresses', () => {

      it('Case 74: ::1 (loopback) → true', () => {
        expect(validateIPAddress('::1')).toBe(true);
      });

      it('Case 75: 2001:db8::1 (documentation prefix) → true', () => {
        expect(validateIPAddress('2001:db8::1')).toBe(true);
      });

      it('Case 76: fe80::1 (link-local) → true', () => {
        expect(validateIPAddress('fe80::1')).toBe(true);
      });

      it('Case 77: :: (all zeros shorthand) → true', () => {
        expect(validateIPAddress('::')).toBe(true);
      });

      it('Case 78: Full IPv6 address → true', () => {
        expect(validateIPAddress('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
      });
    });

    // ── 2D: Invalid IPv6 addresses ───────────────────────────────────────────

    describe('Invalid IPv6 addresses', () => {

      it('Case 79: "::::" (only colons, multiple ::) → false', () => {
        // '::::' contains '::' twice → rejected by double-colon check
        expect(validateIPAddress('::::')).toBe(false);
      });

      it('Case 80: "xyz::1" (non-hex chars) → false', () => {
        expect(validateIPAddress('xyz::1')).toBe(false);
      });

      it('Case 81: "::g" (non-hex char g) → false', () => {
        expect(validateIPAddress('::g')).toBe(false);
      });

      it('Case 82: "1::2::3" (multiple :: groups) → false', () => {
        expect(validateIPAddress('1::2::3')).toBe(false);
      });

      it('Case 83: Empty string for IPv6 → false', () => {
        expect(validateIPAddress('')).toBe(false);
      });

      it('Case 84: Very long string (100 chars, exceeds 39-char limit) → false', () => {
        const longStr = '2001:' + '0db8:'.repeat(19);
        expect(longStr.length).toBeGreaterThan(39);
        expect(validateIPAddress(longStr)).toBe(false);
      });

      it('Case 85: Single colon ":" → false (length < 2)', () => {
        expect(validateIPAddress(':')).toBe(false);
      });

      it('Case 86: IPv6 group with 5 hex digits "12345::1" → false', () => {
        expect(validateIPAddress('12345::1')).toBe(false);
      });
    });

    // ── 2E: Injection attempts ───────────────────────────────────────────────

    describe('Injection / malicious input', () => {

      it('Case 87: Command injection "127.0.0.1; rm -rf /" → false', () => {
        expect(validateIPAddress('127.0.0.1; rm -rf /')).toBe(false);
      });

      it('Case 88: HTTP header injection "192.168.1.1\\nHost: evil.com" → false', () => {
        expect(validateIPAddress('192.168.1.1\nHost: evil.com')).toBe(false);
      });

      it('Case 89: XSS injection "<script>alert(1)</script>" → false', () => {
        expect(validateIPAddress('<script>alert(1)</script>')).toBe(false);
      });

      it('Case 90: SQL injection "1.1.1.1\' OR 1=1 --" → false', () => {
        expect(validateIPAddress("1.1.1.1' OR 1=1 --")).toBe(false);
      });

      it('Case 91: Path traversal "127.0.0.1/../../../etc/passwd" → false', () => {
        expect(validateIPAddress('127.0.0.1/../../../etc/passwd')).toBe(false);
      });

      it('Case 92: Null byte injection "127.0.0.1\\0malicious" → false', () => {
        expect(validateIPAddress('127.0.0.1\0malicious')).toBe(false);
      });
    });
  });
});
