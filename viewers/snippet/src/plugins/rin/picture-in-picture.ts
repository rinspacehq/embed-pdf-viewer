// SPDX-License-Identifier: MIT

type DocumentPiP = {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
};

function documentPiP(view: Window): DocumentPiP | undefined {
  if (!('documentPictureInPicture' in view)) return;
  const api: unknown = view.documentPictureInPicture;
  if (typeof api !== 'object' || api === null || !('requestWindow' in api) || typeof api.requestWindow !== 'function') return;
  return api as DocumentPiP;
}

/** Moves one already-mounted panel. It never creates a second host or executor. */
export class RinPictureInPicture {
  private pip?: Window;
  private opening = false;
  private disposed = false;
  private release?: () => void;

  constructor(
    private readonly home: HTMLElement,
    private readonly content: HTMLElement,
    private readonly changed: (open: boolean) => void,
  ) {}

  get supported() { return Boolean(this.home.ownerDocument.defaultView && documentPiP(this.home.ownerDocument.defaultView)); }

  async open() {
    if (this.disposed || this.opening) return;
    if (this.pip && !this.pip.closed) { this.pip.focus(); return; }
    const original = this.home.ownerDocument;
    const opener = original.defaultView;
    const api = opener && documentPiP(opener);
    if (!api) throw new Error('当前浏览器不支持画中画。');
    this.opening = true;
    try {
      // Must be called directly from the user's gesture, before any awaits.
      const pip = await api.requestWindow({ width: 520, height: 640 });
      if (this.disposed || !this.home.isConnected) { pip.close(); return; }
      this.pip = pip;
      pip.document.title = '琳';
      pip.document.documentElement.lang = original.documentElement.lang;
      pip.document.body.style.cssText = 'margin:0;height:100dvh;overflow:hidden';
      const host = pip.document.createElement('div');
      host.style.cssText = 'height:100%;width:100%';
      const shadow = host.attachShadow({ mode: 'open' });
      const root = original.createElement('div');
      root.className = 'embedpdf-snippet-root';
      shadow.append(root);
      pip.document.body.append(host);
      const sourceRoot = this.home.getRootNode();
      const sourceStyleRoot = sourceRoot instanceof ShadowRoot ? sourceRoot : original;
      const sourceHost = sourceRoot instanceof ShadowRoot ? sourceRoot.host : original.documentElement;
      const viewerRoot = this.home.closest('.embedpdf-snippet-root') || sourceHost;
      const styles: Node[] = [];
      const syncStyles = () => {
        styles.splice(0).forEach(node => node.parentNode?.removeChild(node));
        for (const style of sourceStyleRoot.querySelectorAll('style,link[rel="stylesheet"]')) {
          const copy = style.cloneNode(true);
          shadow.insertBefore(copy, root);
          styles.push(copy);
        }
        // UI and MathJax webfonts live at Document scope in the normal viewer.
        for (const style of original.head.querySelectorAll('style,link[rel="stylesheet"]')) {
          const copy = style.cloneNode(true);
          pip.document.head.append(copy);
          styles.push(copy);
        }
        const computed = opener.getComputedStyle(viewerRoot);
        for (const property of Array.from(computed)) {
          if (property.startsWith('--ep-')) host.style.setProperty(property, computed.getPropertyValue(property));
        }
        host.style.colorScheme = opener.getComputedStyle(sourceHost).colorScheme;
      };
      syncStyles();
      const observer = new MutationObserver(records => {
        if (records.some(record => record.type === 'characterData' && record.target.parentElement?.tagName === 'STYLE'
          || record.target instanceof Element && record.target.matches('style,link[rel="stylesheet"]')
          || record.type === 'attributes' && record.target === viewerRoot
          || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && node.matches('style,link[rel="stylesheet"]')))) syncStyles();
      });
      observer.observe(sourceStyleRoot, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'href', 'class'] });
      if (sourceStyleRoot !== original) observer.observe(original.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href'] });
      const focused = sourceStyleRoot.activeElement;
      root.append(this.content);
      if (focused instanceof HTMLElement && this.content.contains(focused)) focused.focus({ preventScroll: true });
      let returned = false;
      const restore = () => {
        if (returned) return;
        returned = true;
        observer.disconnect();
        const active = shadow.activeElement;
        if (this.home.isConnected) {
          this.home.append(this.content);
          if (active instanceof HTMLElement && this.content.contains(active)) active.focus({ preventScroll: true });
        }
        opener.removeEventListener('pagehide', close);
        this.pip = undefined;
        this.release = undefined;
        if (!this.disposed) this.changed(false);
      };
      const close = () => { restore(); if (!pip.closed) pip.close(); };
      this.release = close;
      pip.addEventListener('pagehide', restore, { once: true });
      opener.addEventListener('pagehide', close, { once: true });
      this.changed(true);
      pip.requestAnimationFrame(() => {
        if (this.disposed || pip.closed || !root.contains(this.content)) return;
        const target = focused instanceof HTMLElement && this.content.contains(focused)
          ? focused : this.content.querySelector<HTMLElement>('textarea:not([disabled]),button');
        target?.focus({ preventScroll: true });
      });
    } catch (error) {
      this.close();
      throw error;
    } finally { this.opening = false; }
  }

  close() {
    if (this.release) this.release();
    else if (this.pip && !this.pip.closed) { this.pip.close(); this.pip = undefined; }
  }

  dispose() { this.disposed = true; this.close(); }
}
