import { config } from '@theoria/shared/config';

/** `leanprover/lean4:v4.28.0`, `v4.28.0` or `4.28.0` → `4.28.0`. */
export const leanVersionOf = (toolchain: string) => toolchain.trim().replace(/^.*:/, '').replace(/^v/, '');

/** `4.28.0` → `leanprover/lean4:v4.28.0`. */
export const toolchainFor = (version: string) => `${config().lean.toolchainPrefix}${leanVersionOf(version)}`;
