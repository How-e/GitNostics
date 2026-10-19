// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Dashboard, type DataMode } from '@gitnostics/shared';
import { AppContext, type AppContextValue } from './context';
import { SettingsPage } from './settings';

const dashboard = (connected = true): Dashboard => ({
  mode: 'live',
  repositories: [],
  findings: [],
  activity: [],
  incidents: [],
  notifications: [],
  settings: defaultSettings,
  connection: { mode: 'app', connected, identity: 'Example installation', writesEnabled: false },
  storageHistory: [],
  workflowAnalytics: [],
});

function view(data: Dashboard, mode: DataMode = 'live') {
  const context: AppContextValue = {
    data,
    mode,
    busy: false,
    mutate: async () => undefined,
    preview: async () => {},
    inspect: () => {},
    refresh: () => {},
  };
  return (
    <AppContext.Provider value={context}>
      <SettingsPage exploreDemo={() => {}} />
    </AppContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('connection discovery', () => {
  it('labels an unavailable installation without claiming public access', () => {
    render(view(dashboard(false)));
    expect(screen.getByText('Connection unavailable')).toBeTruthy();
    expect(screen.queryByText('Public mode')).toBeNull();
  });

  it('shows capped results and a useful empty search state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          repositories: [{ fullName: 'example/project', private: true }],
          complete: false,
        }),
      }),
    );
    render(view(dashboard()));
    fireEvent.click(screen.getByRole('button', { name: 'Discover accessible repositories' }));
    expect(await screen.findByText(/500-repository limit/)).toBeTruthy();
    expect(screen.getByText('example/project')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search discovered repositories' }), {
      target: { value: 'missing' },
    });
    expect(screen.getByText('No matching repositories')).toBeTruthy();
  });

  it('keeps discovered repositories selectable when the connection becomes verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          repositories: [{ fullName: 'example/project', private: true }],
          complete: true,
        }),
      }),
    );
    const rendered = render(view(dashboard(false)));
    fireEvent.click(screen.getByRole('button', { name: 'Discover accessible repositories' }));
    expect(await screen.findByText('example/project')).toBeTruthy();
    rendered.rerender(view(dashboard(true)));
    expect(screen.getByText('example/project')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Add repository' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    rendered.rerender(view(dashboard(false)));
    expect(screen.queryByText('example/project')).toBeNull();
  });

  it('cancels discovery across mode changes and ignores even a late response', async () => {
    let resolve: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const data = dashboard();
    const rendered = render(view(data));
    fireEvent.click(screen.getByRole('button', { name: 'Discover accessible repositories' }));
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    rendered.rerender(view(data, 'demo'));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolve({
        ok: true,
        json: async () => ({
          repositories: [{ fullName: 'private/late', private: true }],
          complete: true,
        }),
      });
    });
    expect(
      screen.getByText('Repository discovery is available in the live workspace.'),
    ).toBeTruthy();
    expect(screen.queryByText('private/late')).toBeNull();
    expect(screen.queryByText('Discovering…')).toBeNull();
  });
});
