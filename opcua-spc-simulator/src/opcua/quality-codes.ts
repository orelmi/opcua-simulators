/**
 * Quality (StatusCode) overrides
 * Shared mapping between dashboard quality keys and node-opcua StatusCodes.
 * Used to force the OPC UA quality of a parameter's tags to a non-Good value.
 */

import { StatusCodes } from 'node-opcua';

/**
 * Selectable OPC UA qualities.
 * 'Good' is the default (no override); the others can be forced per parameter.
 */
export const QUALITY_STATUS_CODES = {
  Good: StatusCodes.Good,
  Uncertain: StatusCodes.Uncertain,
  Bad: StatusCodes.Bad,
  BadNoCommunication: StatusCodes.BadNoCommunication,
  BadNotConnected: StatusCodes.BadNotConnected,
  BadDeviceFailure: StatusCodes.BadDeviceFailure,
  BadSensorFailure: StatusCodes.BadSensorFailure,
  BadOutOfService: StatusCodes.BadOutOfService,
  BadWaitingForInitialData: StatusCodes.BadWaitingForInitialData,
  UncertainLastUsableValue: StatusCodes.UncertainLastUsableValue,
} as const;

export type QualityKey = keyof typeof QUALITY_STATUS_CODES;

/**
 * Non-Good quality keys, exposed to the dashboard for the quality selector.
 */
export const NON_GOOD_QUALITY_KEYS: string[] = Object.keys(QUALITY_STATUS_CODES).filter(
  (k) => k !== 'Good'
);

/**
 * Whether a quality key is a valid, selectable value.
 */
export function isValidQualityKey(key: string): boolean {
  return key in QUALITY_STATUS_CODES;
}

/**
 * Resolve a quality key to a node-opcua StatusCode.
 * Returns StatusCodes.Good for null/undefined/unknown keys.
 */
export function resolveStatusCode(key: string | null | undefined) {
  if (key && key in QUALITY_STATUS_CODES) {
    return (QUALITY_STATUS_CODES as Record<string, typeof StatusCodes.Good>)[key];
  }
  return StatusCodes.Good;
}
