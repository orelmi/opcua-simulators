/**
 * Simulation Scenarios for Control Chart Testing
 *
 * These scenarios are designed to test various SPC (Statistical Process Control)
 * rules and patterns commonly used in manufacturing quality control.
 */

import { SimulationScenario, ParameterConfig, ScenarioParams } from '../types';

/**
 * Random generator with Box-Muller transform for normal distribution
 */
function normalRandom(mean: number, stddev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z0 * stddev + mean;
}

/**
 * Scenario 1: NORMAL - Process under control
 * Values distributed normally around the center line within control limits
 * Expected: No control chart violations
 */
export const normalScenario: SimulationScenario = {
  name: 'normal',
  description: 'Processus sous contrôle - distribution normale autour de la ligne centrale',
  duration: 0, // Continuous
  paramDefs: [
    { key: 'noise', label: 'Bruit', type: 'range', min: 0.5, max: 2, step: 0.1, default: 1, unit: 'x' }
  ],
  defaultParams: { noise: 1 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl } = config.controlLimits;
    const noise = params?.noise ?? 1;
    // Standard deviation is ~1/6 of the control range for 99.7% within limits
    const range = config.controlLimits.ucl - config.controlLimits.lcl;
    const stddev = (range / 6) * noise;
    return normalRandom(cl, stddev);
  },
};

/**
 * Scenario 2: TREND - Gradual drift upward or downward
 * Simulates tool wear, temperature drift, etc.
 * Expected: Should trigger Western Electric Rule 2 (9 points in a row on same side)
 */
export const trendUpScenario: SimulationScenario = {
  name: 'trend_up',
  description: 'Dérive progressive vers le haut - simule usure outil ou dérive thermique',
  duration: 0,
  paramDefs: [
    { key: 'driftRate', label: 'Vitesse de dérive', type: 'range', min: 0.1, max: 3, step: 0.1, default: 0.5, unit: '%/min' },
    { key: 'maxDrift', label: 'Dérive max', type: 'range', min: 20, max: 100, step: 5, default: 80, unit: '%' }
  ],
  defaultParams: { driftRate: 0.5, maxDrift: 80 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, ucl } = config.controlLimits;
    const range = ucl - cl;
    const stddev = range / 10;

    const driftRatePercent = params?.driftRate ?? 0.5;
    const maxDriftPercent = params?.maxDrift ?? 80;

    // Gradual drift: driftRate% of range per minute
    const driftRate = range * (driftRatePercent / 100); // per minute
    const minutesElapsed = time / 60000;
    const drift = Math.min(driftRate * minutesElapsed, range * (maxDriftPercent / 100));

    return normalRandom(cl + drift, stddev);
  },
};

export const trendDownScenario: SimulationScenario = {
  name: 'trend_down',
  description: 'Dérive progressive vers le bas',
  duration: 0,
  paramDefs: [
    { key: 'driftRate', label: 'Vitesse de dérive', type: 'range', min: 0.1, max: 3, step: 0.1, default: 0.5, unit: '%/min' },
    { key: 'maxDrift', label: 'Dérive max', type: 'range', min: 20, max: 100, step: 5, default: 80, unit: '%' }
  ],
  defaultParams: { driftRate: 0.5, maxDrift: 80 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, lcl } = config.controlLimits;
    const range = cl - lcl;
    const stddev = range / 10;

    const driftRatePercent = params?.driftRate ?? 0.5;
    const maxDriftPercent = params?.maxDrift ?? 80;

    const driftRate = range * (driftRatePercent / 100);
    const minutesElapsed = time / 60000;
    const drift = Math.min(driftRate * minutesElapsed, range * (maxDriftPercent / 100));

    return normalRandom(cl - drift, stddev);
  },
};

/**
 * Scenario 3: SHIFT - Sudden process mean shift
 * Simulates sudden change (new batch, operator change, etc.)
 * Expected: Should trigger Rule 1 (point outside control limits) or Rule 2
 */
export const shiftScenario: SimulationScenario = {
  name: 'shift',
  description: 'Décalage soudain de la moyenne - simule changement de lot ou opérateur',
  duration: 0,
  paramDefs: [
    { key: 'shiftDelay', label: 'Délai avant shift', type: 'range', min: 0.5, max: 10, step: 0.5, default: 5, unit: 'min' },
    { key: 'shiftAmount', label: 'Amplitude du shift', type: 'range', min: 20, max: 100, step: 5, default: 60, unit: '%' }
  ],
  defaultParams: { shiftDelay: 5, shiftAmount: 60 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, ucl } = config.controlLimits;
    const range = ucl - cl;
    const stddev = range / 8;

    const shiftDelayMin = params?.shiftDelay ?? 5;
    const shiftAmountPercent = params?.shiftAmount ?? 60;

    // Shift occurs after shiftDelay minutes
    const shiftTime = shiftDelayMin * 60 * 1000;
    const shifted = time > shiftTime;
    const shiftAmount = shifted ? range * (shiftAmountPercent / 100) : 0;

    return normalRandom(cl + shiftAmount, stddev);
  },
};

