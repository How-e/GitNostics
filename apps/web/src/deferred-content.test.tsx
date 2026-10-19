// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { lazy } from 'react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeferredContent } from './deferred-content';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('on-demand downloads', () => {
  it('recovers from a failed page download when navigating to another route', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const FailedPage = lazy(() => Promise.reject(new Error('Chunk unavailable')));
    function Workspace() {
      const location = useLocation();
      return (
        <>
          <nav>
            <Link to="/settings">Settings</Link>
          </nav>
          <DeferredContent key={location.pathname} label="Loading page…">
            <Routes>
              <Route path="/" element={<FailedPage />} />
              <Route path="/settings" element={<h1>Settings recovered</h1>} />
            </Routes>
          </DeferredContent>
        </>
      );
    }
    render(
      <MemoryRouter>
        <Workspace />
      </MemoryRouter>,
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This page could not be loaded.',
    );
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings recovered' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces pending content while keeping the surrounding navigation usable', async () => {
    let finish!: (value: { default: () => React.ReactNode }) => void;
    const Page = lazy(
      () =>
        new Promise<{ default: () => React.ReactNode }>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <>
        <nav>
          <a href="/settings">Settings</a>
        </nav>
        <DeferredContent label="Loading page…">
          <Page />
        </DeferredContent>
      </>,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading page…');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
    await act(async () => {
      finish({ default: () => <h1>Downloaded page</h1> });
    });
    expect(screen.getByRole('heading', { name: 'Downloaded page' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('contains failed chart downloads and offers recovery without hiding the page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Chart = lazy(() => Promise.reject(new Error('Chunk unavailable')));
    render(
      <>
        <h1>Storage</h1>
        <DeferredContent label="Loading chart…" chart>
          <Chart />
        </DeferredContent>
      </>,
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This chart could not be loaded.',
    );
    expect(screen.getByRole('heading', { name: 'Storage' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload workspace' })).toBeTruthy();
  });
});
