// SPDX-License-Identifier: MIT
import type { RinHost } from './plugins/rin/types';
export type { RinHost, RinSession, RinSnapshot, RinDocumentTools, RinReply, RinVoiceControls, RinVoiceState } from './plugins/rin/types';
export type { RinReadingContext, RinEvidence, RinEvidenceBatch, RinRegionEvidence } from './plugins/rin/types';
export type { RinRenderedLesson, RinLessonStep } from './plugins/rin/types';
export type { RinConversationHistory } from './plugins/rin/types';
export type { RinCheckAction } from './plugins/rin/types';
export type ReaderView = { pageIndex: number; pageOffsetRatio: number; zoom: number | 'fit-page' | 'fit-width' };
export interface ReaderOptions {
  target: HTMLElement;
  wasmUrl: string;
  documentId: string;
  title: string;
  buffer: ArrayBuffer;
  host: RinHost;
  locale?: string;
  view?: ReaderView;
  onOpenFile(): void;
  onClose(): void;
  onReady(pageCount: number): void;
  onViewChange(view: ReaderView): void;
}
export interface ReaderHandle { destroy(): void; thumbnail(): Promise<Blob | undefined> }
