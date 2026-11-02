import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FieldTree, SchemaFn, form } from '@angular/forms/signals';
import { serverErrors, shownError } from './form-errors';
import { emailRules, matchesField, numberRange, passwordRules, phoneRules, requiredText } from './form-rules';

/** Builds a signal form outside a component (forms need an injection context). */
function build<T>(initial: T, schema?: SchemaFn<T>) {
  const value = signal(initial);
  const tree = TestBed.runInInjectionContext(() => (schema ? form(value, schema) : form(value)));
  return { value, form: tree };
}

const messages = (field: FieldTree<unknown>) => field().errors().map((e) => e.message);

describe('form rules', () => {
  it('requiredText checks presence and length', () => {
    const { value, form: f } = build({ name: '' }, (p) => requiredText(p.name, 'Name', { min: 2, max: 5 }));
    expect(messages(f.name)).toEqual(['Name is required']);
    value.set({ name: 'A' });
    expect(messages(f.name)).toEqual(['Name must be at least 2 characters']);
    value.set({ name: 'Too long' });
    expect(messages(f.name)).toEqual(['Name must be at most 5 characters']);
    value.set({ name: 'Asha' });
    expect(f.name().valid()).toBe(true);
  });

  it('emailRules and optional phoneRules', () => {
    const { value, form: f } = build({ email: 'nope', phone: '' }, (p) => {
      emailRules(p.email);
      phoneRules(p.phone, { optional: true });
    });
    expect(messages(f.email)).toContain('Enter a valid email address');
    expect(f.phone().valid()).toBe(true); // optional and empty
    value.set({ email: 'a@b.co', phone: '12' });
    expect(f.email().valid()).toBe(true);
    expect(messages(f.phone)).toEqual(['Enter a valid phone number (10-15 digits)']);
  });

  it('passwordRules needs 8+ characters with a letter and a number', () => {
    const { value, form: f } = build({ password: 'abcdefgh' }, (p) => passwordRules(p.password));
    expect(messages(f.password)).toEqual(['Include at least one number']);
    value.set({ password: 'abc123' });
    expect(messages(f.password)).toContain('Password must be at least 8 characters');
    value.set({ password: 'Secret123' });
    expect(f.password().valid()).toBe(true);
  });

  it('matchesField compares with the other field', () => {
    const { value, form: f } = build({ password: 'Secret123', confirm: 'Secret124' }, (p) => matchesField(p.confirm, p.password));
    expect(messages(f.confirm)).toEqual(['Passwords do not match']);
    value.set({ password: 'Secret123', confirm: 'Secret123' });
    expect(f.confirm().valid()).toBe(true);
  });

  it('numberRange treats null as missing unless optional', () => {
    const { value, form: f } = build({ a: null as number | null, b: null as number | null }, (p) => {
      numberRange(p.a, 'Price', 1, 10);
      numberRange(p.b, 'Limit', 1, 10, { optional: true });
    });
    expect(messages(f.a)).toEqual(['Price is required']);
    expect(f.b().valid()).toBe(true);
    value.set({ a: 11, b: 0 });
    expect(messages(f.a)).toEqual(['Price must be at most 10']);
    expect(messages(f.b)).toEqual(['Limit must be at least 1']);
  });
});

describe('form errors', () => {
  it('shownError waits until the field is touched', () => {
    const { form: f } = build({ name: '' }, (p) => requiredText(p.name, 'Name'));
    expect(shownError(f.name)).toBe('');
    f.name().markAsTouched();
    expect(shownError(f.name)).toBe('Name is required');
  });

  it('serverErrors maps dotted API fields onto the form and ignores unknown ones', () => {
    const { form: f } = build({ address: { city: '' }, name: '' });
    const result = serverErrors(f, [
      { field: 'address.city', message: 'Unknown city' },
      { field: 'nope', message: 'ignored' },
    ]);
    expect(Array.isArray(result) && result.map((e) => e.message)).toEqual(['Unknown city']);
    expect(Array.isArray(result) && result[0].fieldTree).toBe(f.address.city);
  });
});
