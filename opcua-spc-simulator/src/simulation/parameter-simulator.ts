/**
 * Parameter Simulator
 * Generates simulated values for CC parameters based on scenarios
 */

import { EventEmitter } from 'events';
import { ParameterConfig, SimulationScenario, HistoricalDataPoint, AcquisitionStatus, ScenarioParams, ScenarioParamDef } from '../types';
import { getScenario } from './scenarios';
import { StationStateMachine } from './station-state-machine';

export interface ParameterState {
  config: ParameterConfig;
  currentValue: number;
  sampleValue: number; // alias for currentValue (SPC sample)
  engValue: number;
  sampleIndex: number;
  lastUpdate: Date;
  lastSpcEmit: number; // timestamp of last SPC emit
  lastEngEmit: number; // timestamp of last EngValue emit
}

export class ParameterSimulator extends EventEmitter {
  private parameters: Map<number, ParameterState> = new Map();
  private scenario: SimulationScenario;
  private scenarioParams: ScenarioParams = {};
  private startTime: number;
  private intervalId: NodeJS.Timeout | null = null;
  private sampleRate: number;
  private spcFrequency: number;
  private engFrequency: number;
  private stateMachine: StationStateMachine | null = null;
  private forceSpcEmission: boolean = false;

  /**
   * @param scenarioName - Name of the simulation scenario
   * @param sampleRate - Internal simulation tick rate in ms (default: 100ms)
   * @param spcFrequency - SPC sample frequency in ms for SampleValue/SampleIndex updates (default: 5000ms = 5s)
   * @param engFrequency - EngValue update frequency in ms (default: 100ms)
   */
  constructor(scenarioName: string, sampleRate: number = 100, spcFrequency: number = 5000, engFrequency: number = 100) {
    super();
    this.scenario = getScenario(scenarioName);
    this.scenarioParams = { ...this.scenario.defaultParams };
    this.startTime = Date.now();
    this.sampleRate = sampleRate;
    this.spcFrequency = spcFrequency;
    this.engFrequency = engFrequency;
  }

  /**
   * Set the station state machine reference
   * SampleValue will only be updated when acquisition is active
   */
  setStateMachine(stateMachine: StationStateMachine): void {
    this.stateMachine = stateMachine;

    // Listen for reset event to reset sample indices
    this.stateMachine.on('reset', () => {
      this.resetSampleIndices();
    });
  }

  /**
   * Reset all sample indices to 0
   */
  resetSampleIndices(): void {
    for (const [, state] of this.parameters) {
      state.sampleIndex = 0;
      state.lastSpcEmit = 0;
    }
    console.log('Sample indices reset to 0');
  }

  /**
   * Add a parameter to simulate
   */
  addParameter(config: ParameterConfig): void {
    const initialValue = this.generateBaseValue(config);
    this.parameters.set(config.index, {
      config,
      currentValue: initialValue,
      sampleValue: initialValue,
      engValue: initialValue, // Assume 1:1 scaling for simplicity
      sampleIndex: 0,
      lastUpdate: new Date(),
      lastSpcEmit: 0,
      lastEngEmit: 0,
    });
  }

  /**
   * Generate base value from scenario (without injected events)
   * Used for EngValue and as base for SPC value
   */
  private generateBaseValue(config: ParameterConfig): number {
    const elapsedTime = Date.now() - this.startTime;
    let value = this.scenario.generator(elapsedTime, config, this.scenarioParams);

    // Clamp to tolerance limits (scenario stays within limits)
    const { usl, lsl } = config.toleranceLimits;
    value = Math.max(lsl, Math.min(usl, value));

    return value;
  }

  /**
   * Apply injected events to a base value
   * Events can push values outside tolerance limits (for outlier testing)
   */
  private applyEventsToValue(
    baseValue: number,
    config: ParameterConfig,
    activeEvents: { type: string; params: Record<string, number> }[]
  ): number {
    let value = baseValue;
    for (const event of activeEvents) {
      value = this.applyEvent(value, config, event);
    }
    return value;
  }

