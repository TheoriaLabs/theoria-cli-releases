import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { config } from '@theoria/shared/config';
import { run, seconds } from '@theoria/shared/process';
import { applyBedrockRegion, bedrockRegion } from '@theoria/shared/aws';
import { readSecret } from './keychain.ts';
import { readSecretNames } from './store.ts';

/**
 * AWS credentials for sandboxed sessions, without handing them the means to sign in.
 *
 * The bot resolves `bedrock.awsProfile` itself, outside the sandbox: whatever the profile uses (an SSO session, a
 * `credential_process`, `aws login`) runs here, through
 * `aws configure export-credentials`. Sessions get only the resulting short-lived keys, from a server on 127.0.0.1
 * that answers only requests carrying this run's random token. The AWS SDK reads that server by itself: it is the
 * container-credentials endpoint (`AWS_CONTAINER_CREDENTIALS_FULL_URI`), which the SDK accepts on loopback.
 *
 * A session therefore never needs `~/.aws` or a sign-in tool, and the sandbox denies all of them.
 */

export interface AwsKeys { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string; Expiration?: string }

export class CredentialBroker {
  private server: Server | undefined;
  private readonly token = randomBytes(24).toString('hex');
  private cached: AwsKeys | undefined;
  private inflight: Promise<AwsKeys> | undefined;
  private port = 0;
  lastError: string | undefined;
  private readonly profile: string;

  constructor(profile: string) { this.profile = profile; }

  /** Fetches the profile's keys now, so a broken profile is reported at startup rather than on the first prompt. */
  async start(): Promise<void> {
    await this.keys();
    this.server = createServer((request, response) => {
      if (request.headers.authorization !== this.token || request.url !== '/credentials') {
        response.statusCode = 403;
        response.end();
        return;
      }
      this.keys().then(keys => {
        response.setHeader('content-type', 'application/json');
        // The container-credentials format: Token for the session token, an RFC 3339 expiry.
        response.end(JSON.stringify({
          AccessKeyId: keys.AccessKeyId, SecretAccessKey: keys.SecretAccessKey,
          ...(keys.SessionToken ? { Token: keys.SessionToken } : {}),
          ...(keys.Expiration ? { Expiration: new Date(keys.Expiration).toISOString() } : {}),
        }));
      }, (error: unknown) => {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
      });
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as { port: number }).port;
  }

  stop() { this.server?.close(); }

  /** The variables that point a session's AWS SDK at the broker and at nothing else. */
  environment(): Record<string, string> {
    return {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `http://127.0.0.1:${this.port}/credentials`,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: this.token,
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    };
  }

  /** The cached keys, fetched again when they are close to expiring. One fetch at a time. */
  async keys(): Promise<AwsKeys> {
    const margin = seconds(config().bedrock.credentialBroker.refreshBeforeSeconds);
    const fresh = this.cached && (!this.cached.Expiration || Date.parse(this.cached.Expiration) - margin > Date.now());
    if (fresh) return this.cached!;
    this.inflight ??= this.fetch().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async fetch(): Promise<AwsKeys> {
    const env = { ...process.env };
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN']) delete env[key];
    const result = await run('aws', ['configure', 'export-credentials', '--profile', this.profile, '--format', 'process'], {
      env, timeoutMs: seconds(config().bedrock.credentialBroker.fetchTimeoutSeconds),
    });
    if (result.code !== 0) {
      this.lastError = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' ') || `aws exited with ${result.code}`;
      throw new Error(`AWS profile ${this.profile} gave no credentials: ${this.lastError}`);
    }
    const keys = JSON.parse(result.stdout) as AwsKeys;
    if (!keys.AccessKeyId || !keys.SecretAccessKey) throw new Error(`AWS profile ${this.profile} gave no credentials.`);
    // The SDK refuses container credentials without an expiry; keys given without one are fetched again soon.
    keys.Expiration ??= new Date(Date.now() + seconds(config().bedrock.credentialBroker.unknownExpirySeconds)).toISOString();
    this.lastError = undefined;
    this.cached = keys;
    return keys;
  }
}

/** Shared credential path for independent agents, benchmark workers and bot sessions. */
export async function loadSecrets(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of readSecretNames()) { const value = await readSecret(name); if (value) out[name] = value; }
  return out;
}
/** Prefer explicitly supplied secrets and broker credentials; otherwise inherit the launching environment. */
export function sessionEnv(broker?: CredentialBroker, secrets: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...secrets };
  if (broker) {
    const region = config().bedrock.region || bedrockRegion({ AWS_PROFILE: config().bedrock.awsProfile });
    for (const key of Object.keys(env)) if (/^AWS_/.test(key) && !(key in secrets)) delete env[key];
    Object.assign(env, broker.environment()); if (region) env.AWS_REGION = region;
  } else applyBedrockRegion(env);
  return env;
}
let workerBroker: Promise<CredentialBroker> | undefined;
export async function terminalWorkerEnv(): Promise<NodeJS.ProcessEnv> {
  const profile = config().bedrock.awsProfile;
  if (profile) workerBroker ??= (async () => { const broker = new CredentialBroker(profile); await broker.start(); return broker; })().catch(error => { workerBroker = undefined; throw error; });
  return sessionEnv(workerBroker ? await workerBroker : undefined, await loadSecrets());
}
