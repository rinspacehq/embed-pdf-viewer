// SPDX-License-Identifier: MIT
import { UIPlugin, type UISchema } from '@embedpdf/plugin-ui';
import type { Command } from '@embedpdf/plugin-commands';

export const rinCommand: Command = {
  id: 'rin:toggle', label: '琳', categories: ['rin'],
  action: ({ registry, documentId }) => registry.getPlugin<UIPlugin>('ui')?.provides().forDocument(documentId).toggleSidebar('right', 'main', 'rin-panel'),
};

export function withRinUI(schema: UISchema): UISchema {
  const toolbar = schema.toolbars?.['main-toolbar'];
  return {
    ...schema,
    toolbars: { ...schema.toolbars, ...(toolbar ? {
      'main-toolbar': { ...toolbar, items: [...toolbar.items,
        { type: 'command-button', id: 'rin-button', commandId: 'rin:toggle', variant: 'text' }] },
    } : {}) },
    sidebars: { ...schema.sidebars,
      'rin-panel': { id: 'rin-panel', position: { placement: 'right', slot: 'main', order: 0 },
        content: { type: 'component', componentId: 'rin-panel' }, width: '360px', collapsible: true, defaultOpen: false },
    },
  };
}
