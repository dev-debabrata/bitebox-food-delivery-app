import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InstallDialog } from './install-dialog';

describe('InstallDialog', () => {
  let fixture: ComponentFixture<InstallDialog>;
  let component: InstallDialog;
  let mockRef: { close: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockRef = { close: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [InstallDialog],
      providers: [{ provide: MatDialogRef, useValue: mockRef }],
    }).compileComponents();

    fixture = TestBed.createComponent(InstallDialog);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the title and switches tabs between platforms', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Install BiteBox');

    // Switch to iOS
    component.setTab('ios');
    fixture.detectChanges();
    expect(component.activeTab()).toBe('ios');
    expect(el.textContent).toContain('Add to Home Screen');

    // Switch to Android
    component.setTab('android');
    fixture.detectChanges();
    expect(component.activeTab()).toBe('android');
    expect(el.textContent).toContain('Install app');

    // Switch to Desktop
    component.setTab('desktop');
    fixture.detectChanges();
    expect(component.activeTab()).toBe('desktop');
    expect(el.textContent).toContain('Google Chrome');
  });

  it('closes when close() is invoked', () => {
    component.close();
    expect(mockRef.close).toHaveBeenCalledOnce();
  });
});
