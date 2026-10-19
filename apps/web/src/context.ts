import { createContext, useContext } from 'react';
import type { ActionRequest, Dashboard, DataMode } from '@gitnostics/shared';

export interface AppContextValue {
  data: Dashboard;
  mode: DataMode;
  busy: boolean;
  mutate: <T = unknown>(
    path: string,
    body: unknown,
    success: string,
    method?: string,
  ) => Promise<T | undefined>;
  preview: (request: ActionRequest) => Promise<void>;
  inspect: (id: string) => void;
  refresh: () => void;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('Application context is missing.');
  return context;
}
