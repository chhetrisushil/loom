// Lazily code-split chart implementation — imported on demand by the
// LatencyChart custom element (the platform's equivalent of React.lazy).
export function renderBars(host: HTMLElement, data: number[]): void {
  const bars = document.createElement("div");
  bars.className = "bars";
  const max = data.length ? Math.max(...data) : 1;
  for (const v of data.slice(-16)) {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.max(4, (v / (max || 1)) * 100)}%`;
    bar.title = String(Math.round(v));
    bars.appendChild(bar);
  }
  host.appendChild(bars);
}
