import type { PanelState } from '../../domain/panel-state';
import type { PostKind } from '../../domain/post';
import type { PreviewInput, PreviewResult, Rule, SaveRulesResult } from '../../domain/rule';
import type { Settings } from '../../domain/settings';

export interface PanelGateway {
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  onSettingsChanged(listener: (settings: Settings) => void): () => void;
  loadPanelState(): Promise<PanelState>;
  onPanelStateChanged(listener: (state: PanelState) => void): () => void;
  saveRules(rules: Rule[], expectedRevision: number): Promise<SaveRulesResult>;
  previewRule(input: PreviewInput): Promise<PreviewResult>;
  override(postId: string, shown: boolean): Promise<void>;
  clearData(): Promise<void>;
  clearHidden(kind: PostKind): Promise<void>;
}