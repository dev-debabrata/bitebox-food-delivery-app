import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import {
  ChannelPreferences,
  NotificationPreferencesService,
} from '../../../core/services/notification-preferences.service';
import { ChannelSettings } from './channel-settings';

const prefs = (smsOrders = false): ChannelPreferences => ({
  channels: {
    push: { orders: true, account: true, promotions: false },
    email: { orders: true, account: true, promotions: false },
    sms: { orders: smsOrders, account: false, promotions: false },
  },
  categories: ['orders', 'account', 'promotions'],
  available: { push: true, email: true, sms: true },
});

describe('ChannelSettings', () => {
  const update = vi.fn();

  function create(load = of(prefs())) {
    TestBed.configureTestingModule({
      imports: [ChannelSettings],
      providers: [
        provideRouter([]),
        { provide: NotificationPreferencesService, useValue: { get: () => load, update } },
      ],
    });
    const fixture = TestBed.createComponent(ChannelSettings);
    fixture.detectChanges();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fixture.componentInstance as any;
  }

  beforeEach(() => update.mockReset());

  it('saves a switch and keeps the server answer', () => {
    update.mockReturnValue(of(prefs(true)));
    const c = create();
    c.toggle('sms', 'orders', true);
    expect(update).toHaveBeenCalledWith({ sms: { orders: true } });
    expect(c.prefs().channels.sms.orders).toBe(true);
    expect(c.error()).toBeNull();
  });

  it('restores the switch when saving fails', () => {
    update.mockReturnValue(throwError(() => new Error('offline')));
    const c = create();
    c.toggle('sms', 'orders', true);
    expect(c.prefs().channels.sms.orders).toBe(false);
    expect(c.error()).toBeTruthy();
  });

  it('stays hidden when the API has no channel preferences', () => {
    const c = create(throwError(() => new Error('404')));
    expect(c.prefs()).toBeNull();
  });
});
