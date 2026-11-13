import { WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { KycService } from '../../../../core/services/kyc.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { KycSummary } from '../../../models/kyc.models';
import { KycDocuments } from './kyc-documents';

const summary: KycSummary = {
  documents: [
    {
      id: 'd1',
      kind: 'pan_card',
      label: 'PAN card',
      numberLast4: '234F',
      contentType: 'application/pdf',
      size: 100,
      status: 'rejected',
      reviewNote: 'The PAN is blurred',
      uploadedAt: '2026-11-13T10:00:00Z',
      reviewedAt: '2026-11-13T11:00:00Z',
    },
  ],
  allowedKinds: [],
  checklist: [
    { kind: 'fssai_licence', label: 'FSSAI licence', status: null },
    { kind: 'pan_card', label: 'PAN card', status: 'rejected' },
  ],
  payoutAccount: null,
  complete: false,
};

describe('KycDocuments', () => {
  let fixture: ComponentFixture<KycDocuments>;
  let upload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    upload = vi.fn(() => of(summary.documents[0]));
    await TestBed.configureTestingModule({
      imports: [KycDocuments],
      providers: [
        { provide: KycService, useValue: { upload, open: vi.fn(() => Promise.resolve()) } },
        { provide: NotificationService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(KycDocuments);
    fixture.componentRef.setInput('summary', summary);
    await fixture.whenStable();
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const component = () =>
    fixture.componentInstance as unknown as {
      edit(kind: string): void;
      pick(event: Event): void;
      model: WritableSignal<{ number: string }>;
    };

  it('lists what is needed, with the reviewer note on rejected documents', () => {
    const text = el().textContent ?? '';
    expect(text).toContain('FSSAI licence');
    expect(text).toContain('Not uploaded yet');
    expect(text).toContain('ending 234F');
    expect(text).toContain('The PAN is blurred');
    expect(text).toContain('Needs a new upload');
  });

  it('uploads the chosen file with its number, then asks the parent to reload', async () => {
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    component().edit('fssai_licence');
    await fixture.whenStable();
    el().querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(upload).not.toHaveBeenCalled(); // no file yet
    expect(el().textContent).toContain('Choose a PDF or a photo');

    const file = new File(['%PDF-1.4'], 'fssai.pdf', { type: 'application/pdf' });
    component().pick({ target: { files: [file] } } as unknown as Event); // as the file input does
    component().model.set({ number: '12345678901234' });
    el().querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(upload).toHaveBeenCalledWith('fssai_licence', file, '12345678901234');
    expect(changed).toHaveBeenCalled();
  });
});
