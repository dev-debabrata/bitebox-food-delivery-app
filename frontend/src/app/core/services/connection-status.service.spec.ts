import { TestBed } from '@angular/core/testing';
import { ConnectionStatus } from './connection-status.service';

describe('ConnectionStatus', () => {
  let onLine = true;

  beforeEach(() => {
    vi.useFakeTimers();
    onLine = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const go = (online: boolean) => {
    onLine = online;
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  };

  it('follows the browser and briefly reports a restored connection', () => {
    const status = TestBed.inject(ConnectionStatus);
    expect(status.online()).toBe(true);
    expect(status.restored()).toBe(false);

    go(false);
    expect(status.online()).toBe(false);
    expect(status.restored()).toBe(false);

    go(true);
    expect(status.online()).toBe(true);
    expect(status.restored()).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(status.restored()).toBe(false);
  });

  it('starts offline when the browser already is', () => {
    onLine = false;
    expect(TestBed.inject(ConnectionStatus).online()).toBe(false);
  });
});
