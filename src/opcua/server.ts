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
import { SQLiteHistoryStore } from '../database/sqlite-store';
import { ParameterSimulator, createDefaultParameters } from '../simulation/parameter-simulator';
import { StationStateMachine } from '../simulation/station-state-machine';
import { CLIOptions, ParameterConfig, TriggerType } from '../types';
import path from 'path';
import fs from 'fs';

export class CCSimulatorServer {
  private server: OPCUAServer | null = null;
  private historyStore: SQLiteHistoryStore;
  private simulator: ParameterSimulator;
  private stateMachine: StationStateMachine;
  private options: CLIOptions;
  private parameterConfigs: ParameterConfig[];

  constructor(options: CLIOptions) {
    this.options = options;

    // Initialize SQLite store
    this.historyStore = new SQLiteHistoryStore(options.dbPath);

    // Create parameter configurations
    this.parameterConfigs = createDefaultParameters(
      options.parameterCount,
      options.target,
      options.uslOffset,
      options.lslOffset,
      options.sampleRate
    );

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

    // Initialize simulator with frequencies
    this.simulator = new ParameterSimulator(
      options.scenario,
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

    // Initialize state machine - starts in NotConfigured state
    // User must send Configure command to start the workflow:
    // NotConfigured -> Configure -> Configuring -> Idle -> Start -> AcquisitionStarted -> Stop -> AcquisitionStopped -> Reset -> Idle
    this.stateMachine = new StationStateMachine(0);
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
        manufacturerName: 'Framatome MSP Simulator',
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
    const builder = new AddressSpaceBuilder(
      addressSpace,
      this.historyStore,
      this.simulator,
      this.stateMachine
    );
    builder.build(this.parameterConfigs);

    // Start server
    await this.server.start();

    // Start simulation
    this.simulator.start();

    const endpointUrl = this.server.getEndpointUrl();
    console.log('='.repeat(60));
    console.log('OPC UA CC Simulator Server started');
    console.log('='.repeat(60));
    console.log(`Endpoint URL: ${endpointUrl}`);
    console.log(`Parameters: P01 to P${this.options.parameterCount.toString().padStart(2, '0')}`);
    console.log(`Scenario: ${this.options.scenario}`);
    console.log(`Internal tick rate: ${this.options.sampleRate}ms`);
    console.log(`SPC sample frequency: ${this.options.spcFrequency}ms (SampleValue/SampleIndex)`);
    console.log(`EngValue frequency: ${this.options.engFrequency}ms`);
    console.log(`Target: ${this.options.target}`);
    console.log(`Tolerance: LSL=${(this.options.target * (1 - this.options.lslOffset / 100)).toFixed(4)}, USL=${(this.options.target * (1 + this.options.uslOffset / 100)).toFixed(4)}`);
    console.log(`Database: ${this.options.dbPath}`);
    console.log('='.repeat(60));
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    // Stop simulation
    this.simulator.stop();

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
}
