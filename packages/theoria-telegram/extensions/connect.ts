import { mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerCard } from '@theoria/shared/card';
import { config } from '@theoria/shared/config';
import { projectRoot } from '@theoria/shared/paths';
import { launchDirEnv, projectRecord, projectsRoot } from '@theoria/shared/project';
import { formatDuration } from '../src/bot.ts';
import { botPid, botStatus, login, startBot, stopBot } from '../src/cli.ts';
import { guardToolCall, secretNames, withoutSecrets } from '../src/guard.ts';
import { deleteToken, looksLikeToken, readToken, saveToken } from '../src/keychain.ts';
import { qr } from '../src/qr.ts';
import { botSessionEnv } from '../src/session.ts';
import { createPairing, deleteOwner, pairingLink, readOwner, type Owner } from '../src/store.ts';
import { TelegramApi } from '../src/telegram.ts';

/**
 * The Telegram connector inside a Theoria session.
 *
 * In a session `theoria bot` started, it only guards file tools (`guard.ts`); the sandbox around the session is the
 * real boundary. In a terminal session it offers `/connect-bot` and sends each workflow verdict to the paired
 * Telegram account, so a run finishing while you are away reaches your phone.
 */

type Ctx = ExtensionCommandContext;

const connectors = [{ id: 'telegram', label: 'Telegram — a private bot for your phone' }] as const;