/**
 * Scenario 4: CYCLIC - Periodic oscillation
 * Simulates environmental cycles, batch-to-batch variation
 * Expected: Recognizable pattern in control chart
 */
export const cyclicScenario: SimulationScenario = {
  name: 'cyclic',
  description: 'Oscillation périodique - simule cycles environnementaux ou batch',
  duration: 0,
  paramDefs: [
    { key: 'cyclePeriod', label: 'Période du cycle', type: 'range', min: 1, max: 30, step: 1, default: 10, unit: 'min' },
    { key: 'amplitude', label: 'Amplitude', type: 'range', min: 10, max: 60, step: 5, default: 30, unit: '%' }
  ],
  defaultParams: { cyclePeriod: 10, amplitude: 30 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const stddev = range / 15;

    const cyclePeriodMin = params?.cyclePeriod ?? 10;
    const amplitudePercent = params?.amplitude ?? 30;

    // Cycle period in milliseconds
    const cyclePeriod = cyclePeriodMin * 60 * 1000;
    const cycleAmplitude = range * (amplitudePercent / 100);
    const cycleValue = Math.sin((2 * Math.PI * time) / cyclePeriod) * cycleAmplitude;

    return normalRandom(cl + cycleValue, stddev);
  },
};

/**
 * Scenario 5: STRATIFICATION - Values hugging center line
 * Indicates mixture of data from different sources
 * Expected: Low variation, values clustered near CL
 */
export const stratificationScenario: SimulationScenario = {
  name: 'stratification',
  description: 'Stratification - valeurs groupées près de la ligne centrale',
  duration: 0,
  paramDefs: [
    { key: 'tightness', label: 'Regroupement', type: 'range', min: 10, max: 40, step: 2, default: 20, unit: 'x' }
  ],
  defaultParams: { tightness: 20 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const tightness = params?.tightness ?? 20;
    // Very small standard deviation - values clustered near center
    const stddev = range / tightness;

    return normalRandom(cl, stddev);
  },
};

/**
 * Scenario 6: MIXTURE - Bimodal distribution
 * Values avoid the center, cluster near control limits
 * Indicates two different process states
 */
export const mixtureScenario: SimulationScenario = {
  name: 'mixture',
  description: 'Distribution bimodale - valeurs évitant le centre',
  duration: 0,
  paramDefs: [
    { key: 'separation', label: 'Séparation', type: 'range', min: 10, max: 45, step: 5, default: 25, unit: '%' },
    { key: 'upperBias', label: 'Biais haut', type: 'range', min: 0, max: 100, step: 10, default: 50, unit: '%' }
  ],
  defaultParams: { separation: 25, upperBias: 50 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const stddev = range / 15;

    const separation = params?.separation ?? 25;
    const upperBias = params?.upperBias ?? 50;

    // Choose upper or lower cluster based on upperBias probability
    const upperCluster = Math.random() * 100 < upperBias;
    const clusterCenter = upperCluster
      ? cl + range * (separation / 100)
      : cl - range * (separation / 100);

    return normalRandom(clusterCenter, stddev);
  },
};

/**
 * Scenario 7: OUT_OF_CONTROL - Occasional points outside limits
 * Tests rule 1: single point outside 3-sigma limits
 */
export const outOfControlScenario: SimulationScenario = {
  name: 'out_of_control',
  description: 'Points occasionnels hors limites - test règle 1',
  duration: 0,
  paramDefs: [
    { key: 'outlierProb', label: 'Probabilité outlier', type: 'range', min: 1, max: 20, step: 1, default: 5, unit: '%' },
    { key: 'overshoot', label: 'Dépassement', type: 'range', min: 10, max: 50, step: 5, default: 20, unit: '%' }
  ],
  defaultParams: { outlierProb: 5, overshoot: 20 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const stddev = range / 6;

    const outlierProb = params?.outlierProb ?? 5;
    const overshootPercent = params?.overshoot ?? 20;

    // outlierProb% chance of out-of-control point
    if (Math.random() * 100 < outlierProb) {
      const overshoot = range * (overshootPercent / 100);
      return Math.random() > 0.5 ? ucl + overshoot : lcl - overshoot;
    }

    return normalRandom(cl, stddev);
  },
};

/**
 * Scenario 8: INCREASING_VARIANCE - Process becoming unstable
 * Standard deviation increases over time
 */
export const increasingVarianceScenario: SimulationScenario = {
  name: 'increasing_variance',
  description: 'Variance croissante - processus devenant instable',
  duration: 0,
  paramDefs: [
    { key: 'growthRate', label: 'Vitesse croissance', type: 'range', min: 0.5, max: 5, step: 0.5, default: 1, unit: 'x/10min' }
  ],
  defaultParams: { growthRate: 1 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const baseStddev = range / 10;

    const growthRate = params?.growthRate ?? 1;

    // Variance increases based on growthRate
    const minutesElapsed = time / 60000;
    const varianceMultiplier = 1 + (minutesElapsed / 10) * growthRate;
    const currentStddev = baseStddev * varianceMultiplier;

    return normalRandom(cl, currentStddev);
  },
};

