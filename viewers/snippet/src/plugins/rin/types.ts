// SPDX-License-Identifier: MIT

export type RinSession = { status: 'loading' | 'anonymous' | 'authenticated'; accountId?: string };
export type RinPageText = { page: number; text: string };
export type RinMessage = { role: 'user' | 'assistant'; text: string; pages?: number[] };
export type RinUsage = { inputTokens: number; outputTokens: number };
export type RinReply = { text: string; pages?: number[]; costSG?: number; usage?: RinUsage };
export type RinSnapshot = {
  messages: RinMessage[];
  draft: string;
  running: boolean;
  recoverable?: boolean;
  error?: string;
  costSG?: number;
  usage?: RinUsage;
};

export interface RinDocumentTools {
  info(): { documentId: string; title: string; pageCount: number; currentPage: number };
  readPages(pages: number[]): Promise<RinPageText[]>;
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
  }): Promise<RinReply>;
  stop(documentId: string): Promise<void>;
}

export interface RinPluginConfig { host: RinHost }

export interface RinCapability {
  session(): RinSession;
  login(): Promise<void>;
  snapshot(documentId: string): RinSnapshot;
  subscribe(listener: () => void): () => void;
  draft(documentId: string, text: string): void;
  send(documentId: string): Promise<void>;
  stop(documentId: string): Promise<void>;
  tools(documentId: string): RinDocumentTools;
}
