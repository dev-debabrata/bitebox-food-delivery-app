import { TestBed } from '@angular/core/testing';
import { PhoneInput } from './phone-input';

describe('PhoneInput', () => {
  const create = (value: string) => {
    const fixture = TestBed.createComponent(PhoneInput);
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
    // Protected state, read for the test.
    const c = fixture.componentInstance as unknown as { country: () => string; national: () => string; setCountry(c: string): void; setNational(t: string): void };
    return { fixture, c };
  };

  it('splits an international number into country and digits', () => {
    const { c } = create('+447911123456');
    expect(c.country()).toBe('GB');
    expect(c.national()).toBe('7911123456');
  });

  it('reads numbers saved without a code as Indian', () => {
    const { c } = create('9876543210');
    expect(c.country()).toBe('IN');
    expect(c.national()).toBe('9876543210');
  });

  it('produces the full international number, or empty when cleared', () => {
    const { fixture, c } = create('');
    c.setNational('98765 43210');
    expect(fixture.componentInstance.value()).toBe('+919876543210');
    c.setCountry('US');
    expect(fixture.componentInstance.value()).toBe('+19876543210');
    c.setNational('');
    expect(fixture.componentInstance.value()).toBe('');
  });

  it('keeps digits only, up to the country\'s mobile length', () => {
    const { fixture, c } = create('');
    c.setNational('97a2354b22422343');
    expect(fixture.componentInstance.value()).toBe('+919723542242'); // India: 10 digits
    c.setCountry('SG');
    expect(fixture.componentInstance.value()).toBe('+6597235422'); // Singapore: 8
    c.setNational('+44 7911 123456');
    expect(c.country()).toBe('GB');
    expect(fixture.componentInstance.value()).toBe('+447911123456');
  });
});
