/** Append literal user guidance after rendering; its contents are never template-expanded. */
export function appendPrompt(prompt: string, addition?: string): string {
  return addition === undefined ? prompt : `${prompt}\n\nAdditional instructions:\n${addition}`;
}

export function validatePromptAppend(value: unknown): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !value.trim()))
    throw new Error('prompt-append must be nonempty text.');
}
