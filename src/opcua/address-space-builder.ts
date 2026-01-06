/**
 * OPC UA Address Space Builder
 * Creates the CC (Control Chart) namespace based on the NodeSet XML
 */

import {
  AddressSpace,
  DataType,
  Namespace,
  UAObject,
  UAVariable,
  Variant,
  StatusCodes,
  DataValue,
  HistoryReadResult,
  NumericRange,
  AccessLevelFlag,
  HistoryData,
} from 'node-opcua';
import { ParameterConfig, AcquisitionStatus, TriggerType } from '../types';
import { SQLiteHistoryStore } from '../database/sqlite-store';
import { ParameterSimulator, ParameterState } from '../simulation/parameter-simulator';
import { StationStateMachine } from '../simulation/station-state-machine';

const NAMESPACE_URI = 'http://framatome.com/UA/msp';

export interface CCParameter {
  object: UAObject;
  sampleValue: UAVariable;
  sampleIndex: UAVariable;
  engValue: UAVariable;
  name: UAVariable;
  parameterIndex: UAVariable;
  enabled: UAVariable;
  unit: UAVariable;
}

export interface StationNodes {
  object: UAObject;
  name: UAVariable;
  serialNumber: UAVariable;
  manufacturer: UAVariable;
  heartbeat: UAVariable;
  heartbeatAck: UAVariable;
  stateObject: UAObject;
  statusValue: UAVariable;
  startedAt: UAVariable;
  stoppedAt: UAVariable;
  commandObject: UAObject;
  configureCmd: UAVariable;
  startCmd: UAVariable;
  stopCmd: UAVariable;
  resetCmd: UAVariable;
  metricsObject: UAObject;
  cycleTime: UAVariable;
  info1: UAVariable;
  info2: UAVariable;
  startupTime: UAVariable;
  storageFillPercentage: UAVariable;
  upTimeSeconds: UAVariable;
  contextObject: UAObject;
  doubleInfo1: UAVariable;
  doubleInfo2: UAVariable;
  doubleInfo3: UAVariable;
  operationId: UAVariable;
  productionOrderId: UAVariable;
  routingId: UAVariable;
  specDouble1: UAVariable;
  specDouble2: UAVariable;
  specDouble3: UAVariable;
  specString1: UAVariable;
  specString2: UAVariable;
  specString3: UAVariable;
}

export class AddressSpaceBuilder {
  private addressSpace: AddressSpace;
  private namespace: Namespace;
  private parameters: Map<number, CCParameter> = new Map();
  private historyStore: SQLiteHistoryStore;
  private simulator: ParameterSimulator;
  private stateMachine: StationStateMachine;
  private stationNodes: StationNodes | null = null;

  constructor(
    addressSpace: AddressSpace,
    historyStore: SQLiteHistoryStore,
    simulator: ParameterSimulator,
    stateMachine: StationStateMachine
  ) {
    this.addressSpace = addressSpace;
    this.namespace = addressSpace.registerNamespace(NAMESPACE_URI);
    this.historyStore = historyStore;
    this.simulator = simulator;
    this.stateMachine = stateMachine;
  }

  /**
   * Build the complete CC address space
   */
  build(parameterConfigs: ParameterConfig[]): void {
    // Create CCParameterType
    this.createCCParameterType();

    // Create CCRangeType
    this.createCCRangeType();

    // Create Station object with state machine
    this.createStationObject();

    // Create parameters P01-P24
    for (const config of parameterConfigs) {
      this.createParameter(config);
    }

    // Bind state machine to OPC UA nodes
    this.bindStateMachine();

    console.log(`Address space built with ${parameterConfigs.length} parameters`);
  }

  /**
   * Create the CCParameterType object type
   */
  private createCCParameterType(): void {
    const baseObjectType = this.addressSpace.findObjectType('BaseObjectType')!;

    this.namespace.addObjectType({
      browseName: 'CCParameterType',
      subtypeOf: baseObjectType,
    });
  }

  /**
   * Create the CCRangeType object type
   */
  private createCCRangeType(): void {
    const baseObjectType = this.addressSpace.findObjectType('BaseObjectType')!;

    this.namespace.addObjectType({
      browseName: 'CCRangeType',
      subtypeOf: baseObjectType,
    });
  }

