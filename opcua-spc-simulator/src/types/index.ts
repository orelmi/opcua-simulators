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

/**
 * Scenario parameter definition for UI controls
 */
export interface ScenarioParamDef {
  /** Parameter key */
  key: string;
  /** Display label */
  label: string;
  /** Parameter type */
  type: 'range' | 'number';
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Step increment */
  step: number;
  /** Default value */
  default: number;
  /** Unit suffix for display */
  unit?: string;
}

/**
 * Scenario parameters - current values keyed by parameter name
 */
export type ScenarioParams = Record<string, number>;

export interface SimulationScenario {
  /** Scenario name */
  name: string;
  /** Scenario description */
  description: string;
  /** Duration in milliseconds */
  duration: number;
  /** Generator function for values - receives optional params */
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams) => number;
  /** Configurable parameters for this scenario */
  paramDefs?: ScenarioParamDef[];
  /** Default parameter values */
  defaultParams?: ScenarioParams;
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

/**
 * NodeId format type
 * - 'string': ns=X;s=Path.To.Variable (e.g., ns=2;s=Station.Name)
 * - 'numeric': ns=X;i=NNNNN (auto-incremented numeric IDs)
 * Note: Default namespace index is 2 (0=OPC UA, 1=Server, 2+=Custom)
 */
export type NodeIdFormat = 'string' | 'numeric';

/**
 * Parameter configuration from config file (optional overrides)
 */
export interface ParameterConfigOverride {
  /** Parameter index (1-24) - required to identify which parameter to configure */
  index: number;
  /** Override display name */
  displayName?: string;
  /** Override description */
  description?: string;
  /** Override unit */
  unit?: string;
  /** Override target value */
  target?: number;
  /** Override USL (absolute value) */
  usl?: number;
  /** Override LSL (absolute value) */
  lsl?: number;
  /** Override UCL (absolute value) */
  ucl?: number;
  /** Override LCL (absolute value) */
  lcl?: number;
  /** Override CL (center line, defaults to target) */
  cl?: number;
  /** Whether this parameter is enabled */
  enabled?: boolean;
}

/**
 * Configuration file structure for parameters
 */
export interface ParametersConfigFile {
  /** Optional global defaults that apply to all parameters unless overridden */
  defaults?: {
    /** Default USL offset from target in % (default: 5) */
    uslOffsetPercent?: number;
    /** Default LSL offset from target in % (default: 5) */
    lslOffsetPercent?: number;
    /** Control limits as percentage of tolerance range (default: 75) */
    controlLimitPercent?: number;
  };
  /** Per-parameter configuration overrides */
  parameters?: ParameterConfigOverride[];
}

export interface CLIOptions {
  /** OPC UA server port */
  port: number;
  /** Number of parameters to simulate (1-24) */
  parameterCount: number;
  /** Global USL offset from target (%) - used when no config file */
  uslOffset: number;
  /** Global LSL offset from target (%) - used when no config file */
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
  /** Target value for all parameters - used when no config file */
  target: number;
  /** Namespace index for custom nodes (default: 2, use 1 for server namespace) */
  namespaceIndex: number;
  /** NodeId format: 'string' for ns=X;s=Path or 'numeric' for ns=X;i=NNN */
  nodeIdFormat: NodeIdFormat;
  /** Web dashboard port (0 to disable) */
  dashboardPort: number;
  /** Path to parameters configuration file (JSON) */
  configFile?: string;
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
