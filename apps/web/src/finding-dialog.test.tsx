// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, type Dashboard, type Finding } from '@gitnostics/shared';
import { AppContext, type AppContextValue } from './context';
import { FindingDialog } from './components';

const finding: Finding = {
  id: 'finding-1',
  mode: 'demo',
  status: 'active',
  ruleId: 'rule-1',
  ruleVersion: 1,
  fingerprint: 'fixture',
  repository: 'example/project',
  type: 'workflow',
  severity: 'high',
  confidence: 'confirmed',
  title: 'Example finding',
  explanation: 'Fixture evidence',
  recommendation: 'Review fixture',
  evidence: [],
  firstDetectedAt: '2026-10-18T00:00:00Z',
  lastObservedAt: '2026-10-18T00:00:00Z',
};
const data: Dashboard = {
  mode: 'demo',
  repositories: [],
  findings: [finding],
  activity: [],
  incidents: [],
  notifications: [],
  settings: defaultSettings,
  storageHistory: [],
  workflowAnalytics: [],
  connection: { mode: 'public', connected: true, identity: 'Fixture', writesEnabled: false },
};

function view(succeeds: boolean) {
  const context: AppContextValue = {
    data,
    mode: 'demo',
    busy: false,
    mutate: async <T,>() => (succeeds ? ({ updated: true } as T) : undefined),
    preview: async () => {},
    inspect: () => {},
    refresh: () => {},
  };
  return (
    <MemoryRouter>
      <AppContext.Provider value={context}>
        <div role="status">Global notification</div>
        <FindingDialog finding={finding} close={() => {}} />
      </AppContext.Provider>
    </MemoryRouter>
  );
}

afterEach(cleanup);

describe('finding dialog mutation announcements', () => {
  it('announces successful status changes inside the modal accessibility tree', async () => {
    render(view(true));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByRole('combobox', { name: 'Finding status' }), {
      target: { value: 'acknowledged' },
    });
    expect((await screen.findByRole('status')).textContent).toBe('Finding status updated');
    expect(dialog.getByRole('status')).toBeTruthy();
  });

  it('announces failed status changes inside the modal without claiming success', async () => {
    render(view(false));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByRole('combobox', { name: 'Finding status' }), {
      target: { value: 'acknowledged' },
    });
    expect((await dialog.findByRole('alert')).textContent).toContain('could not be saved');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('announces successful rule suppression inside the modal', async () => {
    render(view(true));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Suppress rule' }));
    expect((await screen.findByRole('status')).textContent).toBe(
      'Rule suppressed for this workspace',
    );
  });
});
