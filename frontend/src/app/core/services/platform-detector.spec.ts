import { describe, expect, it } from 'vitest';
import { detectPlatform } from './platform-detector';

describe('detectPlatform', () => {
  it('detects iPhone Safari correctly as mobile', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      'iPhone',
      5,
    );
    expect(res.device).toBe('mobile');
    expect(res.isIOS).toBe(true);
    expect(res.isIPhone).toBe(true);
    expect(res.isSafari).toBe(true);
    expect(res.browserLabel).toBe('Safari (iPhone)');
  });

  it('detects iPadOS Safari correctly as tablet', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      'MacIntel',
      5,
    );
    expect(res.device).toBe('tablet');
    expect(res.isIOS).toBe(true);
    expect(res.isIPad).toBe(true);
    expect(res.isSafari).toBe(true);
    expect(res.browserLabel).toBe('Safari (iPad)');
  });

  it('detects macOS Safari as desktop', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      'MacIntel',
      0,
    );
    expect(res.device).toBe('desktop');
    expect(res.isMacOS).toBe(true);
    expect(res.isSafari).toBe(true);
    expect(res.browserLabel).toBe('Safari (Mac)');
  });

  it('detects Windows Chrome as desktop', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Win32',
      0,
    );
    expect(res.device).toBe('desktop');
    expect(res.isWindows).toBe(true);
    expect(res.isChrome).toBe(true);
    expect(res.browserLabel).toBe('Google Chrome');
  });

  it('detects Windows Edge as desktop', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
      'Win32',
      0,
    );
    expect(res.device).toBe('desktop');
    expect(res.isWindows).toBe(true);
    expect(res.isEdge).toBe(true);
    expect(res.browserLabel).toBe('Microsoft Edge');
  });

  it('detects Android phone Chrome as mobile', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
      'Linux armv8l',
      5,
    );
    expect(res.device).toBe('mobile');
    expect(res.isAndroid).toBe(true);
    expect(res.isChrome).toBe(true);
    expect(res.browserLabel).toBe('Chrome for Android');
  });

  it('detects Android tablet Chrome as tablet', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Linux aarch64',
      5,
    );
    expect(res.device).toBe('tablet');
    expect(res.isAndroid).toBe(true);
    expect(res.isChrome).toBe(true);
  });

  it('detects Android Firefox as mobile', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
      'Linux armv8l',
      5,
    );
    expect(res.device).toBe('mobile');
    expect(res.isAndroid).toBe(true);
    expect(res.isFirefox).toBe(true);
    expect(res.browserLabel).toBe('Firefox for Android');
  });

  it('detects Desktop Firefox as desktop', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
      'Win32',
      0,
    );
    expect(res.device).toBe('desktop');
    expect(res.isFirefox).toBe(true);
    expect(res.browserLabel).toBe('Mozilla Firefox');
  });

  it('detects Samsung Internet as samsung', () => {
    const res = detectPlatform(
      'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
      'Linux armv8l',
      5,
    );
    expect(res.device).toBe('mobile');
    expect(res.isSamsung).toBe(true);
    expect(res.browserLabel).toBe('Samsung Internet');
  });
});
