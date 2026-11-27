export const VOICE_VOLUME_KEY: string;
export function restoreVoiceVolume(saved: string | null): number;
export function prepareSpeech(markdown: string): string;
export class SpeechChunks {
  push(fragment: string): string[];
  finish(): string[];
}
