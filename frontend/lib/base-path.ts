/** Keep application requests inside the same mounted Next.js application. */
export function applicationBasePath(): string {
  const value = process.env.NEXT_PUBLIC_BASE_PATH || '';
  if (value && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value)) {
    throw new Error('Invalid application base path');
  }
  return value;
}

export function withBasePath(url: string): string {
  const base = applicationBasePath();
  if (!base || !url.startsWith('/') || url.startsWith('//') || url === base || url.startsWith(base + '/')) return url;
  return base + url;
}

export function withoutBasePath(pathname: string): string {
  const base = applicationBasePath();
  if (base && pathname === base) return '/';
  return base && pathname.startsWith(base + '/') ? pathname.slice(base.length) : pathname;
}

export function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(typeof input === 'string' ? withBasePath(input) : input, init);
}
