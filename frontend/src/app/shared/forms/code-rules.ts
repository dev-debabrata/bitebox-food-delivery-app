import { SchemaPath, required, validate } from '@angular/forms/signals';

/** A 6-digit SMS code. */
export function codeRules(path: SchemaPath<string>): void {
  required(path, { message: 'Enter the 6-digit code' });
  validate(path, ({ value }) =>
    value() && !/^\d{6}$/.test(value())
      ? { kind: 'code', message: 'Enter the 6-digit code' }
      : undefined,
  );
}
