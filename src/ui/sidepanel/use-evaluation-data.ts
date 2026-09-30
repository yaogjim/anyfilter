import { useCallback, useEffect, useState } from 'react';
import type { EvaluationConnections } from '../../domain/evaluation-pricing';
import type { EvaluationOverview, EvaluationRunStatus } from '../../domain/evaluation-run';
import type { KeyPresence } from '../../infrastructure/evaluation-keys';
import type { PanelGateway } from './PanelGateway';

/** Progress is only display; polling it never touches spending. Faster while a
 * batch runs, slow otherwise so a budget switched elsewhere shows up. */
const POLL_RUNNING_MS = 1000;
const POLL_IDLE_MS = 2500;

export interface EvaluationData {
  overview: EvaluationOverview | null;
  keys: KeyPresence | null;
  connections: EvaluationConnections | null;
  status: EvaluationRunStatus | null;
  refresh: () => Promise<void>;
  setStatus: (status: EvaluationRunStatus) => void;
}

/** Reads the evaluation overview, key presence, connections and run status, and
 * keeps them fresh. Read-only: it never starts a run and never reads a key. Held
 * once by the verification view so the status strip and the evaluation tab agree. */
export function useEvaluationData(gateway: PanelGateway): EvaluationData {
  const [overview, setOverview] = useState<EvaluationOverview | null>(null);
  const [keys, setKeys] = useState<KeyPresence | null>(null);
  const [connections, setConnections] = useState<EvaluationConnections | null>(null);
  const [status, setStatus] = useState<EvaluationRunStatus | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const [nextOverview, nextKeys, nextStatus, nextConnections] = await Promise.all([
      gateway.loadEvaluationOverview(),
      gateway.loadKeyPresence(),
      gateway.loadEvaluationRunStatus(),
      gateway.loadEvaluationConnections(),
    ]);
    if (nextOverview) setOverview(nextOverview);
    if (nextKeys) setKeys(nextKeys);
    if (nextStatus) setStatus(nextStatus);
    if (nextConnections) setConnections(nextConnections);
  }, [gateway]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = status?.running === true;
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  return { overview, keys, connections, status, refresh, setStatus };
}
