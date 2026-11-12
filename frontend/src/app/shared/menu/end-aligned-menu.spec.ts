import { describe, expect, it, vi } from 'vitest';
import type { MenuComponent } from 'nexprime';
import { toggleEndAligned } from './end-aligned-menu';

describe('toggleEndAligned', () => {
  function setup() {
    const trigger = document.createElement('button');
    const inner = document.createElement('span');
    trigger.append(inner);
    trigger.getBoundingClientRect = () => new DOMRect(1000, 300, 40, 40); // right edge at 1040
    const toggle = vi.fn();
    return { trigger, inner, toggle, menu: { toggle } as unknown as MenuComponent };
  }

  it('anchors the panel so its right edge lines up with the trigger', () => {
    const { trigger, toggle, menu } = setup();
    toggleEndAligned(menu, { currentTarget: trigger } as unknown as Event);
    const anchor = toggle.mock.calls[0][0].currentTarget;
    const rect: DOMRect = anchor.getBoundingClientRect();
    expect(rect.right).toBe(1040);
    expect(rect.width).toBe(240);
    expect(rect.top).toBe(300);
  });

  it('still counts clicks on the trigger as the menu own clicks (so they do not close it twice)', () => {
    const { trigger, inner, toggle, menu } = setup();
    toggleEndAligned(menu, { currentTarget: trigger } as unknown as Event);
    const anchor = toggle.mock.calls[0][0].currentTarget;
    expect(anchor.contains(inner)).toBe(true);
    expect(anchor.contains(document.body)).toBe(false);
  });

  it('uses the given panel width (compact menus)', () => {
    const { trigger, toggle, menu } = setup();
    toggleEndAligned(menu, { currentTarget: trigger } as unknown as Event, 160);
    const rect: DOMRect = toggle.mock.calls[0][0].currentTarget.getBoundingClientRect();
    expect([rect.left, rect.right]).toEqual([880, 1040]);
  });

  it('falls back to the default placement without an element target', () => {
    const { toggle, menu } = setup();
    const event = { currentTarget: null } as unknown as Event;
    toggleEndAligned(menu, event);
    expect(toggle).toHaveBeenCalledWith(event);
  });
});
