/**
 * Web Dashboard Server
 * Provides a web interface to monitor and control the OPC UA simulator
 */

import express, { Express, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { ParameterSimulator, ParameterState } from '../simulation/parameter-simulator';
import { StationStateMachine } from '../simulation/station-state-machine';
import { listScenarios } from '../simulation/scenarios';
import { AcquisitionStatus } from '../types';

export interface DashboardOptions {
  port: number;
  simulator: ParameterSimulator;
  stateMachine: StationStateMachine;
}

interface DashboardState {
  stationState: {
    status: AcquisitionStatus;
    statusName: string;
    startedAt: Date | null;
    stoppedAt: Date | null;
  };
  scenario: {
    name: string;
    description: string;
  };
  parameters: {
    index: number;
    name: string;
    enabled: boolean;
    sampleValue: number;
    engValue: number;
    sampleIndex: number;
    unit: string;
  }[];
  availableScenarios: { name: string; description: string }[];
  uptime: number;
}

export class DashboardServer {
  private app: Express;
  private server: http.Server;
  private wss: WebSocketServer;
  private options: DashboardOptions;
  private updateInterval: NodeJS.Timeout | null = null;
  private clients: Set<WebSocket> = new Set();

  constructor(options: DashboardOptions) {
    this.options = options;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.setupRoutes();
    this.setupWebSocket();
  }

  private getStatusName(status: AcquisitionStatus): string {
    const names: Record<AcquisitionStatus, string> = {
      [AcquisitionStatus.NotConfigured]: 'Not Configured',
      [AcquisitionStatus.Idle]: 'Idle',
      [AcquisitionStatus.AcquisitionStarted]: 'Acquisition Started',
      [AcquisitionStatus.AcquisitionStopped]: 'Acquisition Stopped',
      [AcquisitionStatus.Configuring]: 'Configuring',
      [AcquisitionStatus.ConfigurationError]: 'Configuration Error',
    };
    return names[status] || 'Unknown';
  }

  private getDashboardState(): DashboardState {
    const state = this.options.stateMachine.getState();
    const currentScenario = this.options.simulator.getCurrentScenario();
    const parameterStates = this.options.simulator.getAllStates();

    const parameters = Array.from(parameterStates.entries()).map(([index, pState]) => ({
      index,
      name: pState.config.displayName,
      enabled: pState.config.enabled,
      sampleValue: pState.sampleValue,
      engValue: pState.engValue,
      sampleIndex: pState.sampleIndex,
      unit: pState.config.unit,
    }));

    return {
      stationState: {
        status: state.status,
        statusName: this.getStatusName(state.status),
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
      },
      scenario: {
        name: currentScenario.name,
        description: currentScenario.description,
      },
      parameters,
      availableScenarios: listScenarios(),
      uptime: process.uptime(),
    };
  }

  private setupRoutes(): void {
    // Serve static files
    this.app.use(express.static(path.join(__dirname, 'public')));
    this.app.use(express.json());

    // API: Get current state
    this.app.get('/api/state', (req: Request, res: Response) => {
      res.json(this.getDashboardState());
    });

    // API: Get available scenarios
    this.app.get('/api/scenarios', (req: Request, res: Response) => {
      res.json(listScenarios());
    });

    // API: Change scenario
    this.app.post('/api/scenario', (req: Request, res: Response) => {
      const { name } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'Scenario name required' });
      }

      try {
        this.options.simulator.setScenario(name);
        this.broadcastState();
        res.json({ success: true, scenario: name });
      } catch (error) {
        res.status(400).json({ error: `Invalid scenario: ${name}` });
      }
    });

    // API: Send station command
    this.app.post('/api/command/:cmd', (req: Request, res: Response) => {
      const { cmd } = req.params;
      const validCommands = ['configure', 'start', 'stop', 'reset'];

      if (!validCommands.includes(cmd)) {
        return res.status(400).json({ error: `Invalid command: ${cmd}` });
      }

      try {
        switch (cmd) {
          case 'configure':
            // Transition to Configuring state
            this.options.stateMachine.dispatch({ type: 'CONFIGURE' });
            // Simulate configuration process and auto-complete after short delay
            setTimeout(() => {
              this.options.stateMachine.dispatch({ type: 'CONFIGURATION_DONE' });
              this.broadcastState();
            }, 500);
            break;
          case 'start':
            this.options.stateMachine.dispatch({ type: 'START_ACQUISITION', trigger: 0 });
            break;
          case 'stop':
            this.options.stateMachine.dispatch({ type: 'STOP_ACQUISITION', trigger: 0 });
            break;
          case 'reset':
            this.options.stateMachine.dispatch({ type: 'RESET' });
            break;
        }
        this.broadcastState();
        res.json({ success: true, command: cmd });
      } catch (error) {
        res.status(500).json({ error: `Command failed: ${error}` });
      }
    });

    // Serve dashboard HTML
    this.app.get('/', (req: Request, res: Response) => {
      res.send(this.getDashboardHTML());
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      console.log(`Dashboard client connected (${this.clients.size} total)`);

      // Send initial state
      ws.send(JSON.stringify({ type: 'state', data: this.getDashboardState() }));

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`Dashboard client disconnected (${this.clients.size} total)`);
      });

      ws.on('message', (message: string) => {
        try {
          const msg = JSON.parse(message.toString());
          if (msg.type === 'setScenario' && msg.name) {
            this.options.simulator.setScenario(msg.name);
            this.broadcastState();
          }
        } catch (e) {
          // Ignore invalid messages
        }
      });
    });
  }

  private broadcastState(): void {
    const state = this.getDashboardState();
    const message = JSON.stringify({ type: 'state', data: state });

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, () => {
        console.log(`Dashboard available at http://localhost:${this.options.port}`);
        resolve();
      });

      // Start periodic updates
      this.updateInterval = setInterval(() => {
        this.broadcastState();
      }, 500);
    });
  }

  async stop(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Close all WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('Dashboard server stopped');
        resolve();
      });
    });
  }

  private getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OPC UA SPC Simulator Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px solid #333;
    }
    h1 {
      font-size: 1.5rem;
      color: #4ecca3;
    }
    .uptime {
      color: #888;
      font-size: 0.9rem;
    }
    .grid {
      display: grid;
      grid-template-columns: 300px 1fr;
      gap: 20px;
    }
    .panel {
      background: #16213e;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .panel h2 {
      font-size: 1rem;
      color: #4ecca3;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #333;
    }
    .status-badge {
      display: inline-block;
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .status-0 { background: #444; color: #aaa; }
    .status-1 { background: #2d4a3e; color: #4ecca3; }
    .status-2 { background: #1e5128; color: #4eff4e; }
    .status-3 { background: #5c3d2e; color: #ffa500; }
    .status-8 { background: #3d3d1e; color: #ffff4e; }
    .status-9 { background: #5c2e2e; color: #ff4e4e; }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #222;
    }
    .info-label { color: #888; }
    .info-value { font-weight: 500; }
    .commands {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 15px;
    }
    button {
      background: #4ecca3;
      color: #1a1a2e;
      border: none;
      padding: 10px 15px;
      border-radius: 5px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
    }
    button:hover {
      background: #3db892;
      transform: translateY(-1px);
    }
    button:disabled {
      background: #333;
      color: #666;
      cursor: not-allowed;
      transform: none;
    }
    button.danger {
      background: #e74c3c;
    }
    button.danger:hover {
      background: #c0392b;
    }
    select {
      width: 100%;
      padding: 10px;
      border-radius: 5px;
      border: 1px solid #333;
      background: #0f0f23;
      color: #eee;
      font-size: 1rem;
      margin-bottom: 10px;
    }
    .parameters-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 15px;
    }
    .param-card {
      background: #0f0f23;
      border-radius: 8px;
      padding: 15px;
      border-left: 3px solid #4ecca3;
    }
    .param-card.disabled {
      opacity: 0.5;
      border-left-color: #444;
    }
    .param-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .param-name {
      font-weight: 600;
      color: #4ecca3;
    }
    .param-index {
      color: #666;
      font-size: 0.85rem;
    }
    .param-values {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .param-value {
      text-align: center;
      padding: 8px;
      background: #16213e;
      border-radius: 5px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .param-value:hover {
      background: #1e2d4a;
      transform: scale(1.02);
    }
    .param-value-label {
      font-size: 0.75rem;
      color: #666;
      margin-bottom: 3px;
    }
    .param-value-number {
      font-size: 1.1rem;
      font-weight: 600;
      font-family: 'Courier New', monospace;
    }
    .param-unit {
      font-size: 0.8rem;
      color: #888;
      margin-left: 3px;
    }
    .scenario-info {
      background: #0f0f23;
      padding: 10px;
      border-radius: 5px;
      margin-bottom: 15px;
    }
    .scenario-name {
      font-weight: 600;
      color: #4ecca3;
    }
    .scenario-desc {
      font-size: 0.85rem;
      color: #888;
      margin-top: 5px;
    }
    .ws-status {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 5px;
    }
    .ws-connected { background: #4ecca3; }
    .ws-disconnected { background: #e74c3c; }
    @media (max-width: 900px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    /* Modal styles */
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.7);
    }
    .modal.show {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-content {
      background: #16213e;
      border-radius: 10px;
      padding: 20px;
      width: 90%;
      max-width: 800px;
      max-height: 90vh;
      position: relative;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #333;
    }
    .modal-title {
      font-size: 1.2rem;
      color: #4ecca3;
    }
    .modal-close {
      background: none;
      border: none;
      color: #888;
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0;
    }
    .modal-close:hover {
      color: #fff;
      background: none;
      transform: none;
    }
    .chart-container {
      position: relative;
      height: 400px;
    }
    .chart-info {
      display: flex;
      justify-content: space-between;
      margin-top: 15px;
      padding: 10px;
      background: #0f0f23;
      border-radius: 5px;
    }
    .chart-stat {
      text-align: center;
    }
    .chart-stat-label {
      font-size: 0.75rem;
      color: #666;
    }
    .chart-stat-value {
      font-size: 1.1rem;
      font-weight: 600;
      color: #4ecca3;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1><span class="ws-status ws-disconnected" id="wsStatus"></span>OPC UA SPC Simulator</h1>
      <span class="uptime" id="uptime">Uptime: --</span>
    </header>

    <div class="grid">
      <div class="sidebar">
        <div class="panel">
          <h2>Station State</h2>
          <div class="info-row">
            <span class="info-label">Status</span>
            <span class="status-badge status-0" id="statusBadge">--</span>
          </div>
          <div class="info-row">
            <span class="info-label">Started At</span>
            <span class="info-value" id="startedAt">--</span>
          </div>
          <div class="info-row">
            <span class="info-label">Stopped At</span>
            <span class="info-value" id="stoppedAt">--</span>
          </div>
          <div class="commands">
            <button id="btnConfigure" onclick="sendCommand('configure')">Configure</button>
            <button id="btnStart" onclick="sendCommand('start')">Start</button>
            <button id="btnStop" onclick="sendCommand('stop')" class="danger">Stop</button>
            <button id="btnReset" onclick="sendCommand('reset')">Reset</button>
          </div>
        </div>

        <div class="panel">
          <h2>Simulation Scenario</h2>
          <div class="scenario-info">
            <div class="scenario-name" id="scenarioName">--</div>
            <div class="scenario-desc" id="scenarioDesc">--</div>
          </div>
          <select id="scenarioSelect" onchange="changeScenario(this.value)">
            <option value="">Select scenario...</option>
          </select>
        </div>
      </div>

      <div class="main">
        <div class="panel">
          <h2>Parameters</h2>
          <div class="parameters-grid" id="parametersGrid">
            <!-- Parameters will be rendered here -->
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Chart Modal -->
  <div id="chartModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3 class="modal-title" id="chartTitle">Parameter Chart</h3>
        <button class="modal-close" onclick="closeChartModal()">&times;</button>
      </div>
      <div class="chart-container">
        <canvas id="chartCanvas"></canvas>
      </div>
      <div class="chart-info">
        <div class="chart-stat">
          <div class="chart-stat-label">Current</div>
          <div class="chart-stat-value" id="chartCurrent">--</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Min</div>
          <div class="chart-stat-value" id="chartMin">--</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Max</div>
          <div class="chart-stat-value" id="chartMax">--</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Avg</div>
          <div class="chart-stat-value" id="chartAvg">--</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let ws = null;
    let state = null;
    let chart = null;
    let chartData = { labels: [], values: [] };
    let currentChartParam = null;
    let currentChartType = null; // 'sample' or 'eng'
    const MAX_CHART_POINTS = 60;

    function formatTime(date) {
      if (!date) return '--';
      return new Date(date).toLocaleTimeString();
    }

    function formatUptime(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      return \`\${h}h \${m}m \${s}s\`;
    }

    function formatNumber(num, decimals = 2) {
      return num.toFixed(decimals);
    }

    function openChartModal(paramIndex, paramName, valueType, unit) {
      currentChartParam = paramIndex;
      currentChartType = valueType;
      chartData = { labels: [], values: [] };

      const typeLabel = valueType === 'sample' ? 'SampleValue' : 'EngValue';
      document.getElementById('chartTitle').textContent = \`\${paramName} - \${typeLabel} (\${unit})\`;
      document.getElementById('chartModal').classList.add('show');

      // Initialize chart
      const ctx = document.getElementById('chartCanvas').getContext('2d');
      if (chart) chart.destroy();

      const borderColor = valueType === 'sample' ? '#4ecca3' : '#f39c12';
      const bgColor = valueType === 'sample' ? 'rgba(78, 204, 163, 0.1)' : 'rgba(243, 156, 18, 0.1)';

      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: typeLabel,
            data: [],
            borderColor: borderColor,
            backgroundColor: bgColor,
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 0 },
          scales: {
            x: {
              grid: { color: '#333' },
              ticks: { color: '#888', maxRotation: 0 }
            },
            y: {
              grid: { color: '#333' },
              ticks: { color: '#888' }
            }
          },
          plugins: {
            legend: { display: false }
          }
        }
      });
    }

    function closeChartModal() {
      document.getElementById('chartModal').classList.remove('show');
      currentChartParam = null;
      currentChartType = null;
      if (chart) {
        chart.destroy();
        chart = null;
      }
    }

    function updateChartData(param) {
      if (!chart || currentChartParam !== param.index) return;

      const value = currentChartType === 'sample' ? param.sampleValue : param.engValue;
      const now = new Date().toLocaleTimeString();

      chartData.labels.push(now);
      chartData.values.push(value);

      // Keep only last MAX_CHART_POINTS points
      if (chartData.labels.length > MAX_CHART_POINTS) {
        chartData.labels.shift();
        chartData.values.shift();
      }

      chart.data.labels = chartData.labels;
      chart.data.datasets[0].data = chartData.values;
      chart.update('none');

      // Update stats
      const current = value;
      const min = Math.min(...chartData.values);
      const max = Math.max(...chartData.values);
      const avg = chartData.values.reduce((a, b) => a + b, 0) / chartData.values.length;

      document.getElementById('chartCurrent').textContent = formatNumber(current);
      document.getElementById('chartMin').textContent = formatNumber(min);
      document.getElementById('chartMax').textContent = formatNumber(max);
      document.getElementById('chartAvg').textContent = formatNumber(avg);
    }

    function updateUI(data) {
      state = data;

      // Update status
      const statusBadge = document.getElementById('statusBadge');
      statusBadge.textContent = data.stationState.statusName;
      statusBadge.className = 'status-badge status-' + data.stationState.status;

      // Update times
      document.getElementById('startedAt').textContent = formatTime(data.stationState.startedAt);
      document.getElementById('stoppedAt').textContent = formatTime(data.stationState.stoppedAt);
      document.getElementById('uptime').textContent = 'Uptime: ' + formatUptime(data.uptime);

      // Update scenario
      document.getElementById('scenarioName').textContent = data.scenario.name;
      document.getElementById('scenarioDesc').textContent = data.scenario.description;

      // Update scenario select
      const select = document.getElementById('scenarioSelect');
      if (select.options.length <= 1) {
        data.availableScenarios.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.name;
          opt.textContent = s.name + ' - ' + s.description;
          select.appendChild(opt);
        });
      }
      select.value = data.scenario.name;

      // Update command buttons
      const status = data.stationState.status;
      document.getElementById('btnConfigure').disabled = status !== 0;
      document.getElementById('btnStart').disabled = status !== 1;
      document.getElementById('btnStop').disabled = status !== 2;
      document.getElementById('btnReset').disabled = status !== 3;

      // Update parameters
      const grid = document.getElementById('parametersGrid');
      grid.innerHTML = data.parameters.map(p => \`
        <div class="param-card \${p.enabled ? '' : 'disabled'}">
          <div class="param-header">
            <span class="param-name">\${p.name}</span>
            <span class="param-index">P\${String(p.index).padStart(2, '0')}</span>
          </div>
          <div class="param-values">
            <div class="param-value" onclick="openChartModal(\${p.index}, '\${p.name}', 'sample', '\${p.unit}')" title="Click to view chart">
              <div class="param-value-label">Sample Value</div>
              <div class="param-value-number">\${formatNumber(p.sampleValue)}<span class="param-unit">\${p.unit}</span></div>
            </div>
            <div class="param-value" onclick="openChartModal(\${p.index}, '\${p.name}', 'eng', '\${p.unit}')" title="Click to view chart">
              <div class="param-value-label">Eng Value</div>
              <div class="param-value-number">\${formatNumber(p.engValue)}<span class="param-unit">\${p.unit}</span></div>
            </div>
          </div>
          <div style="text-align: center; margin-top: 8px; color: #666; font-size: 0.8rem;">
            Sample #\${p.sampleIndex}
          </div>
        </div>
      \`).join('');

      // Update chart if open
      if (currentChartParam !== null) {
        const param = data.parameters.find(p => p.index === currentChartParam);
        if (param) updateChartData(param);
      }
    }

    function connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + window.location.host);

      ws.onopen = () => {
        document.getElementById('wsStatus').className = 'ws-status ws-connected';
        console.log('WebSocket connected');
      };

      ws.onclose = () => {
        document.getElementById('wsStatus').className = 'ws-status ws-disconnected';
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(connectWebSocket, 2000);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state') {
          updateUI(msg.data);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    }

    async function sendCommand(cmd) {
      try {
        const res = await fetch('/api/command/' + cmd, { method: 'POST' });
        const data = await res.json();
        if (!data.success) {
          alert('Command failed: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    async function changeScenario(name) {
      if (!name) return;
      try {
        const res = await fetch('/api/scenario', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Failed to change scenario: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    // Close modal on background click
    document.getElementById('chartModal').addEventListener('click', (e) => {
      if (e.target.id === 'chartModal') closeChartModal();
    });

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeChartModal();
    });

    // Initial load
    fetch('/api/state')
      .then(res => res.json())
      .then(updateUI)
      .catch(console.error);

    // Connect WebSocket
    connectWebSocket();
  </script>
</body>
</html>`;
  }
}