  /**
   * Apply an injected event to modify a value
   */
  private applyEvent(value: number, config: ParameterConfig, event: { type: string; params: Record<string, number> }): number {
    const { ucl, lcl, cl } = config.controlLimits;
    const { usl, lsl } = config.toleranceLimits;
    const range = ucl - lcl;
    const toleranceRange = usl - lsl;
    const sigma = range / 6;

    switch (event.type) {
      case 'outlier_high':
        // Point above USL
        return usl + toleranceRange * (event.params.overshoot ?? 0.1);

      case 'outlier_low':
        // Point below LSL
        return lsl - toleranceRange * (event.params.overshoot ?? 0.1);

      case 'outlier_random':
        // Random outlier above or below limits
        const aboveLimit = Math.random() > 0.5;
        const overshoot = toleranceRange * (event.params.overshoot ?? 0.1);
        return aboveLimit ? usl + overshoot : lsl - overshoot;

      case 'shift_up':
        // Shift value upward
        return value + range * (event.params.amount ?? 0.5);

      case 'shift_down':
        // Shift value downward
        return value - range * (event.params.amount ?? 0.5);

      case 'near_ucl':
        // Value near upper control limit
        return ucl - sigma * 0.2 + (Math.random() - 0.5) * sigma * 0.2;

      case 'near_lcl':
        // Value near lower control limit
        return lcl + sigma * 0.2 + (Math.random() - 0.5) * sigma * 0.2;

      case 'at_target':
        // Value exactly at target with minimal noise
        return cl + (Math.random() - 0.5) * sigma * 0.1;

      case 'above_ucl':
        // Value above UCL but within USL
        return ucl + (usl - ucl) * 0.5 + (Math.random() - 0.5) * sigma * 0.2;

      case 'below_lcl':
        // Value below LCL but within LSL
        return lcl - (lcl - lsl) * 0.5 + (Math.random() - 0.5) * sigma * 0.2;

      case 'high_variance':
        // Add extra variance
        const extraNoise = (Math.random() - 0.5) * range * (event.params.factor ?? 1);
        return value + extraNoise;

      case 'trend_spike':
        // Sudden spike in value
        return cl + range * (event.params.amount ?? 0.7);

      default:
        return value;
    }
  }

  /**
   * Update all parameters and emit new values based on frequencies
   */
  private updateAll(): void {
    const timestamp = new Date();
    const now = timestamp.getTime();

    // Check if this tick will emit an SPC sample
    const isAcquiring = this.forceSpcEmission ||
                        (this.stateMachine?.getStatus() === AcquisitionStatus.AcquisitionStarted);

    // Check if ANY parameter will emit SPC this tick (they should be synchronized)
    let willEmitSpc = false;
    if (isAcquiring) {
      for (const [, state] of this.parameters) {
        if (now - state.lastSpcEmit >= this.spcFrequency) {
          willEmitSpc = true;
          break;
        }
      }
    }

    // Get active events ONLY when we're about to emit SPC samples
    // This ensures events are applied exactly when SPC samples are taken
    const activeEvents = willEmitSpc ? this.getActiveEventsForApply() : [];

    for (const [index, state] of this.parameters) {
      // Generate base value from scenario (without events for EngValue)
      const baseValue = this.generateBaseValue(state.config);

      // For EngValue: use base value (scenario only, no injected events)
      // For SampleValue: apply injected events on top of base value
      const engValue = baseValue;
      const spcValue = activeEvents.length > 0
        ? this.applyEventsToValue(baseValue, state.config, activeEvents)
        : baseValue;

      // Always update current/internal value
      state.currentValue = spcValue;
      state.lastUpdate = timestamp;

      // Emit EngValue update at engFrequency (default 100ms)
      // EngValue shows the "real-time" scenario value without injected events
      if (now - state.lastEngEmit >= this.engFrequency) {
        state.lastEngEmit = now;
        state.engValue = engValue;
        this.emit(`engValue:${index}`, {
          timestamp,
          parameterIndex: index,
          engValue: state.engValue,
        });
      }

      // Emit SPC sample (SampleValue/SampleIndex) at spcFrequency (default 5s)
      // SampleValue includes injected events for SPC testing
      if (isAcquiring && now - state.lastSpcEmit >= this.spcFrequency) {
        state.sampleIndex++;
        state.lastSpcEmit = now;
        state.sampleValue = spcValue;

        const dataPoint: HistoricalDataPoint = {
          timestamp,
          parameterIndex: index,
          value: state.sampleValue,
          engValue: state.engValue,
          sampleIndex: state.sampleIndex,
        };

        this.emit('data', dataPoint);
        this.emit(`parameter:${index}`, dataPoint);
      }
    }

    // Decrement event durations only when SPC samples are emitted
    if (willEmitSpc) {
      this.decrementEventDurations();
    }
  }

