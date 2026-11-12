import { TestBed } from '@angular/core/testing';
import { InstallPromptService } from './install-prompt.service';

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
  beforeEach(() => {
    localStorage.clear();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  });

  it('keeps the browser prompt for the Install button and suppresses the mini-infobar', async () => {
    const installer = TestBed.inject(InstallPromptService);
    expect(installer.canInstall()).toBe(false);

    const event = promptEvent('accepted');
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(installer.canInstall()).toBe(true);
    expect(installer.showBanner()).toBe(true);

    expect(await installer.install()).toBe(true);
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(installer.canInstall()).toBe(false); // a prompt can only be used once
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

  it('treats a standalone window as installed', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const installer = TestBed.inject(InstallPromptService);
    window.dispatchEvent(promptEvent('accepted'));
    expect(installer.installed()).toBe(true);
    expect(installer.canInstall()).toBe(false);
  });
});
