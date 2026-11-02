import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Box, Markdown } from '@earendil-works/pi-tui';
import { componentOn } from '@theoria/shared/harness';
import { helpCompletions, helpText } from '../src/help.ts';

/**
 * `/help [command]`: Theoria's slash commands with their forms (`<required>`, `[optional]`), only those this session
 * has. The card is a session entry, shown in the transcript but never sent to the model: help is for the person.
 */
interface HelpEntryData { title: string; lines: string[]; ok: boolean }

export default function help(pi: ExtensionAPI) {
  if (!componentOn('project') && !componentOn('actions')) return;
  pi.registerEntryRenderer<HelpEntryData>('theoria-help', (entry, _options, theme) => {
    const data = entry.data ?? { title: 'Theoria commands', lines: [], ok: true };
    const box = new Box(1, 1, text => theme.bg('customMessageBg', text));
    box.addChild(new Markdown([theme.fg(data.ok ? 'accent' : 'warning', theme.bold(data.title)), '', ...data.lines].join('\n'), 0, 0, getMarkdownTheme()));
    return box;
  });
  pi.registerCommand('help', {
    description: 'Theoria commands with their required and optional arguments: /help [command]',
    getArgumentCompletions: prefix => helpCompletions(pi.getCommands(), prefix),
    handler: async args => {
      // An entry, not a message: the transcript shows it, the model never sees it. Writing to stdout instead would
      // corrupt RPC and print modes.
      pi.appendEntry<HelpEntryData>('theoria-help', helpText(pi.getCommands(), args));
    },
  });
}