  /**
   * Start simulation
   */
  start(): void {
    if (this.intervalId) {
      return;
    }

    this.startTime = Date.now();
    this.intervalId = setInterval(() => this.updateAll(), this.sampleRate);
    console.log(`Simulation started with scenario: ${this.scenario.name}`);
  }

  /**
   * Stop simulation
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('Simulation stopped');
    }
  }

  /**
   * Change scenario at runtime
   */
  setScenario(scenarioName: string): void {
    const previousScenario = this.scenario.name;
    this.scenario = getScenario(scenarioName);
    this.scenarioParams = { ...this.scenario.defaultParams };
    this.startTime = Date.now(); // Reset time reference
    console.log(`[Simulator] Scenario changed from '${previousScenario}' to '${this.scenario.name}'`);
    this.emit('scenarioChanged', { previousScenario, newScenario: this.scenario.name });
  }

  /**
   * Get current state of a parameter
   */
  getParameterState(index: number): ParameterState | undefined {
    return this.parameters.get(index);
  }

  /**
   * Get all parameter states
   */
  getAllStates(): Map<number, ParameterState> {
    return new Map(this.parameters);
  }

  /**
   * Get current scenario
   */
  getCurrentScenario(): SimulationScenario {
    return this.scenario;
  }

  /**
   * Get current frequencies
   */
  getFrequencies(): { spcFrequency: number; engFrequency: number } {
    return {
      spcFrequency: this.spcFrequency,
      engFrequency: this.engFrequency,
    };
  }

  /**
   * Set SPC sample frequency at runtime
   */
  setSpcFrequency(frequencyMs: number): void {
    const minFreq = 100;
    const maxFreq = 60000;
    this.spcFrequency = Math.max(minFreq, Math.min(maxFreq, frequencyMs));
    console.log(`[Simulator] SPC frequency changed to ${this.spcFrequency}ms`);
    this.emit('frequencyChanged', { type: 'spc', frequency: this.spcFrequency });
  }

  /**
   * Set EngValue frequency at runtime
   */
  setEngFrequency(frequencyMs: number): void {
    const minFreq = 50;
    const maxFreq = 10000;
    this.engFrequency = Math.max(minFreq, Math.min(maxFreq, frequencyMs));
    console.log(`[Simulator] EngValue frequency changed to ${this.engFrequency}ms`);
    this.emit('frequencyChanged', { type: 'eng', frequency: this.engFrequency });
  }

  /**
   * Get force SPC emission flag
   */
  getForceSpcEmission(): boolean {
    return this.forceSpcEmission;
  }

  /**
   * Set force SPC emission flag
   * When true, SPC samples are emitted regardless of acquisition state
   */
  setForceSpcEmission(force: boolean): void {
    this.forceSpcEmission = force;
    console.log(`[Simulator] Force SPC emission ${force ? 'enabled' : 'disabled'}`);
    this.emit('forceSpcEmissionChanged', { forceSpcEmission: force });
  }

  /**
   * Get scenario parameter definitions for current scenario
   */
  getScenarioParamDefs(): ScenarioParamDef[] {
    return this.scenario.paramDefs ?? [];
  }

  /**
   * Get current scenario parameters
   */
  getScenarioParams(): ScenarioParams {
    return { ...this.scenarioParams };
  }

  /**
   * Set a scenario parameter value
   */
  setScenarioParam(key: string, value: number): void {
    const paramDef = this.scenario.paramDefs?.find(p => p.key === key);
    if (paramDef) {
      // Clamp to min/max
      const clampedValue = Math.max(paramDef.min, Math.min(paramDef.max, value));
      this.scenarioParams[key] = clampedValue;
      console.log(`[Simulator] Scenario param '${key}' set to ${clampedValue}`);
      this.emit('scenarioParamChanged', { key, value: clampedValue });
    } else {
      console.warn(`[Simulator] Unknown scenario param: ${key}`);
    }
  }

