/**
 * SQLite Historical Data Store
 * Provides caching and historization for OPC UA data
 */

import Database from 'better-sqlite3';
import { HistoricalDataPoint, AcquisitionStatus } from '../types';

/**
 * Persisted simulator state
 */
export interface PersistedState {
  acquisitionStatus: AcquisitionStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  scenarioName: string;
  parameterStates: {
    parameterIndex: number;
    sampleIndex: number;
    sampleValue: number;
    engValue: number;
  }[];
}

export class SQLiteHistoryStore {
  private db: Database.Database;
  private insertStmt!: Database.Statement;
  private queryByTimeRangeStmt!: Database.Statement;
  private queryLatestStmt!: Database.Statement;
  private deleteOldDataStmt!: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initializeDatabase();
    this.prepareStatements();
  }

  private initializeDatabase(): void {
    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Create historical data table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS historical_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        parameter_index INTEGER NOT NULL,
        sample_index INTEGER NOT NULL,
        value REAL NOT NULL,
        eng_value REAL NOT NULL,
        status_code INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_historical_timestamp
        ON historical_data(timestamp);

      CREATE INDEX IF NOT EXISTS idx_historical_param_time
        ON historical_data(parameter_index, timestamp);

      CREATE TABLE IF NOT EXISTS parameter_config (
        parameter_index INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        target REAL NOT NULL,
        usl REAL NOT NULL,
        lsl REAL NOT NULL,
        ucl REAL NOT NULL,
        lcl REAL NOT NULL,
        cl REAL NOT NULL,
        unit TEXT DEFAULT 'mm',
        sample_rate INTEGER DEFAULT 1000
      );

      -- Simulator state persistence table
      CREATE TABLE IF NOT EXISTS simulator_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        acquisition_status INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        stopped_at TEXT,
        scenario_name TEXT DEFAULT 'realistic',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Parameter state persistence table
      CREATE TABLE IF NOT EXISTS parameter_state (
        parameter_index INTEGER PRIMARY KEY,
        sample_index INTEGER NOT NULL DEFAULT 0,
        sample_value REAL NOT NULL DEFAULT 0,
        eng_value REAL NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Initialize simulator state if not exists
      INSERT OR IGNORE INTO simulator_state (id, acquisition_status, scenario_name)
      VALUES (1, 0, 'realistic');
    `);

    // Migration: add status_code column to historical_data for databases created
    // before per-sample quality was introduced.
    const historicalColumns = this.db
      .prepare(`PRAGMA table_info(historical_data)`)
      .all() as { name: string }[];
    if (!historicalColumns.some((c) => c.name === 'status_code')) {
      this.db.exec(
        `ALTER TABLE historical_data ADD COLUMN status_code INTEGER NOT NULL DEFAULT 0`
      );
    }
  }

  private prepareStatements(): void {
    this.insertStmt = this.db.prepare(`
      INSERT INTO historical_data (timestamp, parameter_index, sample_index, value, eng_value, status_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.queryByTimeRangeStmt = this.db.prepare(`
      SELECT timestamp, parameter_index, sample_index, value, eng_value, status_code
      FROM historical_data
      WHERE parameter_index = ? AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `);

    this.queryLatestStmt = this.db.prepare(`
      SELECT timestamp, parameter_index, sample_index, value, eng_value, status_code
      FROM historical_data
      WHERE parameter_index = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    this.deleteOldDataStmt = this.db.prepare(`
      DELETE FROM historical_data
      WHERE timestamp < ?
    `);
  }

  /**
   * Insert a single data point
   */
  insertDataPoint(dataPoint: HistoricalDataPoint): void {
    this.insertStmt.run(
      dataPoint.timestamp.toISOString(),
      dataPoint.parameterIndex,
      dataPoint.sampleIndex,
      dataPoint.value,
      dataPoint.engValue,
      dataPoint.statusCode ?? 0
    );
  }

  /**
   * Insert multiple data points in a transaction
   */
  insertBatch(dataPoints: HistoricalDataPoint[]): void {
    const insertMany = this.db.transaction((points: HistoricalDataPoint[]) => {
      for (const point of points) {
        this.insertStmt.run(
          point.timestamp.toISOString(),
          point.parameterIndex,
          point.sampleIndex,
          point.value,
          point.engValue,
          point.statusCode ?? 0
        );
      }
    });
    insertMany(dataPoints);
  }

  /**
   * Query data by time range for a specific parameter
   */
  queryByTimeRange(
    parameterIndex: number,
    startTime: Date,
    endTime: Date
  ): HistoricalDataPoint[] {
    const rows = this.queryByTimeRangeStmt.all(
      parameterIndex,
      startTime.toISOString(),
      endTime.toISOString()
    ) as any[];

    return rows.map((row) => ({
      timestamp: new Date(row.timestamp),
      parameterIndex: row.parameter_index,
      sampleIndex: row.sample_index,
      value: row.value,
      engValue: row.eng_value,
      statusCode: row.status_code ?? 0,
    }));
  }

  /**
   * Query latest N data points for a parameter
   */
  queryLatest(parameterIndex: number, count: number): HistoricalDataPoint[] {
    const rows = this.queryLatestStmt.all(parameterIndex, count) as any[];

    return rows.map((row) => ({
      timestamp: new Date(row.timestamp),
      parameterIndex: row.parameter_index,
      sampleIndex: row.sample_index,
      value: row.value,
      engValue: row.eng_value,
      statusCode: row.status_code ?? 0,
    })).reverse(); // Return in chronological order
  }

  /**
   * Delete data older than specified date
   */
  deleteOldData(beforeDate: Date): number {
    const result = this.deleteOldDataStmt.run(beforeDate.toISOString());
    return result.changes;
  }

  /**
   * Purge the entire history table (historical_data). Returns the number of
   * deleted rows. Used by the dashboard "Purge history" button to avoid a large
   * backlog that overwhelms OPC UA HistoryRead clients.
   */
  clearHistory(): number {
    const result = this.db.prepare('DELETE FROM historical_data').run();
    return result.changes;
  }

  /**
   * Save parameter configuration
   */
  saveParameterConfig(config: {
    parameterIndex: number;
    name: string;
    target: number;
    usl: number;
    lsl: number;
    ucl: number;
    lcl: number;
    cl: number;
    unit: string;
    sampleRate: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO parameter_config
      (parameter_index, name, target, usl, lsl, ucl, lcl, cl, unit, sample_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      config.parameterIndex,
      config.name,
      config.target,
      config.usl,
      config.lsl,
      config.ucl,
      config.lcl,
      config.cl,
      config.unit,
      config.sampleRate
    );
  }

  /**
   * Get statistics for a parameter
   */
  getParameterStats(parameterIndex: number): {
    count: number;
    min: number;
    max: number;
    avg: number;
    stddev: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        MIN(value) as min,
        MAX(value) as max,
        AVG(value) as avg,
        (
          SELECT AVG((value - sub.avg) * (value - sub.avg))
          FROM historical_data, (SELECT AVG(value) as avg FROM historical_data WHERE parameter_index = ?) as sub
          WHERE parameter_index = ?
        ) as variance
      FROM historical_data
      WHERE parameter_index = ?
    `);

    const row = stmt.get(parameterIndex, parameterIndex, parameterIndex) as any;
    if (!row || row.count === 0) return null;

    return {
      count: row.count,
      min: row.min,
      max: row.max,
      avg: row.avg,
      stddev: Math.sqrt(row.variance || 0),
    };
  }

  /**
   * Save simulator state for persistence across restarts
   */
  saveSimulatorState(state: {
    acquisitionStatus: AcquisitionStatus;
    startedAt: Date | null;
    stoppedAt: Date | null;
    scenarioName: string;
  }): void {
    const stmt = this.db.prepare(`
      UPDATE simulator_state SET
        acquisition_status = ?,
        started_at = ?,
        stopped_at = ?,
        scenario_name = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `);
    stmt.run(
      state.acquisitionStatus,
      state.startedAt?.toISOString() ?? null,
      state.stoppedAt?.toISOString() ?? null,
      state.scenarioName
    );
  }

  /**
   * Save parameter state for persistence
   */
  saveParameterState(state: {
    parameterIndex: number;
    sampleIndex: number;
    sampleValue: number;
    engValue: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO parameter_state
      (parameter_index, sample_index, sample_value, eng_value, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(
      state.parameterIndex,
      state.sampleIndex,
      state.sampleValue,
      state.engValue
    );
  }

  /**
   * Save multiple parameter states in a transaction
   */
  saveParameterStates(states: {
    parameterIndex: number;
    sampleIndex: number;
    sampleValue: number;
    engValue: number;
  }[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO parameter_state
      (parameter_index, sample_index, sample_value, eng_value, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const saveAll = this.db.transaction((stateList: typeof states) => {
      for (const state of stateList) {
        stmt.run(
          state.parameterIndex,
          state.sampleIndex,
          state.sampleValue,
          state.engValue
        );
      }
    });

    saveAll(states);
  }

  /**
   * Load persisted simulator state
   */
  loadSimulatorState(): PersistedState | null {
    const stateRow = this.db.prepare(`
      SELECT acquisition_status, started_at, stopped_at, scenario_name
      FROM simulator_state WHERE id = 1
    `).get() as any;

    if (!stateRow) return null;

    const paramRows = this.db.prepare(`
      SELECT parameter_index, sample_index, sample_value, eng_value
      FROM parameter_state
      ORDER BY parameter_index
    `).all() as any[];

    return {
      acquisitionStatus: stateRow.acquisition_status as AcquisitionStatus,
      startedAt: stateRow.started_at,
      stoppedAt: stateRow.stopped_at,
      scenarioName: stateRow.scenario_name || 'realistic',
      parameterStates: paramRows.map(row => ({
        parameterIndex: row.parameter_index,
        sampleIndex: row.sample_index,
        sampleValue: row.sample_value,
        engValue: row.eng_value,
      })),
    };
  }

  /**
   * Clear persisted state (reset to defaults)
   */
  clearPersistedState(): void {
    this.db.exec(`
      UPDATE simulator_state SET
        acquisition_status = 0,
        started_at = NULL,
        stopped_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1;

      DELETE FROM parameter_state;
    `);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
