import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import RootLayout from '@/app/layout';

vi.mock('@/components/session-recovery', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

it('tolerates browser root attributes but still reports application hydration errors', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const recoverable = vi.fn();
  const doc = document.implementation.createHTMLDocument('');
  const server = <RootLayout><main><p>照片识别</p></main></RootLayout>;
  doc.open(); doc.write('<!doctype html>' + renderToString(server)); doc.close();
  doc.documentElement.setAttribute('data-tabbit-tray-loaded', 'synthetic-extension');
  doc.body.setAttribute('mpa-version', 'synthetic-extension');
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(doc, server, { onRecoverableError: recoverable }); });
    expect(log).not.toHaveBeenCalled();
    expect(recoverable).not.toHaveBeenCalled();
    await act(async () => { root?.unmount(); }); root = undefined;
    doc.open(); doc.write('<!doctype html>' + renderToString(server)); doc.close();
    await act(async () => { root = hydrateRoot(doc, <RootLayout><main><p>不同的应用内容</p></main></RootLayout>, { onRecoverableError: recoverable }); });
    expect(recoverable).toHaveBeenCalled();
  } finally {
    await act(async () => { root?.unmount(); });
    log.mockRestore();
  }
});
