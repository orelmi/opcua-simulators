/**
 * OPC UA CC Simulator - Main Entry Point
 *
 * A simulator for testing Statistical Process Control (SPC) and control charts
 * with OPC UA historization support.
 */

import { Command } from 'commander';
import { CCSimulatorServer } from './opcua/server';
import { CLIOptions } from './types';
import { listScenarios } from './simulation/scenarios';
import path from 'path';
import fs from 'fs';

const program = new Command();

program
  .name('opcua-cc-simulator')
  .description('OPC UA Control Chart Simulator with historization support')
  .version('1.0.0');

program
  .option('-P, --port <port>', 'OPC UA server port', '4840')
  .option('-p, --params <count>', 'Number of enabled parameters (1-24, all 24 always created)', '24')
  .option('-t, --target <value>', 'Target/nominal value for all parameters', '100.0')
  .option('--usl-offset <percent>', 'USL offset from target in %', '5.0')
  .option('--lsl-offset <percent>', 'LSL offset from target in %', '5.0')
  .option('-s, --scenario <name>', 'Simulation scenario', 'realistic')
  .option('-r, --sample-rate <ms>', 'Internal simulation tick rate in milliseconds', '100')
  .option('-f, --spc-frequency <ms>', 'SPC sample frequency in milliseconds (SampleValue/SampleIndex updates)', '5000')
  .option('-e, --eng-frequency <ms>', 'EngValue update frequency in milliseconds', '100')
  .option('-d, --db <path>', 'SQLite database path', './data/cc_history.db')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('--list-scenarios', 'List available simulation scenarios')
  .action(async (options) => {
    // Handle list scenarios
    if (options.listScenarios) {
      console.log('\nAvailable simulation scenarios:');
      console.log('='.repeat(60));
      for (const scenario of listScenarios()) {
        console.log(`  ${scenario.name.padEnd(22)} ${scenario.description}`);
      }
      console.log('\nUse with: --scenario <name>');
      console.log('');
      process.exit(0);
    }

    // Parse and validate options
    const cliOptions: CLIOptions = {
      port: parseInt(options.port, 10),
      parameterCount: Math.min(24, Math.max(1, parseInt(options.params, 10))),
      target: parseFloat(options.target),
      uslOffset: parseFloat(options.uslOffset),
      lslOffset: parseFloat(options.lslOffset),
      scenario: options.scenario,
      sampleRate: parseInt(options.sampleRate, 10),
      spcFrequency: parseInt(options.spcFrequency, 10),
      engFrequency: parseInt(options.engFrequency, 10),
      dbPath: options.db,
      verbose: options.verbose,
    };

    // Validate parameter count
    if (cliOptions.parameterCount < 1 || cliOptions.parameterCount > 24) {
      console.error('Error: Parameter count must be between 1 and 24');
      process.exit(1);
    }

    // Ensure data directory exists
    const dataDir = path.dirname(cliOptions.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Create and start server
    const server = new CCSimulatorServer(cliOptions);

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      await server.start();

      // Print usage examples
      console.log('\nUsage examples:');
      console.log('-'.repeat(60));
      console.log('Browse address space:');
      console.log(`  opc.tcp://localhost:${cliOptions.port}/UA/CCSimulator`);
      console.log('\nStation state machine workflow:');
      console.log('  1. Configure -> Configuring -> Idle');
      console.log('  2. Start -> AcquisitionStarted');
      console.log('  3. Stop -> AcquisitionStopped');
      console.log('  4. Reset -> Idle (can Start again)');
      console.log('\nStation nodes:');
      console.log('  Objects/Station/Name                - Station name (auto-generated, e.g., "station-A3F2B1")');
      console.log('  Objects/Station/SerialNumber        - Serial number (e.g., "SN-20260106-B4C8A2")');
      console.log('  Objects/Station/Manufacturer        - "Framatome MSP Simulator"');
      console.log('  Objects/Station/Heartbeat           - Watchdog (UInt64, writable by client)');
      console.log('  Objects/Station/HeartbeatAck        - Auto-copies Heartbeat value');
      console.log('  Objects/Station/State/Value         - Current state (0=NotConfigured, 1=Idle, 2=Started, 3=Stopped, 8=Configuring)');
      console.log('  Objects/Station/State/StartedAt     - Acquisition start timestamp');
      console.log('  Objects/Station/State/StoppedAt     - Acquisition stop timestamp');
      console.log('  Objects/Station/Command/Configure   - Write true to configure (NotConfigured->Idle)');
      console.log('  Objects/Station/Command/Start       - Write true to start acquisition (Idle->Started)');
      console.log('  Objects/Station/Command/Stop        - Write true to stop acquisition (Started->Stopped)');
      console.log('  Objects/Station/Command/Reset       - Write true to reset (Stopped->Idle)');
      console.log('  Objects/Station/Metrics/CycleTime              - Cycle time in ms');
      console.log('  Objects/Station/Metrics/Info1                  - Random value (simulated)');
      console.log('  Objects/Station/Metrics/Info2                  - Static value (no simulation)');
      console.log('  Objects/Station/Metrics/StartupTime            - Server startup timestamp');
      console.log('  Objects/Station/Metrics/StorageFillPercentage  - Storage fill %');
      console.log('  Objects/Station/Metrics/UpTimeSeconds          - Uptime in seconds');
      console.log('  Objects/Station/Context/DoubleInfo1            - 0-360° revolution (simulated)');
      console.log('  Objects/Station/Context/DoubleInfo2            - No simulation');
      console.log('  Objects/Station/Context/DoubleInfo3            - No simulation');
      console.log('  Objects/Station/Context/OperationId            - Client writable');
      console.log('  Objects/Station/Context/ProductionOrderId      - Client writable');
      console.log('  Objects/Station/Context/RoutingId              - Client writable');
      console.log('  Objects/Station/Context/SpecDouble1-3          - Client writable');
      console.log('  Objects/Station/Context/SpecString1-3          - Client writable');
      console.log('\nParameter nodes (P01-P24 always created, enabled based on --params):');
      console.log('  Objects/P01/SampleValue              - SPC sample value (historized)');
      console.log('  Objects/P01/EngValue                 - Engineering value (real-time, not historized)');
      console.log('  Objects/P01/SampleIndex              - Sample counter');
      console.log('  Objects/P01/Enabled                  - Parameter enabled (true/false)');
      console.log('  Objects/P01/Unit                     - Unit of measurement (A, V, °C, mm, etc.)');
      console.log('  Objects/P01/Config/EngRange/MinimumValue - LSL');
      console.log('  Objects/P01/Config/EngRange/MaximumValue - USL');
      console.log('\nPress Ctrl+C to stop the server');
      console.log('-'.repeat(60));

    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  });

program.parse();
