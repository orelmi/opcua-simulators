/**
 * Types for OPC UA Control Chart Simulator
 */

export interface ToleranceLimits {
  /** Upper Specification Limit (USL) - limite de tolérance haute */
  usl: number;
  /** Lower Specification Limit (LSL) - limite de tolérance basse */
  lsl: number;
  /** Target/Nominal value - valeur cible */
  target: number;
}

export interface ControlLimits {
  /** Upper Control Limit (UCL) - limite de contrôle haute */
  ucl: number;
  /** Lower Control Limit (LCL) - limite de contrôle basse */
  lcl: number;
  /** Center Line (CL) - ligne centrale (moyenne) */
  cl: number;
}

export interface ParameterConfig {
  /** Parameter index (1-24) */
  index: number;
  /** Parameter name (P01-P24) */
  name: string;
  /** Display name (e.g., WeldCurrent, ArcVoltage) */
  displayName: string;
  /** Description (e.g., "Courant de soudage") */
  description: string;
  /** Tolerance limits from manufacturing specs */
  toleranceLimits: ToleranceLimits;
  /** Control limits for SPC charts */
  controlLimits: ControlLimits;
  /** Unit of measurement */
  unit: string;
  /** Sample rate in milliseconds */
  sampleRate: number;
  /** Whether this parameter is enabled/active */
  enabled: boolean;
}

export interface SimulationScenario {
  /** Scenario name */
  name: string;
  /** Scenario description */
  description: string;
  /** Duration in milliseconds */
  duration: number;
  /** Generator function for values */
  generator: (time: number, config: ParameterConfig) => number;
}

export interface HistoricalDataPoint {
  /** Timestamp of the data point */
  timestamp: Date;
  /** Parameter index */
  parameterIndex: number;
  /** Sample value */
  value: number;
  /** Sample index */
  sampleIndex: number;
  /** Engineering value */
  engValue: number;
}

export interface CLIOptions {
  /** OPC UA server port */
  port: number;
  /** Number of parameters to simulate (1-24) */
  parameterCount: number;
  /** Global USL offset from target (%) */
  uslOffset: number;
  /** Global LSL offset from target (%) */
  lslOffset: number;
  /** Simulation scenario name */
  scenario: string;
  /** Sample rate in milliseconds (internal simulation tick) */
  sampleRate: number;
  /** SPC sample frequency in milliseconds (for SampleValue/SampleIndex updates, default 5000ms) */
  spcFrequency: number;
  /** EngValue update frequency in milliseconds (default 100ms) */
  engFrequency: number;
  /** SQLite database path */
  dbPath: string;
  /** Enable verbose logging */
  verbose: boolean;
  /** Target value for all parameters */
  target: number;
}

export enum AcquisitionStatus {
  NotConfigured = 0,
  Idle = 1,
  AcquisitionStarted = 2,
  AcquisitionStopped = 3,
  Configuring = 8,
  ConfigurationError = 9
}

export enum ProcessingFunction {
  None = 0,
  Average = 1,
  MovingAverage = 2
}

/**
 * Trigger types for start/stop conditions
 */
export enum TriggerType {
  UaCommand = 0,
  RisingEdge = 1,
  FallingEdge = 2,
  BothEdge = 3
}

/**
 * Station state machine events
 */
export type StationEvent =
  | { type: 'CONFIGURE' }
  | { type: 'CONFIGURATION_DONE' }
  | { type: 'CONFIGURATION_ERROR'; error: string }
  | { type: 'START_ACQUISITION'; trigger: TriggerType }
  | { type: 'STOP_ACQUISITION'; trigger: TriggerType }
  | { type: 'RESET' };

/**
 * Station state
 */
export interface StationState {
  status: AcquisitionStatus;
  startedAt: Date | null;
  stoppedAt: Date | null;
  configurationError: string | null;
  lastTransition: Date;
}
