import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { emailRules } from './form-rules';

describe('emailRules', () => {
  const valid = (value: string, optional = false) =>
    TestBed.runInInjectionContext(() => {
      const f = form(signal({ email: value }), (p) => emailRules(p.email, { optional }));
      return f.email().valid();
    });

  it.each(['name@gmail.com', 'first.last@navsoft.in', 'a+tag@mail.example.co.uk'])('accepts %s', (email) => {
    expect(valid(email)).toBe(true);
  });

  it.each(['dsfdsfsdsdfd@in', 'name@gmail', 'name@gmail.c', 'name@.com', 'no-at-sign.com', 'two words@gmail.com'])(
    'rejects %s',
    (email) => {
      expect(valid(email)).toBe(false);
    },
  );

  it('allows an empty optional email', () => {
    expect(valid('', true)).toBe(true);
    expect(valid('', false)).toBe(false);
  });
});
