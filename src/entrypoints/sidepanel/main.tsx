import '../../assets/globals.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BackgroundClient } from '../../infrastructure/background-client';
import { loadCaptureState, onCaptureStateChanged } from '../../infrastructure/capture-store';
import {
  loadVerificationCandidates,
  loadVerificationStatus,
} from '../../infrastructure/evaluation-verification';
import { loadPanelState, onPanelStateChanged } from '../../infrastructure/panel-state-store';
import { loadReviewCount, loadReviewStore, onReviewRecordsChanged } from '../../infrastructure/review-store';
import { loadSettings, onSettingsChanged, saveSettings } from '../../infrastructure/settings-store';
import { LanguageProvider } from '../../ui/language';
import { App } from '../../ui/sidepanel/App';
import type { PanelGateway } from '../../ui/sidepanel/PanelGateway';

const client = new BackgroundClient();

const gateway: PanelGateway = {
  loadSettings,
  saveSettings,
  onSettingsChanged,
  loadPanelState,
  onPanelStateChanged,
  saveRules: (rules, expectedRevision) => client.saveRules(rules, expectedRevision),
  previewRule: (input) => client.previewRule(input),
  override: (postId, shown) => client.override(postId, shown),
  clearData: () => client.clearData(),
  clearHidden: (kind) => client.clearHidden(kind),
  loadCaptureState,
  onCaptureStateChanged,
  setCaptureRunState: (runState) => client.setCaptureRunState(runState),
  clearCapture: () => client.clearCapture(),
  loadVerificationCandidates,
  loadVerificationStatus,
  loadVerificationSampleDetail: (sampleId) => client.loadVerificationSampleDetail(sampleId),
  enableVerificationBudget: () => client.enableVerificationBudget(),
  disableVerificationBudget: () => client.disableVerificationBudget(),
  runVerificationSample: (sampleId, ruleId) => client.runVerificationSample(sampleId, ruleId),
  loadReviewCount,
  onReviewCountChanged: onReviewRecordsChanged,
  clearReviewRecords: () => client.clearReviewRecords(),
  exportReviewRecords: async () => (await loadReviewStore()).records,
  loadEvaluationOverview: () => client.loadEvaluationOverview(),
  loadKeyPresence: () => client.loadKeyPresence(),
  setEvaluationKey: (labeller, key) => client.setEvaluationKey(labeller, key),
  loadEvaluationConnections: () => client.loadEvaluationConnections(),
  setEvaluationConnection: (labeller, baseUrl, model) => client.setEvaluationConnection(labeller, baseUrl, model),
  startEvaluationBatch: (labeller) => client.startEvaluationBatch(labeller),
  stopEvaluationBatch: () => client.stopEvaluationBatch(),
  loadEvaluationRunStatus: () => client.loadEvaluationRunStatus(),
  exportEvaluation: () => client.exportEvaluation(),
};

const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('side panel root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <LanguageProvider>
      <App gateway={gateway} />
    </LanguageProvider>
  </React.StrictMode>,
);