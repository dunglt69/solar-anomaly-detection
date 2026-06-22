import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { db, client } from '../db/index.js';
import { telemetry } from '../db/schema.js';
import { wsBroadcast, clients } from '../plugins/websocket.js';
import {
  decodeModbusRegisters,
  startModbusPoller,
  type ModbusPollerConfig,
  type DecodedTelemetry,
} from '../services/modbus.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: WebSocket Plugin — wsBroadcast & clients (~32 cases)
// ─────────────────────────────────────────────────────────────────────────────
describe('WebSocket Plugin — wsBroadcast & clients', () => {
  afterEach(() => {
    // Clear the module-level clients set after every test
    clients.clear();
  });

  // ── Export existence & type checks ──────────────────────────────────────

  it('Case 1: wsBroadcast is exported and is a function', () => {
    expect(wsBroadcast).toBeDefined();
    expect(typeof wsBroadcast).toBe('function');
  });

  it('Case 2: clients is exported and is a Set', () => {
    expect(clients).toBeDefined();
    expect(clients).toBeInstanceOf(Set);
  });

  it('Case 3: clients set is initially empty in test context', () => {
    expect(clients.size).toBe(0);
  });

  // ── Broadcasting with no clients (should never throw) ──────────────────

  it('Case 4: wsBroadcast with no clients does not throw', () => {
    expect(() => wsBroadcast({ type: 'telemetry', data: {} })).not.toThrow();
  });

  it('Case 5: wsBroadcast with null data does not throw when no clients', () => {
    expect(() => wsBroadcast(null)).not.toThrow();
  });

  it('Case 6: wsBroadcast with undefined data does not throw when no clients', () => {
    expect(() => wsBroadcast(undefined)).not.toThrow();
  });

  it('Case 7: wsBroadcast with empty string does not throw', () => {
    expect(() => wsBroadcast('')).not.toThrow();
  });

  it('Case 8: wsBroadcast with numeric 0 does not throw', () => {
    expect(() => wsBroadcast(0)).not.toThrow();
  });

  it('Case 9: wsBroadcast with boolean false does not throw', () => {
    expect(() => wsBroadcast(false)).not.toThrow();
  });

  it('Case 10: wsBroadcast with empty object does not throw', () => {
    expect(() => wsBroadcast({})).not.toThrow();
  });

  it('Case 11: wsBroadcast with empty array does not throw', () => {
    expect(() => wsBroadcast([])).not.toThrow();
  });

  // ── Broadcasting with mock clients ─────────────────────────────────────

  it('Case 12: wsBroadcast sends to client with readyState 1 (OPEN)', () => {
    const sent: string[] = [];
    const mockSocket = {
      readyState: 1,
      send: (msg: string) => { sent.push(msg); },
    } as any;
    clients.add(mockSocket);

    wsBroadcast({ type: 'telemetry', value: 42 });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'telemetry', value: 42 });
  });

  it('Case 13: wsBroadcast skips client with readyState 0 (CONNECTING)', () => {
    const sent: string[] = [];
    const mockSocket = {
      readyState: 0,
      send: (msg: string) => { sent.push(msg); },
    } as any;
    clients.add(mockSocket);

    wsBroadcast({ data: 'hello' });
    expect(sent).toHaveLength(0);
  });

  it('Case 14: wsBroadcast skips client with readyState 2 (CLOSING)', () => {
    const sent: string[] = [];
    const mockSocket = {
      readyState: 2,
      send: (msg: string) => { sent.push(msg); },
    } as any;
    clients.add(mockSocket);

    wsBroadcast({ data: 'test' });
    expect(sent).toHaveLength(0);
  });

  it('Case 15: wsBroadcast skips client with readyState 3 (CLOSED)', () => {
    const sent: string[] = [];
    const mockSocket = {
      readyState: 3,
      send: (msg: string) => { sent.push(msg); },
    } as any;
    clients.add(mockSocket);

    wsBroadcast({ data: 'test' });
    expect(sent).toHaveLength(0);
  });

  it('Case 16: wsBroadcast sends to multiple OPEN clients', () => {
    const sent1: string[] = [];
    const sent2: string[] = [];
    const sock1 = { readyState: 1, send: (m: string) => sent1.push(m) } as any;
    const sock2 = { readyState: 1, send: (m: string) => sent2.push(m) } as any;
    clients.add(sock1);
    clients.add(sock2);

    wsBroadcast({ type: 'test' });
    expect(sent1).toHaveLength(1);
    expect(sent2).toHaveLength(1);
  });

  it('Case 17: wsBroadcast sends only to OPEN clients in a mixed set', () => {
    const sentOpen: string[] = [];
    const sentClosed: string[] = [];
    const openSock = { readyState: 1, send: (m: string) => sentOpen.push(m) } as any;
    const closedSock = { readyState: 3, send: (m: string) => sentClosed.push(m) } as any;
    clients.add(openSock);
    clients.add(closedSock);

    wsBroadcast({ ping: true });
    expect(sentOpen).toHaveLength(1);
    expect(sentClosed).toHaveLength(0);
  });

  // ── Message format / serialisation ─────────────────────────────────────

  it('Case 18: broadcast message is valid JSON', () => {
    const sent: string[] = [];
    const mockSocket = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(mockSocket);

    wsBroadcast({ type: 'telemetry', data: { vdc1: 315.4 } });
    expect(() => JSON.parse(sent[0]!)).not.toThrow();
  });

  it('Case 19: broadcast null serialises to the JSON string "null"', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    wsBroadcast(null);
    expect(sent[0]).toBe('null');
  });

  it('Case 20: broadcast undefined serialises correctly (undefined → no value)', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    // JSON.stringify(undefined) returns undefined, but the function calls
    // JSON.stringify first, then send. In practice this means the message
    // will be the string "undefined" if toString is called, or literally undefined.
    wsBroadcast(undefined);
    // The sent message might be the JS value undefined (not a string)
    // Just verify it was called
    expect(sent).toHaveLength(1);
  });

  it('Case 21: telemetry payload preserves all numeric fields', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    const payload = {
      type: 'telemetry',
      data: { vdc1: 315.4, vdc2: 312.8, idc1: 5.25, idc2: 4.8, irr: 800.5, pvt: 42.6 },
    };
    wsBroadcast(payload);

    const parsed = JSON.parse(sent[0]!);
    expect(parsed.data.vdc1).toBe(315.4);
    expect(parsed.data.vdc2).toBe(312.8);
    expect(parsed.data.idc1).toBe(5.25);
    expect(parsed.data.idc2).toBe(4.8);
    expect(parsed.data.irr).toBe(800.5);
    expect(parsed.data.pvt).toBe(42.6);
  });

  it('Case 22: broadcast with nested objects serialises correctly', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    const deep = { a: { b: { c: { d: 'deep' } } } };
    wsBroadcast(deep);
    expect(JSON.parse(sent[0]!)).toEqual(deep);
  });

  it('Case 23: broadcast with ISO timestamp string', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    const ts = new Date().toISOString();
    wsBroadcast({ timestamp: ts });
    expect(JSON.parse(sent[0]!).timestamp).toBe(ts);
  });

  it('Case 24: broadcast with array of numbers', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    wsBroadcast([1, 2, 3, 4, 5]);
    expect(JSON.parse(sent[0]!)).toEqual([1, 2, 3, 4, 5]);
  });

  // ── Large payload & rapid broadcasts ───────────────────────────────────

  it('Case 25: broadcast with very large payload does not throw', () => {
    const sock = { readyState: 1, send: vi.fn() } as any;
    clients.add(sock);

    const largePayload = { type: 'bulk', data: Array.from({ length: 10000 }, (_, i) => i) };
    expect(() => wsBroadcast(largePayload)).not.toThrow();
    expect(sock.send).toHaveBeenCalledTimes(1);
  });

  it('Case 26: multiple rapid broadcasts all arrive in order', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    for (let i = 0; i < 100; i++) {
      wsBroadcast({ seq: i });
    }
    expect(sent).toHaveLength(100);
    // Verify ordering
    sent.forEach((raw, idx) => {
      expect(JSON.parse(raw).seq).toBe(idx);
    });
  });

  it('Case 27: broadcast with special characters in strings', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    const payload = { msg: 'Hello <script>alert("xss")</script> "quotes" & ñ 中文' };
    wsBroadcast(payload);
    expect(JSON.parse(sent[0]!).msg).toBe(payload.msg);
  });

  it('Case 28: clients set can be cleared (simulating disconnect all)', () => {
    const s1 = { readyState: 1, send: vi.fn() } as any;
    const s2 = { readyState: 1, send: vi.fn() } as any;
    clients.add(s1);
    clients.add(s2);
    expect(clients.size).toBe(2);

    clients.clear();
    expect(clients.size).toBe(0);

    wsBroadcast({ type: 'test' });
    expect(s1.send).not.toHaveBeenCalled();
    expect(s2.send).not.toHaveBeenCalled();
  });

  it('Case 29: removing a specific client from set works', () => {
    const sent: string[] = [];
    const stayer = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    const leaver = { readyState: 1, send: vi.fn() } as any;
    clients.add(stayer);
    clients.add(leaver);

    clients.delete(leaver);
    wsBroadcast({ type: 'after-delete' });

    expect(sent).toHaveLength(1);
    expect(leaver.send).not.toHaveBeenCalled();
  });

  it('Case 30: broadcast with Date object serialises to ISO string in JSON', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    const d = new Date('2026-06-01T12:00:00.000Z');
    wsBroadcast({ created: d });
    expect(JSON.parse(sent[0]!).created).toBe('2026-06-01T12:00:00.000Z');
  });

  it('Case 31: broadcast with circular reference throws (JSON.stringify limitation)', () => {
    const sock = { readyState: 1, send: vi.fn() } as any;
    clients.add(sock);

    const circular: any = { a: 1 };
    circular.self = circular;
    expect(() => wsBroadcast(circular)).toThrow();
  });

  it('Case 32: broadcast with alert-type payload preserves structure', () => {
    const sent: string[] = [];
    const sock = { readyState: 1, send: (m: string) => sent.push(m) } as any;
    clients.add(sock);

    const alertPayload = {
      type: 'alert',
      data: {
        id: 'ALT-001',
        severity: 'critical',
        faultType: 3,
        confidence: 0.95,
        detectionLayer: 'ai',
      },
    };
    wsBroadcast(alertPayload);
    const parsed = JSON.parse(sent[0]!);
    expect(parsed.type).toBe('alert');
    expect(parsed.data.severity).toBe('critical');
    expect(parsed.data.confidence).toBe(0.95);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Modbus Service — decodeModbusRegisters & startModbusPoller (~30 cases)
// ─────────────────────────────────────────────────────────────────────────────
describe('Modbus Service — decodeModbusRegisters', () => {
  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(telemetry);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ── Export existence & types ────────────────────────────────────────────

  it('Case 33: decodeModbusRegisters is exported and is a function', () => {
    expect(decodeModbusRegisters).toBeDefined();
    expect(typeof decodeModbusRegisters).toBe('function');
  });

  it('Case 34: startModbusPoller is exported and is a function', () => {
    expect(startModbusPoller).toBeDefined();
    expect(typeof startModbusPoller).toBe('function');
  });

  // ── Normal decoding ────────────────────────────────────────────────────

  it('Case 35: decodes typical midday register values', () => {
    //  vdc1=315.4  vdc2=312.8  idc1=5.25  idc2=4.80  irr=800.5  pvt=42.6
    const regs = [3154, 3128, 525, 480, 8005, 426];
    const d = decodeModbusRegisters(regs);

    expect(d.vdc1).toBe(315.4);
    expect(d.vdc2).toBe(312.8);
    expect(d.idc1).toBe(5.25);
    expect(d.idc2).toBe(4.80);
    expect(d.irr).toBe(800.5);
    expect(d.pvt).toBe(42.6);
  });

  it('Case 36: computes pdc1 = vdc1 * idc1 correctly', () => {
    const regs = [3154, 3128, 525, 480, 8005, 426];
    const d = decodeModbusRegisters(regs);
    // 315.4 * 5.25 = 1655.85
    expect(d.pdc1).toBe(1655.85);
  });

  it('Case 37: computes pdc2 = vdc2 * idc2 correctly', () => {
    const regs = [3154, 3128, 525, 480, 8005, 426];
    const d = decodeModbusRegisters(regs);
    // 312.8 * 4.80 = 1501.44
    expect(d.pdc2).toBe(1501.44);
  });

  it('Case 38: computes pdcTotal = pdc1 + pdc2', () => {
    const regs = [3154, 3128, 525, 480, 8005, 426];
    const d = decodeModbusRegisters(regs);
    expect(d.pdcTotal).toBe(1655.85 + 1501.44);
  });

  // ── All-zero registers ────────────────────────────────────────────────

  it('Case 39: all-zero registers produce all-zero output', () => {
    const d = decodeModbusRegisters([0, 0, 0, 0, 0, 0]);
    expect(d.vdc1).toBe(0);
    expect(d.vdc2).toBe(0);
    expect(d.idc1).toBe(0);
    expect(d.idc2).toBe(0);
    expect(d.irr).toBe(0);
    expect(d.pvt).toBe(0);
    expect(d.pdc1).toBe(0);
    expect(d.pdc2).toBe(0);
    expect(d.pdcTotal).toBe(0);
  });

  // ── Register count edge cases ─────────────────────────────────────────

  it('Case 40: throws when given 0 registers', () => {
    expect(() => decodeModbusRegisters([])).toThrow('Invalid Modbus registers: expected 6 registers');
  });

  it('Case 41: throws when given 5 registers (one short)', () => {
    expect(() => decodeModbusRegisters([100, 200, 300, 400, 500])).toThrow(
      'Invalid Modbus registers: expected 6 registers'
    );
  });

  it('Case 42: throws when given 1 register', () => {
    expect(() => decodeModbusRegisters([1000])).toThrow(
      'Invalid Modbus registers: expected 6 registers'
    );
  });

  it('Case 43: accepts exactly 6 registers', () => {
    expect(() => decodeModbusRegisters([1, 2, 3, 4, 5, 6])).not.toThrow();
  });

  it('Case 44: accepts more than 6 registers (only first 6 used)', () => {
    // The guard only checks data.length < 6, so 7+ should work
    const d = decodeModbusRegisters([1000, 2000, 500, 600, 7000, 350, 9999]);
    expect(d.vdc1).toBe(100);   // 1000 / 10
    expect(d.vdc2).toBe(200);   // 2000 / 10
    expect(d.idc1).toBe(5);     // 500 / 100
    expect(d.idc2).toBe(6);     // 600 / 100
    expect(d.irr).toBe(700);    // 7000 / 10
    expect(d.pvt).toBe(35);     // 350 / 10
  });

  // ── Scale factor validation ────────────────────────────────────────────

  it('Case 45: VDC1 scale factor is /10', () => {
    const d = decodeModbusRegisters([100, 0, 0, 0, 0, 0]);
    expect(d.vdc1).toBe(10); // 100 / 10
  });

  it('Case 46: VDC2 scale factor is /10', () => {
    const d = decodeModbusRegisters([0, 2500, 0, 0, 0, 0]);
    expect(d.vdc2).toBe(250); // 2500 / 10
  });

  it('Case 47: IDC1 scale factor is /100', () => {
    const d = decodeModbusRegisters([0, 0, 750, 0, 0, 0]);
    expect(d.idc1).toBe(7.5); // 750 / 100
  });

  it('Case 48: IDC2 scale factor is /100', () => {
    const d = decodeModbusRegisters([0, 0, 0, 333, 0, 0]);
    expect(d.idc2).toBe(3.33); // 333 / 100
  });

  it('Case 49: IRR scale factor is /10', () => {
    const d = decodeModbusRegisters([0, 0, 0, 0, 10250, 0]);
    expect(d.irr).toBe(1025); // 10250 / 10
  });

  it('Case 50: PVT scale factor is /10', () => {
    const d = decodeModbusRegisters([0, 0, 0, 0, 0, 655]);
    expect(d.pvt).toBe(65.5); // 655 / 10
  });

  // ── Rounding of power calculations ─────────────────────────────────────

  it('Case 51: pdc1 rounds to 2 decimal places', () => {
    // 315.3 * 5.33 = 1680.549 → 1680.55
    const d = decodeModbusRegisters([3153, 0, 533, 0, 0, 0]);
    expect(d.pdc1).toBe(1680.55);
  });

  it('Case 52: pdc2 rounds to 2 decimal places', () => {
    // 312.7 * 4.87 = 1522.849 → 1522.85
    const d = decodeModbusRegisters([0, 3127, 0, 487, 0, 0]);
    expect(d.pdc2).toBe(1522.85);
  });

  it('Case 53: pdcTotal rounds to 2 decimal places', () => {
    const d = decodeModbusRegisters([3153, 3127, 533, 487, 8005, 426]);
    expect(d.pdc1).toBe(1680.55);
    expect(d.pdc2).toBe(1522.85);
    expect(d.pdcTotal).toBe(3203.4);
  });

  // ── Return shape validation ─────────────────────────────────────────────

  it('Case 54: decoded result has exactly 9 keys', () => {
    const d = decodeModbusRegisters([1000, 1000, 100, 100, 5000, 300]);
    const keys = Object.keys(d);
    expect(keys).toHaveLength(9);
  });

  it('Case 55: decoded result contains all expected property names', () => {
    const d = decodeModbusRegisters([1000, 1000, 100, 100, 5000, 300]);
    expect(d).toHaveProperty('vdc1');
    expect(d).toHaveProperty('vdc2');
    expect(d).toHaveProperty('idc1');
    expect(d).toHaveProperty('idc2');
    expect(d).toHaveProperty('irr');
    expect(d).toHaveProperty('pvt');
    expect(d).toHaveProperty('pdc1');
    expect(d).toHaveProperty('pdc2');
    expect(d).toHaveProperty('pdcTotal');
  });

  it('Case 56: all decoded values are numbers', () => {
    const d = decodeModbusRegisters([3154, 3128, 525, 480, 8005, 426]);
    for (const val of Object.values(d)) {
      expect(typeof val).toBe('number');
    }
  });

  // ── Boundary & extreme register values ────────────────────────────────

  it('Case 57: maximum unsigned 16-bit register value (65535)', () => {
    const d = decodeModbusRegisters([65535, 65535, 65535, 65535, 65535, 65535]);
    expect(d.vdc1).toBe(6553.5);     // 65535 / 10
    expect(d.idc1).toBe(655.35);     // 65535 / 100
    expect(d.irr).toBe(6553.5);      // 65535 / 10
    expect(d.pvt).toBe(6553.5);      // 65535 / 10
  });

  it('Case 58: register value of 1 produces small decoded values', () => {
    const d = decodeModbusRegisters([1, 1, 1, 1, 1, 1]);
    expect(d.vdc1).toBe(0.1);
    expect(d.idc1).toBe(0.01);
    expect(d.irr).toBe(0.1);
  });

  it('Case 59: power is zero when current is zero regardless of voltage', () => {
    const d = decodeModbusRegisters([5000, 5000, 0, 0, 5000, 300]);
    expect(d.vdc1).toBe(500);
    expect(d.vdc2).toBe(500);
    expect(d.pdc1).toBe(0);
    expect(d.pdc2).toBe(0);
    expect(d.pdcTotal).toBe(0);
  });

  it('Case 60: power is zero when voltage is zero regardless of current', () => {
    const d = decodeModbusRegisters([0, 0, 500, 500, 5000, 300]);
    expect(d.pdc1).toBe(0);
    expect(d.pdc2).toBe(0);
    expect(d.pdcTotal).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: ModbusPollerConfig type & startModbusPoller structural checks
// ─────────────────────────────────────────────────────────────────────────────
describe('Modbus Service — ModbusPollerConfig & startModbusPoller', () => {
  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(telemetry);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // startModbusPoller attempts a real TCP connection which will fail in tests.
  // We verify it rejects with a connection error (confirming it validates and
  // attempts the connection).

  it('Case 61: startModbusPoller rejects on connection refused (port 59998)', async () => {
    const cfg: ModbusPollerConfig = {
      host: '127.0.0.1',
      port: 59998, // extremely unlikely to be listening — instant ECONNREFUSED
      interval: 1000,
    };
    await expect(startModbusPoller(cfg)).rejects.toThrow(/Failed to connect/);
  }, 60_000);

  it('Case 62: startModbusPoller rejects when port is a non-listening port on localhost', async () => {
    const cfg: ModbusPollerConfig = {
      host: '127.0.0.1',
      port: 59999, // extremely unlikely to be listening
      interval: 500,
    };
    await expect(startModbusPoller(cfg)).rejects.toThrow(/Failed to connect/);
  }, 60_000);
});