/**
 * Scenario 9: NELSON_RULE_TEST - Tests multiple Nelson rules
 * Deliberately creates patterns violating Nelson rules
 */
export const nelsonRuleTestScenario: SimulationScenario = {
  name: 'nelson_rules',
  description: 'Test des règles de Nelson - violations multiples',
  duration: 0,
  paramDefs: [
    { key: 'cycleTime', label: 'Durée phase', type: 'range', min: 1, max: 5, step: 0.5, default: 2, unit: 'min' },
    { key: 'intensity', label: 'Intensité', type: 'range', min: 0.5, max: 1.5, step: 0.1, default: 1, unit: 'x' }
  ],
  defaultParams: { cycleTime: 2, intensity: 1 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const sigma = range / 6;

    const cycleTimeMin = params?.cycleTime ?? 2;
    const intensity = params?.intensity ?? 1;

    // Cycle through different rule violations
    const cycleTime = cycleTimeMin * 60 * 1000;
    const phase = Math.floor((time % (cycleTime * 4)) / cycleTime);

    switch (phase) {
      case 0:
        // Rule 3: 6 points in a row steadily increasing
        const increment = (time % cycleTime) / cycleTime;
        return cl - sigma * intensity + (2 * sigma * intensity * increment);
      case 1:
        // Rule 4: 14 points alternating up and down
        const isUp = Math.floor(time / 5000) % 2 === 0;
        return isUp ? cl + sigma * 0.8 * intensity : cl - sigma * 0.8 * intensity;
      case 2:
        // Rule 5: 2 of 3 points beyond 2-sigma (same side)
        if (Math.random() < 0.7) {
          return cl + sigma * 2.2 * intensity;
        }
        return normalRandom(cl, sigma * 0.3);
      case 3:
      default:
        // Normal operation
        return normalRandom(cl, sigma);
    }
  },
};

/**
 * Scenario 10: REALISTIC - Combines multiple real-world effects
 * Includes baseline variation, occasional drift, and rare outliers
 */
export const realisticScenario: SimulationScenario = {
  name: 'realistic',
  description: 'Scénario réaliste - combine plusieurs effets',
  duration: 0,
  paramDefs: [
    { key: 'cycleEffect', label: 'Effet cyclique', type: 'range', min: 0, max: 100, step: 10, default: 30, unit: '%' },
    { key: 'batchEffect', label: 'Effet batch', type: 'range', min: 0, max: 100, step: 10, default: 50, unit: '%' },
    { key: 'outlierProb', label: 'Prob. outlier', type: 'range', min: 0, max: 5, step: 0.5, default: 1, unit: '%' }
  ],
  defaultParams: { cycleEffect: 30, batchEffect: 50, outlierProb: 1 },
  generator: (time: number, config: ParameterConfig, params?: ScenarioParams): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const sigma = range / 6;

    const cycleEffect = params?.cycleEffect ?? 30;
    const batchEffect = params?.batchEffect ?? 50;
    const outlierProb = params?.outlierProb ?? 1;

    // Base variation
    let value = normalRandom(cl, sigma);

    // Small cyclic component (temperature, etc.)
    const hourCycle = Math.sin((2 * Math.PI * time) / (60 * 60 * 1000)) * sigma * (cycleEffect / 100);
    value += hourCycle;

    // Occasional small shifts (batch changes every ~30 min)
    const batchNumber = Math.floor(time / (30 * 60 * 1000));
    const batchOffset = ((batchNumber * 7) % 10 - 5) / 10 * sigma * (batchEffect / 100);
    value += batchOffset;

    // Rare outliers
    if (Math.random() * 100 < outlierProb) {
      value += (Math.random() > 0.5 ? 1 : -1) * sigma * 2.5;
    }

    return value;
  },
};

/**
 * All available scenarios
 */
export const scenarios: Map<string, SimulationScenario> = new Map([
  ['normal', normalScenario],
  ['trend_up', trendUpScenario],
  ['trend_down', trendDownScenario],
  ['shift', shiftScenario],
  ['cyclic', cyclicScenario],
  ['stratification', stratificationScenario],
  ['mixture', mixtureScenario],
  ['out_of_control', outOfControlScenario],
  ['increasing_variance', increasingVarianceScenario],
  ['nelson_rules', nelsonRuleTestScenario],
  ['realistic', realisticScenario],
]);

/**
 * Get scenario by name
 */
export function getScenario(name: string): SimulationScenario {
  const scenario = scenarios.get(name);
  if (!scenario) {
    console.warn(`Scenario '${name}' not found, using 'normal'`);
    return normalScenario;
  }
  return scenario;
}

/**
 * List all available scenarios
 */
export function listScenarios(): { name: string; description: string }[] {
  return Array.from(scenarios.entries()).map(([name, scenario]) => ({
    name,
    description: scenario.description,
  }));
}
