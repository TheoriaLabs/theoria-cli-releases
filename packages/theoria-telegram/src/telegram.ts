import { config } from '@theoria/shared/config';
import { seconds } from '@theoria/shared/process';

/**
 * The Telegram Bot API, by plain HTTPS calls. Adapted from TheoriaLabs' transport: every call has a time limit,
 * returns Telegram's own description on failure rather than throwing, and a 409 (another process is reading this
 * bot's updates) is reported as a conflict so the caller can stop instead of fighting over the update stream.
 */

export interface InlineButton { text: string; callback_data: string }

export interface ApiResult<T> { ok: boolean; result?: T; detail: string; conflict: boolean; retryAfter?: number }

export interface TelegramUser { id: number; is_bot?: boolean; first_name?: string; username?: string }
export interface TelegramMessage { message_id: number; chat: { id: number; type?: string }; from?: TelegramUser; text?: string }
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: TelegramMessage };
}

export class TelegramApi {
  private readonly base: string;

  constructor(token: string, base = config().connectors.telegram.apiBase) {
    this.base = `${base.replace(/\/$/, '')}/bot${token}`;
  }

  async call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = seconds(config().connectors.telegram.requestTimeoutSeconds)): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.base}/${method}`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
      return {
        ok: !!payload.ok, result: payload.result,
        detail: payload.description ?? `${method} answered ${response.status}`,
        conflict: response.status === 409,
        ...(payload.parameters?.retry_after ? { retryAfter: payload.parameters.retry_after } : {}),
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : `${method} failed`, conflict: false };
    } finally { clearTimeout(timer); }
  }

  getMe() { return this.call<TelegramUser>('getMe'); }

  getUpdates(offset: number) {
    const timeout = config().connectors.telegram.pollTimeoutSeconds;
    return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, seconds(timeout + 10));
  }

  /** Plain text: model output is not valid Telegram Markdown often enough to risk a parse failure. */
  sendMessage(chatId: number, text: string, buttons?: InlineButton[][]) {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId, text, link_preview_options: { is_disabled: true },
      ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  editMessageText(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]) {
    return this.call<TelegramMessage>('editMessageText', {
      chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons ?? [] },
    });
  }

  answerCallbackQuery(id: string, text?: string) { return this.call<boolean>('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); }
  sendChatAction(chatId: number) { return this.call<boolean>('sendChatAction', { chat_id: chatId, action: 'typing' }); }

  /** The command menu, for one chat when `chatId` is given. */
  setMyCommands(commands: { command: string; description: string }[], chatId?: number) {
    return this.call<boolean>('setMyCommands', { commands, ...(chatId ? { scope: { type: 'chat', chat_id: chatId } } : {}) });
  }
}

/** Splits text into Telegram-sized messages, at line breaks where possible. */
export function chunks(text: string, size = config().connectors.telegram.maxMessageChars): string[] {
  const out: string[] = [];
  let rest = text.trim() || '(empty)';
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size);
    const at = cut > size / 2 ? cut : size;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}

/** A Pi command name as a Telegram command: lowercase letters, digits and `_`, at most 32 characters. */
export const telegramCommand = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
