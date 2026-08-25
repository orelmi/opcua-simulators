/**
 * NodeSet Address Space Builder
 * Creates a simplified OPC UA address space from a parsed NodeSet XML.
 * Only creates parameter objects with their EngValue variable (no station, no SPC model).
 * EngValue NodeIds match the original NodeSet for client compatibility.
 */

import {
  AddressSpace,
  DataType,
  Namespace,
  UAVariable,
  Variant,
  AccessLevelFlag,
} from 'node-opcua';
import { NodeSetParseResult, NodeSetParameter } from '../nodeset/nodeset-parser';
import { ParameterSimulator } from '../simulation/parameter-simulator';
import { ParameterConfig } from '../types';
import { resolveStatusCode } from './quality-codes';

export class NodeSetAddressSpaceBuilder {
  private addressSpace: AddressSpace;
  /** Map from XML namespace index (1-based) to server Namespace object */
  private namespaceMap: Map<number, Namespace> = new Map();
  private simulator: ParameterSimulator;
  private engValueVariables: Map<number, UAVariable> = new Map();

  constructor(
    addressSpace: AddressSpace,
    simulator: ParameterSimulator,
  ) {
    this.addressSpace = addressSpace;
    this.simulator = simulator;
  }

  /**
   * Build the address space from the parsed NodeSet.
   * Registers namespaces, creates parameter objects, and binds EngValue simulation.
   */
  build(parseResult: NodeSetParseResult, parameterConfigs: ParameterConfig[]): void {
    // 1. Register all namespaces from the NodeSet XML
    this.registerNamespaces(parseResult.namespaceUris);

    // 2. Create parameter objects with EngValue
    for (const param of parseResult.parameters) {
      this.createParameterWithEngValue(param);
    }

    // 3. Bind EngValue simulation for each parameter
    for (const config of parameterConfigs) {
      const engVar = this.engValueVariables.get(config.index);
      if (engVar) {
        this.bindEngValueSimulation(config.index, engVar);
      }
    }

    // 4. Re-apply quality to current value immediately when a forced quality toggles
    this.simulator.on('qualityOverrideChanged', ({ index }: { index: number }) => {
      const engVar = this.engValueVariables.get(index);
      const state = this.simulator.getParameterState(index);
      if (!engVar || !state) return;
      engVar.setValueFromSource(
        new Variant({ dataType: DataType.Double, value: state.engValue }),
        resolveStatusCode(this.simulator.getQualityOverride(index)),
        new Date()
      );
    });

    console.log(`[NodeSet] Address space built with ${parseResult.parameters.length} parameters (EngValue only)`);
  }

  /**
   * Register namespaces from the NodeSet XML in order.
   * XML namespace indices are 1-based (ns=1 = first Uri, ns=2 = second Uri, etc.)
   * because ns=0 is always the OPC UA base namespace.
   *
   * The server always has ns=0 (OPC UA Foundation) and ns=1 (server own namespace).
   * To keep namespace indices aligned with the XML, we reuse the server's own
   * namespace (ns=1) for the first XML namespace URI. This way:
   *   XML ns=1 -> server ns=1 (own namespace, reused)
   *   XML ns=2 -> server ns=2 (registered)
   *   XML ns=3 -> server ns=3 (registered)
   */
  private registerNamespaces(uris: string[]): void {
    for (let i = 0; i < uris.length; i++) {
      const xmlNsIndex = i + 1; // XML ns indices are 1-based
      let ns: Namespace;

      if (xmlNsIndex === 1) {
        // Reuse the server's own namespace (index 1) for the first XML namespace
        // This avoids shifting all subsequent namespace indices by +1
        ns = this.addressSpace.getOwnNamespace();
      } else {
        ns = this.addressSpace.registerNamespace(uris[i]);
      }

      this.namespaceMap.set(xmlNsIndex, ns);
      console.log(`[NodeSet] Registered namespace ns=${xmlNsIndex} (XML) -> ns=${ns.index} (server): ${uris[i]}`);
    }
  }

  /**
   * Get the server Namespace object for a given XML namespace index
   */
  private getNamespace(xmlNsIndex: number): Namespace {
    const ns = this.namespaceMap.get(xmlNsIndex);
    if (!ns) {
      throw new Error(`Namespace for XML index ${xmlNsIndex} not registered`);
    }
    return ns;
  }

  /**
   * Create a parameter object with only its EngValue variable.
   * Uses the exact NodeIds from the NodeSet XML (remapped to server namespace indices).
   */
  private createParameterWithEngValue(param: NodeSetParameter): void {
    const objectsFolder = this.addressSpace.rootFolder.objects;

    // Create the parameter object (e.g., Z01) in the correct namespace
    const objNamespace = this.getNamespace(param.objectXmlNsIndex);
    const objNodeId = param.objectNodeIdType === 'i'
      ? `i=${param.objectNodeIdValue}`
      : `s=${param.objectNodeIdValue}`;

    const paramObject = objNamespace.addObject({
      nodeId: objNodeId,
      organizedBy: objectsFolder,
      browseName: `${objNamespace.index}:${param.browseName}`,
      displayName: param.displayName,
    });

    // Create the EngValue variable in the correct namespace
    const engNamespace = this.getNamespace(param.engValue.xmlNamespaceIndex);
    const engNodeId = param.engValue.nodeIdType === 'i'
      ? `i=${param.engValue.nodeIdValue}`
      : `s=${param.engValue.nodeIdValue}`;

    const engValue = engNamespace.addVariable({
      nodeId: engNodeId,
      componentOf: paramObject,
      browseName: `${this.getNamespace(1).index}:EngValue`, // EngValue BrowseName uses MSP namespace prefix
      displayName: 'EngValue',
      dataType: DataType.Double,
      value: { dataType: DataType.Double, value: 0 },
      accessLevel: AccessLevelFlag.CurrentRead,
      userAccessLevel: AccessLevelFlag.CurrentRead,
      historizing: false,
    });

    this.engValueVariables.set(param.index, engValue);

    console.log(`[NodeSet] Created ${param.browseName} (ns=${objNamespace.index};${objNodeId}) -> EngValue (ns=${engNamespace.index};${engNodeId})`);
  }

  /**
   * Bind an EngValue variable to the simulator's engValue events
   */
  private bindEngValueSimulation(parameterIndex: number, engValue: UAVariable): void {
    this.simulator.on(`engValue:${parameterIndex}`, (data: { timestamp: Date; engValue: number }) => {
      engValue.setValueFromSource(
        new Variant({ dataType: DataType.Double, value: data.engValue }),
        resolveStatusCode(this.simulator.getQualityOverride(parameterIndex)),
        data.timestamp
      );
    });
  }
}
