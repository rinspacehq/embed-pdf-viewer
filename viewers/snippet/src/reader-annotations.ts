// SPDX-License-Identifier: MIT
import type { AnnotationScope, AnnotationTransferItem } from '@embedpdf/plugin-annotation';
import type { ReaderAnnotationHost } from './reader-api';

export function bindReaderAnnotations(scope: AnnotationScope, host: ReaderAnnotationHost) {
  const slots = new Map<string, number>();
  const restoring = new Set<string>();
  const keyFor = (page: number, id: string) => JSON.stringify([page, id]);

  return scope.onAnnotationEvent(event => {
    if (event.type === 'loaded') {
      const originals = new Map<number, AnnotationTransferItem['annotation'][]>();
      for (const [page, ids] of Object.entries(scope.getState().pages)) {
        const annotations = ids.map(id => scope.getState().byUid[id].object);
        originals.set(Number(page), annotations);
        annotations.forEach((annotation, slot) => {
          slots.set(keyFor(Number(page), annotation.id), slot);
        });
      }
      const imports: AnnotationTransferItem[] = [];
      try {
        for (const { pageIndex, anchor, item } of host.edits) {
          if (typeof anchor === 'string') {
            if (item) {
              restoring.add(keyFor(pageIndex, item.annotation.id));
              imports.push(item);
            }
            continue;
          }
          const original = originals.get(pageIndex)?.[anchor];
          if (!original || item && original.type !== item.annotation.type) {
            host.onRestoreError();
            continue;
          }
          restoring.add(keyFor(pageIndex, original.id));
          if (item) {
            const { id, ...patch } = item.annotation;
            scope.updateAnnotation(pageIndex, original.id, patch);
          } else {
            scope.deleteAnnotation(pageIndex, original.id);
          }
        }
        if (imports.length) scope.importAnnotations(imports);
      } catch {
        host.onRestoreError();
      }
      return;
    }
    if (!event.committed) return;
    const { annotation, pageIndex } = event;
    const key = keyFor(pageIndex, annotation.id);
    if (restoring.delete(key)) return;
    const item = event.type === 'delete' ? null : {
      annotation,
      ...(event.type === 'create' && event.ctx ? { ctx: event.ctx } : {}),
    };
    host.onEdit({ pageIndex, anchor: slots.get(key) ?? annotation.id, item });
  });
}
