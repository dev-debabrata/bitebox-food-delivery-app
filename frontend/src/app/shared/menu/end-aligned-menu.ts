import type { MenuComponent } from 'nexprime';

/** np-menu's default panel width (NexPrime: `.menu { width: 240px }`). */
const PANEL_WIDTH = 240;
/** Width of a menu with the global `bb-menu-compact` class (styles.scss), for short item lists. */
export const COMPACT_MENU_WIDTH = 160;

/**
 * Opens or closes a popup `np-menu` with its right edge under the trigger's right edge, the usual
 * place for a row's "⋮" actions. NexPrime always opens popups from the trigger's left edge, which
 * pushes the panel past the end of the row; it has no alignment option. The menu still keeps itself
 * inside the viewport and still treats clicks on the trigger as its own.
 *
 *   <np-button ... (clicked)="toggleEndAligned(menu, $event)" />
 *   <np-menu #menu [popup]="true" [model]="items" />
 *
 * Pass `width` when the panel isn't the default 240px (e.g. COMPACT_MENU_WIDTH).
 */
export function toggleEndAligned(menu: MenuComponent, event: Event, width = PANEL_WIDTH): void {
  const trigger = event.currentTarget;
  if (!(trigger instanceof Element)) {
    menu.toggle(event);
    return;
  }
  const anchor = {
    contains: (node: Node | null) => trigger.contains(node),
    getBoundingClientRect: () => {
      const r = trigger.getBoundingClientRect();
      return new DOMRect(r.right - width, r.top, width, r.height);
    },
  };
  menu.toggle({ currentTarget: anchor } as unknown as Event);
}
