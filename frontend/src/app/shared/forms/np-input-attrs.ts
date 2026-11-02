import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/** Native input hints NexPrime does not forward to its inner control. */
const FORWARDED = ['autocomplete', 'inputmode', 'autocapitalize', 'enterkeyhint'] as const;

/**
 * Copies `autocomplete` / `inputmode` / ... from an `<np-text-input>` host to
 * its inner `<input>`, so password managers and mobile keyboards still work:
 *
 *   <np-text-input type="email" autocomplete="email" inputmode="email" ... />
 */
@Directive({
  selector:
    'np-text-input[autocomplete], np-text-input[inputmode], np-text-input[autocapitalize], np-text-input[enterkeyhint]',
})
export class NpInputAttrs {
  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      const control = host.querySelector('input');
      if (!control) return;
      for (const name of FORWARDED) {
        const value = host.getAttribute(name);
        if (value !== null) control.setAttribute(name, value);
      }
    });
  }
}
