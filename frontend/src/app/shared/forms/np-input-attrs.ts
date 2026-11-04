import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

const FORWARDED = ['autocomplete', 'inputmode', 'autocapitalize', 'enterkeyhint'] as const;

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
