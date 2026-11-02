import { getMarkdownTheme, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Box, Markdown } from '@earendil-works/pi-tui';

/**
 * Theoria's cards in the conversation: a bold, coloured first line and a Markdown body. One message type per
 * package, each registered with its own renderer, so a card renders whichever packages a project loads.
 */
export type CardLine = string | undefined | false;
export interface CardDetails { ok?: boolean; tone?: 'success' | 'warning' | 'accent' | 'error'; [key: string]: unknown }

export function registerCard(pi: ExtensionAPI, customType: string) {
  pi.registerMessageRenderer(customType, (message, { outputPad }, theme) => {
    const details = message.details as CardDetails | undefined;
    const tone = details?.tone ?? (details?.ok ? 'success' : 'warning');
    const [title = '', ...rest] = String(message.content).split('\n');
    const box = new Box(outputPad, 1, text => theme.bg('customMessageBg', text));
    box.addChild(new Markdown([theme.fg(tone, theme.bold(title)), ...rest].join('\n'), 0, 0, getMarkdownTheme()));
    return box;
  });
  return (title: string, lines: CardLine[], details: CardDetails) => ({
    customType, content: [title, ...lines.filter(Boolean)].join('\n'), display: true, details,
  });
}
