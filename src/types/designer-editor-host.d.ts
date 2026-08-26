export interface EmbeddedEditorHandle {
  destroy(): void;
  getSchema(): Record<string, unknown>;
}

export declare function mountEmbeddedEditorModal(opts: {
  container?: HTMLElement;
  initialSchema: { type: string; components: unknown[]; [k: string]: unknown };
  onSave: (schema: Record<string, unknown>) => void | Promise<void>;
  onClose?: () => void;
}): Promise<EmbeddedEditorHandle>;