  /**
   * Set multiple scenario parameters at once
   */
  setScenarioParams(params: ScenarioParams): void {
    for (const [key, value] of Object.entries(params)) {
      this.setScenarioParam(key, value);
    }
  }

  /**
   * Reset scenario time reference (useful for scenarios with time-based effects)
   */
  resetScenarioTime(): void {
    this.startTime = Date.now();
    console.log('[Simulator] Scenario time reset');
    this.emit('scenarioTimeReset');
  }

  // ============== SPC Event Injection ==============
  // These methods allow triggering immediate SPC events for testing

  private injectedEvents: {
    type: string;
    duration: number;
    startTime: number;
    params: Record<string, number>;
  }[] = [];

  /**
   * Inject an immediate SPC event that will affect the next N samples
   */
  injectEvent(eventType: string, duration: number = 1, params: Record<string, number> = {}): void {
    this.injectedEvents.push({
      type: eventType,
      duration,
      startTime: Date.now(),
      params,
    });
    console.log(`[Simulator] Injected event: ${eventType} for ${duration} samples`);
    this.emit('eventInjected', { type: eventType, duration, params });
  }

  /**
   * Get active events for applying to values (without decrementing)
   */
  private getActiveEventsForApply(): { type: string; params: Record<string, number> }[] {
    return this.injectedEvents
      .filter(e => e.duration > 0)
      .map(e => ({ type: e.type, params: e.params }));
  }

  /**
   * Decrement duration of all active events (called once per SPC sample)
   */
  private decrementEventDurations(): void {
    this.injectedEvents = this.injectedEvents
      .map(e => ({ ...e, duration: e.duration - 1 }))
      .filter(e => e.duration >= 0);
  }

  /**
   * Get active events without consuming them (for status display)
   */
  getActiveEvents(): { type: string; remaining: number; params: Record<string, number> }[] {
    return this.injectedEvents
      .filter(e => e.duration > 0)
      .map(e => ({ type: e.type, remaining: e.duration, params: e.params }));
  }

  /**
   * Clear all injected events
   */
  clearInjectedEvents(): void {
    this.injectedEvents = [];
    console.log('[Simulator] Cleared all injected events');
  }

  /**
   * Restore parameter states from persistence
   */
  restoreParameterStates(states: {
    parameterIndex: number;
    sampleIndex: number;
    sampleValue: number;
    engValue: number;
  }[]): void {
    for (const persistedState of states) {
      const state = this.parameters.get(persistedState.parameterIndex);
      if (state) {
        state.sampleIndex = persistedState.sampleIndex;
        state.sampleValue = persistedState.sampleValue;
        state.engValue = persistedState.engValue;
        state.currentValue = persistedState.sampleValue;
      }
    }
  }

  /**
   * Get all parameter states for persistence
   */
  getParameterStatesForPersistence(): {
    parameterIndex: number;
    sampleIndex: number;
    sampleValue: number;
    engValue: number;
  }[] {
    const states: {
      parameterIndex: number;
      sampleIndex: number;
      sampleValue: number;
      engValue: number;
    }[] = [];

    for (const [index, state] of this.parameters) {
      states.push({
        parameterIndex: index,
        sampleIndex: state.sampleIndex,
        sampleValue: state.sampleValue,
        engValue: state.engValue,
      });
    }

    return states;
  }
}

/**
 * Welding process parameter definitions with realistic units, targets, and limits
 * Each parameter has specific tolerance and control limits based on welding standards
 */
export interface WeldingParameterDef {
  name: string;
  description: string;
  unit: string;
  target: number;
  /** Tolerance limits (manufacturing specs) */
  usl: number;
  lsl: number;
  /** Control limits (SPC - tighter than tolerance) */
  ucl: number;
  lcl: number;
}

