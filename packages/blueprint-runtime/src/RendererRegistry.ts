// Generic widget registry — framework-agnostic.
// TRenderer is narrowed by each framework adapter:
//   React:   RendererRegistry<React.FC<WidgetRendererProps>>
//   Angular: RendererRegistry<Type<unknown>>
//   DOM:     RendererRegistry<(el: HTMLElement, props: WidgetRendererProps) => void>

export class RendererRegistry<TRenderer> {
  private readonly renderers = new Map<string, TRenderer>();

  register(kind: string, renderer: TRenderer): this {
    this.renderers.set(kind, renderer);
    return this;
  }

  get(kind: string): TRenderer | undefined {
    return this.renderers.get(kind);
  }

  has(kind: string): boolean {
    return this.renderers.has(kind);
  }

  kinds(): string[] {
    return Array.from(this.renderers.keys());
  }

  // Returns a new registry that contains all renderers from both registries.
  // Entries in `other` win on conflicts.
  merge(other: RendererRegistry<TRenderer>): RendererRegistry<TRenderer> {
    const merged = new RendererRegistry<TRenderer>();
    for (const [kind, r] of this.renderers) merged.register(kind, r);
    for (const kind of other.kinds()) {
      const r = other.get(kind);
      if (r !== undefined) merged.register(kind, r);
    }
    return merged;
  }
}
