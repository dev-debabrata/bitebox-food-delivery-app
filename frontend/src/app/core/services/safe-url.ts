/** An in-app path, or null for anything that could leave the site (`//host`, `/\host`, `https:`). */
export function safeReturnUrl(url: string | undefined): string | null {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') ? url : null;
}
