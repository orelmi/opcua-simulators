/**
 * Station State Machine
 * Implements the acquisition state machine
 *
 * States:
 * - NotConfigured (0) - Initial state at startup
 * - Configuring (8)   - Configuration in progress
 * - ConfigurationError (9) - Configuration failed
 * - Idle (1)          - Ready to start acquisition
 * - AcquisitionStarted (2) - Acquiring data
 * - AcquisitionStopped (3) - Acquisition stopped, waiting for Reset
 *
 * Workflow:
 * 1. NotConfigured -> Configure command -> Configuring
 * 2. Configuring -> (auto) -> Idle
 * 3. Idle -> Start command -> AcquisitionStarted
 * 4. AcquisitionStarted -> Stop command -> AcquisitionStopped
 * 5. AcquisitionStopped -> Start command -> AcquisitionStarted (direct restart)
 * 5b. AcquisitionStopped -> Reset command -> Idle (alternative)
 *
 * Transitions:
 * - NotConfigured -> Configuring (Configure command)
 * - Configuring -> Idle (Configuration done - automatic)
 * - Configuring -> ConfigurationError (Configuration error)
 * - ConfigurationError -> Configuring (Configure command)
 * - Idle -> AcquisitionStarted (Start command)
 * - Idle -> Configuring (Configure command - reconfigure)
 * - AcquisitionStarted -> AcquisitionStopped (Stop command)
 * - AcquisitionStopped -> AcquisitionStarted (Start command - direct restart)
 * - AcquisitionStopped -> Idle (Reset command)
 */

import { EventEmitter } from 'events';
import { AcquisitionStatus, StationEvent, StationState, TriggerType } from '../types';

export class StationStateMachine extends EventEmitter {
  private state: StationState;
  private autoResetDelay: number;
  private autoResetTimer: NodeJS.Timeout | null = null;

  /**
   * @param initialStatusOrAutoResetDelay - Initial status to restore OR delay in ms before auto-reset (0 = disabled)
   * @param autoResetDelay - Delay in ms before auto-reset (only used if first param is status)
   */
  constructor(initialStatusOrAutoResetDelay: AcquisitionStatus | number = 0, autoResetDelay: number = 0) {
    super();

    // Handle backward compatibility: if first param is a small number, it's autoResetDelay
    let initialStatus: AcquisitionStatus;
    if (typeof initialStatusOrAutoResetDelay === 'number' && initialStatusOrAutoResetDelay <= 10) {
      // Could be status (0-9) or autoResetDelay
      // Status values are 0-3, 8-9; autoResetDelay would typically be larger
      if (initialStatusOrAutoResetDelay === 0) {
        initialStatus = AcquisitionStatus.NotConfigured;
        this.autoResetDelay = autoResetDelay;
      } else if (Object.values(AcquisitionStatus).includes(initialStatusOrAutoResetDelay)) {
        initialStatus = initialStatusOrAutoResetDelay as AcquisitionStatus;
        this.autoResetDelay = autoResetDelay;
      } else {
        initialStatus = AcquisitionStatus.NotConfigured;
        this.autoResetDelay = initialStatusOrAutoResetDelay;
      }
    } else {
      initialStatus = AcquisitionStatus.NotConfigured;
      this.autoResetDelay = initialStatusOrAutoResetDelay as number;
    }

    this.state = {
      status: initialStatus,
      startedAt: null,
      stoppedAt: null,
      configurationError: null,
      lastTransition: new Date(),
    };
  }

  /**
   * Get current state
   */
  getState(): StationState {
    return { ...this.state };
  }

  /**
   * Get current status
   */
  getStatus(): AcquisitionStatus {
    return this.state.status;
  }

  /**
   * Process an event and transition state
   */
  dispatch(event: StationEvent): boolean {
    const previousStatus = this.state.status;
    let transitioned = false;

    switch (event.type) {
      case 'CONFIGURE':
        transitioned = this.handleConfigure();
        break;

      case 'CONFIGURATION_DONE':
        transitioned = this.handleConfigurationDone();
        break;

      case 'CONFIGURATION_ERROR':
        transitioned = this.handleConfigurationError(event.error);
        break;

      case 'START_ACQUISITION':
        transitioned = this.handleStartAcquisition(event.trigger);
        break;

      case 'STOP_ACQUISITION':
        transitioned = this.handleStopAcquisition(event.trigger);
        break;

      case 'RESET':
        transitioned = this.handleReset();
        break;
    }

    if (transitioned) {
      this.state.lastTransition = new Date();
      this.emit('stateChanged', {
        previousStatus,
        newStatus: this.state.status,
        state: this.getState(),
      });
    }

    return transitioned;
  }

  /**
   * Handle CONFIGURE event
   * Valid from: NotConfigured, Idle, ConfigurationError
   */
  private handleConfigure(): boolean {
    const validStates = [
      AcquisitionStatus.NotConfigured,
      AcquisitionStatus.Idle,
      AcquisitionStatus.ConfigurationError,
    ];

    if (!validStates.includes(this.state.status)) {
      return false;
    }

    this.state.status = AcquisitionStatus.Configuring;
    this.state.configurationError = null;
    return true;
  }

