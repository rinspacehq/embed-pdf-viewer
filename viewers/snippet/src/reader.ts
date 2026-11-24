// SPDX-License-Identifier: MIT
import { EmbedPdfContainer } from './web-components/container';
import { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { ZoomPlugin, ZoomMode } from '@embedpdf/plugin-zoom';
import { RenderPlugin } from '@embedpdf/plugin-render';
import { ViewportPlugin } from '@embedpdf/plugin-viewport';
import { AnnotationPlugin } from '@embedpdf/plugin-annotation';
import { bindReaderAnnotations } from './reader-annotations';
import { createReaderRangedEngine } from './reader-ranged-engine.js';
import type { ReaderHandle, ReaderOptions } from './reader-api';
export type { ReaderHandle, ReaderOptions, ReaderRangeSource } from './reader-api';

/** Native viewer with same-origin assets and a small framework-neutral host boundary. */
export async function initReader(options: ReaderOptions): Promise<ReaderHandle> {
  const { signal, rangeSource } = options;
  signal?.throwIfAborted();
  const viewer = document.createElement('embedpdf-container') as EmbedPdfContainer;
  let closed = false;
  let disposeListeners = () => {};
  const rangeError = (status: number) => {
    if (closed) return;
    cleanup();
    options.onRangeError?.(status);
  };
  const engine = rangeSource
    ? createReaderRangedEngine(new URL(options.wasmUrl, location.href).href, rangeSource, rangeError)
    : undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', abort);
    disposeListeners();
    engine?.destroy?.();
    viewer.remove();
  };
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = signal && new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    cleanup();
    rejectAbort(signal?.reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
  viewer.config = {
    engine, wasmUrl: options.wasmUrl, fonts: { ui: null, signature: null }, fontFallback: null,
    stamp: { manifests: [] }, tabBar: 'never', rin: { host: options.host },
    i18n: { defaultLocale: options.locale || 'en' },
    zoom: { defaultZoomLevel: ZoomMode.FitPage },
    commands: { commands: {
      'document:open': { id: 'document:open', labelKey: 'document.open', icon: 'fileImport', shortcuts: ['Ctrl+O', 'Meta+O'], categories: ['document'], action: options.onOpenFile },
      'document:close': { id: 'document:close', labelKey: 'document.close', categories: ['document'], action: options.onClose },
    } },
  };
  options.target.append(viewer);
  try {
    const registry = await (aborted ? Promise.race([viewer.registry, aborted]) : viewer.registry);
    const id = options.documentId;
    const manager = registry.getPlugin<DocumentManagerPlugin>('document-manager')!.provides();
    const scrolling = registry.getPlugin<ScrollPlugin>('scroll')!.provides();
    const scroll = scrolling.forDocument(id);
    const zoom = registry.getPlugin<ZoomPlugin>('zoom')!.provides().forDocument(id);
    let ready = false;
    let restored = false;
    let destroyed = false;
    let resizing = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastView = options.view || { pageIndex: 0, pageOffsetRatio: 0, zoom: 'fit-page' as const };
    const sample = () => {
      if (!ready || destroyed || resizing) return;
      const metrics = scroll.getMetrics();
      const pageIndex = metrics.currentPage - 1;
      const page = manager.getDocument(id)?.pages[pageIndex];
      if (!page) return;
      const visible = metrics.pageVisibilityMetrics.find(item => item.pageNumber === metrics.currentPage);
      if (!visible || scroll.getPageChangeState().isChanging) return;
      const level = zoom.getState().zoomLevel;
      lastView = { pageIndex, pageOffsetRatio: Math.max(0, visible.original.pageY) / page.size.height,
        zoom: level === ZoomMode.Automatic ? 'fit-width' : level };
      options.onViewChange(lastView);
    };
    // Native desktop/mobile layouts remount their viewport. Restore after their
    // 150 ms auto-zoom debounce, and don't persist the transient first page.
    const restoreAfterLayout = () => {
      if (!restored || destroyed) return;
      resizing = true;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (destroyed) return;
        const page = manager.getDocument(id)?.pages[lastView.pageIndex];
        if (page) scroll.scrollToPage({ pageNumber: lastView.pageIndex + 1,
          pageCoordinates: { x: 0, y: page.size.height * lastView.pageOffsetRatio }, alignY: 0, behavior: 'instant' });
        requestAnimationFrame(() => requestAnimationFrame(() => { if (!destroyed) { resizing = false; ready = true; sample(); } }));
      }, 250);
    };
    window.addEventListener('resize', restoreAfterLayout);
    const userScroll = () => { clearTimeout(resizeTimer); resizing = false; ready = true; };
    viewer.addEventListener('wheel', userScroll, { capture: true, passive: true });
    viewer.addEventListener('touchmove', userScroll, { capture: true, passive: true });
    const unsubscribe = [scrolling.onLayoutReady(event => {
      if (event.documentId !== id || restored || destroyed) return;
      restored = true;
      const pageCount = manager.getDocument(id)?.pages.length || 0;
      const view = options.view;
      if (view && view.pageIndex < pageCount) {
        zoom.requestZoom(typeof view.zoom === 'number' ? view.zoom : view.zoom === 'fit-page' ? ZoomMode.FitPage : ZoomMode.FitWidth);
      } else zoom.requestZoom(ZoomMode.FitPage);
      restoreAfterLayout();
      options.onReady(pageCount);
    }), manager.onDocumentClosed(closedId => { if (closedId === id && !destroyed) options.onClose(); }),
      scroll.onScroll(sample), zoom.onZoomChange(sample),
      registry.getPlugin<ViewportPlugin>('viewport')!.provides().onViewportResize(event => { if (event.documentId === id) restoreAfterLayout(); })];
    if (options.annotations) {
      const scope = registry.getPlugin<AnnotationPlugin>('annotation')!.provides().forDocument(id);
      unsubscribe.push(bindReaderAnnotations(scope, options.annotations));
    }
    disposeListeners = () => { destroyed = true; clearTimeout(resizeTimer); window.removeEventListener('resize', restoreAfterLayout);
      viewer.removeEventListener('wheel', userScroll, true); viewer.removeEventListener('touchmove', userScroll, true);
      unsubscribe.forEach(stop => stop()); };
    const opened = await (rangeSource
      ? manager.openDocumentUrl({ url: new URL(rangeSource.url, location.href).href,
          name: options.title, documentId: id, mode: 'range-request' })
      : manager.openDocumentBuffer({ buffer: options.buffer, name: options.title, documentId: id })
    ).toPromise();
    // Native password/error UI owns retry for the local-file path.
    void opened.task.toPromise().catch(() => { if (rangeSource) rangeError(0); });
    return {
      destroy: cleanup,
      async thumbnail() {
        const first = manager.getDocument(id)?.pages[0];
        if (!first || destroyed) return;
        return registry.getPlugin<RenderPlugin>('render')!.provides().forDocument(id)
          .renderPage({ pageIndex: 0, options: { scaleFactor: 240 / first.size.width } }).toPromise();
      },
    };
  } catch (error) { cleanup(); throw error; }
}
