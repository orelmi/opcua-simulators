/**
 * Simulation Scenarios for Control Chart Testing
 *
 * These scenarios are designed to test various SPC (Statistical Process Control)
 * rules and patterns commonly used in manufacturing quality control.
 */

import { SimulationScenario, ParameterConfig } from '../types';

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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl } = config.controlLimits;
    // Standard deviation is ~1/6 of the control range for 99.7% within limits
    const range = config.controlLimits.ucl - config.controlLimits.lcl;
    const stddev = range / 6;
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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, ucl } = config.controlLimits;
    const range = ucl - cl;
    const stddev = range / 10;

    // Gradual drift: 0.5% of range per minute
    const driftRate = range * 0.005; // per minute
    const minutesElapsed = time / 60000;
    const drift = Math.min(driftRate * minutesElapsed, range * 0.8);

    return normalRandom(cl + drift, stddev);
  },
};

export const trendDownScenario: SimulationScenario = {
  name: 'trend_down',
  description: 'Dérive progressive vers le bas',
  duration: 0,
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, lcl } = config.controlLimits;
    const range = cl - lcl;
    const stddev = range / 10;

    const driftRate = range * 0.005;
    const minutesElapsed = time / 60000;
    const drift = Math.min(driftRate * minutesElapsed, range * 0.8);

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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, ucl } = config.controlLimits;
    const range = ucl - cl;
    const stddev = range / 8;

    // Shift occurs after 5 minutes
    const shiftTime = 5 * 60 * 1000;
    const shifted = time > shiftTime;
    const shiftAmount = shifted ? range * 0.6 : 0;

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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const stddev = range / 15;

    // 10-minute cycle
    const cyclePeriod = 10 * 60 * 1000;
    const cycleAmplitude = range * 0.3;
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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    // Very small standard deviation - 15 points within middle third
    const stddev = range / 20;

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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const stddev = range / 15;

    // Randomly choose upper or lower cluster
    const upperCluster = Math.random() > 0.5;
    const clusterCenter = upperCluster ? cl + range * 0.25 : cl - range * 0.25;

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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const stddev = range / 6;

    // 5% chance of out-of-control point
    if (Math.random() < 0.05) {
      const overshoot = range * 0.2;
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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const baseStddev = range / 10;

    // Variance doubles every 10 minutes
    const minutesElapsed = time / 60000;
    const varianceMultiplier = 1 + (minutesElapsed / 10);
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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const sigma = range / 6;

    // Cycle through different rule violations
    const cycleTime = 2 * 60 * 1000; // 2-minute cycles
    const phase = Math.floor((time % (cycleTime * 4)) / cycleTime);

    switch (phase) {
      case 0:
        // Rule 3: 6 points in a row steadily increasing
        const increment = (time % cycleTime) / cycleTime;
        return cl - sigma + (2 * sigma * increment);
      case 1:
        // Rule 4: 14 points alternating up and down
        const isUp = Math.floor(time / 5000) % 2 === 0;
        return isUp ? cl + sigma * 0.8 : cl - sigma * 0.8;
      case 2:
        // Rule 5: 2 of 3 points beyond 2-sigma (same side)
        if (Math.random() < 0.7) {
          return cl + sigma * 2.2;
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
  generator: (time: number, config: ParameterConfig): number => {
    const { cl, ucl, lcl } = config.controlLimits;
    const range = ucl - lcl;
    const sigma = range / 6;

    // Base variation
    let value = normalRandom(cl, sigma);

    // Small cyclic component (temperature, etc.)
    const hourCycle = Math.sin((2 * Math.PI * time) / (60 * 60 * 1000)) * sigma * 0.3;
    value += hourCycle;

    // Occasional small shifts (batch changes every ~30 min)
    const batchNumber = Math.floor(time / (30 * 60 * 1000));
    const batchOffset = ((batchNumber * 7) % 10 - 5) / 10 * sigma;
    value += batchOffset;

    // Rare outliers (1% chance)
    if (Math.random() < 0.01) {
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
