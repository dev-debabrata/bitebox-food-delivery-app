import {
  SchemaPath,
  email,
  max,
  maxLength,
  min,
  minLength,
  pattern,
  required,
  validate,
} from '@angular/forms/signals';
import { parsePhoneNumberFromString } from 'libphonenumber-js/mobile';

export const POSTAL_CODE_PATTERN = /^[A-Za-z0-9 -]{3,10}$/;

export const EMAIL_PATTERN = /^[^\s@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export function requiredText(
  path: SchemaPath<string>,
  label: string,
  { min: minLen = 1, max: maxLen }: { min?: number; max?: number } = {},
): void {
  required(path, { message: `${label} is required` });
  if (minLen > 1)
    minLength(path, minLen, { message: `${label} must be at least ${minLen} characters` });
  if (maxLen) maxLength(path, maxLen, { message: `${label} must be at most ${maxLen} characters` });
}

export function emailRules(
  path: SchemaPath<string>,
  { optional = false }: { optional?: boolean } = {},
): void {
  if (!optional) required(path, { message: 'Email is required' });
  email(path, { message: 'Enter a valid email address' });
  pattern(path, EMAIL_PATTERN, { message: 'Enter a valid email address, e.g. name@gmail.com' });
  maxLength(path, 254, { message: 'Email is too long' });
}

export function passwordRules(path: SchemaPath<string>, label = 'Password'): void {
  required(path, { message: `${label} is required` });
  minLength(path, 8, { message: `${label} must be at least 8 characters` });
  pattern(path, /[A-Za-z]/, { message: 'Include at least one letter' });
  pattern(path, /[0-9]/, { message: 'Include at least one number' });
  validate(path, ({ value }) =>
    new TextEncoder().encode(value()).length > 72
      ? { kind: 'tooLong', message: 'Password is too long' }
      : undefined,
  );
}

export function matchesField(
  confirm: SchemaPath<string>,
  other: SchemaPath<string>,
  message = 'Passwords do not match',
): void {
  required(confirm, { message: 'Please confirm your password' });
  validate(confirm, ({ value, valueOf }) =>
    value() && value() !== valueOf(other) ? { kind: 'mismatch', message } : undefined,
  );
}

export function phoneRules(
  path: SchemaPath<string>,
  { optional = false }: { optional?: boolean } = {},
): void {
  if (!optional) required(path, { message: 'Phone number is required' });
  validate(path, ({ value }) =>
    value() && !parsePhoneNumberFromString(value(), 'IN')?.isValid()
      ? { kind: 'phone', message: 'Enter a valid mobile number for the selected country' }
      : undefined,
  );
}

export function numberRange(
  path: SchemaPath<number | null>,
  label: string,
  lo: number,
  hi: number,
  { optional = false }: { optional?: boolean } = {},
): void {
  if (!optional) required(path, { message: `${label} is required` });
  min(path, lo, { message: `${label} must be at least ${lo}` });
  max(path, hi, { message: `${label} must be at most ${hi}` });
}
