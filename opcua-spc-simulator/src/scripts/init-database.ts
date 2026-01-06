/**
 * Database Initialization Script
 * Generates 24 hours of historical data for testing
 */

import { SQLiteHistoryStore } from '../database/sqlite-store';
import { ParameterConfig, HistoricalDataPoint } from '../types';
import { createDefaultParameters } from '../simulation/parameter-simulator';
import { getScenario, listScenarios } from '../simulation/scenarios';

interface InitOptions {
  dbPath: string;
  parameterCount: number;
  target: number;
  uslOffset: number;
  lslOffset: number;
  sampleRate: number;
  scenario: string;
  hoursBack: number;
}

/**
 * Generate historical data for a parameter
 */
function generateHistoricalData(
  config: ParameterConfig,
  scenario: ReturnType<typeof getScenario>,
  startTime: Date,
  endTime: Date,
  sampleRate: number
): HistoricalDataPoint[] {
  const dataPoints: HistoricalDataPoint[] = [];
  let sampleIndex = 0;
  const scenarioStartTime = startTime.getTime();

  for (
    let timestamp = startTime.getTime();
    timestamp <= endTime.getTime();
    timestamp += sampleRate
  ) {
    const elapsedTime = timestamp - scenarioStartTime;
    const value = scenario.generator(elapsedTime, config);

    // Clamp to tolerance limits
    const clampedValue = Math.max(
      config.toleranceLimits.lsl,
      Math.min(config.toleranceLimits.usl, value)
    );

    dataPoints.push({
      timestamp: new Date(timestamp),
      parameterIndex: config.index,
      sampleIndex: sampleIndex++,
      value: clampedValue,
      engValue: clampedValue,
    });
  }

  return dataPoints;
}

/**
 * Initialize database with historical data
 */
async function initializeDatabase(options: InitOptions): Promise<void> {
  console.log('='.repeat(60));
  console.log('OPC UA CC Simulator - Database Initialization');
  console.log('='.repeat(60));

  // Create store
  const store = new SQLiteHistoryStore(options.dbPath);

  // Create parameter configs
  const parameterConfigs = createDefaultParameters(
    options.parameterCount,
    options.target,
    options.uslOffset,
    options.lslOffset,
    options.sampleRate
  );

  // Get scenario
  const scenario = getScenario(options.scenario);

  // Calculate time range
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - options.hoursBack * 60 * 60 * 1000);

  console.log(`\nGenerating ${options.hoursBack} hours of historical data...`);
  console.log(`Time range: ${startTime.toISOString()} to ${endTime.toISOString()}`);
  console.log(`Scenario: ${scenario.name} - ${scenario.description}`);
  console.log(`Sample rate: ${options.sampleRate}ms`);
  console.log(`Parameters: ${options.parameterCount}`);
  console.log(`Target: ${options.target}`);
  console.log(`Tolerance: ±${options.uslOffset}%`);
  console.log('');

  const totalSamples =
    Math.ceil((options.hoursBack * 60 * 60 * 1000) / options.sampleRate) *
    options.parameterCount;
  console.log(`Total samples to generate: ${totalSamples.toLocaleString()}`);

  let generatedCount = 0;
  const batchSize = 10000;

  for (const config of parameterConfigs) {
    console.log(`\nProcessing ${config.name}...`);

    // Save parameter config
    store.saveParameterConfig({
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

    // Generate data in batches
    const dataPoints = generateHistoricalData(
      config,
      scenario,
      startTime,
      endTime,
      options.sampleRate
    );

    // Insert in batches for better performance
    for (let i = 0; i < dataPoints.length; i += batchSize) {
      const batch = dataPoints.slice(i, i + batchSize);
      store.insertBatch(batch);
      generatedCount += batch.length;

      // Progress indicator
      const progress = Math.round((generatedCount / totalSamples) * 100);
      process.stdout.write(`\r  Progress: ${progress}% (${generatedCount.toLocaleString()} samples)`);
    }

    // Print stats for this parameter
    const stats = store.getParameterStats(config.index);
    if (stats) {
      console.log(`\n  Stats: avg=${stats.avg.toFixed(4)}, stddev=${stats.stddev.toFixed(4)}, min=${stats.min.toFixed(4)}, max=${stats.max.toFixed(4)}`);
    }
  }

  console.log('\n');
  console.log('='.repeat(60));
  console.log('Database initialization complete!');
  console.log(`Database file: ${options.dbPath}`);
  console.log(`Total samples: ${generatedCount.toLocaleString()}`);
  console.log('='.repeat(60));

  store.close();
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse command line arguments
  const options: InitOptions = {
    dbPath: './data/cc_history.db',
    parameterCount: 24,
    target: 100.0,
    uslOffset: 5.0,
    lslOffset: 5.0,
    sampleRate: 1000,
    scenario: 'realistic',
    hoursBack: 24,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--db':
      case '-d':
        options.dbPath = args[++i];
        break;
      case '--params':
      case '-p':
        options.parameterCount = parseInt(args[++i], 10);
        break;
      case '--target':
      case '-t':
        options.target = parseFloat(args[++i]);
        break;
      case '--usl-offset':
        options.uslOffset = parseFloat(args[++i]);
        break;
      case '--lsl-offset':
        options.lslOffset = parseFloat(args[++i]);
        break;
      case '--sample-rate':
      case '-r':
        options.sampleRate = parseInt(args[++i], 10);
        break;
      case '--scenario':
      case '-s':
        options.scenario = args[++i];
        break;
      case '--hours':
      case '-h':
        options.hoursBack = parseInt(args[++i], 10);
        break;
      case '--list-scenarios':
        console.log('Available scenarios:');
        for (const s of listScenarios()) {
          console.log(`  ${s.name.padEnd(20)} - ${s.description}`);
        }
        process.exit(0);
      case '--help':
        console.log(`
OPC UA CC Simulator - Database Initialization

Usage: npx ts-node src/scripts/init-database.ts [options]

Options:
  -d, --db <path>         Database file path (default: ./data/cc_history.db)
  -p, --params <count>    Number of parameters P01-P24 (default: 24)
  -t, --target <value>    Target/nominal value (default: 100.0)
  --usl-offset <percent>  USL offset from target in % (default: 5.0)
  --lsl-offset <percent>  LSL offset from target in % (default: 5.0)
  -r, --sample-rate <ms>  Sample rate in milliseconds (default: 1000)
  -s, --scenario <name>   Simulation scenario (default: realistic)
  -h, --hours <hours>     Hours of historical data (default: 24)
  --list-scenarios        List available scenarios
  --help                  Show this help message
`);
        process.exit(0);
    }
  }

  // Ensure data directory exists
  const dataDir = options.dbPath.substring(0, options.dbPath.lastIndexOf('/'));
  if (dataDir && !require('fs').existsSync(dataDir)) {
    require('fs').mkdirSync(dataDir, { recursive: true });
  }

  await initializeDatabase(options);
}

main().catch((error) => {
  console.error('Initialization failed:', error);
  process.exit(1);
});