export const WELDING_PARAMETERS: WeldingParameterDef[] = [
  // Current and voltage parameters
  {
    name: 'WeldCurrent', description: 'Courant de soudage', unit: 'A',
    target: 180, usl: 195, lsl: 165,  // ±8% tolerance
    ucl: 190, lcl: 170                 // ±5.5% control (tighter)
  },
  {
    name: 'ArcVoltage', description: 'Tension d\'arc', unit: 'V',
    target: 24, usl: 26, lsl: 22,     // ±8% tolerance
    ucl: 25.2, lcl: 22.8               // ±5% control
  },
  {
    name: 'WireSpeed', description: 'Vitesse du fil', unit: 'm/min',
    target: 8.5, usl: 9.35, lsl: 7.65, // ±10% tolerance
    ucl: 9.0, lcl: 8.0                  // ±6% control
  },
  {
    name: 'TravelSpeed', description: 'Vitesse d\'avance', unit: 'mm/s',
    target: 12, usl: 14, lsl: 10,      // ±17% tolerance
    ucl: 13, lcl: 11                    // ±8% control
  },

  // Gas and flow parameters
  {
    name: 'GasFlow', description: 'Débit de gaz', unit: 'L/min',
    target: 18, usl: 22, lsl: 14,      // wide tolerance
    ucl: 20, lcl: 16                    // tighter control
  },
  {
    name: 'GasPressure', description: 'Pression de gaz', unit: 'bar',
    target: 2.5, usl: 3.0, lsl: 2.0,   // ±20% tolerance
    ucl: 2.8, lcl: 2.2                  // ±12% control
  },

  // Temperature parameters
  {
    name: 'PreheatTemp', description: 'Température de préchauffage', unit: '°C',
    target: 150, usl: 180, lsl: 120,   // wide range per AWS
    ucl: 170, lcl: 130                  // tighter control
  },
  {
    name: 'InterpassTemp', description: 'Température inter-passes', unit: '°C',
    target: 200, usl: 250, lsl: 150,   // per welding procedure
    ucl: 230, lcl: 170                  // process control
  },
  {
    name: 'PostheatTemp', description: 'Température de post-chauffage', unit: '°C',
    target: 250, usl: 280, lsl: 220,   // PWHT requirements
    ucl: 270, lcl: 230                  // tight control for metallurgy
  },

  // Geometric parameters
  {
    name: 'BeadWidth', description: 'Largeur du cordon', unit: 'mm',
    target: 8.0, usl: 10.0, lsl: 6.0,  // ±25% tolerance
    ucl: 9.0, lcl: 7.0                  // ±12.5% control
  },
  {
    name: 'BeadHeight', description: 'Hauteur du cordon', unit: 'mm',
    target: 2.5, usl: 3.5, lsl: 1.5,   // ±40% tolerance
    ucl: 3.0, lcl: 2.0                  // ±20% control
  },
  {
    name: 'Penetration', description: 'Pénétration', unit: 'mm',
    target: 4.0, usl: 5.0, lsl: 3.0,   // ±25% tolerance
    ucl: 4.5, lcl: 3.5                  // ±12.5% control
  },

  // Position and angle parameters
  {
    name: 'TorchAngle', description: 'Angle de la torche', unit: '°',
    target: 15, usl: 25, lsl: 5,       // wide tolerance for angle
    ucl: 20, lcl: 10                    // preferred operating range
  },
  {
    name: 'WorkAngle', description: 'Angle de travail', unit: '°',
    target: 45, usl: 55, lsl: 35,      // ±10° tolerance
    ucl: 50, lcl: 40                    // ±5° control
  },
  {
    name: 'CTWD', description: 'Distance tube contact-pièce', unit: 'mm',
    target: 18, usl: 22, lsl: 14,      // critical for arc stability
    ucl: 20, lcl: 16                    // tight control
  },
  {
    name: 'StickOut', description: 'Stick-out fil', unit: 'mm',
    target: 12, usl: 15, lsl: 9,       // affects heat input
    ucl: 14, lcl: 10                    // process control
  },

  // Energy and power parameters
  {
    name: 'HeatInput', description: 'Apport de chaleur', unit: 'kJ/mm',
    target: 1.2, usl: 1.5, lsl: 0.9,   // per WPS limits
    ucl: 1.4, lcl: 1.0                  // metallurgical control
  },
  {
    name: 'ArcPower', description: 'Puissance d\'arc', unit: 'kW',
    target: 4.3, usl: 5.0, lsl: 3.6,   // calculated from V×I
    ucl: 4.7, lcl: 3.9                  // stable arc range
  },
  {
    name: 'ArcEnergy', description: 'Énergie d\'arc', unit: 'J/mm',
    target: 360, usl: 430, lsl: 290,   // wide tolerance
    ucl: 400, lcl: 320                  // process control
  },

  // Time parameters
  {
    name: 'ArcOnTime', description: 'Temps d\'arc', unit: 's',
    target: 45, usl: 60, lsl: 30,      // cycle time dependent
    ucl: 55, lcl: 35                    // productivity target
  },
  {
    name: 'WeldDuration', description: 'Durée de soudage', unit: 's',
    target: 120, usl: 150, lsl: 90,    // part dependent
    ucl: 140, lcl: 100                  // cycle control
  },
  {
    name: 'PulseFreq', description: 'Fréquence de pulsation', unit: 'Hz',
    target: 120, usl: 150, lsl: 90,    // pulse MIG parameters
    ucl: 140, lcl: 100                  // stable pulse range
  },

  // Quality parameters
  {
    name: 'ArcStability', description: 'Stabilité d\'arc', unit: '%',
    target: 95, usl: 100, lsl: 85,     // higher is better
    ucl: 98, lcl: 92                    // good quality range
  },
  {
    name: 'SpatterIndex', description: 'Index de projections', unit: '%',
    target: 2.0, usl: 5.0, lsl: 0.0,   // lower is better
    ucl: 3.5, lcl: 0.5                  // acceptable quality
  },
];

