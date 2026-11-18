// SPDX-License-Identifier: MIT
import type { RinHost } from './plugins/rin/types';
import type { AnnotationTransferItem } from '@embedpdf/plugin-annotation';
export type { RinHost, RinSession, RinSnapshot, RinDocumentTools, RinReply, RinVoiceControls, RinVoiceState } from './plugins/rin/types';
export type { RinReadingContext, RinEvidence, RinEvidenceBatch, RinRegionEvidence } from './plugins/rin/types';
export type { RinRenderedLesson, RinLessonStep } from './plugins/rin/types';
export type { RinConversationHistory } from './plugins/rin/types';
export type { RinCheckAction } from './plugins/rin/types';
export type ReaderView = { pageIndex: number; pageOffsetRatio: number; zoom: number | 'fit-page' | 'fit-width' };
export interface ReaderAnnotationEdit {
  pageIndex: number;
  /** Original page slot, or the viewer ID for an annotation created in Reader. */
  anchor: number | string;
  item: AnnotationTransferItem | null;
}
export interface ReaderAnnotationHost {
  edits: ReaderAnnotationEdit[];
  onEdit(edit: ReaderAnnotationEdit): void;
  onRestoreError(): void;
}
export interface ReaderOptions {
  target: HTMLElement;
  wasmUrl: string;
  documentId: string;
  title: string;
  buffer: ArrayBuffer;
  host: RinHost;
  locale?: string;
  view?: ReaderView;
  annotations?: ReaderAnnotationHost;
  onOpenFile(): void;
  onClose(): void;
  onReady(pageCount: number): void;
  onViewChange(view: ReaderView): void;
}
export interface ReaderHandle { destroy(): void; thumbnail(): Promise<Blob | undefined> }
