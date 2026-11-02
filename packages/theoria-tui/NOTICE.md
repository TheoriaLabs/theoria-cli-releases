# Third-party code

- `src/editor.ts`, `src/footer.ts`, `src/git.ts`, `src/icons.ts`, `src/peek.ts`, `src/runtime.ts`,
  `src/session-lifecycle.ts`, `src/settings-command.ts`, `src/state.ts`, `src/telemetry.ts`, `src/utils.ts` and
  `extensions/tui.ts` are adapted from [pi-open-tui](https://github.com/OldSuns/pi-open-tui) 0.3.11, MIT
  (`LICENSE-pi-open-tui`). Theoria's changes: settings from Theoria's configuration (`src/config.ts`), pinned
  statuses in the footer, the Theoria header, the `/tui` command.
- The header's animation approach (a frame timer, unreferenced and cleared on dispose; a true-colour gradient)
  follows [pi-cc-header](https://github.com/eriiic7z/pi-cc-header) 1.1.1, MIT (`LICENSE-pi-cc-header`). The Theta
  frames themselves are Theoria's (`src/logo.ts`).
