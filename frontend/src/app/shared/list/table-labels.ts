import { DestroyRef, Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/**
 * Copies each column heading onto its body cells as `data-label`, so on phones the
 * global `.bb-table` rules can show every row as a card ("Coins  50") instead of a
 * squeezed, sideways-scrolling table. Rows added later (paging, filters) are labelled
 * too. Cells that already carry a `data-label`, or span several columns, are left alone.
 */
@Directive({ selector: 'table.bb-table' })
export class TableLabels {
  constructor() {
    const table = inject<ElementRef<HTMLTableElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);

    afterNextRender(() => {
      const label = () => {
        const headings = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
        for (const row of Array.from(table.tBodies).flatMap((b) => [...b.rows])) {
          [...row.cells].forEach((cell, i) => {
            if (cell.colSpan === 1 && !cell.hasAttribute('data-label')) {
              cell.setAttribute('data-label', headings[i] ?? '');
            }
          });
        }
      };
      label();
      const observer = new MutationObserver(label);
      observer.observe(table, { childList: true, subtree: true });
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