  /**
   * Create a CC Parameter object (P01-P24)
   */
  private createParameter(config: ParameterConfig): void {
    const objectsFolder = this.addressSpace.rootFolder.objects;

    // Create parameter object
    const paramObject = this.namespace.addObject({
      organizedBy: objectsFolder,
      browseName: config.name,
      displayName: config.name,
    });

    // Create SampleValue variable with historization
    const sampleValue = this.namespace.addVariable({
      componentOf: paramObject,
      browseName: 'SampleValue',
      displayName: 'SampleValue',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: config.toleranceLimits.target },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.HistoryRead,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.HistoryRead,
      historizing: true,
    });

    // Set up history read capability
    this.setupHistoryRead(sampleValue, config.index);

    // Create SampleIndex variable (using UInt32 for simplicity)
    const sampleIndex = this.namespace.addVariable({
      componentOf: paramObject,
      browseName: 'SampleIndex',
      displayName: 'SampleIndex',
      dataType: DataType.UInt32,
      value: { dataType: DataType.UInt32, value: 0 },
    });

    // Create EngValue variable (no historization - real-time only)
    const engValue = this.namespace.addVariable({
      componentOf: paramObject,
      browseName: 'EngValue',
      displayName: 'EngValue',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: config.toleranceLimits.target },
      accessLevel: AccessLevelFlag.CurrentRead,
      userAccessLevel: AccessLevelFlag.CurrentRead,
      historizing: false,
    });

    // Create Name variable (display name like "WeldCurrent")
    const nameVar = this.namespace.addVariable({
      componentOf: paramObject,
      browseName: 'Name',
      displayName: 'Name',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: config.displayName },
    });

    // Create Description variable
    this.namespace.addVariable({
      componentOf: paramObject,
      browseName: 'Description',
      displayName: 'Description',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: config.description },
    });

    // Create ParameterIndex variable
    const parameterIndexVar = this.namespace.addVariable({
      componentOf: paramObject,
      browseName: 'ParameterIndex',
      displayName: 'ParameterIndex',
      dataType: DataType.UInt32,
      value: { dataType: DataType.UInt32, value: config.index },
    });

    // Create Enabled variable
    const enabledVar = this.namespace.addVariable({
      componentOf: paramObject,
      browseName: 'Enabled',
      displayName: 'Enabled',
      dataType: DataType.Boolean,
      value: { dataType: DataType.Boolean, value: config.enabled },
    });

    // Create Unit variable
    const unitVar = this.namespace.addVariable({
      componentOf: paramObject,
      browseName: 'Unit',
      displayName: 'Unit',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: config.unit },
    });

    // Create Config sub-object with limits
    const configObject = this.namespace.addObject({
      componentOf: paramObject,
      browseName: 'Config',
      displayName: 'Config',
    });

    // Create EngRange (tolerance limits)
    const engRange = this.namespace.addObject({
      componentOf: configObject,
      browseName: 'EngRange',
      displayName: 'EngRange',
    });

    this.namespace.addVariable({
      componentOf: engRange,
      browseName: 'MinimumValue',
      displayName: 'MinimumValue',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: config.toleranceLimits.lsl },
    });

    this.namespace.addVariable({
      componentOf: engRange,
      browseName: 'MaximumValue',
      displayName: 'MaximumValue',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: config.toleranceLimits.usl },
    });

    // Store parameter reference
    this.parameters.set(config.index, {
      object: paramObject,
      sampleValue,
      sampleIndex,
      engValue,
      name: nameVar,
      parameterIndex: parameterIndexVar,
      enabled: enabledVar,
      unit: unitVar,
    });

    // Set up value binding to simulator (only for enabled parameters)
    if (config.enabled) {
      this.bindToSimulator(config.index, sampleValue, sampleIndex, engValue);
    }
  }

  /**
   * Set up history read capability for a variable
   */
  private setupHistoryRead(variable: UAVariable, parameterIndex: number): void {
    const historyStore = this.historyStore;

    // Install history server capabilities
    variable.bindExtensionObject();

    // Override history read
    (variable as any)['$historicalDataConfiguration'] = {
      startOfArchive: new Date(Date.now() - 24 * 60 * 60 * 1000),
      startOfOnlineArchive: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };

    // Set up historyRead handler
    const originalHistoryRead = (variable as any).historyRead?.bind(variable);
    (variable as any).historyRead = async (
      context: any,
      historyReadDetails: any,
      indexRange: NumericRange | null,
      dataEncoding: any,
      continuationPoint: Buffer | null
    ): Promise<HistoryReadResult> => {
      try {
        const startTime = historyReadDetails.startTime || new Date(0);
        const endTime = historyReadDetails.endTime || new Date();

        const data = historyStore.queryByTimeRange(parameterIndex, startTime, endTime);

        const dataValues = data.map((point) => new DataValue({
          value: new Variant({ dataType: DataType.Double, value: point.value }),
          sourceTimestamp: point.timestamp,
          serverTimestamp: point.timestamp,
          statusCode: StatusCodes.Good,
        }));

        const historyData = new HistoryData({ dataValues });

        return new HistoryReadResult({
          statusCode: StatusCodes.Good,
          historyData,
        });
      } catch (error) {
        console.error('History read error:', error);
        return new HistoryReadResult({
          statusCode: StatusCodes.BadInternalError,
        });
      }
    };
  }

  /**
   * Bind OPC UA variable to simulator updates
   */
  private bindToSimulator(
    parameterIndex: number,
    sampleValue: UAVariable,
    sampleIndex: UAVariable,
    engValue: UAVariable
  ): void {
    // Listen for EngValue updates (high frequency, default 100ms)
    this.simulator.on(`engValue:${parameterIndex}`, (data: { timestamp: Date; engValue: number }) => {
      engValue.setValueFromSource(
        new Variant({ dataType: DataType.Double, value: data.engValue }),
        StatusCodes.Good,
        data.timestamp
      );
    });

    // Listen for SPC sample updates (lower frequency, default 5s)
    this.simulator.on(`parameter:${parameterIndex}`, (dataPoint) => {
      // Update SampleValue
      sampleValue.setValueFromSource(
        new Variant({ dataType: DataType.Double, value: dataPoint.value }),
        StatusCodes.Good,
        dataPoint.timestamp
      );

      // Update SampleIndex
      sampleIndex.setValueFromSource(
        new Variant({ dataType: DataType.UInt32, value: dataPoint.sampleIndex % 0xFFFFFFFF }),
        StatusCodes.Good,
        dataPoint.timestamp
      );

      // Store in history (only SPC samples are historized)
      this.historyStore.insertDataPoint(dataPoint);
    });
  }


  /**
   * Generate a random station name with format "station-XXXXXX"
   */
  private generateStationName(): string {
    const randomHex = Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase();
    return `station-${randomHex}`;
  }

  /**
   * Generate a serial number with format "SN-YYYYMMDD-XXXXXX"
   */
  private generateSerialNumber(): string {
    const date = new Date();
    const dateStr = date.getFullYear().toString() +
      (date.getMonth() + 1).toString().padStart(2, '0') +
      date.getDate().toString().padStart(2, '0');
    const randomHex = Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase();
    return `SN-${dateStr}-${randomHex}`;
  }

  /**
   * Create Station object with state machine variables and methods
   * Conforms to XML NodeSet: Station/State, Station/Command, Station/Config
   */
  private createStationObject(): void {
    const objectsFolder = this.addressSpace.rootFolder.objects;
    const stationName = this.generateStationName();
    const serialNumber = this.generateSerialNumber();

    // Create Station object
    const stationObject = this.namespace.addObject({
      organizedBy: objectsFolder,
      browseName: 'Station',
      displayName: 'Station',
    });

    // Station/Name - auto-generated unique identifier
    const nameVar = this.namespace.addVariable({
      componentOf: stationObject,
      browseName: 'Name',
      displayName: 'Name',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: stationName },
    });

    // Station/SerialNumber - auto-generated serial number
    const serialNumberVar = this.namespace.addVariable({
      componentOf: stationObject,
      browseName: 'SerialNumber',
      displayName: 'SerialNumber',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: serialNumber },
    });

    // Station/Manufacturer
    const manufacturerVar = this.namespace.addVariable({
      componentOf: stationObject,
      browseName: 'Manufacturer',
      displayName: 'Manufacturer',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: 'Framatome MSP Simulator' },
    });

    // Station/Heartbeat - writable by client for watchdog (using UInt32 for compatibility)
    const heartbeatVar = this.namespace.addVariable({
      componentOf: stationObject,
      browseName: 'Heartbeat',
      displayName: 'Heartbeat',
      dataType: DataType.UInt32,
      value: { dataType: DataType.UInt32, value: 0 },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Station/HeartbeatAck - auto-copies Heartbeat value
    const heartbeatAckVar = this.namespace.addVariable({
      componentOf: stationObject,
      browseName: 'HeartbeatAck',
      displayName: 'HeartbeatAck',
      dataType: DataType.UInt32,
      value: { dataType: DataType.UInt32, value: 0 },
      accessLevel: AccessLevelFlag.CurrentRead,
      userAccessLevel: AccessLevelFlag.CurrentRead,
    });

    // Bind Heartbeat -> HeartbeatAck copy mechanism
    heartbeatVar.on('value_changed', (dataValue) => {
      heartbeatAckVar.setValueFromSource(
        new Variant({ dataType: DataType.UInt32, value: dataValue.value.value }),
        StatusCodes.Good,
        new Date()
      );
    });

    console.log(`Station name: ${stationName}`);
    console.log(`Serial number: ${serialNumber}`);

    // Create State sub-object (AcquisitionStateType)
    const stateObj = this.namespace.addObject({
      componentOf: stationObject,
      browseName: 'State',
      displayName: 'State',
    });

    // State/Value (UInt16) - acquisition status
    const statusValue = this.namespace.addVariable({
      componentOf: stateObj,
      browseName: 'Value',
      displayName: 'Value',
      dataType: DataType.UInt16,
      value: { dataType: DataType.UInt16, value: this.stateMachine.getStatus() },
    });

    // State/StartedAt (DateTime)
    const startedAt = this.namespace.addVariable({
      componentOf: stateObj,
      browseName: 'StartedAt',
      displayName: 'StartedAt',
      dataType: DataType.DateTime,
      value: { dataType: DataType.DateTime, value: null },
    });

    // State/StoppedAt (DateTime)
    const stoppedAt = this.namespace.addVariable({
      componentOf: stateObj,
      browseName: 'StoppedAt',
      displayName: 'StoppedAt',
      dataType: DataType.DateTime,
      value: { dataType: DataType.DateTime, value: null },
    });

    // Create Command sub-object with boolean commands
    const commandObject = this.namespace.addObject({
      componentOf: stationObject,
      browseName: 'Command',
      displayName: 'Command',
    });

    // Command/Configure (Boolean)
    const configureCmd = this.namespace.addVariable({
      componentOf: commandObject,
      browseName: 'Configure',
      displayName: 'Configure',
      dataType: DataType.Boolean,
      value: { dataType: DataType.Boolean, value: false },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Command/Start (Boolean)
    const startCmd = this.namespace.addVariable({
      componentOf: commandObject,
      browseName: 'Start',
      displayName: 'Start',
      dataType: DataType.Boolean,
      value: { dataType: DataType.Boolean, value: false },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Command/Stop (Boolean)
    const stopCmd = this.namespace.addVariable({
      componentOf: commandObject,
      browseName: 'Stop',
      displayName: 'Stop',
      dataType: DataType.Boolean,
      value: { dataType: DataType.Boolean, value: false },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Command/Reset (Boolean)
    const resetCmd = this.namespace.addVariable({
      componentOf: commandObject,
      browseName: 'Reset',
      displayName: 'Reset',
      dataType: DataType.Boolean,
      value: { dataType: DataType.Boolean, value: false },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Bind command variables to state machine (rising edge trigger)
    this.bindCommandVariable(configureCmd, () => {
      this.stateMachine.dispatch({ type: 'CONFIGURE' });
      // Simulate configuration (auto-complete after 1 second)
      setTimeout(() => {
        this.stateMachine.dispatch({ type: 'CONFIGURATION_DONE' });
      }, 1000);
    });

    this.bindCommandVariable(startCmd, () => {
      this.stateMachine.dispatch({ type: 'START_ACQUISITION', trigger: TriggerType.UaCommand });
    });

    this.bindCommandVariable(stopCmd, () => {
      this.stateMachine.dispatch({ type: 'STOP_ACQUISITION', trigger: TriggerType.UaCommand });
    });

    this.bindCommandVariable(resetCmd, () => {
      this.stateMachine.dispatch({ type: 'RESET' });
    });

    // Create Config sub-object
    const configObject = this.namespace.addObject({
      componentOf: stationObject,
      browseName: 'Config',
      displayName: 'Config',
    });

    // Config/StartCondition object
    const startCondition = this.namespace.addObject({
      componentOf: configObject,
      browseName: 'StartCondition',
      displayName: 'StartCondition',
    });

    this.namespace.addVariable({
      componentOf: startCondition,
      browseName: 'Type',
      displayName: 'Type',
      dataType: DataType.UInt16,
      value: { dataType: DataType.UInt16, value: TriggerType.UaCommand },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    this.namespace.addVariable({
      componentOf: startCondition,
      browseName: 'ParameterIndex',
      displayName: 'ParameterIndex',
      dataType: DataType.UInt32,
      value: { dataType: DataType.UInt32, value: 0 },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Config/StopCondition object
    const stopCondition = this.namespace.addObject({
      componentOf: configObject,
      browseName: 'StopCondition',
      displayName: 'StopCondition',
    });

    this.namespace.addVariable({
      componentOf: stopCondition,
      browseName: 'Type',
      displayName: 'Type',
      dataType: DataType.UInt16,
      value: { dataType: DataType.UInt16, value: TriggerType.UaCommand },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    this.namespace.addVariable({
      componentOf: stopCondition,
      browseName: 'ParameterIndex',
      displayName: 'ParameterIndex',
      dataType: DataType.UInt32,
      value: { dataType: DataType.UInt32, value: 0 },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Create Metrics sub-object
    const metricsObject = this.namespace.addObject({
      componentOf: stationObject,
      browseName: 'Metrics',
      displayName: 'Metrics',
    });

    const startupTime = new Date();

    // Metrics/CycleTime - cycle time in milliseconds (simulated)
    const cycleTimeVar = this.namespace.addVariable({
      componentOf: metricsObject,
      browseName: 'CycleTime',
      displayName: 'CycleTime',
      dataType: DataType.UInt32,
      value: { dataType: DataType.UInt32, value: 5000 }, // 5 seconds initial
    });

    // Metrics/Info1 - random info value (simulated)
    const info1Var = this.namespace.addVariable({
      componentOf: metricsObject,
      browseName: 'Info1',
      displayName: 'Info1',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: Math.random() * 100 },
    });

    // Metrics/Info2 - info value (no simulation, static)
    const info2Var = this.namespace.addVariable({
      componentOf: metricsObject,
      browseName: 'Info2',
      displayName: 'Info2',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: 0.0 },
    });

    // Metrics/StartupTime - server startup timestamp
    const startupTimeVar = this.namespace.addVariable({
      componentOf: metricsObject,
      browseName: 'StartupTime',
      displayName: 'StartupTime',
      dataType: DataType.DateTime,
      value: { dataType: DataType.DateTime, value: startupTime },
    });

    // Metrics/StorageFillPercentage - storage fill percentage (simulated)
    const storageFillPercentageVar = this.namespace.addVariable({
      componentOf: metricsObject,
      browseName: 'StorageFillPercentage',
      displayName: 'StorageFillPercentage',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: 10.0 + Math.random() * 20 }, // 10-30% initial
    });

    // Metrics/UpTimeSeconds - uptime in seconds since startup
    const upTimeSecondsVar = this.namespace.addVariable({
      componentOf: metricsObject,
      browseName: 'UpTimeSeconds',
      displayName: 'UpTimeSeconds',
      dataType: DataType.UInt32,
      value: { dataType: DataType.UInt32, value: 0 },
    });

    // Create Context sub-object
    const contextObject = this.namespace.addObject({
      componentOf: stationObject,
      browseName: 'Context',
      displayName: 'Context',
    });

    // Context/DoubleInfo1 - perpetual revolution 0-360° (simulated)
    const doubleInfo1Var = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'DoubleInfo1',
      displayName: 'DoubleInfo1',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: 0.0 },
    });

    // Context/DoubleInfo2 - no simulation
    const doubleInfo2Var = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'DoubleInfo2',
      displayName: 'DoubleInfo2',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: 0.0 },
    });

    // Context/DoubleInfo3 - no simulation
    const doubleInfo3Var = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'DoubleInfo3',
      displayName: 'DoubleInfo3',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: 0.0 },
    });

    // Context/OperationId - writable by OPC UA client
    const operationIdVar = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'OperationId',
      displayName: 'OperationId',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: '' },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Context/ProductionOrderId - writable by OPC UA client
    const productionOrderIdVar = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'ProductionOrderId',
      displayName: 'ProductionOrderId',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: '' },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Context/RoutingId - writable by OPC UA client
    const routingIdVar = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'RoutingId',
      displayName: 'RoutingId',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: '' },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Context/SpecDouble1 - writable by OPC UA client
    const specDouble1Var = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'SpecDouble1',
      displayName: 'SpecDouble1',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: 0.0 },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Context/SpecDouble2 - writable by OPC UA client
    const specDouble2Var = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'SpecDouble2',
      displayName: 'SpecDouble2',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: 0.0 },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Context/SpecDouble3 - writable by OPC UA client
    const specDouble3Var = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'SpecDouble3',
      displayName: 'SpecDouble3',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: 0.0 },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Context/SpecString1 - writable by OPC UA client
    const specString1Var = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'SpecString1',
      displayName: 'SpecString1',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: '' },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Context/SpecString2 - writable by OPC UA client
    const specString2Var = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'SpecString2',
      displayName: 'SpecString2',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: '' },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Context/SpecString3 - writable by OPC UA client
    const specString3Var = this.namespace.addVariable({
      componentOf: contextObject,
      browseName: 'SpecString3',
      displayName: 'SpecString3',
      dataType: DataType.String,
      value: { dataType: DataType.String, value: '' },
      accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
      userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
    });

    // Start metrics and context simulation timer
    this.startMetricsSimulation(
      cycleTimeVar,
      info1Var,
      storageFillPercentageVar,
      upTimeSecondsVar,
      startupTime,
      doubleInfo1Var
    );

    // Store references
    this.stationNodes = {
      object: stationObject,
      name: nameVar,
      serialNumber: serialNumberVar,
      manufacturer: manufacturerVar,
      heartbeat: heartbeatVar,
      heartbeatAck: heartbeatAckVar,
      stateObject: stateObj,
      statusValue,
      startedAt,
      stoppedAt,
      commandObject,
      configureCmd,
      startCmd,
      stopCmd,
      resetCmd,
      metricsObject,
      cycleTime: cycleTimeVar,
      info1: info1Var,
      info2: info2Var,
      startupTime: startupTimeVar,
      storageFillPercentage: storageFillPercentageVar,
      upTimeSeconds: upTimeSecondsVar,
      contextObject,
      doubleInfo1: doubleInfo1Var,
      doubleInfo2: doubleInfo2Var,
      doubleInfo3: doubleInfo3Var,
      operationId: operationIdVar,
      productionOrderId: productionOrderIdVar,
      routingId: routingIdVar,
      specDouble1: specDouble1Var,
      specDouble2: specDouble2Var,
      specDouble3: specDouble3Var,
      specString1: specString1Var,
      specString2: specString2Var,
      specString3: specString3Var,
    };
  }

  /**
   * Start metrics simulation
   */
  private startMetricsSimulation(
    cycleTime: UAVariable,
    info1: UAVariable,
    storageFillPercentage: UAVariable,
    upTimeSeconds: UAVariable,
    startupTime: Date,
    doubleInfo1: UAVariable
  ): void {
    let revolutionAngle = 0; // 0-360° perpetual revolution

    // Update metrics every second
    setInterval(() => {
      const now = new Date();

      // Update UpTimeSeconds (seconds since startup)
      const uptimeValue = Math.floor((Date.now() - startupTime.getTime()) / 1000);
      upTimeSeconds.setValueFromSource(
        new Variant({ dataType: DataType.UInt32, value: uptimeValue }),
        StatusCodes.Good,
        now
      );

      // Update Info1 with random value
      info1.setValueFromSource(
        new Variant({ dataType: DataType.Double, value: Math.random() * 100 }),
        StatusCodes.Good,
        now
      );

      // Update CycleTime with realistic variation (4.5-5.5 seconds) when acquiring
      if (this.stateMachine.getStatus() === AcquisitionStatus.AcquisitionStarted) {
        const cycleValue = 4500 + Math.random() * 1000; // 4500-5500 ms
        cycleTime.setValueFromSource(
          new Variant({ dataType: DataType.UInt32, value: Math.floor(cycleValue) }),
          StatusCodes.Good,
          now
        );
      }

      // Slowly increase storage fill percentage (realistic behavior)
      const currentFill = (storageFillPercentage.readValue().value.value as number) || 10;
      const newFill = Math.min(95, currentFill + 0.001); // Very slow increase
      storageFillPercentage.setValueFromSource(
        new Variant({ dataType: DataType.Double, value: newFill }),
        StatusCodes.Good,
        now
      );

      // Update DoubleInfo1 - perpetual revolution 0-360°
      revolutionAngle = (revolutionAngle + 1) % 360; // 1° per second = full revolution in 6 minutes
      doubleInfo1.setValueFromSource(
        new Variant({ dataType: DataType.Double, value: revolutionAngle }),
        StatusCodes.Good,
        now
      );
    }, 1000);
  }

  /**
   * Bind a boolean command variable to trigger action on rising edge (false -> true)
   */
  private bindCommandVariable(variable: UAVariable, action: () => void): void {
    variable.on('value_changed', (dataValue) => {
      const value = dataValue.value.value as boolean;
      if (value === true) {
        action();
        // Auto-reset to false after action
        setTimeout(() => {
          variable.setValueFromSource(
            new Variant({ dataType: DataType.Boolean, value: false }),
            StatusCodes.Good,
            new Date()
          );
        }, 100);
      }
    });
  }


  /**
   * Bind state machine events to OPC UA variables
   */
  private bindStateMachine(): void {
    if (!this.stationNodes) return;

    const nodes = this.stationNodes;

    // Listen for state changes
    this.stateMachine.on('stateChanged', (event: {
      previousStatus: AcquisitionStatus;
      newStatus: AcquisitionStatus;
      state: { startedAt: Date | null; stoppedAt: Date | null };
    }) => {
      const now = new Date();

      // Update status value
      nodes.statusValue.setValueFromSource(
        new Variant({ dataType: DataType.UInt16, value: event.newStatus }),
        StatusCodes.Good,
        now
      );

      // Update timestamps
      nodes.startedAt.setValueFromSource(
        new Variant({ dataType: DataType.DateTime, value: event.state.startedAt }),
        StatusCodes.Good,
        now
      );

      nodes.stoppedAt.setValueFromSource(
        new Variant({ dataType: DataType.DateTime, value: event.state.stoppedAt }),
        StatusCodes.Good,
        now
      );

      console.log(`Station state: ${this.stateMachine.getStatusName()}`);
    });

    // Control simulation based on acquisition state
    this.stateMachine.on('acquisitionStarted', () => {
      console.log('Acquisition started - simulation active');
    });

    this.stateMachine.on('acquisitionStopped', () => {
      console.log('Acquisition stopped');
    });
  }

  /**
   * Get parameter by index
   */
  getParameter(index: number): CCParameter | undefined {
    return this.parameters.get(index);
  }

  /**
   * Get namespace
   */
  getNamespace(): Namespace {
    return this.namespace;
  }

  /**
   * Get station nodes
   */
  getStationNodes(): StationNodes | null {
    return this.stationNodes;
  }

  /**
   * Get state machine
   */
  getStateMachine(): StationStateMachine {
    return this.stateMachine;
  }
}
