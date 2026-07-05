import { CommonModule } from "@angular/common";
import { Component, computed, inject } from "@angular/core";
import { LoomService } from "./loom.service";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [CommonModule],
  styles: [
    `
    :host { display: block; }

    .shell {
      min-height: 100vh;
      background: #0d1117;
      color: #e2e8f0;
      font-family: system-ui, -apple-system, sans-serif;
      padding: 0 0 40px;
    }

    .header {
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .header h1 { font-size: 18px; font-weight: 600; color: #f0f6fc; }
    .header .sub { font-size: 12px; color: #8b949e; }
    .badge-angular {
      background: #c3002f;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      letter-spacing: 0.04em;
    }
    .badge-phase {
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 12px;
      margin-left: auto;
    }
    .phase-idle      { background: #21262d; color: #8b949e; }
    .phase-running   { background: #1c3a5e; color: #58a6ff; }
    .phase-suspended { background: #3d2c00; color: #e3b341; }
    .phase-completed { background: #1a3f2b; color: #3fb950; }
    .phase-failed    { background: #3d1c1c; color: #f85149; }

    .main { max-width: 960px; margin: 0 auto; padding: 24px; }

    .toolbar {
      display: flex;
      gap: 10px;
      margin-bottom: 24px;
      align-items: center;
    }

    .btn {
      padding: 8px 16px;
      border-radius: 6px;
      border: 1px solid transparent;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary  { background: #238636; border-color: #2ea043; color: #fff; }
    .btn-warning  { background: #9e6a03; border-color: #e3b341; color: #fff; }
    .btn-ghost    { background: #21262d; border-color: #30363d; color: #c9d1d9; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }

    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 16px;
    }
    .card-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #8b949e;
      margin-bottom: 12px;
    }

    .metric-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
    .metric-label { color: #8b949e; }
    .metric-value { font-weight: 600; color: #f0f6fc; font-variant-numeric: tabular-nums; }
    .metric-value.warn { color: #e3b341; }
    .metric-value.danger { color: #f85149; }

    .bar-track { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; margin-top: 4px; }
    .bar-fill  { height: 100%; border-radius: 3px; transition: width 0.3s; }

    .approval-banner {
      grid-column: 1 / -1;
      background: #3d2c00;
      border: 1px solid #9e6a03;
      border-radius: 8px;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .approval-banner .title { font-size: 14px; font-weight: 600; color: #e3b341; }
    .approval-banner .sub   { font-size: 12px; color: #b08800; margin-top: 4px; }

    .log-card { grid-column: 1 / -1; }
    .log-list { list-style: none; max-height: 220px; overflow-y: auto; }
    .log-item {
      display: flex;
      gap: 12px;
      padding: 6px 0;
      border-bottom: 1px solid #21262d;
      font-size: 12px;
      font-family: "SF Mono", Menlo, monospace;
    }
    .log-time  { color: #484f58; min-width: 70px; }
    .log-label { color: #58a6ff; min-width: 180px; font-weight: 600; }
    .log-payload { color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px; }

    .empty { padding: 40px; text-align: center; color: #484f58; font-size: 14px; }

    .resolved-banner {
      grid-column: 1 / -1;
      background: #1a3f2b;
      border: 1px solid #2ea043;
      border-radius: 8px;
      padding: 20px;
    }
    .resolved-banner h3 { font-size: 16px; color: #3fb950; margin-bottom: 8px; }
    .resolved-banner p  { font-size: 13px; color: #8b949e; }

    .exec-id { font-size: 11px; color: #484f58; font-family: monospace; }
  `,
  ],
  template: `
    <div class="shell">
      <header class="header">
        <div>
          <div style="display:flex; align-items:center; gap:8px;">
            <h1>Cloud Command Center</h1>
            <span class="badge-angular">Angular</span>
          </div>
          <div class="sub">Powered by @loom/workflow-runtime &nbsp;—&nbsp; framework-agnostic durable workflows</div>
        </div>
        <span class="badge-phase" [ngClass]="phaseCls()">
          {{ loom.phase() | uppercase }}
        </span>
      </header>

      <main class="main">
        <div class="toolbar">
          <button class="btn btn-primary"
                  [disabled]="loom.phase() !== 'idle' && loom.phase() !== 'completed' && loom.phase() !== 'failed'"
                  (click)="runInvestigation()">
            &#9654; Run Investigation
          </button>
          <button class="btn btn-warning"
                  [disabled]="loom.phase() !== 'suspended'"
                  (click)="approve()">
            &#10003; Approve Remediation
          </button>
          <button class="btn btn-ghost" (click)="reset()">
            &#8635; Reset
          </button>
          @if (loom.executionId()) {
            <span class="exec-id">exec: {{ loom.executionId() }}</span>
          }
        </div>

        @if (loom.phase() === 'idle') {
          <div class="empty">
            Click <strong>Run Investigation</strong> to start a durable incident workflow.
            Loom's runtime is framework-agnostic — no React, no Angular adapter needed.
          </div>
        }

        @if (loom.phase() !== 'idle') {
          <div class="grid">

            @if (loom.incidentState()?.pendingApproval) {
              <div class="approval-banner">
                <div>
                  <div class="title">&#9888; Approval Required</div>
                  <div class="sub">
                    Metrics and logs analyzed. Workflow is durably suspended,
                    awaiting operator sign-off before applying remediation.
                  </div>
                </div>
                <button class="btn btn-warning" (click)="approve()">Approve</button>
              </div>
            }

            @if (loom.incidentState()?.summary) {
              <div class="resolved-banner">
                <h3>&#10003; Incident Resolved</h3>
                <p>{{ loom.incidentState()?.summary }}</p>
              </div>
            }

            @if (loom.incidentState()?.metrics; as m) {
              <div class="card">
                <div class="card-title">System Metrics</div>

                <div class="metric-row">
                  <span class="metric-label">CPU Usage</span>
                  <span class="metric-value danger">{{ m.cpu.current }}%</span>
                </div>
                <div class="bar-track">
                  <div class="bar-fill" style="background:#f85149"
                       [style.width.%]="m.cpu.current"></div>
                </div>

                <div class="metric-row" style="margin-top:12px">
                  <span class="metric-label">Memory</span>
                  <span class="metric-value warn">{{ m.memory.usedMb | number }}MB / {{ m.memory.totalMb | number }}MB</span>
                </div>
                <div class="bar-track">
                  <div class="bar-fill" style="background:#e3b341"
                       [style.width.%]="(m.memory.usedMb / m.memory.totalMb) * 100"></div>
                </div>

                <div class="metric-row" style="margin-top:12px">
                  <span class="metric-label">DB Connections</span>
                  <span class="metric-value danger">{{ m.connections.active }} / {{ m.connections.max }}</span>
                </div>
                <div class="bar-track">
                  <div class="bar-fill" style="background:#f85149"
                       [style.width.%]="(m.connections.active / m.connections.max) * 100"></div>
                </div>
              </div>
            }

            @if (!loom.incidentState()?.metrics && loom.phase() !== 'idle') {
              <div class="card">
                <div class="card-title">System Metrics</div>
                <div class="empty" style="padding:24px">Fetching metrics…</div>
              </div>
            }

            @if (loom.incidentState()?.logs; as l) {
              <div class="card">
                <div class="card-title">Log Analysis</div>
                <div class="metric-row">
                  <span class="metric-label">Error Count</span>
                  <span class="metric-value danger">{{ l.errorCount }}</span>
                </div>
                <div class="metric-row">
                  <span class="metric-label">Top Error</span>
                  <span class="metric-value" style="font-size:12px; color:#f0f6fc">{{ l.topError }}</span>
                </div>
                <div class="metric-row">
                  <span class="metric-label">Time Range</span>
                  <span class="metric-value" style="color:#8b949e">{{ l.timeRange }}</span>
                </div>
              </div>
            }

            @if (!loom.incidentState()?.logs && loom.phase() !== 'idle') {
              <div class="card">
                <div class="card-title">Log Analysis</div>
                <div class="empty" style="padding:24px">Fetching logs…</div>
              </div>
            }

            <div class="card log-card">
              <div class="card-title">Event Log</div>
              @if (loom.eventLog().length === 0) {
                <div class="empty" style="padding:16px">Events will appear here…</div>
              } @else {
                <ul class="log-list">
                  @for (entry of loom.eventLog(); track entry.id) {
                    <li class="log-item">
                      <span class="log-time">{{ entry.time }}</span>
                      <span class="log-label">{{ entry.label }}</span>
                      <span class="log-payload">{{ entry.payload | json }}</span>
                    </li>
                  }
                </ul>
              }
            </div>

          </div>
        }
      </main>
    </div>
  `,
})
export class AppComponent {
  readonly loom = inject(LoomService);

  phaseCls = computed(() => `phase-${this.loom.phase()}`);

  runInvestigation(): void {
    void this.loom.startInvestigation(`INC-${Date.now().toString(36).toUpperCase()}`);
  }

  approve(): void {
    void this.loom.approve();
  }

  reset(): void {
    this.loom.reset();
  }
}
