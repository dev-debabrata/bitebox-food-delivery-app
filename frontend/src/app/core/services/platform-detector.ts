export type DeviceType = 'desktop' | 'mobile' | 'tablet';
export type PlatformOS = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'other';
export type BrowserFamily = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'opera' | 'other';

export interface DevicePlatformInfo {
  device: DeviceType;
  os: PlatformOS;
  browser: BrowserFamily;
  isIOS: boolean;
  isIPad: boolean;
  isIPhone: boolean;
  isAndroid: boolean;
  isMacOS: boolean;
  isWindows: boolean;
  isLinux: boolean;
  isSafari: boolean;
  isChrome: boolean;
  isEdge: boolean;
  isFirefox: boolean;
  isSamsung: boolean;
  isOpera: boolean;
  browserLabel: string;
  deviceLabel: string;
}

/**
 * Detects device form factor and browser family for installation instructions.
 */
export function detectPlatform(
  customUA?: string,
  customPlatform?: string,
  customMaxTouch?: number,
): DevicePlatformInfo {
  const ua = customUA ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const plat = customPlatform ?? (typeof navigator !== 'undefined' ? navigator.platform || '' : '');
  const touch = customMaxTouch ?? (typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0);

  const isIPad = /iPad/.test(ua) || (plat === 'MacIntel' && touch > 1 && !/iPhone/.test(ua));
  const isIPhone = /iPhone|iPod/.test(ua);
  const isIOS = isIPad || isIPhone;
  const isAndroid = /Android/.test(ua);
  const isMacOS = /Macintosh|Mac OS X/.test(ua) && !isIOS;
  const isWindows = /Windows|Win32|Win64/.test(ua);
  const isLinux = /Linux/.test(ua) && !isAndroid;

  const os: PlatformOS = isIOS ? 'ios' : isAndroid ? 'android' : isMacOS ? 'macos' : isWindows ? 'windows' : isLinux ? 'linux' : 'other';

  const device: DeviceType = isIPad || (isAndroid && !/Mobile/.test(ua)) || /Tablet|PlayBook|Silk/i.test(ua)
    ? 'tablet'
    : isIPhone || (isAndroid && /Mobile/.test(ua)) || /Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)
      ? 'mobile'
      : 'desktop';

  const isEdge = /Edg\/|EdgA\/|EdgiOS\//.test(ua);
  const isOpera = /OPR\/|Opera\//.test(ua);
  const isSamsung = /SamsungBrowser\//.test(ua);
  const isFirefox = /Firefox\/|FxiOS\//.test(ua);
  const isChrome = !isEdge && !isOpera && !isSamsung && /CriOS\/|Chrome\//.test(ua);
  const isSafari = !isEdge && !isOpera && !isSamsung && !isChrome && !isFirefox && /Safari\//.test(ua);

  const browser: BrowserFamily = isEdge ? 'edge' : isOpera ? 'opera' : isSamsung ? 'samsung' : isFirefox ? 'firefox' : isChrome ? 'chrome' : isSafari ? 'safari' : 'other';

  const sub = isIOS ? 'for iOS' : isAndroid ? 'for Android' : '';
  const browserLabel = isSafari
    ? isIPad ? 'Safari (iPad)' : isIPhone ? 'Safari (iPhone)' : isMacOS ? 'Safari (Mac)' : 'Safari'
    : isChrome ? (sub ? `Chrome ${sub}` : 'Google Chrome')
    : isEdge ? (sub ? `Edge ${sub}` : 'Microsoft Edge')
    : isFirefox ? (sub ? `Firefox ${sub}` : 'Mozilla Firefox')
    : isSamsung ? 'Samsung Internet'
    : isOpera ? 'Opera'
    : 'Browser';

  const deviceLabel = device === 'tablet' ? 'Tablet' : device === 'mobile' ? 'Mobile' : 'Desktop';

  return {
    device, os, browser,
    isIOS, isIPad, isIPhone, isAndroid, isMacOS, isWindows, isLinux,
    isSafari, isChrome, isEdge, isFirefox, isSamsung, isOpera,
    browserLabel, deviceLabel,
  };
}
