const {
    OPCUAServer,
    Variant,
    DataType,
    StatusCodes
} = require("node-opcua");

// ====================
// CONSTANTES D'ÉTAT
// ====================
const C_NOT_CONFIGURED = 0;
const C_IDLE = 1;
const C_ACQUISITION_STARTED = 2;
const C_ACQUISITION_STOPPED = 3;
const C_CONFIGURING = 8;

// ====================
// VARIABLES
// ====================
let Station_Command_Configure = { value: false };
let Station_Command_Start = { value: false };
let Station_Command_Stop = { value: false };
let Station_Command_Reset = { value: false };
let Station_Heartbeat = { value: 0 };
let Station_Heartbeat_Ack = { value: 0 };
let Station_State_Value = { value: C_NOT_CONFIGURED };
let Station_Started_At = { value: new Date() };
let Station_Stopped_At = { value: new Date() };

let P01_SampleValue = { value: 0 };
let P02_SampleValue = { value: 0 };
let P04_SampleValue = { value: 0 };
let P05_SampleValue = { value: 0 };

let P01_SampleIndex = { value: 0 };
let P02_SampleIndex = { value: 0 };
let P04_SampleIndex = { value: 0 };
let P05_SampleIndex = { value: 0 };

const usedValue = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 59, 58, 57];
let sampleIndex = 0;
let index = 0;

// ====================
// SERVEUR
// ====================
async function startServer() {

    const server = new OPCUAServer({
        port: 4840,
        buildInfo: {
            productName: "OPCUA Simulator with Historian",
            buildNumber: "1",
            buildDate: new Date()
        }
    });

    await server.initialize();

    const addressSpace = server.engine.addressSpace;
    const namespace = addressSpace.getOwnNamespace();

    const simulation = namespace.addObject({
        organizedBy: addressSpace.rootFolder.objects,
        browseName: "Simulation"
    });

    // ====================
    // FONCTION UTILITAIRE
    // ====================
    function bindVariable(name, ref, dataType) {
        return namespace.addVariable({
            componentOf: simulation,
            browseName: name,
            nodeId: `ns=1;s=${name}`,
            dataType,
            value: {
                get: () => new Variant({ dataType, value: ref.value }),
                set: (variant) => {
                    ref.value = variant.value;
                    return StatusCodes.Good;
                }
            }
        });
    }

    // ====================
    // VARIABLES STATION
    // ====================
    bindVariable("Station.Command.Configure", Station_Command_Configure, DataType.Boolean);
    bindVariable("Station.Command.Start", Station_Command_Start, DataType.Boolean);
    bindVariable("Station.Command.Stop", Station_Command_Stop, DataType.Boolean);
    bindVariable("Station.Command.Reset", Station_Command_Reset, DataType.Boolean);
    bindVariable("Station.Heartbeat", Station_Heartbeat, DataType.Int32);
    bindVariable("Station.HeartbeatAck", Station_Heartbeat_Ack, DataType.Int32);
    bindVariable("Station.State.Value", Station_State_Value, DataType.Int32);
    bindVariable("Station.State.StartedAt", Station_Started_At, DataType.DateTime);
    bindVariable("Station.State.StoppedAt", Station_Stopped_At, DataType.DateTime);

    // ====================
    // VARIABLES PROCESS HISTORISÉES (OFFICIEL)
    // ====================
    function createHistorizedVariable(name, ref) {
        return namespace.addVariable({
            componentOf: simulation,
            browseName: name,
            nodeId: `ns=1;s=${name}`,
            dataType: DataType.Double,
            historizing: true, // 🔥 clé
            minimumSamplingInterval: 1000,
            value: {
                get: () => new Variant({
                    dataType: DataType.Double,
                    value: ref.value
                })
            }
        });
    }

    const P01_Node = createHistorizedVariable("P01.SampleValue", P01_SampleValue);
    const P02_Node = createHistorizedVariable("P02.SampleValue", P02_SampleValue);
    const P04_Node = createHistorizedVariable("P04.SampleValue", P04_SampleValue);
    const P05_Node = createHistorizedVariable("P05.SampleValue", P05_SampleValue);

    bindVariable("P01.SampleIndex", P01_SampleIndex, DataType.Int32);
    bindVariable("P02.SampleIndex", P02_SampleIndex, DataType.Int32);
    bindVariable("P04.SampleIndex", P04_SampleIndex, DataType.Int32);
    bindVariable("P05.SampleIndex", P05_SampleIndex, DataType.Int32);

    // ====================
    // BOUCLE COMMANDES (10 ms)
    // ====================
    setInterval(() => {
        Station_Heartbeat_Ack.value = Station_Heartbeat.value;

        if (Station_Command_Configure.value) {
            Station_Command_Configure.value = false;
            Station_State_Value.value = C_CONFIGURING;
            setTimeout(() => Station_State_Value.value = C_IDLE, 2000);
        }

        if (Station_Command_Start.value) {
            Station_Command_Start.value = false;
            Station_State_Value.value = C_ACQUISITION_STARTED;
            Station_Started_At.value = new Date();
        }

        if (Station_Command_Stop.value) {
            Station_Command_Stop.value = false;
            Station_State_Value.value = C_ACQUISITION_STOPPED;
            Station_Stopped_At.value = new Date();
        }

        if (Station_Command_Reset.value) {
            Station_Command_Reset.value = false;
            Station_State_Value.value = C_IDLE;
        }
    }, 10);

    // ====================
    // BOUCLE ACQUISITION (1 s)
    // ====================
    setInterval(() => {
        if (Station_State_Value.value === C_ACQUISITION_STARTED) {

            sampleIndex++;
            const v = usedValue[index];

            P01_SampleValue.value = v;
            P02_SampleValue.value = v + 10;
            P04_SampleValue.value = v - 10;
            P05_SampleValue.value = v - 5;

            P01_SampleIndex.value =
            P02_SampleIndex.value =
            P04_SampleIndex.value =
            P05_SampleIndex.value = sampleIndex;

            const now = new Date();

            // ✅ LA SEULE FAÇON OFFICIELLE D’HISTORISER
            P01_Node.setValueFromSource({ dataType: DataType.Double, value: P01_SampleValue.value }, StatusCodes.Good, now);
            P02_Node.setValueFromSource({ dataType: DataType.Double, value: P02_SampleValue.value }, StatusCodes.Good, now);
            P04_Node.setValueFromSource({ dataType: DataType.Double, value: P04_SampleValue.value }, StatusCodes.Good, now);
            P05_Node.setValueFromSource({ dataType: DataType.Double, value: P05_SampleValue.value }, StatusCodes.Good, now);

            index = (index + 1) % usedValue.length;
        }
    }, 1000);

    await server.start();
    console.log("✅ Serveur OPC UA avec Historian démarré : opc.tcp://localhost:4840");
}

startServer();
