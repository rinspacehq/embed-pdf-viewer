// SPDX-License-Identifier: MIT
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { usePlugin } from '@embedpdf/core/preact';
import { UIPlugin } from '@embedpdf/plugin-ui';
import { RinPlugin } from './plugin';

export function RinPanel({ documentId }: { documentId: string }) {
  const { plugin } = usePlugin<RinPlugin>('rin');
  const { plugin: ui } = usePlugin<UIPlugin>('ui');
  const capability = plugin?.provides();
  const [, refresh] = useState(0);
  useEffect(() => capability?.subscribe(() => refresh(value => value + 1)), [capability]);
  if (!capability) return null;
  const record = capability.snapshot(documentId);
  const session = capability.session();
  return <section className="flex h-full min-h-0 flex-col text-fg-primary" aria-label="琳">
    <div className="border-border-default flex items-center justify-between border-b p-3 font-semibold"><span>琳</span>
      <button type="button" aria-label="收起琳" className="rounded px-2 py-1" onClick={() => ui?.provides().forDocument(documentId).closeSidebarSlot('right', 'main')}>×</button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-3" aria-live="polite">
      {record.messages.map((message, index) => <article key={index} className="mb-4">
        <div className="mb-1 text-xs text-fg-secondary">{message.role === 'user' ? '你' : '琳'}</div>
        <div className="select-text whitespace-pre-wrap break-words text-sm">{message.text}</div>
        {message.pages?.map(page => <button key={page} type="button" className="mr-2 mt-2 rounded border px-2 py-1 text-xs" onClick={() => capability.tools(documentId).navigate(page)}>第 {page} 页</button>)}
      </article>)}
      {record.running && <p role="status" className="text-sm text-fg-secondary">正在阅读…</p>}
      {record.error && <p role="alert" className="mt-2 text-sm">{record.error}</p>}
    </div>
    <form className="border-border-default border-t p-3" onSubmit={event => { event.preventDefault(); void capability.send(documentId); }}>
      <textarea className="border-border-default bg-bg-surface w-full resize-none rounded border p-2 text-sm" rows={3} maxLength={8000} disabled={record.running} aria-label="发给琳的消息" value={record.draft} onInput={event => capability.draft(documentId, event.currentTarget.value)} />
      <div className="mt-2 flex items-center justify-between gap-2">
        {record.costSG !== undefined ? <details className="text-xs text-fg-secondary"><summary>实扣 {Number(record.costSG.toFixed(6))} 善功</summary>
          {record.usage && <p className="mt-2">输入 {record.usage.inputTokens} token · 输出 {record.usage.outputTokens} token</p>}
        </details> : <span />}
        <div className="flex gap-2">
          {(record.running || record.recoverable) && <button className="rounded border px-3 py-1" type="button" onClick={() => { void capability.stop(documentId); }}>停止</button>}
          {!record.running && <button className="rounded border px-3 py-1" disabled={!capability.ready(documentId) || session.status === 'loading' || !record.draft.trim()} type="submit">{session.status === 'anonymous' ? '登录' : '发送'}</button>}
        </div>
      </div>
    </form>
  </section>;
}