/**
 * Create default parameter configurations using built-in welding parameter definitions
 * Always creates 24 parameters, with enabled=true for active ones
 */
export function createDefaultParameters(
  activeCount: number,
  sampleRate: number,
  configOverrides?: import('../types').ParametersConfigFile
): ParameterConfig[] {
  const parameters: ParameterConfig[] = [];
  const overrideMap = new Map<number, import('../types').ParameterConfigOverride>();

  // Build override map for quick lookup
  if (configOverrides?.parameters) {
    for (const override of configOverrides.parameters) {
      overrideMap.set(override.index, override);
    }
  }

  // Get global defaults from config file
  const globalDefaults = configOverrides?.defaults ?? {};
  const defaultControlPercent = globalDefaults.controlLimitPercent ?? 75;

  // Always create 24 parameters
  for (let i = 1; i <= 24; i++) {
    const paramDef = WELDING_PARAMETERS[i - 1];
    const override = overrideMap.get(i);
    const name = `P${i.toString().padStart(2, '0')}`;

    // Determine if enabled: override > activeCount default
    const enabled = override?.enabled ?? (i <= activeCount);

    // Use override values, then paramDef values, then generic defaults
    const displayName = override?.displayName ?? paramDef?.name ?? name;
    const description = override?.description ?? paramDef?.description ?? `Parameter ${i}`;
    const unit = override?.unit ?? paramDef?.unit ?? 'unit';
    const target = override?.target ?? paramDef?.target ?? 100;

    // Tolerance limits: use override absolute values, or paramDef values
    let usl: number, lsl: number;
    if (override?.usl !== undefined && override?.lsl !== undefined) {
      usl = override.usl;
      lsl = override.lsl;
    } else if (paramDef) {
      usl = paramDef.usl;
      lsl = paramDef.lsl;
    } else {
      // Fallback: use global percentage defaults
      const uslPercent = globalDefaults.uslOffsetPercent ?? 5;
      const lslPercent = globalDefaults.lslOffsetPercent ?? 5;
      usl = target * (1 + uslPercent / 100);
      lsl = target * (1 - lslPercent / 100);
    }

    // Control limits: use override absolute values, or paramDef values, or calculate
    let ucl: number, lcl: number, cl: number;
    if (override?.ucl !== undefined && override?.lcl !== undefined) {
      ucl = override.ucl;
      lcl = override.lcl;
      cl = override.cl ?? target;
    } else if (paramDef) {
      ucl = paramDef.ucl;
      lcl = paramDef.lcl;
      cl = target;
    } else {
      // Calculate control limits as percentage of tolerance range
      const toleranceRange = usl - lsl;
      const controlRange = toleranceRange * (defaultControlPercent / 100);
      cl = target;
      ucl = cl + controlRange / 2;
      lcl = cl - controlRange / 2;
    }

    parameters.push({
      index: i,
      name,
      displayName,
      description,
      toleranceLimits: { usl, lsl, target },
      controlLimits: { ucl, lcl, cl },
      unit,
      sampleRate,
      enabled,
    });
  }

  return parameters;
}
