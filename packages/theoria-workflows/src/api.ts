/** What other Theoria packages use from the workflows package: progress towards a project's goal. */
export { measureProgress, progressBar, progressLines, progressMeasure, readProgress, type Progress, type ProgressItem } from './progress.ts';
export { loadPrompt, workflowNames, type WorkflowName } from './prompt.ts';
export { counts, readInventory, refreshInventory, type Inventory, type TheoremState } from './inventory.ts';
export { projectRow, statusLines } from './status.ts';
export { blank, declarations, type Declaration } from './lean-source.ts';
export { compressionRounds, type CompressionHost } from './compression-rounds.ts';
export { prepareCompression, checkCompressedFile, compressionDetails, type CompressionBaseline, type CompressionVerdict, type CompressionVerifier } from './compression-gate.ts';
export { compressionScore, compatibilityPercent, scoreComponents, sourceHash, type ScoreWeights, type CompressionPolicy, type CompressionMeasurement } from './compression-metrics.ts';
export { withCompressSkill, compressSkillPath, compressionSkillArgs, resolveCompressionSkill, compressionSkillLabel,
  type CompressionSkill, type CompressionSkillSelection } from './compress-skill.ts';
export { loadDefaultPrompt, render, splitArgs, type WorkflowPrompt } from './prompt.ts';
