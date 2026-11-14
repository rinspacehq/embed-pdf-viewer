// SPDX-License-Identifier: MIT

export type RinSession = { status: 'loading' | 'anonymous' | 'authenticated' | 'test'; accountId?: string };
export type RinPageText = { page: number; text: string };
export type RinReadingContext = {
  documentVersion: string;
  profileDigest: string;
  maxPages: number;
  maxChars: number;
};
export type RinEvidence = RinPageText & {
  id: string;
  documentVersion: string;
  digest: string;
  startUTF16: number;
  endUTF16: number;
  kind: 'text' | 'text-unavailable';
  complete: boolean;
  continuation?: string;
};
export type RinEvidenceBatch = {
  pages: RinEvidence[];
  complete: boolean;
  continuation?: string;
};
export type RinRegionEvidence = {
  id: string;
  documentVersion: string;
  page: number;
  text: string;
  digest: string;
  complete: true;
  kind: 'region-transcription';
  region: { x: number; y: number; width: number; height: number };
  imageDigest: string;
  confirmation: 'user';
};
export type RinLessonStep = {
  id: string;
  kind: 'explanation' | 'example' | 'derivation' | 'question' | 'feedback';
  parentStepId?: string;
  evidenceRefs: string[];
  narration: string[];
  checkId?: string;
};
export type RinCheckAction = { kind: 'attempt' | 'challenge' | 'hint' | 'reveal' | 'skip'; checkId: string };
export type RinRenderedLesson = {
  operationId: string;
  revision: number;
  view: { schema: 'reader-lesson-view/v1'; steps: RinLessonStep[]; next: 'continue' | 'wait' | 'done';
    assessment?: { checkId: string; verdict: 'correct' | 'partially-correct' | 'incorrect' | 'uncertain'; basis: 'model'; assisted: boolean } };
  html: string;
  htmlDigest: string;
  resultHash: string;
};
export type RinMessage = { role: 'user' | 'assistant'; text: string; pages?: number[]; lesson?: RinRenderedLesson };
export type RinUsage = { inputTokens: number; outputTokens: number };
export type RinReply = { text: string; pages?: number[]; costSG?: number; usage?: RinUsage; lesson?: RinRenderedLesson };
export type RinSnapshot = {
  messages: RinMessage[];
  draft: string;
  running: boolean;
  recoverable?: boolean;
  error?: string;
  costSG?: number;
  usage?: RinUsage;
  draftAction?: RinCheckAction;
  pendingRequest?: { message: string; action?: RinCheckAction };
  deletionPending?: boolean;
  regions?: RinRegionEvidence[];
};

export type RinConversationHistory = { id: string; createdAt: string; title: string; deleting?: boolean; cloud?: boolean };

export type RinNarrationSource = { operationId: string; stepId: string; narrationIndex: number; lessonResultHash: string };
export type RinPlaybackState = { state: 'idle' | 'loading' | 'playing' | 'stopping' | 'error'; source?: RinNarrationSource; resumeSource?: RinNarrationSource; receivedSamples: number; playedSamples: number; follow: boolean; error?: string; expired?: boolean; cleanupPending?: boolean };
export type RinVoiceState = { input: 'idle' | 'starting' | 'listening' | 'transcribing' | 'review' | 'stopping' | 'error'; transcript: string; error?: string; limitReached?: boolean; cleanupPending?: boolean; playback?: RinPlaybackState };
export interface RinVoiceControls {
  available(): boolean;
  snapshot(): RinVoiceState;
  startInput(): Promise<void>;
  finishInput(): Promise<void>;
  cancelInput(): Promise<void>;
  dismissTranscript(): Promise<void>;
  confirmTranscript(text: string): Promise<string>;
  play?(sources: RinNarrationSource[], regenerate?: boolean): Promise<void>;
  stopPlayback?(): Promise<void>;
  setFollow?(follow: boolean): void;
  evidencePages?(refs: string[]): number[];
}

export interface RinDocumentTools {
  info(): { documentId: string; title: string; pageCount: number; currentPage: number };
  readPages(pages: number[]): Promise<RinPageText[]>;
  readEvidence?(pages: number[], continuation?: string): Promise<RinEvidenceBatch>;
  regions?(): RinRegionEvidence[];
  selection(): Promise<RinPageText[]>;
  search(query: string, pages: number[]): Promise<RinPageText[]>;
  navigate(page: number): void;
}

/** The application owns authentication, persistence and the paid transport. */
export interface RinHost {
  session(): RinSession;
  subscribeSession(listener: () => void): () => void;
  login(): Promise<void>;
  restore(documentId: string): RinSnapshot | undefined;
  save(documentId: string, snapshot: RinSnapshot): void;
  send(input: {
    documentId: string;
    message: string;
    tools: RinDocumentTools;
    signal: AbortSignal;
    action?: RinCheckAction;
  }): Promise<RinReply>;
  stop(documentId: string): Promise<void>;
  panelWidth?(): number | undefined;
  savePanelWidth?(width: number): void;
  readingContext?(documentId: string): RinReadingContext | undefined;
  canStartConversation?(documentId: string): boolean;
  newConversation?(documentId: string): Promise<void>;
  history?(documentId: string): RinConversationHistory[];
  readHistory?(documentId: string, conversationId: string): Promise<RinSnapshot>;
  canHint?(documentId: string, checkId: string): boolean;
  conversationVersion?(documentId: string): string | undefined;
  canDeleteConversation?(documentId: string, conversationId?: string): boolean;
  deleteConversation?(documentId: string, conversationId?: string): Promise<void>;
  voice?(documentId: string): RinVoiceControls | undefined;
}

export interface RinPluginConfig { host: RinHost }

export interface RinCapability {
  panelWidth(): number;
  resizePanel(width: number): void;
  ready(documentId: string): boolean;
  session(): RinSession;
  login(): Promise<void>;
  snapshot(documentId: string): RinSnapshot;
  subscribe(listener: () => void): () => void;
  draft(documentId: string, text: string): void;
  send(documentId: string): Promise<void>;
  stop(documentId: string): Promise<void>;
  tools(documentId: string): RinDocumentTools;
  canStartConversation(documentId: string): boolean;
  newConversation(documentId: string): Promise<void>;
  history(documentId: string): RinConversationHistory[];
  readHistory(documentId: string, conversationId: string): Promise<RinSnapshot>;
  canCheck(documentId: string): boolean;
  canHint(documentId: string, checkId: string): boolean;
  selectCheck(documentId: string, action?: RinCheckAction): void;
  check(documentId: string, action: RinCheckAction): Promise<void>;
  canDeleteConversation(documentId: string, conversationId?: string): boolean;
  deleteConversation(documentId: string, conversationId?: string): Promise<void>;
  voice(documentId: string): RinVoiceControls | undefined;
  confirmVoiceTranscript(documentId: string, text: string): Promise<void>;
  canCaptureRegion(documentId: string): boolean;
  beginRegionCapture(documentId: string): void;
  regionCaptureActive(documentId: string): boolean;
  cancelRegionCapture(documentId: string): void;
  confirmRegion(documentId: string, input: { page: number; rect: { origin: { x: number; y: number }; size: { width: number; height: number } }; imageDigest: string; text: string }): Promise<void>;
  removeRegion(documentId: string, id: string): void;
}
