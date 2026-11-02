import { formatDistance, formatPaise, rupeesToPaise } from './money.pipes';

describe('money helpers', () => {
  it('formats whole rupees without decimals and fractional rupees with two', () => {
    expect(formatPaise(32900)).toBe('₹329');
    expect(formatPaise(14950)).toBe('₹149.50');
    expect(formatPaise(10000000)).toBe('₹1,00,000');
    expect(formatPaise(undefined)).toBe('');
  });

  it('converts typed rupees to integer paise without floating-point drift', () => {
    expect(rupeesToPaise(19.99)).toBe(1999);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(rupeesToPaise(329)).toBe(32900);
  });

  it('formats straight-line distances', () => {
    expect(formatDistance(842)).toBe('840 m');
    expect(formatDistance(4820)).toBe('4.8 km');
  });
});
