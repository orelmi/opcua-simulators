/**
 * OPC UA Server
 * Main server implementation with historization support
 */

import {
  OPCUAServer,
  ServerState,
  ServerCapabilities,
  MessageSecurityMode,
  SecurityPolicy,
  OPCUACertificateManager,
} from 'node-opcua';
import { AddressSpaceBuilder } from './address-space-builder';
import { NodeSetAddressSpaceBuilder } from './nodeset-address-space-builder';
import { SQLiteHistoryStore } from '../database/sqlite-store';
import { ParameterSimulator, createDefaultParameters } from '../simulation/parameter-simulator';
import { StationStateMachine } from '../simulation/station-state-machine';
import { DashboardServer } from '../dashboard/dashboard-server';
import { CLIOptions, ParameterConfig, ParametersConfigFile, AcquisitionStatus } from '../types';
import { parseNodeSetXml, NodeSetParseResult } from '../nodeset/nodeset-parser';
import path from 'path';
import fs from 'fs';

const STATE_SAVE_INTERVAL = 5000; // Save state every 5 seconds

/**
 * Load parameter configuration from a JSON file
 */
function loadConfigFile(configPath: string): ParametersConfigFile | undefined {
  try {
    if (!fs.existsSync(configPath)) {
      console.warn(`Config file not found: ${configPath}`);
      return undefined;
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as ParametersConfigFile;
    console.log(`Loaded parameter config from: ${configPath}`);
    return config;
  } catch (error) {
    console.error(`Failed to load config file: ${configPath}`, error);
    return undefined;
  }
}

export class CCSimulatorServer {
  private server: OPCUAServer | null = null;
  private historyStore: SQLiteHistoryStore;
  private simulator: ParameterSimulator;
  private stateMachine: StationStateMachine;
  private dashboard: DashboardServer | null = null;
  private options: CLIOptions;
  private parameterConfigs: ParameterConfig[];
  private stateSaveIntervalId: NodeJS.Timeout | null = null;
  private addressSpaceBuilder: AddressSpaceBuilder | null = null;
  private connectionBlockingEnabled: boolean = false;
  private connectionBlockingIntervalId: NodeJS.Timeout | null = null;
  private nodesetMode: boolean = false;
  private nodesetParseResult: NodeSetParseResult | null = null;

  constructor(options: CLIOptions) {
    this.options = options;
    this.nodesetMode = !!options.nodesetFile;

    // Initialize SQLite store
    this.historyStore = new SQLiteHistoryStore(options.dbPath);

    if (this.nodesetMode) {
      // ===================== NodeSet mode =====================
      // Parse the NodeSet XML to extract parameters
      this.nodesetParseResult = parseNodeSetXml(options.nodesetFile!);
      console.log(`[NodeSet] Parsed ${this.nodesetParseResult.parameters.length} parameters from ${options.nodesetFile}`);

      // Create generic ParameterConfigs from NodeSet parameters
      this.parameterConfigs = this.nodesetParseResult.parameters.map(p => {
        const target = options.target;
        const uslPercent = options.uslOffset;
        const lslPercent = options.lslOffset;
        const usl = target * (1 + uslPercent / 100);
        const lsl = target * (1 - lslPercent / 100);
        const toleranceRange = usl - lsl;
        const ucl = target + toleranceRange * 0.75 / 2;
        const lcl = target - toleranceRange * 0.75 / 2;

        return {
          index: p.index,
          name: p.browseName,
          displayName: p.displayName,
          description: `NodeSet parameter ${p.browseName}`,
          toleranceLimits: { usl, lsl, target },
          controlLimits: { ucl, lcl, cl: target },
          unit: '°C', // Default unit for thermal parameters
          sampleRate: options.sampleRate,
          enabled: true,
        };
      });

      // Apply config file overrides if provided
      if (options.configFile) {
        const configOverrides = loadConfigFile(options.configFile);
        if (configOverrides?.parameters) {
          for (const override of configOverrides.parameters) {
            const config = this.parameterConfigs.find(c => c.index === override.index);
            if (config) {
              if (override.displayName !== undefined) config.displayName = override.displayName;
              if (override.description !== undefined) config.description = override.description;
              if (override.unit !== undefined) config.unit = override.unit;
              if (override.target !== undefined) config.toleranceLimits.target = override.target;
              if (override.usl !== undefined) config.toleranceLimits.usl = override.usl;
              if (override.lsl !== undefined) config.toleranceLimits.lsl = override.lsl;
              if (override.ucl !== undefined) config.controlLimits.ucl = override.ucl;
              if (override.lcl !== undefined) config.controlLimits.lcl = override.lcl;
              if (override.cl !== undefined) config.controlLimits.cl = override.cl;
              if (override.enabled !== undefined) config.enabled = override.enabled;
            }
          }
        }
      }
    } else {
      // ===================== Normal mode =====================
      // Load config file if specified
      const configOverrides = options.configFile
        ? loadConfigFile(options.configFile)
        : undefined;

      // Create parameter configurations using new format
      this.parameterConfigs = createDefaultParameters(
        options.parameterCount,
        options.sampleRate,
        configOverrides
      );
    }

    // Save configs to database
    for (const config of this.parameterConfigs) {
      this.historyStore.saveParameterConfig({
        parameterIndex: config.index,
        name: config.name,
        target: config.toleranceLimits.target,
        usl: config.toleranceLimits.usl,
        lsl: config.toleranceLimits.lsl,
        ucl: config.controlLimits.ucl,
        lcl: config.controlLimits.lcl,
        cl: config.controlLimits.cl,
        unit: config.unit,
        sampleRate: config.sampleRate,
      });
    }

    // Load persisted state if available
    const persistedState = this.historyStore.loadSimulatorState();

    // Determine scenario: use persisted if available, otherwise CLI option
    const scenarioToUse = persistedState?.scenarioName || options.scenario;

    // Initialize simulator with frequencies
    this.simulator = new ParameterSimulator(
      scenarioToUse,
      options.sampleRate,
      options.spcFrequency,
      options.engFrequency
    );

    // Add only enabled parameters to simulator
    for (const config of this.parameterConfigs) {
      if (config.enabled) {
        this.simulator.addParameter(config);
      }
    }

    // Restore parameter states if persisted
    if (persistedState && persistedState.parameterStates.length > 0) {
      this.simulator.restoreParameterStates(persistedState.parameterStates);
      console.log(`Restored ${persistedState.parameterStates.length} parameter states from persistence`);
    }

    // Initialize state machine with persisted status or default (NotConfigured)
    const initialStatus = persistedState?.acquisitionStatus ?? AcquisitionStatus.NotConfigured;
    this.stateMachine = new StationStateMachine(initialStatus);

    // Restore timestamps if available
    if (persistedState?.startedAt) {
      this.stateMachine.setStartedAt(new Date(persistedState.startedAt));
    }
    if (persistedState?.stoppedAt) {
      this.stateMachine.setStoppedAt(new Date(persistedState.stoppedAt));
    }

    if (initialStatus !== AcquisitionStatus.NotConfigured) {
      console.log(`Restored acquisition state: ${this.getStatusName(initialStatus)}`);
    }

    // Connect state machine to simulator so SampleValue updates only during acquisition
    this.simulator.setStateMachine(this.stateMachine);
  }

  /**
   * Check if running in NodeSet mode
   */
  isNodeSetMode(): boolean {
    return this.nodesetMode;
  }

  private getStatusName(status: AcquisitionStatus): string {
    const names: Record<AcquisitionStatus, string> = {
      [AcquisitionStatus.NotConfigured]: 'NotConfigured',
      [AcquisitionStatus.Idle]: 'Idle',
      [AcquisitionStatus.AcquisitionStarted]: 'AcquisitionStarted',
      [AcquisitionStatus.AcquisitionStopped]: 'AcquisitionStopped',
      [AcquisitionStatus.Configuring]: 'Configuring',
      [AcquisitionStatus.ConfigurationError]: 'ConfigurationError',
    };
    return names[status] || 'Unknown';
  }

  /**
   * Start periodic state persistence
   */
  private startStatePersistence(): void {
    // Save state immediately on state machine changes
    this.stateMachine.on('stateChanged', () => {
      this.saveCurrentState();
    });

    // Also save periodically to capture parameter value changes
    this.stateSaveIntervalId = setInterval(() => {
      this.saveCurrentState();
    }, STATE_SAVE_INTERVAL);

    console.log(`State persistence enabled (interval: ${STATE_SAVE_INTERVAL}ms)`);
  }

  /**
   * Stop state persistence
   */
  private stopStatePersistence(): void {
    if (this.stateSaveIntervalId) {
      clearInterval(this.stateSaveIntervalId);
      this.stateSaveIntervalId = null;
    }
  }

  /**
   * Save current state to database
   */
  private saveCurrentState(): void {
    const machineState = this.stateMachine.getState();

    // Save simulator state
    this.historyStore.saveSimulatorState({
      acquisitionStatus: machineState.status,
      startedAt: machineState.startedAt,
      stoppedAt: machineState.stoppedAt,
      scenarioName: this.simulator.getCurrentScenario().name,
    });

    // Save parameter states
    const paramStates = this.simulator.getParameterStatesForPersistence();
    this.historyStore.saveParameterStates(paramStates);
  }

  /**
   * Initialize and start the OPC UA server
   */
  async start(): Promise<void> {
    // Ensure certificate directory exists
    const certDir = path.join(process.cwd(), 'certificates');
    if (!fs.existsSync(certDir)) {
      fs.mkdirSync(certDir, { recursive: true });
    }

    // Create server
    this.server = new OPCUAServer({
      port: this.options.port,
      resourcePath: '/UA/CCSimulator',
      buildInfo: {
        productName: 'OPC UA CC Simulator',
        buildNumber: '1.0.0',
        buildDate: new Date(),
        manufacturerName: 'OPC UA SPC Simulator',
        softwareVersion: '1.0.0',
      },
      serverInfo: {
        applicationUri: 'urn:CCSimulator:Server',
        productUri: 'urn:CCSimulator',
        applicationName: { text: 'CC Simulator Server', locale: 'en' },
      },
      securityPolicies: [
        SecurityPolicy.None,
        SecurityPolicy.Basic256Sha256,
      ],
      securityModes: [
        MessageSecurityMode.None,
        MessageSecurityMode.SignAndEncrypt,
      ],
      allowAnonymous: true,
      maxConnectionsPerEndpoint: 20,
      serverCapabilities: new ServerCapabilities({
        maxBrowseContinuationPoints: 10,
        maxHistoryContinuationPoints: 10,
        operationLimits: {
          maxNodesPerRead: 1000,
          maxNodesPerBrowse: 1000,
          maxNodesPerHistoryReadData: 1000,
        },
      }),
    });

    // Initialize server
    await this.server.initialize();

    // Build address space
    const addressSpace = this.server.engine.addressSpace!;

    if (this.nodesetMode && this.nodesetParseResult) {
      // NodeSet mode: simplified address space with only EngValue per parameter
      const nodesetBuilder = new NodeSetAddressSpaceBuilder(addressSpace, this.simulator);
      nodesetBuilder.build(this.nodesetParseResult, this.parameterConfigs);
    } else {
      // Normal mode: full CC address space with station, SPC, etc.
      this.addressSpaceBuilder = new AddressSpaceBuilder(
        addressSpace,
        this.historyStore,
        this.simulator,
        this.stateMachine,
        this.options
      );
      this.addressSpaceBuilder.build(this.parameterConfigs);
    }

    // Start server
    await this.server.start();

    // Log OPC UA session/subscription activity for debugging
    this.server.on('create_session', (session: { sessionName: string; clientDescription?: { applicationName?: { text?: string } } }) => {
      const appName = session.clientDescription?.applicationName?.text || 'unknown';
      console.log(`[OPC UA] New session: "${session.sessionName}" from ${appName}`);
    });
    this.server.on('session_closed', (session: { sessionName: string }, reason: string) => {
      console.log(`[OPC UA] Session closed: "${session.sessionName}" reason: ${reason}`);
    });

    // Log all advertised endpoints
    const endpoints = this.server.endpoints.map(ep => ep.endpointDescriptions()).flat();
    console.log(`[OPC UA] Advertised endpoints:`);
    for (const ep of endpoints) {
      if (ep.securityPolicyUri?.includes('None')) {
        console.log(`  ${ep.endpointUrl} (${ep.securityPolicyUri})`);
      }
    }

    // Start simulation
    this.simulator.start();

    // Start periodic state saving
    this.startStatePersistence();

    // Start web dashboard if port > 0
    if (this.options.dashboardPort > 0) {
      this.dashboard = new DashboardServer({
        port: this.options.dashboardPort,
        simulator: this.simulator,
        stateMachine: this.stateMachine,
        opcuaServer: this,
        store: this.historyStore,
        nodesetMode: this.nodesetMode,
      });
      await this.dashboard.start();
    }

    const endpointUrl = this.server.getEndpointUrl();
    console.log('='.repeat(60));
    if (this.nodesetMode) {
      console.log('OPC UA CC Simulator Server started (NodeSet mode - EngValue only)');
    } else {
      console.log('OPC UA CC Simulator Server started');
    }
    console.log('='.repeat(60));
    console.log(`Endpoint URL: ${endpointUrl}`);
    if (this.nodesetMode && this.nodesetParseResult) {
      console.log(`NodeSet file: ${this.options.nodesetFile}`);
      console.log(`Parameters: ${this.nodesetParseResult.parameters.map(p => p.browseName).join(', ')}`);
      console.log(`Mode: EngValue simulation only (no station, no SPC)`);
    } else {
      console.log(`Parameters: P01 to P${this.options.parameterCount.toString().padStart(2, '0')}`);
      console.log(`SPC sample frequency: ${this.options.spcFrequency}ms (SampleValue/SampleIndex)`);
    }
    console.log(`Scenario: ${this.options.scenario}`);
    console.log(`Internal tick rate: ${this.options.sampleRate}ms`);
    console.log(`EngValue frequency: ${this.options.engFrequency}ms`);
    if (this.options.configFile) {
      console.log(`Config file: ${this.options.configFile}`);
    }
    console.log(`Database: ${this.options.dbPath}`);
    if (this.options.dashboardPort > 0) {
      console.log(`Dashboard: http://localhost:${this.options.dashboardPort}`);
    }
    console.log('='.repeat(60));
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    // Save final state before stopping
    this.saveCurrentState();

    // Stop state persistence
    this.stopStatePersistence();

    // Stop connection blocking interval if active
    if (this.connectionBlockingIntervalId) {
      clearInterval(this.connectionBlockingIntervalId);
      this.connectionBlockingIntervalId = null;
    }

    // Stop dashboard
    if (this.dashboard) {
      await this.dashboard.stop();
      this.dashboard = null;
    }

    // Stop simulation
    this.simulator.stop();

    // Stop metrics intervals before destroying address space
    if (this.addressSpaceBuilder) {
      this.addressSpaceBuilder.dispose();
    }

    // Cleanup state machine
    this.stateMachine.destroy();

    // Stop server
    if (this.server) {
      await this.server.shutdown();
      this.server = null;
    }

    // Close database
    this.historyStore.close();

    console.log('Server stopped');
  }

  /**
   * Change simulation scenario at runtime
   */
  setScenario(scenarioName: string): void {
    this.simulator.setScenario(scenarioName);
  }

  /**
   * Get server statistics
   */
  getStatistics(): {
    serverState: ServerState;
    currentScenario: string;
    parameterCount: number;
    uptime: number;
  } {
    return {
      serverState: this.server?.engine?.serverStatus?.state ?? ServerState.Unknown,
      currentScenario: this.simulator.getCurrentScenario().name,
      parameterCount: this.options.parameterCount,
      uptime: process.uptime(),
    };
  }

  /**
   * Get history store for external access
   */
  getHistoryStore(): SQLiteHistoryStore {
    return this.historyStore;
  }

  /**
   * Get simulator for external access
   */
  getSimulator(): ParameterSimulator {
    return this.simulator;
  }

  getHeartbeatSimulationEnabled(): boolean {
    return this.addressSpaceBuilder?.getHeartbeatSimulationEnabled() ?? true;
  }

  setHeartbeatSimulationEnabled(enabled: boolean): void {
    this.addressSpaceBuilder?.setHeartbeatSimulationEnabled(enabled);
  }

  getStorageFillOverride(): number | null {
    return this.addressSpaceBuilder?.getStorageFillOverride() ?? null;
  }

  setStorageFillOverride(value: number | null): void {
    this.addressSpaceBuilder?.setStorageFillOverride(value);
  }

  /**
   * Disconnect all OPC UA client sessions by closing sessions and interrupting channels
   * Useful for simulating communication loss
   * @returns Number of sessions disconnected
   */
  disconnectAllClients(): number {
    if (!this.server) {
      return 0;
    }

    let disconnectedCount = 0;

    // First, close all sessions through the engine
    const engine = this.server.engine;
    if (engine && (engine as any)._sessions) {
      const sessions = (engine as any)._sessions;
      const sessionKeys = Object.keys(sessions);

      for (const key of sessionKeys) {
        const session = sessions[key];
        if (session && session.authenticationToken) {
          try {
            engine.closeSession(session.authenticationToken, true, 'Terminated');
            disconnectedCount++;
          } catch (error) {
            console.error(`Failed to close session:`, error);
          }
        }
      }
    }

    // Then, abruptly interrupt all channels on endpoints
    const endpoints = (this.server as any).endpoints || [];
    for (const endpoint of endpoints) {
      if (endpoint.abruptlyInterruptChannels) {
        endpoint.abruptlyInterruptChannels();
      }
    }

    if (disconnectedCount > 0) {
      console.log(`Disconnected ${disconnectedCount} OPC UA session(s)`);
    }

    return disconnectedCount;
  }

  /**
   * Get number of connected OPC UA sessions
   */
  getConnectedClientCount(): number {
    if (!this.server) {
      return 0;
    }
    return this.server.currentSessionCount;
  }

  /**
   * Get information about connected OPC UA clients
   */
  getConnectedClientsInfo(): {
    sessionCount: number;
    channelCount: number;
    clients: {
      sessionName: string;
      clientDescription: string;
      channelId: number | null;
      creationDate: Date;
    }[];
  } {
    if (!this.server) {
      return { sessionCount: 0, channelCount: 0, clients: [] };
    }

    const clients: {
      sessionName: string;
      clientDescription: string;
      channelId: number | null;
      creationDate: Date;
    }[] = [];

    // Get channel count from endpoints
    let channelCount = 0;
    const endpoints = (this.server as any).endpoints || [];
    for (const endpoint of endpoints) {
      if (endpoint.getChannels) {
        channelCount += endpoint.getChannels().length;
      }
    }

    // Get session info from engine
    const engine = this.server.engine;
    if (engine && (engine as any)._sessions) {
      const sessions = (engine as any)._sessions;
      // _sessions is an object with authenticationToken as keys
      for (const key of Object.keys(sessions)) {
        const session = sessions[key];
        if (session) {
          clients.push({
            sessionName: session.sessionName || 'Unknown',
            clientDescription: session.clientDescription?.applicationName?.text || 'Unknown Client',
            channelId: session.channelId ?? null,
            creationDate: session.creationDate || new Date(),
          });
        }
      }
    }

    return {
      sessionCount: this.server.currentSessionCount,
      channelCount,
      clients,
    };
  }

  /**
   * Enable or disable connection blocking mode
   * When enabled, all existing clients are disconnected and new connections are rejected
   * @param enabled - true to block connections, false to allow
   * @returns Number of clients disconnected (if enabling)
   */
  setConnectionBlocking(enabled: boolean): number {
    const wasEnabled = this.connectionBlockingEnabled;
    this.connectionBlockingEnabled = enabled;

    let disconnectedCount = 0;

    // If enabling blocking, disconnect all existing clients and start blocking interval
    if (enabled && !wasEnabled) {
      disconnectedCount = this.disconnectAllClients();
      console.log(`Connection blocking enabled, disconnected ${disconnectedCount} client(s)`);

      // Start interval to continuously disconnect any new connections
      this.connectionBlockingIntervalId = setInterval(() => {
        if (this.connectionBlockingEnabled && this.getConnectedClientCount() > 0) {
          const count = this.disconnectAllClients();
          if (count > 0) {
            console.log(`Blocked ${count} new connection(s)`);
          }
        }
      }, 500); // Check every 500ms
    } else if (!enabled && wasEnabled) {
      // Stop the blocking interval
      if (this.connectionBlockingIntervalId) {
        clearInterval(this.connectionBlockingIntervalId);
        this.connectionBlockingIntervalId = null;
      }
      console.log('Connection blocking disabled, new connections allowed');
    }

    return disconnectedCount;
  }

  /**
   * Check if connection blocking is enabled
   */
  isConnectionBlocked(): boolean {
    return this.connectionBlockingEnabled;
  }
}
