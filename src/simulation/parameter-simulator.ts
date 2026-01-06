/**
 * Parameter Simulator
 * Generates simulated values for CC parameters based on scenarios
 */

import { EventEmitter } from 'events';
import { ParameterConfig, SimulationScenario, HistoricalDataPoint } from '../types';
import { getScenario } from './scenarios';

export interface ParameterState {
  config: ParameterConfig;
  currentValue: number;
  engValue: number;
  sampleIndex: number;
  lastUpdate: Date;
  lastSpcEmit: number; // timestamp of last SPC emit
  lastEngEmit: number; // timestamp of last EngValue emit
}

export class ParameterSimulator extends EventEmitter {
  private parameters: Map<number, ParameterState> = new Map();
  private scenario: SimulationScenario;
  private startTime: number;
  private intervalId: NodeJS.Timeout | null = null;
  private sampleRate: number;
  private spcFrequency: number;
  private engFrequency: number;

  /**
   * @param scenarioName - Name of the simulation scenario
   * @param sampleRate - Internal simulation tick rate in ms (default: 100ms)
   * @param spcFrequency - SPC sample frequency in ms for SampleValue/SampleIndex updates (default: 5000ms = 5s)
   * @param engFrequency - EngValue update frequency in ms (default: 100ms)
   */
  constructor(scenarioName: string, sampleRate: number = 100, spcFrequency: number = 5000, engFrequency: number = 100) {
    super();
    this.scenario = getScenario(scenarioName);
    this.startTime = Date.now();
    this.sampleRate = sampleRate;
    this.spcFrequency = spcFrequency;
    this.engFrequency = engFrequency;
  }

  /**
   * Add a parameter to simulate
   */
  addParameter(config: ParameterConfig): void {
    const initialValue = this.generateValue(config);
    this.parameters.set(config.index, {
      config,
      currentValue: initialValue,
      engValue: initialValue, // Assume 1:1 scaling for simplicity
      sampleIndex: 0,
      lastUpdate: new Date(),
      lastSpcEmit: 0,
      lastEngEmit: 0,
    });
  }

  /**
   * Generate a value for a parameter based on current scenario
   */
  private generateValue(config: ParameterConfig): number {
    const elapsedTime = Date.now() - this.startTime;
    let value = this.scenario.generator(elapsedTime, config);

    // Clamp to tolerance limits (hard limits from manufacturing)
    const { usl, lsl } = config.toleranceLimits;
    value = Math.max(lsl, Math.min(usl, value));

    return value;
  }

