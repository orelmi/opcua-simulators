/**
 * SQLite Historical Data Store
 * Provides caching and historization for OPC UA data
 */

import Database from 'better-sqlite3';
import { HistoricalDataPoint } from '../types';

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
    `);
  }

  private prepareStatements(): void {
    this.insertStmt = this.db.prepare(`
      INSERT INTO historical_data (timestamp, parameter_index, sample_index, value, eng_value)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.queryByTimeRangeStmt = this.db.prepare(`
      SELECT timestamp, parameter_index, sample_index, value, eng_value
      FROM historical_data
      WHERE parameter_index = ? AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `);

    this.queryLatestStmt = this.db.prepare(`
      SELECT timestamp, parameter_index, sample_index, value, eng_value
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
      dataPoint.engValue
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
          point.engValue
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
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