export default function telegram(pi: ExtensionAPI) {
  if (process.env[botSessionEnv]) {
    const projectsDir = dirname(projectRoot(process.cwd()));
    const secrets = secretNames(process.env, config().sandbox.secretEnvPattern);
    pi.on('tool_call', (event, ctx) => {
      const input = event.input as Record<string, unknown>;
      if (event.toolName === 'bash' && typeof input.command === 'string') input.command = withoutSecrets(input.command, secrets);
      const reason = guardToolCall(event.toolName, input, ctx.cwd, projectRoot(ctx.cwd), projectsDir);
      return reason ? { block: true, reason } : undefined;
    });
    return;
  }

  const card = registerCard(pi, 'theoria-connector');
  const post = (title: string, lines: (string | false | undefined)[], ok = true) => pi.sendMessage(card(title, lines, { ok, tone: ok ? 'success' : 'warning' }));

  // Verdicts from this terminal session reach Telegram as notifications.
  pi.on('message_end', (event, ctx) => {
    const message = event.message as { customType?: string; content?: unknown; details?: { durationMs?: number } };
    // Goal audit results (pi-goal-x) are sent too: a goal finishing while you are away is worth knowing.
    if (message.customType && config().goals.notifyTypes.includes(message.customType)) { void notify(ctx.cwd, `Goal · ${String(message.content ?? '')}`, undefined); return; }
    if (message.customType !== 'theoria-verdict') return;
    const duration = message.details?.durationMs;
    if (duration !== undefined && duration < config().connectors.telegram.notifyMinSeconds * 1000) return;
    void notify(ctx.cwd, String(message.content ?? ''), duration);
  });

  pi.registerCommand('connect-bot', {
    description: 'Connect Theoria to a chat app (Telegram): pair your phone by QR code · status · remove',
    getArgumentCompletions: prefix => ['status', 'pair', 'remove'].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === 'status') { ctx.ui.notify(botStatus().join('\n'), 'info'); return; }
      if (action === 'remove') return remove(ctx);
      if (!ctx.hasUI) return;
      const picked = await ctx.ui.select('Connect Theoria to', connectors.map(connector => connector.label));
      if (!picked) return;
      await connectTelegram(ctx, action === 'pair');
    },
  });

  async function connectTelegram(ctx: Ctx, pairOnly: boolean) {
    if (process.platform !== 'darwin') { ctx.ui.notify('The Telegram connector needs macOS: it keeps the token in the Keychain and sandboxes bot sessions.', 'error'); return; }
    let token = await readToken();
    let me = token ? (await new TelegramApi(token).getMe()).result : undefined;
    if (!pairOnly && token && me) {
      const reuse = await ctx.ui.select(`A bot is set up: @${me.username}`, [`Keep @${me.username}`, 'Use a different bot']);
      if (!reuse) return;
      if (reuse.startsWith('Use')) { token = undefined; me = undefined; }
    }
    if (!token || !me) {
      const link = config().connectors.telegram.botFatherUrl;
      post('Step 1 · Create a Telegram bot', [
        'Scan with your phone to open BotFather, send /newbot, choose a name, and copy the token it gives you.', '',
        '```text', await qr(link), '```', link,
      ]);
      const entered = (await ctx.ui.input('Paste the bot token from BotFather', '123456789:AA…'))?.trim();
      if (!entered) return;
      if (!looksLikeToken(entered)) { ctx.ui.notify('That does not look like a bot token (digits, a colon, then about 35 characters).', 'error'); return; }
      const checked = await new TelegramApi(entered).getMe();
      if (!checked.ok || !checked.result) { ctx.ui.notify(`Telegram refused that token: ${checked.detail}`, 'error'); return; }
      await saveToken(entered);
      token = entered;
      me = checked.result;
      // A running bot still holds the old token.
      if (botPid()) await stopBot();
    }

    const started = await startBot();
    if (!started.ok) { ctx.ui.notify(started.detail, 'error'); return; }

    const projectsDir = projectsRoot(process.env[launchDirEnv] ?? ctx.cwd);
    mkdirSync(projectsDir, { recursive: true });
    const owner = readOwner();
    if (owner && owner.botId === me.id) {
      const again = await ctx.ui.confirm('Already paired', `@${me.username} is paired with ${owner.displayName}. Pair a phone again? The new account replaces it.`);
      if (!again) { post(`Telegram: @${me.username}`, botStatus()); return; }
    }
    const realProjects = realpathSync(projectsDir);
    const pairing = createPairing(me.username ?? '', realProjects);
    const link = pairingLink(me.username ?? '', pairing.code);
    post('Step 2 · Pair your phone', [
      `Scan to open @${me.username} and press Start. The code works once, until ${new Date(pairing.expiresAt).toLocaleTimeString()}.`, '',
      '```text', await qr(link), '```', link, '',
      `From Telegram you reach only the projects in ${realProjects}.`,
    ]);
    waitForPairing(owner?.pairedAt, Date.parse(pairing.expiresAt), me.username ?? '');
  }

  /** Watches for the bot to record the pairing, without holding up the terminal. */
  function waitForPairing(previous: string | undefined, until: number, username: string) {
    const timer = setInterval(() => {
      const owner = readOwner();
      if (owner && owner.pairedAt !== previous) {
        clearInterval(timer);
        post(`Telegram: paired with ${owner.displayName}`, [
          `@${username} answers only ${owner.displayName}. Projects: ${owner.projectsDir}.`,
          'Try /new_project, /projects or /status in the chat. Verdicts from this terminal reach you there too.',
          '`theoria bot login on` starts the bot at login (needs bedrock.awsProfile).',
        ]);
      } else if (Date.now() > until) {
        clearInterval(timer);
        post('Telegram: pairing code expired', ['Nothing was paired. Run /connect-bot pair for a new code.'], false);
      }
    }, 1000);
    timer.unref();
  }

  async function remove(ctx: Ctx) {
    const owner = readOwner();
    if (ctx.hasUI && !await ctx.ui.confirm('Remove the Telegram connector?', `Stops theoria bot, forgets ${owner?.displayName ?? 'the paired account'}, and deletes the bot token from the Keychain.`)) return;
    await login(false);
    await stopBot();
    deleteOwner();
    await deleteToken();
    post('Telegram connector removed', ['The bot token is gone from the Keychain. Revoke it in BotFather (/revoke) if you will not use this bot again.']);
  }
}

/** Sends a verdict to the paired account, if there is one. Failures are not the user's problem mid-session. */
async function notify(cwd: string, content: string, durationMs: number | undefined) {
  const owner: Owner | undefined = readOwner();
  if (!owner) return;
  const token = await readToken();
  if (!token) return;
  const name = projectRecord(cwd)?.name ?? projectRoot(cwd).split('/').pop();
  const took = durationMs === undefined ? '' : ` · ${formatDuration(durationMs)}`;
  await new TelegramApi(token).sendMessage(owner.chatId, `${name}${took} (terminal)\n${content}`.slice(0, config().connectors.telegram.maxMessageChars));
}
