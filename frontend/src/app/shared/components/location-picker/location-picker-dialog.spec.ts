import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { DeliveryLocationService } from '../../../core/services/delivery-location.service';
import { GeolocationService, ImpreciseLocationError } from '../../../core/services/geolocation.service';
import { LocationPickerDialog } from './location-picker-dialog';

type Picker = {
  useGps: () => Promise<void>;
  pick: (p: { latitude: number; longitude: number; label: string }) => void;
  onPinMoved: (p: { latitude: number; longitude: number }) => void;
  confirm: () => void;
};

describe('LocationPickerDialog', () => {
  const geo = { supported: true, currentPrecise: vi.fn() };
  const ref = { close: vi.fn() };
  const location = {
    location: signal(null),
    search: vi.fn(() => of([])),
    reverse: vi.fn(),
    choosePoint: vi.fn(),
    chooseAddress: vi.fn(),
    clear: vi.fn(),
  };

  async function create() {
    await TestBed.configureTestingModule({
      imports: [LocationPickerDialog],
      providers: [
        { provide: GeolocationService, useValue: geo },
        { provide: MatDialogRef, useValue: ref },
        { provide: DeliveryLocationService, useValue: location },
        { provide: AuthService, useValue: { role: () => null } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LocationPickerDialog);
    await fixture.whenStable();
    return fixture.componentInstance as unknown as Picker;
  }

  beforeEach(() => {
    location.choosePoint.mockReset();
    location.reverse.mockReset();
    ref.close.mockReset();
  });

  it('auto-detects and saves the current location in one click', async () => {
    geo.currentPrecise.mockResolvedValue({ latitude: 11.5, longitude: 21.5, accuracy: 15 });
    location.reverse.mockReturnValue(of({ label: 'Sample Area, Sample City', displayName: 'Sample Area, Sample City, Test State', latitude: 11.5, longitude: 21.5 }));
    const picker = await create();

    await picker.useGps();

    expect(location.choosePoint).toHaveBeenCalledWith(expect.objectContaining({ label: 'Sample Area, Sample City', latitude: 11.5, source: 'gps' }));
    expect(ref.close).toHaveBeenCalledWith(true);
  });

  it('never uses a vague browser reading: nothing is saved and search is suggested', async () => {
    geo.currentPrecise.mockRejectedValue(new ImpreciseLocationError(1_400_000));
    const picker = await create();

    await picker.useGps();

    expect(location.choosePoint).not.toHaveBeenCalled();
    expect(ref.close).not.toHaveBeenCalled();
    expect((picker as unknown as { gpsError: () => string }).gpsError()).toContain("couldn't detect your exact location");
  });

  it('lets a searched place be fine-tuned on the map before saving', async () => {
    location.reverse.mockReturnValue(of({ label: 'Demo Street, Sample City', latitude: 12.6, longitude: 22.6 }));
    const picker = await create();
    picker.pick({ latitude: 12.5, longitude: 22.5, label: 'Demo Street' });
    expect(location.choosePoint).not.toHaveBeenCalled();
    picker.onPinMoved({ latitude: 12.6, longitude: 22.6 });
    picker.confirm();
    expect(location.choosePoint).toHaveBeenCalledWith(expect.objectContaining({ label: 'Demo Street, Sample City', latitude: 12.6 }));
  });
});
