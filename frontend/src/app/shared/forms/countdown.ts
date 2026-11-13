import { DestroyRef, inject, signal } from '@angular/core';

/**
 * Seconds left until something may be done again (e.g. "Resend code in 25 s"). Call in an
 * injection context; the timer stops with the component.
 */
export function countdown() {
  const left = signal(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
  return {
    left: left.asReadonly(),
    start(seconds: number): void {
      clearInterval(timer);
      left.set(seconds);
      timer = setInterval(() => {
        left.update((s) => Math.max(0, s - 1));
        if (left() === 0) clearInterval(timer);
      }, 1000);
    },
  };
}
