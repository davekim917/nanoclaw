/**
 * Shared ask_question payload schema + normalization.
 *
 * Producers (host-side approvals, container-side ask_user_question MCP tool)
 * emit an `ask_question` payload. Options may be bare strings for ergonomics,
 * but are normalized here into a consistent shape before delivery, persistence,
 * and rendering.
 */

/**
 * Button style hint passed down to the Chat SDK → platform adapter.
 * The SDK maps these to each platform's native button style (Slack:
 * primary/danger, Teams: positive/destructive, Discord: primary/danger).
 * `undefined` renders as the platform's neutral/default button.
 */
export type OptionStyle = 'primary' | 'danger';

export interface OptionInput {
  label: string;
  selectedLabel?: string;
  value?: string;
  style?: OptionStyle;
}

export type RawOption = string | OptionInput;

export interface NormalizedOption {
  label: string;
  selectedLabel: string;
  value: string;
  style?: OptionStyle;
}

export function normalizeOption(raw: RawOption): NormalizedOption {
  if (typeof raw === 'string') {
    return { label: raw, selectedLabel: raw, value: raw };
  }
  const label = raw.label;
  return {
    label,
    selectedLabel: raw.selectedLabel ?? label,
    value: raw.value ?? label,
    style: raw.style,
  };
}

export function normalizeOptions(raws: RawOption[]): NormalizedOption[] {
  return raws.map(normalizeOption);
}

export interface AskQuestionPayload {
  type: 'ask_question';
  questionId: string;
  title: string;
  question: string;
  options: NormalizedOption[];
}
