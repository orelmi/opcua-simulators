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
import { AcquisitionStatus, ScenarioParamDef, ScenarioParams } from '../types';

export interface OpcuaClientInfo {
  sessionName: string;
  clientDescription: string;
  channelId: number | null;
  creationDate: Date;
}

export interface OpcuaClientsAccessor {
  getConnectedClientCount(): number;
  getConnectedClientsInfo(): {
    sessionCount: number;
    channelCount: number;
    clients: OpcuaClientInfo[];
  };
  disconnectAllClients(): number;
  getHeartbeatSimulationEnabled(): boolean;
  setHeartbeatSimulationEnabled(enabled: boolean): void;
  getStorageFillOverride(): number | null;
  setStorageFillOverride(value: number | null): void;
}

export interface PersistenceStore {
  clearPersistedState(): void;
}

export interface DashboardOptions {
  port: number;
  simulator: ParameterSimulator;
  stateMachine: StationStateMachine;
  opcuaServer?: OpcuaClientsAccessor;
  store?: PersistenceStore;
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
    paramDefs: ScenarioParamDef[];
    params: ScenarioParams;
  };
  frequencies: {
    spcFrequency: number;
    engFrequency: number;
  };
  forceSpcEmission: boolean;
  heartbeatSimulationEnabled: boolean;
  storageFillOverride: number | null;
  parameters: {
    index: number;
    name: string;
    enabled: boolean;
    sampleValue: number;
    engValue: number;
    sampleValueOverride: number | null;
    sampleIndex: number;
    unit: string;
    target: number;
    usl: number;
    lsl: number;
    ucl: number;
    lcl: number;
  }[];
  availableScenarios: { name: string; description: string }[];
  uptime: number;
  opcuaClients: {
    sessionCount: number;
    channelCount: number;
    clients: OpcuaClientInfo[];
  };
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
    const frequencies = this.options.simulator.getFrequencies();

    const parameters = Array.from(parameterStates.entries()).map(([index, pState]) => ({
      index,
      name: pState.config.displayName,
      enabled: pState.config.enabled,
      sampleValue: pState.sampleValue,
      engValue: pState.engValue,
      sampleValueOverride: this.options.simulator.getSampleValueOverride(index),
      sampleIndex: pState.sampleIndex,
      unit: pState.config.unit,
      target: pState.config.toleranceLimits.target,
      usl: pState.config.toleranceLimits.usl,
      lsl: pState.config.toleranceLimits.lsl,
      ucl: pState.config.controlLimits.ucl,
      lcl: pState.config.controlLimits.lcl,
    }));

    // Get OPC UA client info if server is available
    const opcuaClients = this.options.opcuaServer
      ? this.options.opcuaServer.getConnectedClientsInfo()
      : { sessionCount: 0, channelCount: 0, clients: [] };

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
        paramDefs: this.options.simulator.getScenarioParamDefs(),
        params: this.options.simulator.getScenarioParams(),
      },
      frequencies,
      forceSpcEmission: this.options.simulator.getForceSpcEmission(),
      heartbeatSimulationEnabled: this.options.opcuaServer?.getHeartbeatSimulationEnabled() ?? true,
      storageFillOverride: this.options.opcuaServer?.getStorageFillOverride() ?? null,
      parameters,
      availableScenarios: listScenarios(),
      uptime: process.uptime(),
      opcuaClients,
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

    // API: Set frequencies
    this.app.post('/api/frequency', (req: Request, res: Response) => {
      const { spcFrequency, engFrequency } = req.body;

      try {
        if (spcFrequency !== undefined) {
          this.options.simulator.setSpcFrequency(parseInt(spcFrequency, 10));
        }
        if (engFrequency !== undefined) {
          this.options.simulator.setEngFrequency(parseInt(engFrequency, 10));
        }
        this.broadcastState();
        res.json({ success: true, frequencies: this.options.simulator.getFrequencies() });
      } catch (error) {
        res.status(500).json({ error: `Failed to set frequency: ${error}` });
      }
    });

    // API: Set scenario parameters
    this.app.post('/api/scenario-params', (req: Request, res: Response) => {
      const params = req.body;

      try {
        if (typeof params === 'object' && params !== null) {
          this.options.simulator.setScenarioParams(params);
        }
        this.broadcastState();
        res.json({ success: true, params: this.options.simulator.getScenarioParams() });
      } catch (error) {
        res.status(500).json({ error: `Failed to set scenario params: ${error}` });
      }
    });

    // API: Set heartbeat simulation
    this.app.post('/api/heartbeat-simulation', (req: Request, res: Response) => {
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be boolean' });
      }

      if (!this.options.opcuaServer) {
        return res.status(400).json({ error: 'OPC UA server not available' });
      }

      try {
        this.options.opcuaServer.setHeartbeatSimulationEnabled(enabled);
        this.broadcastState();
        res.json({
          success: true,
          heartbeatSimulationEnabled: this.options.opcuaServer.getHeartbeatSimulationEnabled()
        });
      } catch (error) {
        res.status(500).json({ error: `Failed to set heartbeat simulation: ${error}` });
      }
    });

    // API: Set storage fill percentage override
    this.app.post('/api/storage-fill', (req: Request, res: Response) => {
      const { value } = req.body;

      if (typeof value !== 'number' || value < 0 || value > 100) {
        return res.status(400).json({ error: 'value must be a number between 0 and 100' });
      }

      if (!this.options.opcuaServer) {
        return res.status(400).json({ error: 'OPC UA server not available' });
      }

      try {
        this.options.opcuaServer.setStorageFillOverride(value);
        this.broadcastState();
        res.json({ success: true, value });
      } catch (error) {
        res.status(500).json({ error: `Failed to set storage fill: ${error}` });
      }
    });

    // API: Force SampleValue per parameter (null = auto)
    this.app.post('/api/sample-value-override', (req: Request, res: Response) => {
      const { parameterIndex, value } = req.body;

      if (typeof parameterIndex !== 'number') {
        return res.status(400).json({ error: 'parameterIndex must be a number' });
      }
      if (value !== null && typeof value !== 'number') {
        return res.status(400).json({ error: 'value must be a number or null' });
      }

      try {
        this.options.simulator.setSampleValueOverride(parameterIndex, value);
        this.broadcastState();
        res.json({ success: true, parameterIndex, sampleValueOverride: this.options.simulator.getSampleValueOverride(parameterIndex) });
      } catch (error) {
        res.status(500).json({ error: `Failed to set SampleValue override: ${error}` });
      }
    });

    // API: Set force SPC emission
    this.app.post('/api/force-spc-emission', (req: Request, res: Response) => {
      const { forceSpcEmission } = req.body;

      if (typeof forceSpcEmission !== 'boolean') {
        return res.status(400).json({ error: 'forceSpcEmission must be boolean' });
      }

      try {
        this.options.simulator.setForceSpcEmission(forceSpcEmission);
        this.broadcastState();
        res.json({
          success: true,
          forceSpcEmission: this.options.simulator.getForceSpcEmission()
        });
      } catch (error) {
        res.status(500).json({ error: `Failed to set force SPC emission: ${error}` });
      }
    });

    // API: Reset scenario time
    this.app.post('/api/scenario-reset-time', (_req: Request, res: Response) => {
      try {
        this.options.simulator.resetScenarioTime();
        this.broadcastState();
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: `Failed to reset scenario time: ${error}` });
      }
    });

    // API: Inject SPC event
    this.app.post('/api/inject-event', (req: Request, res: Response) => {
      const { eventType, duration, params } = req.body;

      if (!eventType) {
        return res.status(400).json({ error: 'eventType is required' });
      }

      try {
        this.options.simulator.injectEvent(
          eventType,
          duration ?? 1,
          params ?? {}
        );
        res.json({ success: true, eventType, duration: duration ?? 1 });
      } catch (error) {
        res.status(500).json({ error: `Failed to inject event: ${error}` });
      }
    });

    // API: Clear all injected events
    this.app.post('/api/clear-events', (_req: Request, res: Response) => {
      try {
        this.options.simulator.clearInjectedEvents();
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: `Failed to clear events: ${error}` });
      }
    });

    // API: Get OPC UA clients info
    this.app.get('/api/opcua-clients', (_req: Request, res: Response) => {
      if (!this.options.opcuaServer) {
        return res.json({ sessionCount: 0, channelCount: 0, clients: [] });
      }
      res.json(this.options.opcuaServer.getConnectedClientsInfo());
    });

    // API: Disconnect all OPC UA clients
    this.app.post('/api/disconnect-clients', (_req: Request, res: Response) => {
      if (!this.options.opcuaServer) {
        return res.status(400).json({ error: 'OPC UA server not available' });
      }

      try {
        const disconnectedCount = this.options.opcuaServer.disconnectAllClients();
        this.broadcastState();
        res.json({ success: true, disconnectedCount });
      } catch (error) {
        res.status(500).json({ error: `Failed to disconnect clients: ${error}` });
      }
    });

    // API: Reset persistence (clear saved state)
    this.app.post('/api/reset-persistence', (_req: Request, res: Response) => {
      if (!this.options.store) {
        return res.status(400).json({ error: 'Persistence store not available' });
      }

      try {
        this.options.store.clearPersistedState();
        // Also reset the state machine to NotConfigured
        this.options.stateMachine.forceState(AcquisitionStatus.NotConfigured);
        this.broadcastState();
        res.json({ success: true, message: 'Persistence cleared. Restart server to start fresh.' });
      } catch (error) {
        res.status(500).json({ error: `Failed to reset persistence: ${error}` });
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
            const { resetToNotConfigured } = req.body;
            this.options.stateMachine.dispatch({
              type: 'RESET',
              resetToNotConfigured: resetToNotConfigured === true
            });
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

    // Close all WebSocket connections with code 1001 (going away)
    for (const client of this.clients) {
      try {
        client.close(1001, 'Server shutting down');
        client.terminate(); // Force close if close() doesn't work
      } catch {
        // Ignore errors during close
      }
    }
    this.clients.clear();

    // Close WebSocket server
    await new Promise<void>((resolve) => {
      this.wss.close((err) => {
        if (err) {
          console.error('Error closing WebSocket server:', err);
        }
        resolve();
      });
    });

    // Close HTTP server with timeout
    await new Promise<void>((resolve) => {
      // Set a timeout in case server.close() hangs
      const timeout = setTimeout(() => {
        console.warn('Dashboard server close timeout, forcing...');
        resolve();
      }, 2000);

      this.server.close((err) => {
        clearTimeout(timeout);
        if (err) {
          console.error('Error closing dashboard server:', err);
        } else {
          console.log('Dashboard server stopped');
        }
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
      grid-template-columns: 280px 1fr 300px;
      gap: 20px;
    }
    .sidebar-right {
      /* Right sidebar for simulation controls */
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
    .force-spc-enabled {
      color: #4eff4e;
      font-weight: 600;
    }
    .force-spc-disabled {
      color: #888;
    }
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
      transition: background-color 0.2s ease, transform 0.2s ease;
    }
    button:hover:not(:disabled) {
      background: #3db892;
      transform: translateY(-1px);
    }
    button:disabled {
      background: #333;
      color: #666;
      cursor: not-allowed;
      transform: none;
      transition: none;
    }
    button.danger {
      background: #e74c3c;
    }
    button.danger:hover:not(:disabled) {
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
    /* Frequency sliders */
    .frequency-control {
      margin-bottom: 15px;
    }
    .frequency-control label {
      display: block;
      margin-bottom: 5px;
      color: #888;
      font-size: 0.9rem;
    }
    .frequency-control span {
      color: #4ecca3;
      font-weight: 600;
    }
    .frequency-control input[type="range"] {
      width: 100%;
      height: 6px;
      background: #0f0f23;
      border-radius: 3px;
      outline: none;
      -webkit-appearance: none;
    }
    .frequency-control input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      background: #4ecca3;
      border-radius: 50%;
      cursor: pointer;
    }
    .frequency-control input[type="range"]::-moz-range-thumb {
      width: 16px;
      height: 16px;
      background: #4ecca3;
      border-radius: 50%;
      cursor: pointer;
      border: none;
    }
    /* Limits display */
    .param-limits {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      margin-top: 8px;
      padding: 6px;
      background: #0a0a1a;
      border-radius: 4px;
      font-size: 0.7rem;
    }
    .param-limit {
      display: flex;
      justify-content: space-between;
      color: #666;
    }
    .param-limit-value {
      color: #888;
      font-family: 'Courier New', monospace;
    }
    .param-limit.tolerance {
      color: #e74c3c;
    }
    .param-limit.control {
      color: #f39c12;
    }
    /* Sparklines */
    .param-sparklines {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 8px;
    }
    .sparkline-container {
      background: #0a0a1a;
      border-radius: 4px;
      padding: 4px;
    }
    .sparkline-label {
      font-size: 0.65rem;
      color: #555;
      text-align: center;
      margin-bottom: 2px;
    }
    .sparkline {
      width: 100%;
      height: 30px;
    }
    .sparkline-sample path {
      stroke: #4ecca3;
      stroke-width: 1.5;
      fill: none;
    }
    .sparkline-eng path {
      stroke: #f39c12;
      stroke-width: 1.5;
      fill: none;
    }
    /* Scenario controls */
    .scenario-params {
      margin-top: 10px;
    }
    .scenario-param {
      margin-bottom: 10px;
    }
    .scenario-param label {
      display: block;
      font-size: 0.85rem;
      color: #888;
      margin-bottom: 3px;
    }
    .scenario-param label span {
      color: #4ecca3;
      font-weight: 600;
    }
    .scenario-param input[type="range"] {
      width: 100%;
      height: 6px;
      background: #0f0f23;
      border-radius: 3px;
      outline: none;
      -webkit-appearance: none;
    }
    .scenario-param input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      background: #4ecca3;
      border-radius: 50%;
      cursor: pointer;
    }
    /* Quick action buttons */
    .quick-actions {
      margin-top: 10px;
    }
    .quick-actions h3 {
      font-size: 0.85rem;
      color: #888;
      margin-bottom: 8px;
    }
    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .action-btn {
      padding: 6px 8px;
      font-size: 0.75rem;
      border-radius: 4px;
      font-weight: 500;
      transition: all 0.15s;
    }
    .action-btn:hover {
      transform: translateY(-1px);
    }
    .action-btn.outlier {
      background: #e74c3c;
      color: white;
    }
    .action-btn.outlier:hover {
      background: #c0392b;
    }
    .action-btn.shift {
      background: #f39c12;
      color: #1a1a2e;
    }
    .action-btn.shift:hover {
      background: #d68910;
    }
    .action-btn.control {
      background: #9b59b6;
      color: white;
    }
    .action-btn.control:hover {
      background: #8e44ad;
    }
    .action-btn.variance {
      background: #3498db;
      color: white;
    }
    .action-btn.variance:hover {
      background: #2980b9;
    }
    .action-btn.reset-btn {
      background: #2ecc71;
      color: #1a1a2e;
      grid-column: span 2;
    }
    .action-btn.reset-btn:hover {
      background: #27ae60;
    }
    .duration-control {
      margin-top: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.8rem;
      color: #888;
    }
    .duration-control input {
      width: 60px;
      padding: 4px 6px;
      background: #0f0f23;
      border: 1px solid #333;
      border-radius: 4px;
      color: #eee;
      font-size: 0.8rem;
    }
    @media (max-width: 1200px) {
      .grid {
        grid-template-columns: 280px 1fr;
      }
      .sidebar-right {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }
      .sidebar-right .panel {
        margin-bottom: 0;
      }
    }
    @media (max-width: 900px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .sidebar-right {
        grid-template-columns: 1fr;
      }
      .modal {
        left: 20px;
        top: 20px;
        right: 20px;
        bottom: 20px;
      }
    }
    /* Modal styles - non-blocking overlay, draggable */
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      /* Position to the right of sidebar (320px + gap) */
      left: 340px;
      top: 20px;
      right: 20px;
      bottom: 20px;
      pointer-events: none;
    }
    .modal.show {
      display: flex;
      align-items: flex-start;
      justify-content: center;
    }
    .modal-content {
      background: #16213e;
      border-radius: 10px;
      padding: 20px;
      width: 100%;
      max-width: 900px;
      max-height: calc(100vh - 40px);
      position: absolute;
      pointer-events: auto;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      overflow: hidden;
      cursor: default;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #333;
      cursor: move;
      user-select: none;
    }
    .modal-header:active {
      cursor: grabbing;
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
      <!-- Left sidebar: Station controls -->
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
          <div class="info-row">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: #888;">
              <input type="checkbox" id="resetToNotConfiguredCheck" style="cursor: pointer; width: 16px; height: 16px;">
              <span>Reset to Not Configured</span>
            </label>
          </div>
          <div class="commands">
            <button id="btnConfigure" onclick="sendCommand('configure')">Configure</button>
            <button id="btnStart" onclick="sendCommand('start')">Start</button>
            <button id="btnStop" onclick="sendCommand('stop')" class="danger">Stop</button>
            <button id="btnReset" onclick="sendCommand('reset')">Reset</button>
          </div>
          <div class="info-row" style="margin-top: 10px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: #888;">
              <input type="checkbox" id="heartbeatSimCheck" checked onchange="toggleHeartbeatSimulation(this.checked)" style="cursor: pointer; width: 16px; height: 16px;">
              <span>Simulate Heartbeat</span>
            </label>
          </div>
          <div class="frequency-control" style="margin-top: 10px;">
            <label style="color: #888;">Storage Fill: <span id="storageFillValue">--</span>%</label>
            <input type="range" id="storageFillSlider" min="0" max="100" step="1" value="50"
              onmousedown="storageFillSliderActive = true" ontouchstart="storageFillSliderActive = true"
              onmouseup="storageFillSliderActive = false; setStorageFill(this.value)"
              ontouchend="storageFillSliderActive = false; setStorageFill(this.value)"
              oninput="document.getElementById('storageFillValue').textContent = this.value">
          </div>
        </div>

        <div class="panel">
          <h2>Update Frequencies</h2>
          <div class="frequency-control">
            <label>SPC Sample: <span id="spcFreqValue">5</span>s</label>
            <input type="range" id="spcFreqSlider" min="1" max="30" step="1" value="5"
              onmousedown="spcSliderActive = true" ontouchstart="spcSliderActive = true"
              onmouseup="spcSliderActive = false; setFrequency('spc', this.value * 1000)"
              ontouchend="spcSliderActive = false; setFrequency('spc', this.value * 1000)"
              oninput="document.getElementById('spcFreqValue').textContent = this.value">
          </div>
          <div class="frequency-control">
            <label>EngValue: <span id="engFreqValue">100</span>ms</label>
            <input type="range" id="engFreqSlider" min="100" max="10000" step="100" value="100"
              onmousedown="engSliderActive = true" ontouchstart="engSliderActive = true"
              onmouseup="engSliderActive = false; setFrequency('eng', this.value)"
              ontouchend="engSliderActive = false; setFrequency('eng', this.value)"
              oninput="document.getElementById('engFreqValue').textContent = this.value">
          </div>
        </div>

        <div class="panel">
          <h2>SPC Emission Control</h2>
          <div class="info-row">
            <span class="info-label">Force SPC Emission</span>
            <span class="info-value" id="forceSpcStatus">--</span>
          </div>
          <div style="margin-top: 10px; font-size: 0.85rem; color: #888; line-height: 1.4;">
            When enabled, SPC samples (SampleValue/SampleIndex) are emitted continuously, regardless of acquisition state.
          </div>
          <button id="btnToggleForceSpc" onclick="toggleForceSpcEmission()"
                  style="width: 100%; margin-top: 10px;">
            Toggle Force SPC
          </button>
        </div>

        <div class="panel">
          <h2>OPC UA Clients</h2>
          <div class="info-row">
            <span class="info-label">Sessions</span>
            <span class="info-value" id="sessionCount">0</span>
          </div>
          <div class="info-row">
            <span class="info-label">Channels</span>
            <span class="info-value" id="channelCount">0</span>
          </div>
          <div id="clientsList" style="margin-top: 10px; font-size: 0.85rem; max-height: 120px; overflow-y: auto;"></div>
          <button onclick="disconnectClients()" class="danger" style="width: 100%; margin-top: 10px;">Disconnect All</button>
          <button onclick="resetPersistence()" style="width: 100%; margin-top: 10px; background: #555;">Reset Persistence</button>
        </div>
      </div>

      <!-- Main content: Parameters -->
      <div class="main">
        <div class="panel">
          <h2>Parameters</h2>
          <div class="parameters-grid" id="parametersGrid">
            <!-- Parameters will be rendered here -->
          </div>
        </div>
      </div>

      <!-- Right sidebar: Simulation controls -->
      <div class="sidebar-right">
        <div class="panel">
          <h2>Simulation Scenario</h2>
          <div class="scenario-info">
            <div class="scenario-name" id="scenarioName">--</div>
            <div class="scenario-desc" id="scenarioDesc">--</div>
          </div>
          <select id="scenarioSelect" onchange="changeScenario(this.value)">
            <option value="">Select scenario...</option>
          </select>
          <div class="scenario-params" id="scenarioParams">
            <!-- Scenario parameters will be rendered here -->
          </div>
          <button onclick="resetScenarioTime()" style="width:100%; margin-top:10px; background:#555;">Reset Timer</button>
        </div>

        <div class="panel">
          <h2>SPC Events</h2>
          <div class="quick-actions">
            <h3>Outliers</h3>
            <div class="action-grid">
              <button class="action-btn outlier" onclick="injectEvent('outlier_high')">Haut</button>
              <button class="action-btn outlier" onclick="injectEvent('outlier_low')">Bas</button>
              <button class="action-btn outlier" onclick="injectEvent('outlier_random')">Aléatoire</button>
              <button class="action-btn outlier" onclick="injectEvent('outlier_random', getEventDuration())">Série</button>
            </div>
          </div>
          <div class="quick-actions">
            <h3>Shifts</h3>
            <div class="action-grid">
              <button class="action-btn shift" onclick="injectEvent('shift_up', getEventDuration())">Haut</button>
              <button class="action-btn shift" onclick="injectEvent('shift_down', getEventDuration())">Bas</button>
              <button class="action-btn shift" onclick="injectEvent('trend_spike')">Spike</button>
            </div>
          </div>
          <div class="quick-actions">
            <h3>Contrôle</h3>
            <div class="action-grid">
              <button class="action-btn control" onclick="injectEvent('near_ucl', getEventDuration())">~UCL</button>
              <button class="action-btn control" onclick="injectEvent('near_lcl', getEventDuration())">~LCL</button>
              <button class="action-btn control" onclick="injectEvent('above_ucl', getEventDuration())">&gt;UCL</button>
              <button class="action-btn control" onclick="injectEvent('below_lcl', getEventDuration())">&lt;LCL</button>
            </div>
          </div>
          <div class="quick-actions">
            <h3>Autres</h3>
            <div class="action-grid">
              <button class="action-btn variance" onclick="injectEvent('high_variance', getEventDuration())">Variance</button>
              <button class="action-btn variance" onclick="injectEvent('at_target', getEventDuration())">Cible</button>
              <button class="action-btn reset-btn" onclick="clearEvents()">Annuler</button>
            </div>
          </div>
          <div class="duration-control">
            <label>Durée:</label>
            <input type="number" id="eventDuration" value="5" min="1" max="50">
            <span>samples</span>
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
    let currentChartLimits = null; // Store limits for current chart { usl, lsl, ucl, lcl, target }
    let lastSampleIndex = null; // Track last sample index to detect new SPC samples
    const MAX_CHART_POINTS = 60;

    // Track slider interaction to prevent updates while dragging
    let spcSliderActive = false;
    let engSliderActive = false;
    let storageFillSliderActive = false;

    // Sparkline data storage - keyed by parameter index
    const sparklineData = new Map(); // Map<index, { sample: number[], eng: number[], lastSampleIndex: number }>
    const SPARKLINE_POINTS = 200; // Show last 200 consecutive samples

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

    // Generate SVG path for sparkline
    function generateSparklinePath(values, width, height) {
      if (!values || values.length < 2) return '';
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min || 1;
      const padding = 2;
      const effectiveHeight = height - padding * 2;
      const effectiveWidth = width - padding * 2;

      const points = values.map((v, i) => {
        const x = padding + (i / (values.length - 1)) * effectiveWidth;
        const y = padding + effectiveHeight - ((v - min) / range) * effectiveHeight;
        return \`\${x.toFixed(1)},\${y.toFixed(1)}\`;
      });

      return 'M' + points.join('L');
    }

    // Update sparkline data for a parameter
    function updateSparklineData(param) {
      if (!sparklineData.has(param.index)) {
        sparklineData.set(param.index, { sample: [], eng: [], lastSampleIndex: -1 });
      }

      const data = sparklineData.get(param.index);

      // Always update EngValue sparkline
      data.eng.push(param.engValue);
      if (data.eng.length > SPARKLINE_POINTS) data.eng.shift();

      // Update SampleValue sparkline only when sampleIndex changes
      if (data.lastSampleIndex !== param.sampleIndex) {
        data.sample.push(param.sampleValue);
        if (data.sample.length > SPARKLINE_POINTS) data.sample.shift();
        data.lastSampleIndex = param.sampleIndex;
      }
    }

    // Render sparkline SVG
    function renderSparkline(paramIndex, type) {
      const data = sparklineData.get(paramIndex);
      if (!data) return '';
      const values = type === 'sample' ? data.sample : data.eng;
      const path = generateSparklinePath(values, 100, 30);
      return path;
    }

    function openChartModal(paramIndex, paramName, valueType, unit, limits) {
      currentChartParam = paramIndex;
      currentChartType = valueType;
      currentChartLimits = limits || null;
      chartData = { labels: [], values: [] };
      lastSampleIndex = null; // Reset sample index tracking

      const typeLabel = valueType === 'sample' ? 'SampleValue' : 'EngValue';
      document.getElementById('chartTitle').textContent = \`\${paramName} - \${typeLabel} (\${unit})\`;

      // Reset modal position before showing
      const mc = document.querySelector('.modal-content');
      if (mc) {
        mc.style.left = '';
        mc.style.top = '20px';
        mc.style.right = '';
        mc.style.transform = '';
      }

      document.getElementById('chartModal').classList.add('show');

      // Initialize chart
      const ctx = document.getElementById('chartCanvas').getContext('2d');
      if (chart) chart.destroy();

      const borderColor = valueType === 'sample' ? '#4ecca3' : '#f39c12';
      const bgColor = valueType === 'sample' ? 'rgba(78, 204, 163, 0.1)' : 'rgba(243, 156, 18, 0.1)';

      // Create datasets array with main data line
      const datasets = [{
        label: typeLabel,
        data: [],
        borderColor: borderColor,
        backgroundColor: bgColor,
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        order: 0
      }];

      // Add limit lines if limits are provided
      if (limits) {
        // USL - Upper Specification Limit (red dashed)
        datasets.push({
          label: 'USL',
          data: [],
          borderColor: '#e74c3c',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
          order: 1
        });
        // LSL - Lower Specification Limit (red dashed)
        datasets.push({
          label: 'LSL',
          data: [],
          borderColor: '#e74c3c',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
          order: 1
        });
        // UCL - Upper Control Limit (orange dotted)
        datasets.push({
          label: 'UCL',
          data: [],
          borderColor: '#f39c12',
          borderWidth: 1.5,
          borderDash: [2, 2],
          pointRadius: 0,
          fill: false,
          order: 2
        });
        // LCL - Lower Control Limit (orange dotted)
        datasets.push({
          label: 'LCL',
          data: [],
          borderColor: '#f39c12',
          borderWidth: 1.5,
          borderDash: [2, 2],
          pointRadius: 0,
          fill: false,
          order: 2
        });
        // Target/CL - Center Line (green dotted)
        datasets.push({
          label: 'Target',
          data: [],
          borderColor: '#2ecc71',
          borderWidth: 1,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
          order: 3
        });
      }

      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: datasets
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
              ticks: { color: '#888' },
              // Set min/max based on limits with some padding
              suggestedMin: limits ? limits.lsl - (limits.usl - limits.lsl) * 0.1 : undefined,
              suggestedMax: limits ? limits.usl + (limits.usl - limits.lsl) * 0.1 : undefined
            }
          },
          plugins: {
            legend: {
              display: !!limits,
              position: 'top',
              labels: {
                color: '#888',
                boxWidth: 20,
                padding: 10,
                font: { size: 10 }
              }
            }
          }
        }
      });
    }

    function closeChartModal() {
      document.getElementById('chartModal').classList.remove('show');
      currentChartParam = null;
      currentChartType = null;
      currentChartLimits = null;
      if (chart) {
        chart.destroy();
        chart = null;
      }
    }

    function updateChartData(param) {
      if (!chart || currentChartParam !== param.index) return;

      const value = currentChartType === 'sample' ? param.sampleValue : param.engValue;

      // For SampleValue chart, only add point when sampleIndex changes (new SPC sample)
      if (currentChartType === 'sample') {
        if (lastSampleIndex === param.sampleIndex) {
          // No new sample, just update the current value display
          document.getElementById('chartCurrent').textContent = formatNumber(value);
          return;
        }
        lastSampleIndex = param.sampleIndex;
      }

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

      // Update limit lines data if limits exist
      if (currentChartLimits && chart.data.datasets.length > 1) {
        const numPoints = chartData.labels.length;
        chart.data.datasets[1].data = Array(numPoints).fill(currentChartLimits.usl); // USL
        chart.data.datasets[2].data = Array(numPoints).fill(currentChartLimits.lsl); // LSL
        chart.data.datasets[3].data = Array(numPoints).fill(currentChartLimits.ucl); // UCL
        chart.data.datasets[4].data = Array(numPoints).fill(currentChartLimits.lcl); // LCL
        chart.data.datasets[5].data = Array(numPoints).fill(currentChartLimits.target); // Target
      }

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

      // Update scenario parameters
      updateScenarioParams(data.scenario.paramDefs, data.scenario.params);

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
      document.getElementById('btnStart').disabled = status !== 1 && status !== 3;
      document.getElementById('btnStop').disabled = status !== 2;
      document.getElementById('btnReset').disabled = status !== 3;

      // Update frequency sliders (skip if user is dragging)
      if (data.frequencies) {
        if (!spcSliderActive) {
          const spcSeconds = Math.round(data.frequencies.spcFrequency / 1000);
          document.getElementById('spcFreqValue').textContent = spcSeconds;
          document.getElementById('spcFreqSlider').value = spcSeconds;
        }
        if (!engSliderActive) {
          document.getElementById('engFreqValue').textContent = data.frequencies.engFrequency;
          document.getElementById('engFreqSlider').value = data.frequencies.engFrequency;
        }
      }

      // Update force SPC emission status
      if (typeof data.forceSpcEmission !== 'undefined') {
        const forceSpcStatus = document.getElementById('forceSpcStatus');
        const forceSpcBtn = document.getElementById('btnToggleForceSpc');

        if (data.forceSpcEmission) {
          forceSpcStatus.textContent = 'ENABLED';
          forceSpcStatus.className = 'info-value force-spc-enabled';
          forceSpcBtn.textContent = 'Disable Force SPC';
          forceSpcBtn.style.background = '#e74c3c';
        } else {
          forceSpcStatus.textContent = 'Disabled';
          forceSpcStatus.className = 'info-value force-spc-disabled';
          forceSpcBtn.textContent = 'Enable Force SPC';
          forceSpcBtn.style.background = '#4ecca3';
        }
      }

      // Update heartbeat simulation checkbox
      if (typeof data.heartbeatSimulationEnabled !== 'undefined') {
        const heartbeatCheck = document.getElementById('heartbeatSimCheck');
        if (heartbeatCheck) {
          heartbeatCheck.checked = data.heartbeatSimulationEnabled;
        }
      }

      // Update storage fill slider (skip if user is dragging)
      if (!storageFillSliderActive && data.storageFillOverride !== undefined) {
        const val = data.storageFillOverride !== null ? data.storageFillOverride : '--';
        document.getElementById('storageFillValue').textContent = val;
        if (data.storageFillOverride !== null) {
          document.getElementById('storageFillSlider').value = data.storageFillOverride;
        }
      }



      // Update parameters and sparkline data
      data.parameters.forEach(p => updateSparklineData(p));

      const grid = document.getElementById('parametersGrid');

      if (grid.children.length !== data.parameters.length) {
        // Full initial render (first load or parameter count change)
        grid.innerHTML = data.parameters.map(p => {
          const limitsJson = JSON.stringify({ usl: p.usl, lsl: p.lsl, ucl: p.ucl, lcl: p.lcl, target: p.target }).replace(/"/g, '&quot;');
          return \`
          <div class="param-card \${p.enabled ? '' : 'disabled'}" id="pcard-\${p.index}">
            <div class="param-header">
              <span class="param-name">\${p.name}</span>
              <span class="param-index">P\${String(p.index).padStart(2, '0')}</span>
            </div>
            <div class="param-values">
              <div class="param-value" onclick="openChartModal(\${p.index}, '\${p.name}', 'sample', '\${p.unit}', \${limitsJson})" title="Click to view chart">
                <div class="param-value-label">Sample Value</div>
                <div class="param-value-number" id="psv-\${p.index}">\${formatNumber(p.sampleValue)}<span class="param-unit">\${p.unit}</span></div>
              </div>
              <div class="param-value" onclick="openChartModal(\${p.index}, '\${p.name}', 'eng', '\${p.unit}', \${limitsJson})" title="Click to view chart">
                <div class="param-value-label">Eng Value</div>
                <div class="param-value-number" id="pev-\${p.index}">\${formatNumber(p.engValue)}<span class="param-unit">\${p.unit}</span></div>
              </div>
            </div>
            <div class="param-sparklines">
              <div class="sparkline-container" onclick="openChartModal(\${p.index}, '\${p.name}', 'sample', '\${p.unit}', \${limitsJson})" title="Click to view chart">
                <div class="sparkline-label">SampleValue</div>
                <svg class="sparkline sparkline-sample" viewBox="0 0 100 30" preserveAspectRatio="none">
                  <path id="pss-\${p.index}" d="\${renderSparkline(p.index, 'sample')}"/>
                </svg>
              </div>
              <div class="sparkline-container" onclick="openChartModal(\${p.index}, '\${p.name}', 'eng', '\${p.unit}', \${limitsJson})" title="Click to view chart">
                <div class="sparkline-label">EngValue</div>
                <svg class="sparkline sparkline-eng" viewBox="0 0 100 30" preserveAspectRatio="none">
                  <path id="pes-\${p.index}" d="\${renderSparkline(p.index, 'eng')}"/>
                </svg>
              </div>
            </div>
            <div id="pfi-\${p.index}" style="text-align: center; margin-top: 8px; color: #666; font-size: 0.8rem;">
              Sample #\${p.sampleIndex} | Target: \${formatNumber(p.target)}
            </div>
            <div class="param-limits">
              <div class="param-limit tolerance"><span>LSL</span><span class="param-limit-value">\${formatNumber(p.lsl)}</span></div>
              <div class="param-limit tolerance"><span>USL</span><span class="param-limit-value">\${formatNumber(p.usl)}</span></div>
              <div class="param-limit control"><span>LCL</span><span class="param-limit-value">\${formatNumber(p.lcl)}</span></div>
              <div class="param-limit control"><span>UCL</span><span class="param-limit-value">\${formatNumber(p.ucl)}</span></div>
            </div>
            <div style="margin-top: 8px; display: flex; align-items: center; gap: 6px;">
              <label style="color: #888; font-size: 0.78rem; display: flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap;">
                <input type="checkbox" id="pcb-\${p.index}" \${p.sampleValueOverride !== null ? 'checked' : ''}
                  onchange="toggleSampleValueMode(\${p.index}, this.checked)"
                  style="cursor: pointer; width: 13px; height: 13px;">
                Force SampleVal
              </label>
              <input type="text" inputmode="decimal" id="pinp-\${p.index}"
                value="\${p.sampleValueOverride !== null ? p.sampleValueOverride.toFixed(2) : ''}"
                \${p.sampleValueOverride === null ? 'disabled' : ''}
                placeholder="auto"
                style="flex: 1; min-width: 0; padding: 3px 6px; border-radius: 4px; border: 1px solid \${p.sampleValueOverride !== null ? '#4ecca3' : '#333'}; background: #0f0f23; color: \${p.sampleValueOverride !== null ? '#eee' : '#666'}; font-size: 0.78rem;"
                onchange="setSampleValueOverride(\${p.index}, this.value)">
            </div>
          </div>
          \`;
        }).join('');
      } else {
        // In-place update: only refresh display values and sparklines, never touch inputs
        data.parameters.forEach(p => {
          const card = document.getElementById(\`pcard-\${p.index}\`);
          if (card) card.className = \`param-card \${p.enabled ? '' : 'disabled'}\`;
          const sv = document.getElementById(\`psv-\${p.index}\`);
          if (sv) sv.innerHTML = \`\${formatNumber(p.sampleValue)}<span class="param-unit">\${p.unit}</span>\`;
          const ev = document.getElementById(\`pev-\${p.index}\`);
          if (ev) ev.innerHTML = \`\${formatNumber(p.engValue)}<span class="param-unit">\${p.unit}</span>\`;
          const fi = document.getElementById(\`pfi-\${p.index}\`);
          if (fi) fi.textContent = \`Sample #\${p.sampleIndex} | Target: \${formatNumber(p.target)}\`;
          const ss = document.getElementById(\`pss-\${p.index}\`);
          if (ss) ss.setAttribute('d', renderSparkline(p.index, 'sample'));
          const es = document.getElementById(\`pes-\${p.index}\`);
          if (es) es.setAttribute('d', renderSparkline(p.index, 'eng'));
        });
      }

      // Update chart if open
      if (currentChartParam !== null) {
        const param = data.parameters.find(p => p.index === currentChartParam);
        if (param) updateChartData(param);
      }

      // Update OPC UA clients info
      if (data.opcuaClients) {
        document.getElementById('sessionCount').textContent = data.opcuaClients.sessionCount;
        document.getElementById('channelCount').textContent = data.opcuaClients.channelCount;

        const clientsList = document.getElementById('clientsList');
        if (data.opcuaClients.clients.length === 0) {
          clientsList.innerHTML = '<div style="color: #666; text-align: center;">No clients connected</div>';
        } else {
          clientsList.innerHTML = data.opcuaClients.clients.map(c => \`
            <div style="padding: 4px 0; border-bottom: 1px solid #222;">
              <div style="color: #4ecca3;">\${c.clientDescription}</div>
              <div style="color: #666; font-size: 0.75rem;">Session: \${c.sessionName} | Ch: \${c.channelId ?? '-'}</div>
            </div>
          \`).join('');
        }
      }
    }

    async function disconnectClients() {
      if (!confirm('Disconnect all OPC UA clients?')) return;
      try {
        const res = await fetch('/api/disconnect-clients', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          console.log('Disconnected ' + data.disconnectedCount + ' client(s)');
        } else {
          alert('Failed to disconnect: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

async function resetPersistence() {
      if (!confirm('Réinitialiser la persistance ? Le serveur redémarrera à zéro au prochain lancement.')) return;
      try {
        const res = await fetch('/api/reset-persistence', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert(data.message);
        } else {
          alert('Erreur: ' + data.error);
        }
      } catch (error) {
        alert('Erreur: ' + error.message);
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
        const options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        };

        // For reset command, read checkbox state
        if (cmd === 'reset') {
          const checkbox = document.getElementById('resetToNotConfiguredCheck');
          const resetToNotConfigured = checkbox ? checkbox.checked : false;
          options.body = JSON.stringify({ resetToNotConfigured });
        }

        const res = await fetch('/api/command/' + cmd, options);
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

    async function setFrequency(type, valueMs) {
      // Update display immediately (SPC slider sends seconds*1000, EngValue sends ms directly)
      if (type === 'spc') {
        document.getElementById('spcFreqValue').textContent = Math.round(valueMs / 1000);
      } else {
        document.getElementById('engFreqValue').textContent = valueMs;
      }

      try {
        const body = type === 'spc'
          ? { spcFrequency: parseInt(valueMs, 10) }
          : { engFrequency: parseInt(valueMs, 10) };

        const res = await fetch('/api/frequency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.success) {
          alert('Failed to set frequency: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    // Scenario parameters
    let currentParamDefs = [];

    function updateScenarioParams(paramDefs, params) {
      currentParamDefs = paramDefs || [];
      const container = document.getElementById('scenarioParams');

      if (!paramDefs || paramDefs.length === 0) {
        container.innerHTML = '<div style="color: #666; font-size: 0.85rem; margin-top: 10px;">Aucun paramètre pour ce scénario</div>';
        return;
      }

      container.innerHTML = paramDefs.map(def => {
        const value = params[def.key] ?? def.default;
        return \`
          <div class="scenario-param">
            <label>\${def.label}: <span id="paramValue_\${def.key}">\${value}</span>\${def.unit || ''}</label>
            <input type="range"
              id="param_\${def.key}"
              min="\${def.min}"
              max="\${def.max}"
              step="\${def.step}"
              value="\${value}"
              onchange="setScenarioParam('\${def.key}', this.value)"
              oninput="document.getElementById('paramValue_\${def.key}').textContent = this.value"
            >
          </div>
        \`;
      }).join('');
    }

    async function setScenarioParam(key, value) {
      try {
        const res = await fetch('/api/scenario-params', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: parseFloat(value) })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Failed to set param: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    async function resetScenarioTime() {
      try {
        await fetch('/api/scenario-reset-time', { method: 'POST' });
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    async function setStorageFill(value) {
      try {
        const res = await fetch('/api/storage-fill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: parseInt(value, 10) })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Failed to set storage fill: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    function toggleSampleValueMode(paramIndex, manual) {
      const inp = document.getElementById(\`pinp-\${paramIndex}\`);
      if (manual) {
        // Read current displayed sample value to use as initial forced value
        const svEl = document.getElementById(\`psv-\${paramIndex}\`);
        const currentVal = svEl ? parseFloat(svEl.textContent) : 0;
        const initVal = isNaN(currentVal) ? 0 : Math.round(currentVal * 100) / 100;
        if (inp) {
          inp.disabled = false;
          inp.value = initVal.toFixed(2);
          inp.style.borderColor = '#4ecca3';
          inp.style.color = '#eee';
          inp.focus();
          inp.select();
        }
        setSampleValueOverride(paramIndex, initVal);
      } else {
        if (inp) {
          inp.disabled = true;
          inp.value = '';
          inp.style.borderColor = '#333';
          inp.style.color = '#666';
        }
        setSampleValueOverride(paramIndex, null);
      }
    }

    async function setSampleValueOverride(paramIndex, value) {
      let parsed = value === null ? null : parseFloat(value);
      if (parsed !== null && isNaN(parsed)) return;
      // Round to 2 decimal places
      if (parsed !== null) parsed = Math.round(parsed * 100) / 100;
      try {
        const res = await fetch('/api/sample-value-override', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parameterIndex: paramIndex, value: parsed })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Failed to set SampleValue override: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    async function toggleHeartbeatSimulation(enabled) {
      try {
        const res = await fetch('/api/heartbeat-simulation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Failed to toggle heartbeat simulation: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    async function toggleForceSpcEmission() {
      if (!state) return;

      const newState = !state.forceSpcEmission;

      try {
        const res = await fetch('/api/force-spc-emission', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ forceSpcEmission: newState })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Failed to toggle force SPC emission: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    // Event injection
    function getEventDuration() {
      return parseInt(document.getElementById('eventDuration').value, 10) || 5;
    }

    async function injectEvent(eventType, duration = 1, params = {}) {
      try {
        const res = await fetch('/api/inject-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventType, duration, params })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Failed to inject event: ' + data.error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    async function clearEvents() {
      try {
        await fetch('/api/clear-events', { method: 'POST' });
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

    // Draggable modal
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    const modalContent = document.querySelector('.modal-content');
    const modalHeader = document.querySelector('.modal-header');

    modalHeader.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('modal-close')) return;
      isDragging = true;
      const rect = modalContent.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      modalContent.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = e.clientX - dragOffsetX;
      const y = e.clientY - dragOffsetY;
      modalContent.style.left = x + 'px';
      modalContent.style.top = y + 'px';
      modalContent.style.right = 'auto';
      modalContent.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      if (modalContent) modalContent.style.transition = '';
    });

    // Reset modal position when opening
    function resetModalPosition() {
      modalContent.style.left = '';
      modalContent.style.top = '20px';
      modalContent.style.right = '';
      modalContent.style.transform = '';
    }

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
