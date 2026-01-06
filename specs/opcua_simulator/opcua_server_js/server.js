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
const C_CONFIGURING_ERROR = 9;
const C_CONFIGURING = 8;

// ====================
// VARIABLES de simulation (objets mutables)
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

let Station_Name = { value: 'Station 011'}
let P01_SampleValue = { value: 0.0 };
let P02_SampleValue = { value: 0.0 };
let P04_SampleValue = { value: 0.0 };
let P05_SampleValue = { value: 0.0 };

let P01_SampleIndex = { value: 1 };
let P02_SampleIndex = { value: 1 };
let P04_SampleIndex = { value: 1 };
let P05_SampleIndex = { value: 1 };

let P01_Name = { value: "Courant_" };
let P02_Name = { value: "Tension" };
let P04_Name = { value: "Vitesse du fil" };
let P05_Name = { value: "Vitesse de rotation" };

let P01_Enabled = { value: true };
let P02_Enabled = { value: true };
let P04_Enabled = { value: true };
let P05_Enabled = { value: true };

const usedValue = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51];

let sampleIndex = 0;
let index = 0;

// ====================
// DÉMARRAGE DU SERVEUR
// ====================
async function startServer() {
    const server = new OPCUAServer({
        port: 4840,
        resourcePath: "",
        buildInfo: {
            productName: "Simulation OPC UA NodeJS",
            buildNumber: "1",
            buildDate: new Date()
        }
    });

    await server.initialize();

    const namespace = server.engine.addressSpace.getOwnNamespace();

    const simulationObject = namespace.addObject({
        organizedBy: server.engine.addressSpace.rootFolder.objects,
        browseName: "Simulation"
    });

    // ====================
    // Fonction pour lier une variable
    // ====================
    function bindVariable(name, variableRef, dataType) {
        const node = namespace.addVariable({
            componentOf: simulationObject,
            browseName: name,
            nodeId: `ns=1;s=${name}`,
            dataType: dataType,
            value: {
                get: () => new Variant({ dataType: dataType, value: variableRef.value }),
                set: (variant) => {
                    variableRef.value = variant.value;
                    handleCommand(name, variant.value); // <-- déclenche la commande immédiatement
                    return StatusCodes.Good;
                }
            }
        });
        return node;
    }

    // ====================
    // Variables bindées
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
    bindVariable("Station.Name", Station_Name, DataType.String);

    bindVariable("P01.SampleValue", P01_SampleValue, DataType.Double);
    bindVariable("P02.SampleValue", P02_SampleValue, DataType.Double);
    bindVariable("P04.SampleValue", P04_SampleValue, DataType.Double);
    bindVariable("P05.SampleValue", P05_SampleValue, DataType.Double);

    bindVariable("P01.SampleIndex", P01_SampleIndex, DataType.Int32);
    bindVariable("P02.SampleIndex", P02_SampleIndex, DataType.Int32);
    bindVariable("P04.SampleIndex", P04_SampleIndex, DataType.Int32);
    bindVariable("P05.SampleIndex", P05_SampleIndex, DataType.Int32);

    bindVariable("P01.Name", P01_Name, DataType.String);
    bindVariable("P02.Name", P02_Name, DataType.String);
    bindVariable("P04.Name", P04_Name, DataType.String);
    bindVariable("P05.Name", P05_Name, DataType.String);

    bindVariable("P01.Enabled", P01_Enabled, DataType.Boolean);
    bindVariable("P02.Enabled", P02_Enabled, DataType.Boolean);
    bindVariable("P04.Enabled", P04_Enabled, DataType.Boolean);
    bindVariable("P05.Enabled", P05_Enabled, DataType.Boolean);

    // ====================
    // Boucle principale (10ms)
    // ====================
    setInterval(() => {
        // Heartbeat
        Station_Heartbeat_Ack.value = Station_Heartbeat.value;

        // Gestion des commandes
        if (Station_Command_Configure.value) {
            console.log("Command_Configure");
            Station_Command_Configure.value = false;
            Station_State_Value.value = C_CONFIGURING;
            setTimeout(() => { Station_State_Value.value = C_IDLE; }, 2000);
        } else if (Station_Command_Start.value) {
            console.log("Command_Start");
            Station_Command_Start.value = false;
            Station_State_Value.value = C_ACQUISITION_STARTED;
            Station_Started_At.value = new Date();
        } else if (Station_Command_Stop.value) {
            console.log("Command_Stop");
            Station_Command_Stop.value = false;
            Station_State_Value.value = C_ACQUISITION_STOPPED;
            Station_Stopped_At.value = new Date();
        } else if (Station_Command_Reset.value) {
            console.log("Command_Reset");
            Station_Command_Reset.value = false;
            Station_State_Value.value = C_IDLE;
        }
    }, 10);

    // ====================
    // Boucle d’acquisition des échantillons (1s)
    // ====================
    setInterval(() => {
        if (Station_State_Value.value === C_ACQUISITION_STARTED) {
            sampleIndex++;
            const value = usedValue[index];

            P01_SampleValue.value = value;
            P02_SampleValue.value = value + 10;
            P04_SampleValue.value = value - 10;
            P05_SampleValue.value = value - 10;

            P01_SampleIndex.value = sampleIndex;
            P02_SampleIndex.value = sampleIndex;
            P04_SampleIndex.value = sampleIndex;
            P05_SampleIndex.value = sampleIndex;

            index++;
            if (index >= usedValue.length) index = 0;
        }
    }, 1000);

    await server.start();
    console.log("✅ Serveur OPC UA Node.js démarré sur opc.tcp://localhost:4840");
}

startServer();
