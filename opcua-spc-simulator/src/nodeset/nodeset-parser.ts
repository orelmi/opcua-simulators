/**
 * NodeSet XML Parser
 * Parses OPC UA NodeSet2 XML files to extract CCParameterType instances
 * and their EngValue variable NodeIds for simulation.
 */

import fs from 'fs';

/**
 * Parsed EngValue info from NodeSet XML
 */
export interface NodeSetEngValue {
  /** NodeId string value (without namespace prefix), e.g. '"Pyro_Choisi_Pour_Regul"."Thermo_Surveillance_Z1"' */
  nodeIdValue: string;
  /** NodeId type: 'i' for numeric, 's' for string */
  nodeIdType: 'i' | 's';
  /** Namespace index as it appears in the XML (1-based from NamespaceUris) */
  xmlNamespaceIndex: number;
}

/**
 * A parameter extracted from the NodeSet XML
 */
export interface NodeSetParameter {
  /** Browse name (e.g., "Z01") */
  browseName: string;
  /** Display name (e.g., "Z01") */
  displayName: string;
  /** NodeId value of the parameter object (e.g., "5016" for ns=2;i=5016) */
  objectNodeIdValue: string;
  /** NodeId type of the parameter object */
  objectNodeIdType: 'i' | 's';
  /** XML namespace index of the parameter object */
  objectXmlNsIndex: number;
  /** EngValue variable info */
  engValue: NodeSetEngValue;
  /** Parameter index (1-based, assigned during parsing) */
  index: number;
}

/**
 * Result of parsing a NodeSet XML file
 */
export interface NodeSetParseResult {
  /** Namespace URIs declared in the XML (in order) */
  namespaceUris: string[];
  /** Extracted parameters with EngValue info */
  parameters: NodeSetParameter[];
}

/**
 * Parse a NodeId string like "ns=2;i=5016" or "ns=3;s=something"
 */
function parseNodeId(nodeId: string): { nsIndex: number; type: 'i' | 's'; value: string } | null {
  // Handle XML entity decoding for quotes
  const decoded = nodeId.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  const match = decoded.match(/^ns=(\d+);([is])=(.+)$/);
  if (match) {
    return {
      nsIndex: parseInt(match[1], 10),
      type: match[2] as 'i' | 's',
      value: match[3],
    };
  }

  // Also handle NodeIds without namespace (e.g., "i=85" for Objects folder)
  const simpleMatch = decoded.match(/^([is])=(.+)$/);
  if (simpleMatch) {
    return {
      nsIndex: 0,
      type: simpleMatch[1] as 'i' | 's',
      value: simpleMatch[2],
    };
  }

  return null;
}

/**
 * Extract attribute value from an XML element opening tag
 */
function getAttr(elementTag: string, attrName: string): string | null {
  // Match attribute="value" with possible XML entities
  const regex = new RegExp(`${attrName}="([^"]*)"`, 'i');
  const match = elementTag.match(regex);
  return match ? match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null;
}

/**
 * Extract text content between tags: <Tag>content</Tag>
 */
function getTextContent(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Parse a NodeSet2 XML file and extract parameters with EngValue NodeIds
 */
export function parseNodeSetXml(filePath: string): NodeSetParseResult {
  const content = fs.readFileSync(filePath, 'utf-8');

  // 1. Extract NamespaceUris
  const namespaceUris = extractNamespaceUris(content);

  // 2. Extract all UAObject elements and identify CCParameterType instances
  const parameterObjects = extractParameterObjects(content);

  // 3. Extract all EngValue UAVariable elements
  const engValueVars = extractEngValueVariables(content);

  // 4. Match EngValues to their parent parameter objects
  const parameters: NodeSetParameter[] = [];
  let index = 1;

  for (const paramObj of parameterObjects) {
    // Find EngValue whose ParentNodeId matches this object's NodeId
    const engValue = engValueVars.find(ev => ev.parentNodeId === paramObj.nodeId);

    if (engValue) {
      const objParsed = parseNodeId(paramObj.nodeId);
      const engParsed = parseNodeId(engValue.nodeId);

      if (objParsed && engParsed) {
        parameters.push({
          browseName: paramObj.browseName,
          displayName: paramObj.displayName,
          objectNodeIdValue: objParsed.value,
          objectNodeIdType: objParsed.type,
          objectXmlNsIndex: objParsed.nsIndex,
          engValue: {
            nodeIdValue: engParsed.value,
            nodeIdType: engParsed.type,
            xmlNamespaceIndex: engParsed.nsIndex,
          },
          index,
        });
        index++;
      }
    }
  }

  return { namespaceUris, parameters };
}

/**
 * Extract NamespaceUris from the XML
 */
function extractNamespaceUris(xml: string): string[] {
  const uris: string[] = [];
  const nsSection = xml.match(/<NamespaceUris>([\s\S]*?)<\/NamespaceUris>/);
  if (!nsSection) return uris;

  const uriRegex = /<Uri>([^<]+)<\/Uri>/g;
  let match;
  while ((match = uriRegex.exec(nsSection[1])) !== null) {
    uris.push(match[1].trim());
  }
  return uris;
}

/**
 * Extract UAObject elements that are CCParameterType instances.
 * CCParameterType is identified by HasTypeDefinition reference to ns=1;i=1000.
 * We also accept objects organized under Objects folder (ParentNodeId="i=85")
 * that have the CCParameterType reference.
 */
function extractParameterObjects(xml: string): {
  nodeId: string;
  browseName: string;
  displayName: string;
}[] {
  const results: {
    nodeId: string;
    browseName: string;
    displayName: string;
  }[] = [];

  // Match UAObject elements (including their full content until closing tag)
  const objectRegex = /<UAObject\s+([^>]+)>([\s\S]*?)<\/UAObject>/g;
  let match;

  while ((match = objectRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const body = match[2];

    // Check if this object has HasTypeDefinition reference to CCParameterType (ns=1;i=1000)
    if (!body.includes('ns=1;i=1000')) continue;

    // Check that it's a HasTypeDefinition reference
    const hasTypeDef = /<Reference\s+ReferenceType="HasTypeDefinition">ns=1;i=1000<\/Reference>/.test(body);
    if (!hasTypeDef) continue;

    const nodeId = getAttr(attrs, 'NodeId');
    const browseName = getAttr(attrs, 'BrowseName');
    const displayName = getTextContent(body, 'DisplayName');

    if (nodeId && browseName && displayName) {
      // Strip namespace prefix from BrowseName (e.g., "2:Z01" -> "Z01")
      const cleanBrowseName = browseName.includes(':') ? browseName.split(':').slice(1).join(':') : browseName;
      results.push({
        nodeId,
        browseName: cleanBrowseName,
        displayName,
      });
    }
  }

  return results;
}

/**
 * Extract UAVariable elements with BrowseName containing "EngValue"
 */
function extractEngValueVariables(xml: string): {
  nodeId: string;
  parentNodeId: string;
}[] {
  const results: {
    nodeId: string;
    parentNodeId: string;
  }[] = [];

  // Match UAVariable elements with EngValue in BrowseName
  const varRegex = /<UAVariable\s+([^>]+)>([\s\S]*?)<\/UAVariable>/g;
  let match;

  while ((match = varRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const browseName = getAttr(attrs, 'BrowseName');

    // Check if this is an EngValue variable
    if (!browseName || !browseName.includes('EngValue')) continue;

    const nodeId = getAttr(attrs, 'NodeId');
    const parentNodeId = getAttr(attrs, 'ParentNodeId');

    if (nodeId && parentNodeId) {
      results.push({ nodeId, parentNodeId });
    }
  }

  return results;
}
