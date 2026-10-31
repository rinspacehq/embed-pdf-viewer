// SPDX-License-Identifier: MIT
import { EmbedPdfContainer } from './web-components/container';
import { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { ZoomPlugin, ZoomMode } from '@embedpdf/plugin-zoom';
import { RenderPlugin } from '@embedpdf/plugin-render';
import { ViewportPlugin } from '@embedpdf/plugin-viewport';
import type { ReaderHandle, ReaderOptions } from './reader-api';
export type { ReaderHandle, ReaderOptions } from './reader-api';

/** Native viewer with same-origin assets and a small framework-neutral host boundary. */
export async function initReader(options: ReaderOptions): Promise<ReaderHandle> {
  const viewer = document.createElement('embedpdf-container') as EmbedPdfContainer;
  viewer.config = {
    wasmUrl: options.wasmUrl, fonts: { ui: null, signature: null }, fontFallback: null,
    stamp: { manifests: [] }, tabBar: 'never', rin: { host: options.host },
    i18n: { defaultLocale: options.locale || 'en' },
    zoom: { defaultZoomLevel: ZoomMode.FitPage },
    commands: { commands: {
      'document:open': { id: 'document:open', labelKey: 'document.open', icon: 'fileImport', shortcuts: ['Ctrl+O', 'Meta+O'], categories: ['document'], action: options.onOpenFile },
      'document:close': { id: 'document:close', labelKey: 'document.close', categories: ['document'], action: options.onClose },
    } },
  };
  options.target.append(viewer);
  let cleanup = () => { viewer.remove(); };
  try {
    const registry = await viewer.registry;
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
    }), scroll.onScroll(sample), zoom.onZoomChange(sample),
      registry.getPlugin<ViewportPlugin>('viewport')!.provides().onViewportResize(event => { if (event.documentId === id) restoreAfterLayout(); })];
    cleanup = () => { destroyed = true; clearTimeout(resizeTimer); window.removeEventListener('resize', restoreAfterLayout);
      viewer.removeEventListener('wheel', userScroll, true); viewer.removeEventListener('touchmove', userScroll, true);
      unsubscribe.forEach(stop => stop()); viewer.remove(); };
    const opened = await manager.openDocumentBuffer({ buffer: options.buffer, name: options.title, documentId: id }).toPromise();
    void opened.task.toPromise().catch(() => {}); // Native password/error UI owns retry.
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