  /**
   * Update all parameters and emit new values based on frequencies
   */
  private updateAll(): void {
    const timestamp = new Date();
    const now = timestamp.getTime();

    for (const [index, state] of this.parameters) {
      const newValue = this.generateValue(state.config);

      // Always update current value (internal state)
      state.currentValue = newValue;
      state.engValue = newValue; // Can add scaling transformation here
      state.lastUpdate = timestamp;

      // Emit EngValue update at engFrequency (default 100ms)
      if (now - state.lastEngEmit >= this.engFrequency) {
        state.lastEngEmit = now;
        this.emit(`engValue:${index}`, {
          timestamp,
          parameterIndex: index,
          engValue: state.engValue,
        });
      }

      // Emit SPC sample (SampleValue/SampleIndex) at spcFrequency (default 5s)
      if (now - state.lastSpcEmit >= this.spcFrequency) {
        state.sampleIndex++;
        state.lastSpcEmit = now;

        const dataPoint: HistoricalDataPoint = {
          timestamp,
          parameterIndex: index,
          value: newValue,
          engValue: state.engValue,
          sampleIndex: state.sampleIndex,
        };

        this.emit('data', dataPoint);
        this.emit(`parameter:${index}`, dataPoint);
      }
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
    this.scenario = getScenario(scenarioName);
    this.startTime = Date.now(); // Reset time reference
    console.log(`Scenario changed to: ${this.scenario.name}`);
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
}

/**
 * Welding process parameter definitions with realistic units and targets
 */
export const WELDING_PARAMETERS: Array<{
  name: string;
  description: string;
  unit: string;
  target: number;
  uslPercent: number;
  lslPercent: number;
}> = [
  // Current and voltage parameters
  { name: 'WeldCurrent', description: 'Courant de soudage', unit: 'A', target: 180, uslPercent: 5, lslPercent: 5 },
  { name: 'ArcVoltage', description: 'Tension d\'arc', unit: 'V', target: 24, uslPercent: 8, lslPercent: 8 },
  { name: 'WireSpeed', description: 'Vitesse du fil', unit: 'm/min', target: 8.5, uslPercent: 5, lslPercent: 5 },
  { name: 'TravelSpeed', description: 'Vitesse d\'avance', unit: 'mm/s', target: 12, uslPercent: 10, lslPercent: 10 },

  // Gas and flow parameters
  { name: 'GasFlow', description: 'Débit de gaz', unit: 'L/min', target: 18, uslPercent: 10, lslPercent: 10 },
  { name: 'GasPressure', description: 'Pression de gaz', unit: 'bar', target: 2.5, uslPercent: 15, lslPercent: 15 },

  // Temperature parameters
  { name: 'PreheatTemp', description: 'Température de préchauffage', unit: '°C', target: 150, uslPercent: 10, lslPercent: 10 },
  { name: 'InterpassTemp', description: 'Température inter-passes', unit: '°C', target: 200, uslPercent: 12, lslPercent: 12 },
  { name: 'PostheatTemp', description: 'Température de post-chauffage', unit: '°C', target: 250, uslPercent: 8, lslPercent: 8 },

  // Geometric parameters
  { name: 'BeadWidth', description: 'Largeur du cordon', unit: 'mm', target: 8.0, uslPercent: 15, lslPercent: 15 },
  { name: 'BeadHeight', description: 'Hauteur du cordon', unit: 'mm', target: 2.5, uslPercent: 20, lslPercent: 20 },
  { name: 'Penetration', description: 'Pénétration', unit: 'mm', target: 4.0, uslPercent: 12, lslPercent: 12 },

  // Position and angle parameters
  { name: 'TorchAngle', description: 'Angle de la torche', unit: '°', target: 15, uslPercent: 30, lslPercent: 30 },
  { name: 'WorkAngle', description: 'Angle de travail', unit: '°', target: 45, uslPercent: 10, lslPercent: 10 },
  { name: 'CTWD', description: 'Distance tube contact-pièce', unit: 'mm', target: 18, uslPercent: 15, lslPercent: 15 },
  { name: 'StickOut', description: 'Stick-out fil', unit: 'mm', target: 12, uslPercent: 15, lslPercent: 15 },

  // Energy and power parameters
  { name: 'HeatInput', description: 'Apport de chaleur', unit: 'kJ/mm', target: 1.2, uslPercent: 10, lslPercent: 10 },
  { name: 'ArcPower', description: 'Puissance d\'arc', unit: 'kW', target: 4.3, uslPercent: 8, lslPercent: 8 },
  { name: 'ArcEnergy', description: 'Énergie d\'arc', unit: 'J/mm', target: 360, uslPercent: 10, lslPercent: 10 },

  // Time parameters
  { name: 'ArcOnTime', description: 'Temps d\'arc', unit: 's', target: 45, uslPercent: 20, lslPercent: 20 },
  { name: 'WeldDuration', description: 'Durée de soudage', unit: 's', target: 120, uslPercent: 15, lslPercent: 15 },
  { name: 'PulseFreq', description: 'Fréquence de pulsation', unit: 'Hz', target: 120, uslPercent: 10, lslPercent: 10 },

  // Quality parameters
  { name: 'ArcStability', description: 'Stabilité d\'arc', unit: '%', target: 95, uslPercent: 3, lslPercent: 5 },
  { name: 'SpatterIndex', description: 'Index de projections', unit: '%', target: 2.0, uslPercent: 50, lslPercent: 50 },
];

/**
 * Create default parameter configurations
 * Always creates 24 parameters, with enabled=true for active ones
 */
export function createDefaultParameters(
  activeCount: number,
  defaultTarget: number,
  defaultUslOffset: number,
  defaultLslOffset: number,
  sampleRate: number
): ParameterConfig[] {
  const parameters: ParameterConfig[] = [];

  // Always create 24 parameters
  for (let i = 1; i <= 24; i++) {
    const paramDef = WELDING_PARAMETERS[i - 1];
    const name = `P${i.toString().padStart(2, '0')}`;
    const enabled = i <= activeCount;

    // Use welding parameter definition if available, otherwise use defaults
    const target = paramDef?.target ?? defaultTarget;
    const uslOffset = paramDef?.uslPercent ?? defaultUslOffset;
    const lslOffset = paramDef?.lslPercent ?? defaultLslOffset;
    const unit = paramDef?.unit ?? 'unit';
    const displayName = paramDef?.name ?? name;
    const description = paramDef?.description ?? `Parameter ${i}`;

    // Tolerance limits from manufacturing specs
    const usl = target * (1 + uslOffset / 100);
    const lsl = target * (1 - lslOffset / 100);

    // Control limits are tighter than tolerance limits
    // Typically at 75% of tolerance range
    const toleranceRange = usl - lsl;
    const controlRange = toleranceRange * 0.75;
    const cl = target;
    const ucl = cl + controlRange / 2;
    const lcl = cl - controlRange / 2;

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
