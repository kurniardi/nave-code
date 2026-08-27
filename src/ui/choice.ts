/**
 * Prompt shapes shared by the terminal and by tools that need an answer.
 * Types only — kept separate so a tool can ask a question without importing
 * the terminal, and the terminal can answer without importing the tools.
 */

export interface Choice<T> {
  key: string;
  label: string;
  hint?: string;
  value: T;
}

export interface ChoicePrompt<T> {
  question: string;
  detail?: string;
  tone?: 'normal' | 'danger' | 'plan';
  choices: Array<Choice<T>>;
  /** Returned on Enter, EOF or Ctrl+C. */
  fallback: T;
}

export type Asker = <T>(spec: ChoicePrompt<T>) => Promise<T>;
