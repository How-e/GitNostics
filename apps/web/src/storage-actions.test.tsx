// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Dashboard, type DataMode } from '@gitnostics/shared';
import { demoSnapshots } from '../../server/src/demo';
import { AppContext, type AppContextValue } from './context';
import { SafeActionsPage } from './storage-actions';

afterEach(cleanup);

function view(mode: DataMode = 'demo') {
  const data: Dashboard = {
    mode,
    repositories: demoSnapshots().map((snapshot) => ({
      mode,
      fullName: snapshot.fullName,
      favorite: false,
      selected: true,
      syncedAt: null,
      syncStatus: 'idle',
      error: null,
      snapshot,
    })),
    findings: [],
    activity: [],
    incidents: [],
    notifications: [],
    storageHistory: [],
    workflowAnalytics: [],
    settings: defaultSettings,
    connection: { mode: 'public', connected: true, writesEnabled: false, identity: 'Fixture' },
  };
  const context: AppContextValue = {
    data,
    mode,
    busy: false,
    mutate: async () => undefined,
    preview: vi.fn(),
    inspect: () => {},
    refresh: () => {},
  };
  return (
    <MemoryRouter initialEntries={['/safe-actions?repo=northstar/api']}>
      <AppContext.Provider value={context}>
        <Link to="/safe-actions?repo=northstar/web">Change repository link</Link>
        <SafeActionsPage />
      </AppContext.Provider>
    </MemoryRouter>
  );
}

describe('safe action preparation context', () => {
  it('clears a typed dispatch reference when repository navigation changes', () => {
    render(view());
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'dispatch' } });
    fireEvent.change(screen.getByLabelText('Dispatch reference'), {
      target: { value: 'release/api' },
    });
    fireEvent.click(screen.getByRole('link', { name: 'Change repository link' }));
    expect((screen.getByLabelText('Action repository') as HTMLSelectElement).value).toBe(
      'northstar/web',
    );
    expect((screen.getByLabelText('Dispatch reference') as HTMLInputElement).value).toBe('');
  });

  it('clears a typed dispatch reference when the workspace changes', () => {
    const { rerender } = render(view());
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'dispatch' } });
    fireEvent.change(screen.getByLabelText('Dispatch reference'), {
      target: { value: 'demo-only' },
    });
    rerender(view('live'));
    expect((screen.getByLabelText('Dispatch reference') as HTMLInputElement).value).toBe('');
  });
});
