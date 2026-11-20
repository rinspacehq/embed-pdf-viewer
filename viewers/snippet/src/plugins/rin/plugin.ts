// SPDX-License-Identifier: MIT
import { BasePlugin, type PluginPackage, type PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { SelectionPlugin } from '@embedpdf/plugin-selection';
import { CapturePlugin } from '@embedpdf/plugin-capture';
import type { RinCapability, RinCheckAction, RinDocumentTools, RinHost, RinPluginConfig, RinSnapshot } from './types';
import { evidenceDigest, readBoundedEvidence } from './evidence';

// Also fits the host's UTF-8 tool-result envelope for non-Latin documents.
const MAX_TEXT = 16000;
const MAX_PAGES = 8;

export class RinPlugin extends BasePlugin<RinPluginConfig, RinCapability> {
  static readonly id = 'rin';
  private host!: RinHost;
  private accountId?: string;
  private records = new Map<string, RinSnapshot>();
  private conversationVersions = new Map<string, string | undefined>();
  private pending = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private readinessKey = "";
  private panelWidth = 360;
  private changingConversation = new Set<string>();
  private regionCapture = new Set<string>();

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
    try {
      const width = this.host.panelWidth?.();
      if (width !== undefined && Number.isFinite(width)) this.panelWidth = Math.max(320, Math.min(800, Math.round(width)));
    } catch { /* Unavailable preferences never block PDF reading. */ }
    this.accountId = this.host.session().accountId;
    this.unsubscribe = this.host.subscribeSession(() => {
      if (this.accountId !== this.host.session().accountId) {
        const anonymousDrafts = !this.accountId ? [...this.records].filter(([, record]) => !record.messages.length && record.draft) : [];
        this.pending.forEach(controller => controller.abort());
        this.pending.clear();
        this.records.clear();
        this.conversationVersions.clear();
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
    const version = this.host.conversationVersion?.(documentId);
    if (this.records.has(documentId) && this.conversationVersions.get(documentId) !== version) {
      this.pending.get(documentId)?.abort(); this.pending.delete(documentId);
      this.records.delete(documentId);
    }
    this.conversationVersions.set(documentId, version);
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
      readEvidence: async (pages, continuation) => {
        const context = this.host.readingContext?.(documentId);
        const identity = this.host.session();
        if (!context || identity.status === 'loading' || identity.status === 'anonymous') throw new Error('学习会话尚未准备好。');
        const frozen = { ...context };
        const assertCurrent = () => {
          document();
          const current = this.host.readingContext?.(documentId);
          const session = this.host.session();
          if (session.accountId !== identity.accountId || session.status !== identity.status || !current ||
            current.documentVersion !== frozen.documentVersion || current.profileDigest !== frozen.profileDigest ||
            current.maxPages !== frozen.maxPages || current.maxChars !== frozen.maxChars) throw new Error('学习会话已切换。');
        };
        return readBoundedEvidence(pages, frozen, continuation, document().pages.length, async page => {
          const doc = document();
          const rectangles = await this.engine.getPageTextRects(doc, doc.pages[page - 1]).toPromise();
          assertCurrent();
          const text = rectangles.length ? await this.engine.extractText(doc, [page - 1]).toPromise() : '';
          assertCurrent(); readPages.add(page);
          return text;
        }, assertCurrent);
      },
      regions: () => (this.snapshot(documentId).regions || []).map(region => ({ ...region, region: { ...region.region } })),
      selection: async () => {
        document();
        const context = this.host.readingContext?.(documentId);
        const identity = this.host.session();
        const selection = this.registry.getPlugin<SelectionPlugin>('selection')!.provides().forDocument(documentId);
        const ranges = selection.getFormattedSelection();
        if (!ranges.length) return [];
        if (context && ranges.length > context.maxPages) throw new Error('选中的原文超过本次读取范围，请缩小选区。');
        const texts = await selection.getSelectedText().toPromise();
        document();
        if (context) {
          const current = this.host.readingContext?.(documentId);
          const session = this.host.session();
          if (!current || current.documentVersion !== context.documentVersion || current.profileDigest !== context.profileDigest ||
            current.maxPages !== context.maxPages || current.maxChars !== context.maxChars || session.accountId !== identity.accountId || session.status !== identity.status) throw new Error('学习会话已切换。');
          // Learning selections are complete excerpts. Never reuse the legacy
          // tool's silent per-page clipping and label a clipped excerpt whole.
          let characters = 0;
          const result = ranges.map((range, index) => {
            const text = texts[index] || '';
            if (text.length > context.maxChars * 2 || (characters += Array.from(text).length) > context.maxChars) throw new Error('选中的原文超过本次读取范围，请缩小选区。');
            return { page: range.pageIndex + 1, text };
          });
          result.forEach(item => readPages.add(item.page));
          return result;
        }
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

  private async send(id: string, action?: RinCheckAction, actionMessage?: string, recover = false): Promise<void> {
    if (this.changingConversation.has(id)) return;
    const session = this.host.session();
    const record = this.snapshot(id);
    const retry = recover ? record.pendingRequest : undefined;
    const message = retry?.message || actionMessage || record.draft.trim();
    const selectedAction = retry ? retry.action : action || record.draftAction;
    const submittedDraft = !recover && actionMessage === undefined;
    if (record.running || record.recoverable && !recover || !message) return;
    if (!this.isDocumentReady(id)) { this.update(id, { error: 'PDF 尚未准备好，请稍后重试。' }); return; }
    if (session.status !== 'authenticated' && session.status !== 'test') {
      try { await this.host.login(); }
      catch (error) { this.update(id, { error: error instanceof Error ? error.message : '请先登录。' }); }
      return;
    }
    const controller = new AbortController();
    const accountId = session.accountId;
    const conversationVersion = this.host.conversationVersion?.(id);
    const stillCurrent = () => accountId === this.host.session().accountId && conversationVersion === this.host.conversationVersion?.(id);
    const pages = new Set<number>();
    this.pending.set(id, controller);
    const optimistic = recover ? { running: true, error: undefined } : {
      messages: [...record.messages, { role: 'user' as const, text: message }],
      draft: submittedDraft ? '' : record.draft,
      regions: submittedDraft ? [] : record.regions,
      draftAction: submittedDraft ? undefined : record.draftAction,
      running: true,
      error: undefined,
    };
    if (!this.update(id, optimistic)) { this.pending.delete(id); return; }
    try {
      const reply = await this.host.send({ documentId: id, message, action:selectedAction, tools: this.tools(id, controller.signal, pages), signal: controller.signal });
      if (controller.signal.aborted || !stillCurrent()) return;
      const current = this.snapshot(id);
      this.update(id, { messages: [...current.messages,
        { role: 'assistant', text: reply.text, pages: reply.pages?.filter(page => pages.has(page)), lesson: reply.lesson }],
        pendingRequest: undefined, recoverable: false, costSG: reply.costSG, usage: reply.usage });
    } catch (error) {
      if (stillCurrent()) {
        const restored = this.host.restore(id);
        this.update(id, {
          error: error instanceof Error ? error.message : '请求失败，请重试。',
          recoverable: restored?.recoverable ?? true, pendingRequest: restored?.pendingRequest,
        });
      }
    } finally {
      if (stillCurrent()) this.update(id, { running: false });
      if (this.pending.get(id) === controller) this.pending.delete(id);
    }
  }

  protected buildCapability(): RinCapability {
    return {
      panelWidth: () => this.panelWidth,
      resizePanel: width => {
        if (!Number.isFinite(width)) return;
        this.panelWidth = Math.max(320, Math.min(800, Math.round(width)));
        try { this.host.savePanelWidth?.(this.panelWidth); }
        catch { /* Keep the current layout when preference storage is full. */ }
      },
      session: () => this.host.session(),
      ready: id => this.isDocumentReady(id),
      login: () => this.host.login(),
      snapshot: id => this.snapshot(id),
      subscribe: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
      draft: (id, text) => this.update(id, { draft: text.slice(0, 8000) }),
      tools: id => this.tools(id),
      canStartConversation: id => !this.changingConversation.has(id) && !this.pending.has(id) && Boolean(this.host.newConversation && this.host.canStartConversation?.(id)),
      history: id => this.host.history?.(id) || [],
      canDeleteConversation: (id, conversationId) => !this.changingConversation.has(id) && !this.pending.has(id) && Boolean(this.host.deleteConversation && this.host.canDeleteConversation?.(id, conversationId)),
      voice: id => this.isDocumentReady(id) && !this.changingConversation.has(id) ? this.host.voice?.(id) : undefined,
      confirmVoiceTranscript: async (id, text) => {
        const voice = this.isDocumentReady(id) && !this.changingConversation.has(id) ? this.host.voice?.(id) : undefined;
        if (!voice) throw new Error('语音当前不可用。');
        const accountId = this.host.session().accountId;
        const conversationVersion = this.host.conversationVersion?.(id);
        const draft = await voice.confirmTranscript(text);
        if (accountId !== this.host.session().accountId || conversationVersion !== this.host.conversationVersion?.(id) || this.host.voice?.(id) !== voice) {
          throw new Error('账号、PDF 或对话已切换。');
        }
        this.records.set(id, { ...this.snapshot(id), draft, error: undefined });
        this.notify();
      },
      canCaptureRegion: id => this.isDocumentReady(id) && !this.changingConversation.has(id) && !this.pending.has(id) &&
        ['authenticated', 'test'].includes(this.host.session().status) && Boolean(this.host.readingContext?.(id)) && Boolean(this.registry.getPlugin<CapturePlugin>('capture')),
      beginRegionCapture: id => {
        if (!this.isDocumentReady(id) || this.changingConversation.has(id) || this.pending.has(id) ||
          !['authenticated', 'test'].includes(this.host.session().status) || !this.host.readingContext?.(id)) return;
        const capture = this.registry.getPlugin<CapturePlugin>('capture')?.provides();
        if (!capture) return;
        this.regionCapture.add(id);
        capture.forDocument(id).enableMarqueeCapture();
        this.notify();
      },
      regionCaptureActive: id => this.regionCapture.has(id),
      cancelRegionCapture: id => {
        this.regionCapture.delete(id);
        this.registry.getPlugin<CapturePlugin>('capture')?.provides().forDocument(id).disableMarqueeCapture();
        this.notify();
      },
      confirmRegion: async (id, input) => {
        const context = this.host.readingContext?.(id);
        const page = this.coreState.core.documents[id]?.document?.pages[input.page - 1];
        const rect = input.rect;
        const text = input.text.trim();
        if (!this.regionCapture.has(id) || !context || !page || !text || text.length > context.maxChars || !/^[0-9a-f]{64}$/.test(input.imageDigest) ||
          ![rect.origin.x, rect.origin.y, rect.size.width, rect.size.height].every(Number.isFinite) || rect.origin.x < 0 || rect.origin.y < 0 ||
          rect.size.width <= 0 || rect.size.height <= 0 || rect.origin.x + rect.size.width > page.size.width + 0.001 || rect.origin.y + rect.size.height > page.size.height + 0.001) {
          throw new Error('原文区域无效，请重新选择。');
        }
        const ppm = (value: number, total: number) => Math.max(0, Math.min(1000000, Math.round(value / total * 1000000)));
        const region = { x: ppm(rect.origin.x, page.size.width), y: ppm(rect.origin.y, page.size.height),
          width: ppm(rect.size.width, page.size.width), height: ppm(rect.size.height, page.size.height) };
        if (region.width < 1 || region.height < 1 || region.x + region.width > 1000000 || region.y + region.height > 1000000) throw new Error('原文区域无效，请重新选择。');
        const digest = await evidenceDigest(text);
        const regionId = 'region-' + await evidenceDigest([context.documentVersion, input.page, region.x, region.y, region.width, region.height, input.imageDigest, digest].join('\0'));
        const evidence = { id: regionId, documentVersion: context.documentVersion, page: input.page, text, digest, complete: true as const,
          kind: 'region-transcription' as const, region, imageDigest: input.imageDigest, confirmation: 'user' as const };
        const current = this.host.readingContext?.(id);
        if (!current || current.documentVersion !== context.documentVersion || current.profileDigest !== context.profileDigest || !this.regionCapture.has(id)) throw new Error('学习会话已切换。');
        const existing = this.snapshot(id).regions || [];
        if (existing.length >= context.maxPages || existing.reduce((sum, value) => sum + Array.from(value.text).length, 0) + Array.from(text).length > context.maxChars) throw new Error('区域原文超过本次读取范围。');
        this.regionCapture.delete(id);
        this.update(id, { regions: [...existing.filter(value => value.id !== evidence.id), evidence] });
      },
      removeRegion: (id, evidenceId) => {
        if (this.pending.has(id) || this.changingConversation.has(id)) return;
        this.update(id, { regions: (this.snapshot(id).regions || []).filter(region => region.id !== evidenceId) });
      },
      deleteConversation: async (id, conversationId) => {
        if (!this.host.deleteConversation || !this.host.canDeleteConversation?.(id, conversationId) || this.pending.has(id) || this.changingConversation.has(id)) throw new Error('请先停止当前任务。');
        const identity = this.host.session().accountId;
        this.changingConversation.add(id); this.notify();
        try { await this.host.deleteConversation(id, conversationId); }
        finally {
          if (identity === this.host.session().accountId) { this.records.delete(id); this.snapshot(id); }
          this.changingConversation.delete(id); this.notify();
        }
      },
      readHistory: async (id, conversationId) => {
        const identity = this.host.session().accountId;
        if (!this.host.readHistory) throw new Error('对话记录暂不可用。');
        const snapshot = await this.host.readHistory(id, conversationId);
        if (identity !== this.host.session().accountId) throw new Error('账号已切换。');
        return snapshot;
      },
      newConversation: async id => {
        if (this.pending.has(id) || this.changingConversation.has(id) || !this.host.canStartConversation?.(id) || !this.host.newConversation) return;
        const identity = this.host.session().accountId;
        this.changingConversation.add(id); this.notify();
        try {
          await this.host.newConversation(id);
          if (identity !== this.host.session().accountId) return;
          this.records.delete(id); this.snapshot(id);
        } catch (error) {
          if (identity === this.host.session().accountId) this.update(id, { error: error instanceof Error ? error.message : '无法开始新对话。' });
        } finally { this.changingConversation.delete(id); this.notify(); }
      },
      send: id => this.send(id),
      retry: id => this.send(id, undefined, undefined, true),
      canCheck: id => Boolean(this.host.readingContext?.(id)),
      canHint: (id, checkId) => this.host.canHint?.(id,checkId) ?? true,
      selectCheck: (id, action) => { if (!this.changingConversation.has(id)) this.update(id, { draftAction: action }); },
      check: async (id, action) => {
        if (this.snapshot(id).recoverable) return;
        const labels = { hint: '给我一个提示。', reveal: '查看这道题的答案。', skip: '跳过这道题。' };
        if (action.kind === 'attempt' || action.kind === 'challenge') { this.update(id, { draftAction: action }); return; }
        await this.send(id, action, labels[action.kind]);
      },
      stop: async id => {
        this.pending.get(id)?.abort();
        try { await this.host.stop(id); this.update(id, { recoverable: false, pendingRequest: undefined, error: undefined }); }
        catch (error) { this.update(id, { error: error instanceof Error ? error.message : '停止状态待确认。' }); }
      },
    };
  }

  protected onActiveDocumentChanged(previousId: string | null) { if (previousId) this.pending.get(previousId)?.abort(); }
  protected onDocumentClosed(id: string) { this.pending.get(id)?.abort(); this.regionCapture.delete(id); this.records.delete(id); }
  destroy() {
    this.unsubscribe?.();
    this.pending.forEach(controller => controller.abort());
    this.regionCapture.clear();
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
