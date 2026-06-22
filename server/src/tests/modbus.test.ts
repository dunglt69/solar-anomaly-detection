import { describe, it, expect } from 'vitest';
import { decodeModbusRegisters } from '../services/modbus.service.js';

describe('Modbus Service Decoder Unit Tests', () => {
  it('should correctly decode normal register values', () => {
    // Register mapping:
    // 0: vdc1 * 10
    // 1: vdc2 * 10
    // 2: idc1 * 100
    // 3: idc2 * 100
    // 4: irr * 10
    // 5: pvt * 10
    const registers = [
      3154, // VDC1 = 315.4V
      3128, // VDC2 = 312.8V
      525,  // IDC1 = 5.25A
      480,  // IDC2 = 4.80A
      8005, // IRR = 800.5 W/m2
      426,  // PVT = 42.6°C
    ];

    const decoded = decodeModbusRegisters(registers);

    expect(decoded.vdc1).toBe(315.4);
    expect(decoded.vdc2).toBe(312.8);
    expect(decoded.idc1).toBe(5.25);
    expect(decoded.idc2).toBe(4.80);
    expect(decoded.irr).toBe(800.5);
    expect(decoded.pvt).toBe(42.6);

    // DC Power calculations:
    // pdc1 = vdc1 * idc1 = 315.4 * 5.25 = 1655.85
    // pdc2 = vdc2 * idc2 = 312.8 * 4.8 = 1501.44
    // pdcTotal = pdc1 + pdc2 = 3157.29
    expect(decoded.pdc1).toBe(1655.85);
    expect(decoded.pdc2).toBe(1501.44);
    expect(decoded.pdcTotal).toBe(3157.29);
  });

  it('should throw an error if fewer than 6 registers are provided', () => {
    expect(() => decodeModbusRegisters([3154, 3128, 525, 480, 8005])).toThrow('Invalid Modbus registers: expected 6 registers');
  });

  it('should handle zero values correctly', () => {
    const registers = [0, 0, 0, 0, 0, 0];
    const decoded = decodeModbusRegisters(registers);

    expect(decoded.vdc1).toBe(0);
    expect(decoded.vdc2).toBe(0);
    expect(decoded.idc1).toBe(0);
    expect(decoded.idc2).toBe(0);
    expect(decoded.irr).toBe(0);
    expect(decoded.pvt).toBe(0);
    expect(decoded.pdc1).toBe(0);
    expect(decoded.pdc2).toBe(0);
    expect(decoded.pdcTotal).toBe(0);
  });

  it('should round power calculations to 2 decimal places', () => {
    // Registers resulting in recurring decimals
    const registers = [
      3153, // VDC1 = 315.3V
      3127, // VDC2 = 312.7V
      533,  // IDC1 = 5.33A
      487,  // IDC2 = 4.87A
      8005,
      426
    ];

    const decoded = decodeModbusRegisters(registers);

    // pdc1 = 315.3 * 5.33 = 1680.549 -> rounds to 1680.55
    // pdc2 = 312.7 * 4.87 = 1522.849 -> rounds to 1522.85
    // pdcTotal = 1680.55 + 1522.85 = 3203.40
    expect(decoded.pdc1).toBe(1680.55);
    expect(decoded.pdc2).toBe(1522.85);
    expect(decoded.pdcTotal).toBe(3203.4);
  });
});
