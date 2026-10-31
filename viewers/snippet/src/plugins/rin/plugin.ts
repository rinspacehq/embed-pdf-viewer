// SPDX-License-Identifier: MIT
import { BasePlugin, type PluginPackage, type PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { SelectionPlugin } from '@embedpdf/plugin-selection';
import type { RinCapability, RinDocumentTools, RinHost, RinPluginConfig, RinSnapshot } from './types';

// Also fits the host's UTF-8 tool-result envelope for non-Latin documents.
const MAX_TEXT = 16000;
const MAX_PAGES = 8;

export class RinPlugin extends BasePlugin<RinPluginConfig, RinCapability> {
  static readonly id = 'rin';
  private host!: RinHost;
  private accountId?: string;
  private records = new Map<string, RinSnapshot>();
  private pending = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private readinessKey = "";

  private isDocumentReady(documentId: string) {
    const state = this.coreState.core;
    const doc = state.documents[documentId];
    return state.activeDocumentId === documentId && doc?.status === 'loaded' && Boolean(doc.document?.pages.length);
  }

  protected onCoreStoreUpdated() {
    const id = this.coreState.core.activeDocumentId;
    const key = `${id}:${id ? this.isDocumentReady(id) : false}`;
    if (key !== this.readinessKey) { this.readinessKey = key; this.notify(); }
  }

  protected onDocumentLoadingStarted(id: string) { this.pending.get(id)?.abort(); }

  constructor(id: string, registry: PluginRegistry) { super(id, registry); }

  async initialize(config: RinPluginConfig) {
    this.host = config.host;
    this.accountId = this.host.session().accountId;
    this.unsubscribe = this.host.subscribeSession(() => {
      if (this.accountId !== this.host.session().accountId) {
        const anonymousDrafts = !this.accountId ? [...this.records].filter(([, record]) => !record.messages.length && record.draft) : [];
        this.pending.forEach(controller => controller.abort());
        this.pending.clear();
        this.records.clear();
        this.accountId = this.host.session().accountId;
        if (this.accountId) for (const [id, record] of anonymousDrafts) {
          if (!this.host.restore(id)?.draft) this.update(id, { draft: record.draft });
        }
      }
      this.notify();
    });
  }

  private notify() { this.listeners.forEach(listener => listener()); }

  private snapshot(documentId: string): RinSnapshot {
    let record = this.records.get(documentId);
    if (!record) {
      record = this.host.restore(documentId) || { messages: [], draft: '', running: false };
      record = { ...record, running: false };
      this.records.set(documentId, record);
    }
    return record;
  }

  private update(documentId: string, patch: Partial<RinSnapshot>) {
    const snapshot = { ...this.snapshot(documentId), ...patch };
    try { this.host.save(documentId, snapshot); }
    catch (error) {
      this.records.set(documentId, { ...snapshot, running: false, error: error instanceof Error ? error.message : '无法保存本地会话。' });
      this.notify();
      return false;
    }
    this.records.set(documentId, snapshot);
    this.notify();
    return true;
  }

  private tools(documentId: string, signal?: AbortSignal, readPages = new Set<number>()): RinDocumentTools {
    const document = () => {
      const state = this.coreState.core;
      const doc = state.documents[documentId]?.document;
      if (!state.documents[documentId] || state.activeDocumentId !== documentId || signal?.aborted) {
        throw new Error('当前 PDF 已切换，请重新发送。');
      }
      if (!doc || !this.isDocumentReady(documentId)) throw new Error('PDF 尚未准备好，请稍后重试。');
      return doc;
    };
    const read = async (pages: number[]) => {
      const doc = document();
      const unique = [...new Set(pages)];
      if (!unique.length || unique.length > MAX_PAGES || unique.some(page => !Number.isInteger(page) || page < 1 || page > doc.pages.length)) {
        throw new Error(`每次最多读取 ${MAX_PAGES} 个有效页面。`);
      }
      const results: Array<{ page: number; text: string }> = [];
      let remaining = MAX_TEXT;
      for (const page of unique) {
        document();
        // v2's extractText reads an uninitialised UTF-16 buffer for zero-character
        // pages. Image-only pages must never send that memory as PDF content.
        const rectangles = await this.engine.getPageTextRects(doc, doc.pages[page - 1]).toPromise();
        document();
        const text = rectangles.length ? await this.engine.extractText(doc, [page - 1]).toPromise() : '';
        document();
        results.push({ page, text: text.slice(0, remaining) });
        readPages.add(page);
        remaining -= Math.min(text.length, remaining);
        if (!remaining) break;
      }
      return results;
    };
    return {
      info: () => {
        const doc = document();
        return { documentId, title: this.coreState.core.documents[documentId]?.name || 'PDF', pageCount: doc.pages.length,
          currentPage: this.registry.getPlugin<ScrollPlugin>('scroll')!.provides().forDocument(documentId).getCurrentPage() };
      },
      readPages: read,
      selection: async () => {
        document();
        const selection = this.registry.getPlugin<SelectionPlugin>('selection')!.provides().forDocument(documentId);
        const ranges = selection.getFormattedSelection();
        const texts = await selection.getSelectedText().toPromise();
        document();
        const result = ranges.slice(0, MAX_PAGES).map((range, index) => ({ page: range.pageIndex + 1, text: (texts[index] || '').slice(0, MAX_TEXT / MAX_PAGES) }));
        result.forEach(item => readPages.add(item.page));
        return result;
      },
      search: async (query, pages) => {
        if (!query.trim() || query.length > 500) throw new Error('请输入有效的搜索内容。');
        return (await read(pages)).filter(item => item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      },
      navigate: (page) => {
        const doc = document();
        if (!Number.isInteger(page) || page < 1 || page > doc.pages.length) throw new Error('页码无效。');
        this.registry.getPlugin<ScrollPlugin>('scroll')!.provides().forDocument(documentId).scrollToPage({ pageNumber: page, behavior: 'instant' });
      },
    };
  }

  protected buildCapability(): RinCapability {
    return {
      session: () => this.host.session(),
      ready: id => this.isDocumentReady(id),
      login: () => this.host.login(),
      snapshot: id => this.snapshot(id),
      subscribe: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
      draft: (id, text) => this.update(id, { draft: text.slice(0, 8000) }),
      tools: id => this.tools(id),
      send: async id => {
        const session = this.host.session();
        const record = this.snapshot(id);
        if (record.running || !record.draft.trim()) return;
        if (!this.isDocumentReady(id)) { this.update(id, { error: 'PDF 尚未准备好，请稍后重试。' }); return; }
        if (session.status !== 'authenticated') {
          try { await this.host.login(); }
          catch (error) { this.update(id, { error: error instanceof Error ? error.message : '请先登录。' }); }
          return;
        }
        const controller = new AbortController();
        const accountId = session.accountId;
        const pages = new Set<number>();
        this.pending.set(id, controller);
        const message = record.draft.trim();
        if (!this.update(id, { running: true, error: undefined })) { this.pending.delete(id); return; }
        try {
          const reply = await this.host.send({ documentId: id, message, tools: this.tools(id, controller.signal, pages), signal: controller.signal });
          if (accountId !== this.host.session().accountId) return;
          this.update(id, { messages: [...record.messages, { role: 'user', text: message },
            { role: 'assistant', text: reply.text, pages: reply.pages?.filter(page => pages.has(page)) }],
            draft: '', recoverable: false, costSG: reply.costSG, usage: reply.usage });
        } catch (error) {
          if (accountId === this.host.session().accountId) this.update(id, {
            error: error instanceof Error ? error.message : '请求失败，请重试。', recoverable: true,
          });
        } finally {
          if (accountId === this.host.session().accountId) this.update(id, { running: false });
          if (this.pending.get(id) === controller) this.pending.delete(id);
        }
      },
      stop: async id => {
        this.pending.get(id)?.abort();
        try { await this.host.stop(id); this.update(id, { recoverable: false, error: undefined }); }
        catch (error) { this.update(id, { error: error instanceof Error ? error.message : '停止状态待确认。' }); }
      },
    };
  }

  protected onActiveDocumentChanged(previousId: string | null) { if (previousId) this.pending.get(previousId)?.abort(); }
  protected onDocumentClosed(id: string) { this.pending.get(id)?.abort(); this.records.delete(id); }
  destroy() {
    this.unsubscribe?.();
    this.pending.forEach(controller => controller.abort());
    this.listeners.clear();
    super.destroy();
  }
}

const disconnectedHost: RinHost = {
  session: () => ({ status: 'anonymous' }), subscribeSession: () => () => {},
  login: async () => { throw new Error('琳尚未连接账号服务。'); },
  restore: () => undefined, save: () => {},
  send: async () => { throw new Error('琳尚未连接模型服务。'); }, stop: async () => {},
};

export const RinPluginPackage: PluginPackage<RinPlugin, RinPluginConfig> = {
  manifest: { id: 'rin', name: 'Rin', version: '1.0.0', provides: ['rin'],
    requires: ['document-manager', 'scroll', 'selection'], optional: [], defaultConfig: { host: disconnectedHost } },
  create: registry => new RinPlugin('rin', registry),
  reducer: () => ({}), initialState: {},
};
