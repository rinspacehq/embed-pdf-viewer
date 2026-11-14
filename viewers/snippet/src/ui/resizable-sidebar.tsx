// SPDX-License-Identifier: MIT
import { h, ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/** Optional renderer props; persistence belongs to the application callback. */
export type SidebarResizeOptions = {
  width: number;
  minWidth?: number;
  maxWidth?: number;
  onWidthChange?(width: number): void;
};

export function ResizableSidebar({ id, placement, className, container, options, children }: {
  id: string;
  placement: 'left' | 'right';
  className: string;
  container: HTMLElement;
  options: SidebarResizeOptions;
  children: ComponentChildren;
}) {
  const bounds = () => {
    const maximum = Math.min(options.maxWidth ?? 800, Math.max(0, container.clientWidth - 320));
    return { min: Math.min(options.minWidth ?? 320, maximum), max: maximum };
  };
  const clamp = (value: number) => {
    const { min, max } = bounds();
    return Math.round(Math.max(min, Math.min(max, value)));
  };
  const [width, setWidth] = useState(() => clamp(options.width));
  const liveWidth = useRef(width);
  const drag = useRef<{ id: number; x: number; width: number; cursor: string; select: string }>();
  const handle = useRef<HTMLDivElement>(null);
  const update = (value: number) => { liveWidth.current = clamp(value); setWidth(liveWidth.current); };
  const restoreCursor = () => {
    const active = drag.current;
    if (!active) return;
    const style = container.ownerDocument.documentElement.style;
    if (style.cursor === 'col-resize') style.cursor = active.cursor;
    if (style.userSelect === 'none') style.userSelect = active.select;
  };
  const finish = (cancel: boolean) => {
    const active = drag.current;
    if (!active) return;
    restoreCursor();
    drag.current = undefined;
    if (handle.current?.hasPointerCapture(active.id)) handle.current.releasePointerCapture(active.id);
    if (cancel) update(active.width);
    else options.onWidthChange?.(liveWidth.current);
  };
  useEffect(() => {
    const observer = new ResizeObserver(() => update(liveWidth.current));
    observer.observe(container);
    return () => { observer.disconnect(); restoreCursor(); };
  }, [container]);
  useEffect(() => { if (!drag.current) update(options.width); }, [options.width]);
  const { min, max } = bounds();
  return <div id={id} data-sidebar-id={id} className={`${className} relative shrink-0`} style={{ width: `${width}px` }}>
    <div ref={handle} role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" tabIndex={0}
      aria-controls={id} aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
      className={`absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${placement === 'right' ? '-left-1' : '-right-1'}`}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
        const style = container.ownerDocument.documentElement.style;
        drag.current = { id: event.pointerId, x: event.clientX, width: liveWidth.current, cursor: style.cursor, select: style.userSelect };
        event.currentTarget.setPointerCapture(event.pointerId);
        style.cursor = 'col-resize'; style.userSelect = 'none';
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        update(active.width + (event.clientX - active.x) * (placement === 'right' ? -1 : 1));
      }}
      onPointerUp={event => { if (drag.current?.id === event.pointerId) finish(false); }}
      onPointerCancel={event => { if (drag.current?.id === event.pointerId) finish(true); }}
      onLostPointerCapture={() => finish(true)}
      onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const direction = (event.key === 'ArrowLeft' ? -1 : 1) * (placement === 'right' ? -1 : 1);
        update(event.key === 'Home' ? min : event.key === 'End' ? max : liveWidth.current + direction * (event.shiftKey ? 64 : 16));
        options.onWidthChange?.(liveWidth.current);
      }} />
    {children}
  </div>;
}
