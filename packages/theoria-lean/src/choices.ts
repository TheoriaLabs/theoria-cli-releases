import { describeCheckout, inventory, type Inventory } from './discovery.ts';
import type { Selection } from './settings.ts';
import { leanVersionOf } from './toolchain.ts';
import { extraSpecs, extraState } from './extras.ts';

export interface LeanChoice { label: string; selection: Selection }

/**
 * What a Lean environment can be chosen from on this machine: each built Mathlib checkout (its Lean follows from
 * it), then each installed Lean on its own. Labelled by version; paths are never shown.
 */
export async function leanChoices(options: { rescan?: boolean } = {}): Promise<{ choices: LeanChoice[]; found: Inventory }> {
  const found = await inventory(options);
  const choices: LeanChoice[] = [];
  for (const checkout of found.checkouts.filter(entry => entry.built)) {
    const missing = found.toolchains.includes(checkout.toolchain) ? '' : ' (its Lean is not installed)';
    choices.push({ label: `${describeCheckout(checkout)}${missing}`, selection: { mathlib: checkout.version } });
    for (const extra of extraSpecs()) if (extraState(extra.name, checkout.version).ready) {
      choices.push({ label: `${describeCheckout(checkout)} + ${extra.title}${missing}`, selection: { mathlib: checkout.version, extras: [extra.name] } });
    }
  }
  for (const toolchain of found.toolchains) {
    choices.push({ label: `Lean ${leanVersionOf(toolchain)} · no Mathlib`, selection: { lean: leanVersionOf(toolchain) } });
  }
  return { choices, found };
}
