import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { agentDir } from '@theoria/shared/paths';

/** Where benchmarks keep what they share across projects: sources, tool builds, Mathlib environments. */
const settings = () => config().benchmarks;
export const benchDir = () => join(agentDir(), settings().dir);
export const sourcesDir = () => join(benchDir(), settings().sourcesDir);
export const sourceDir = (id: string) => join(sourcesDir(), id);
export const toolsDir = () => join(benchDir(), settings().toolsDir);
export const envsDir = () => join(benchDir(), settings().envsDir);