  /**
   * Handle CONFIGURATION_DONE event
   * Valid from: Configuring
   */
  private handleConfigurationDone(): boolean {
    if (this.state.status !== AcquisitionStatus.Configuring) {
      return false;
    }

    this.state.status = AcquisitionStatus.Idle;
    return true;
  }

  /**
   * Handle CONFIGURATION_ERROR event
   * Valid from: Configuring
   */
  private handleConfigurationError(error: string): boolean {
    if (this.state.status !== AcquisitionStatus.Configuring) {
      return false;
    }

    this.state.status = AcquisitionStatus.ConfigurationError;
    this.state.configurationError = error;
    return true;
  }

  /**
   * Handle START_ACQUISITION event
   * Valid from: Idle or AcquisitionStopped (direct restart without Reset)
   */
  private handleStartAcquisition(trigger: TriggerType): boolean {
    const validStates = [
      AcquisitionStatus.Idle,
      AcquisitionStatus.AcquisitionStopped,
    ];

    if (!validStates.includes(this.state.status)) {
      return false;
    }

    // Clear any pending auto-reset timer
    if (this.autoResetTimer) {
      clearTimeout(this.autoResetTimer);
      this.autoResetTimer = null;
    }

    this.state.status = AcquisitionStatus.AcquisitionStarted;
    this.state.startedAt = new Date();
    this.state.stoppedAt = null;

    this.emit('acquisitionStarted', {
      trigger,
      startedAt: this.state.startedAt,
    });

    return true;
  }

  /**
   * Handle STOP_ACQUISITION event
   * Valid from: AcquisitionStarted
   */
  private handleStopAcquisition(trigger: TriggerType): boolean {
    if (this.state.status !== AcquisitionStatus.AcquisitionStarted) {
      return false;
    }

    this.state.status = AcquisitionStatus.AcquisitionStopped;
    this.state.stoppedAt = new Date();

    this.emit('acquisitionStopped', {
      trigger,
      stoppedAt: this.state.stoppedAt,
      startedAt: this.state.startedAt,
    });

    // Set up auto-reset if configured
    if (this.autoResetDelay > 0) {
      this.autoResetTimer = setTimeout(() => {
        this.dispatch({ type: 'RESET' });
      }, this.autoResetDelay);
    }

    return true;
  }

  /**
   * Handle RESET event
   * Valid from: AcquisitionStopped
   */
  private handleReset(): boolean {
    if (this.state.status !== AcquisitionStatus.AcquisitionStopped) {
      return false;
    }

    // Clear auto-reset timer if pending
    if (this.autoResetTimer) {
      clearTimeout(this.autoResetTimer);
      this.autoResetTimer = null;
    }

    this.state.status = AcquisitionStatus.Idle;
    this.state.startedAt = null;
    this.state.stoppedAt = null;

    this.emit('reset');

    return true;
  }

  /**
   * Check if acquisition is active
   */
  isAcquiring(): boolean {
    return this.state.status === AcquisitionStatus.AcquisitionStarted;
  }

  /**
   * Check if station is configured
   */
  isConfigured(): boolean {
    return [
      AcquisitionStatus.Idle,
      AcquisitionStatus.AcquisitionStarted,
      AcquisitionStatus.AcquisitionStopped,
    ].includes(this.state.status);
  }

  /**
   * Get status name for display
   */
  getStatusName(): string {
    const names: Record<AcquisitionStatus, string> = {
      [AcquisitionStatus.NotConfigured]: 'NotConfigured',
      [AcquisitionStatus.Idle]: 'Idle',
      [AcquisitionStatus.AcquisitionStarted]: 'AcquisitionStarted',
      [AcquisitionStatus.AcquisitionStopped]: 'AcquisitionStopped',
      [AcquisitionStatus.ConfigurationError]: 'ConfigurationError',
      [AcquisitionStatus.Configuring]: 'Configuring',
    };
    return names[this.state.status];
  }

  /**
   * Set startedAt timestamp (for persistence restore)
   */
  setStartedAt(date: Date | null): void {
    this.state.startedAt = date;
  }

  /**
   * Set stoppedAt timestamp (for persistence restore)
   */
  setStoppedAt(date: Date | null): void {
    this.state.stoppedAt = date;
  }

  /**
   * Force state for simulation purposes
   */
  forceState(status: AcquisitionStatus): void {
    const previousStatus = this.state.status;
    this.state.status = status;
    this.state.lastTransition = new Date();

    if (status === AcquisitionStatus.AcquisitionStarted) {
      this.state.startedAt = new Date();
      this.state.stoppedAt = null;
    } else if (status === AcquisitionStatus.AcquisitionStopped) {
      this.state.stoppedAt = new Date();
    }

    this.emit('stateChanged', {
      previousStatus,
      newStatus: status,
      state: this.getState(),
      forced: true,
    });
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.autoResetTimer) {
      clearTimeout(this.autoResetTimer);
      this.autoResetTimer = null;
    }
    this.removeAllListeners();
  }
}
