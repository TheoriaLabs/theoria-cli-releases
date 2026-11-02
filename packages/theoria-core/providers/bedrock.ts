import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Model, Provider, StreamOptions } from '@earendil-works/pi-ai';
import { config, type TheoriaConfig } from '@theoria/shared/config';

type Ultrafast = TheoriaConfig['bedrock']['ultrafast'];
type UltrafastModel = Pick<Ultrafast, 'aliasId' | 'modelId' | 'name' | 'cost'>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A physical catalog alias: Pi keeps its name/rates in history, while Bedrock receives the actual model ID. */
export function withUltrafast(base: Provider, settings: Ultrafast): Provider {
  const models = [settings, ...settings.additionalModels].map(({ aliasId, modelId, name, cost }) =>
    structuredClone({ aliasId, modelId, name, cost }));
  const byId = new Map(models.map(model => [model.aliasId, model]));
  const alias = (options: UltrafastModel): Model<any> => {
    const model = base.getModels().find(entry => entry.id === options.modelId);
    if (!model || model.api !== 'bedrock-converse-stream') throw new Error(`Ultrafast needs the Bedrock Converse model ${options.modelId} in Pi's catalog.`);
    return { ...model, id: options.aliasId, name: options.name, cost: { ...options.cost } };
  };
  models.forEach(alias); // Diagnose incompatible catalogs at startup, not after the user sends a prompt.
  const payload = (value: unknown, options: UltrafastModel) => {
    if (!object(value)) throw new Error('Bedrock Ultrafast expected an object request payload.');
    const fields = value.additionalModelRequestFields;
    if (fields !== undefined && !object(fields)) throw new Error('Bedrock Ultrafast expected object additionalModelRequestFields.');
    return { ...value, modelId: options.modelId, additionalModelRequestFields: { ...fields, service_tier: 'ultrafast' } };
  };
  const requestOptions = <T extends StreamOptions>(options: UltrafastModel, input?: T): T => ({
    ...input,
    onPayload: async (value: unknown, model: Model<any>) => {
      const prepared = payload(value, options);
      const transformed = await input?.onPayload?.(prepared, model);
      // Other instrumentation may replace the payload; the chosen mode must still reach Bedrock.
      return payload(transformed === undefined ? prepared : transformed, options);
    },
  } as T);
  return {
    ...base,
    getModels: () => [...base.getModels().filter(model => !byId.has(model.id)), ...models.map(alias)],
    getAllModels: () => [...(base.getAllModels?.() ?? base.getModels()).filter(model => !byId.has(model.id)), ...models.map(alias)],
    stream: (model, context, streamOptions) => {
      const options = byId.get(model.id);
      return base.stream(model, context, options ? requestOptions(options, streamOptions) : streamOptions);
    },
    streamSimple: (model, context, streamOptions) => {
      const options = byId.get(model.id);
      return base.streamSimple(model, context, options ? requestOptions(options, streamOptions) : streamOptions);
    },
  };
}

/** Preserve Pi's cached/live catalog overlay as well as its native AWS credential-chain/bearer authentication.
 * Pi's catalog wrapper is internal; bedrock.test.ts exercises it so upgrades fail visibly if this API moves.
 */
export async function ultrafastProvider(): Promise<Provider> {
  const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  // Pi's extension loader aliases the pi-ai root to its compatibility module; importing providers through a
  // package subpath is rewritten incorrectly there. Absolute URLs use the installed native implementations.
  const aiDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')));
  const native = await import(pathToFileURL(join(aiDist, 'providers/amazon-bedrock.js')).href) as { amazonBedrockProvider: () => Provider };
  const catalog = await import(pathToFileURL(join(aiDist, 'providers/all.js')).href) as { getBuiltinModelDataGeneratedAt: () => number };
  const module = await import(pathToFileURL(join(dist, 'core/remote-catalog-provider.js')).href) as {
    withRemoteCatalog: (provider: Provider, catalogBaseUrl?: string, generatedAt?: number) => Provider;
  };
  return withUltrafast(module.withRemoteCatalog(native.amazonBedrockProvider(), undefined, catalog.getBuiltinModelDataGeneratedAt()), config().bedrock.ultrafast);
}

export default async function bedrock(pi: ExtensionAPI) {
  if (config().bedrock.ultrafast.enabled) pi.registerProvider(await ultrafastProvider());
}
