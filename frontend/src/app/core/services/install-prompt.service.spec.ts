import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { vi } from 'vitest';
import { InstallPromptService } from './install-prompt.service';
import { InstallDialog } from '../../shared/components/install-dialog/install-dialog';

function promptEvent(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string; platform: string }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome, platform: 'web' });
  return event;
}

describe('InstallPromptService', () => {
  let mockDialog: { open: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    localStorage.clear();
    window.matchMedia = vi
      .fn()
      .mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    mockDialog = { open: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        InstallPromptService,
        { provide: MatDialog, useValue: mockDialog },
      ],
    });
  });

  it('allows installation across all browsers and shows banner by default in browser tab', () => {
    const installer = TestBed.inject(InstallPromptService);
    // Can install in any browser tab when not running standalone
    expect(installer.canInstall()).toBe(true);
    expect(installer.showBanner()).toBe(true);
    expect(installer.hasNativePrompt()).toBe(false);
  });

  it('keeps the browser prompt for the Install button and suppresses the mini-infobar', async () => {
    const installer = TestBed.inject(InstallPromptService);
    expect(installer.canInstall()).toBe(true);

    const event = promptEvent('accepted');
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(installer.hasNativePrompt()).toBe(true);
    expect(installer.canInstall()).toBe(true);
    expect(installer.showBanner()).toBe(true);

    expect(await installer.install()).toBe(true);
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(installer.hasNativePrompt()).toBe(false); // prompt can only be used once
    expect(installer.installed()).toBe(true);
    expect(installer.canInstall()).toBe(false);
  });

  it('opens instructions dialog on browsers without beforeinstallprompt (Safari, Firefox, iOS, iPadOS)', async () => {
    const installer = TestBed.inject(InstallPromptService);
    expect(installer.hasNativePrompt()).toBe(false);

    // Call install without native prompt available
    const result = await installer.install();
    expect(result).toBe(false);
    expect(mockDialog.open).toHaveBeenCalledWith(
      InstallDialog,
      expect.objectContaining({
        panelClass: 'bb-install-dialog-panel',
      }),
    );
  });

  it('never offers it again once installed', () => {
    const installer = TestBed.inject(InstallPromptService);
    window.dispatchEvent(promptEvent('accepted'));
    window.dispatchEvent(new Event('appinstalled'));
    expect(installer.installed()).toBe(true);
    expect(installer.justInstalled()).toBe(true);
    expect(installer.canInstall()).toBe(false);
    expect(localStorage.getItem('bb.install.done')).toBe('1');
  });

  it('hides the banner after "Not now" (the menu item stays)', async () => {
    const installer = TestBed.inject(InstallPromptService);
    window.dispatchEvent(promptEvent('dismissed'));
    installer.dismiss();
    expect(installer.showBanner()).toBe(false);
    expect(installer.canInstall()).toBe(true);
    expect(Number(localStorage.getItem('bb.install.dismissedAt'))).toBeGreaterThan(0);
  });

  it('keeps banner hidden on page reload when previously dismissed', () => {
    localStorage.setItem('bb.install.dismissedAt', String(Date.now() - 1000));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        InstallPromptService,
        { provide: MatDialog, useValue: mockDialog },
      ],
    });
    const installer = TestBed.inject(InstallPromptService);
    expect(installer.showBanner()).toBe(false);
  });

  it('treats a standalone window as installed', () => {
    window.matchMedia = vi
      .fn()
      .mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const installer = TestBed.inject(InstallPromptService);
    window.dispatchEvent(promptEvent('accepted'));
    expect(installer.installed()).toBe(true);
    expect(installer.canInstall()).toBe(false);
    expect(installer.showBanner()).toBe(false);
  });
});
