import time
from datetime import datetime, timezone
from opcua import Server, ua

# =============================
# CONSTANTES D'ÉTAT
# =============================
C_NOT_CONFIGURED = 0
C_CONFIGURING = 1
C_IDLE = 2
C_ACQUISITION_STARTED = 3
C_ACQUISITION_STOPPED = 4

# =============================
# FONCTIONS UTILITAIRES
# =============================
def creVar(parent, name, value, writable):
    var = parent.add_variable(parent.nodeid.NamespaceIndex, name, value)
    if writable:
        var.set_writable()
    return var

def setVar(var, value, timestamp=None):
    dv = ua.DataValue(ua.Variant(value))
    if timestamp:
        dv.SourceTimestamp = timestamp
        dv.ServerTimestamp = timestamp
    var.set_value(dv)

def setSampleValue(value, sample_index, SampleValue, SampleIndex):
    timestamp = datetime.now(timezone.utc)
    setVar(SampleValue, float(value), timestamp)
    setVar(SampleIndex, sample_index, timestamp)

# =============================
# SERVEUR OPC UA
# =============================
server = Server()
server.set_endpoint("opc.tcp://0.0.0.0:4840/freeopcua/server/")
server.set_server_name("Simulation OPC UA Python 3.12")
server.set_security_policy([ua.SecurityPolicyType.NoSecurity])

uri = "http://example.org/simulation"
idx = server.register_namespace(uri)

# Création objet Simulation
objects = server.get_objects_node()
sim_obj = objects.add_object(idx, "Simulation")

# Variables station
Station_Command_Configure = creVar(sim_obj, "Station.Command.Configure", False, True)
Station_Command_Start = creVar(sim_obj, "Station.Command.Start", False, True)
Station_Command_Stop = creVar(sim_obj, "Station.Command.Stop", False, True)
Station_Command_Reset = creVar(sim_obj, "Station.Command.Reset", False, True)

Station_Heartbeat = creVar(sim_obj, "Station.Heartbeat", 0, True)
Station_Heartbeat_Ack = creVar(sim_obj, "Station.HeartbeatAck", 0, True)
Station_State_Value = creVar(sim_obj, "Station.State.Value", C_NOT_CONFIGURED, True)
Station_Started_At = creVar(sim_obj, "Station.State.StartedAt", 0, False)
Station_Stopped_At = creVar(sim_obj, "Station.State.StoppedAt", 0, False)

# Paramètres
P01_SampleValue = creVar(sim_obj, "P01.SampleValue", 0.0, False)
P01_SampleIndex = creVar(sim_obj, "P01.SampleIndex", 1, False)

# =============================
# Historisation RAM
# =============================
server.historize_node_data_change(P01_SampleValue)

# =============================
# Données de simulation
# =============================
value3 = [50,51,52,53,54,55,56,57,58,59,60,59,58,57,56,55,54,53,52,51]

sampleIndex = 0
index = 0
counter = 0
last_time = time.perf_counter()

# =============================
# Démarrage serveur
# =============================
server.start()
print("✅ Serveur OPC UA démarré sur opc.tcp://0.0.0.0:4840/freeopcua/server/")

try:
    while True:
        time.sleep(0.01)
        timestamp = datetime.now(timezone.utc)

        # Heartbeat
        hb = Station_Heartbeat.get_value()
        setVar(Station_Heartbeat_Ack, hb, timestamp)

        # Commandes
        if Station_Command_Configure.get_value():
            print("Command_Configure")
            setVar(Station_Command_Configure, False)
            setVar(Station_State_Value, C_CONFIGURING)
            time.sleep(5)
            setVar(Station_State_Value, C_IDLE)

        if Station_Command_Start.get_value():
            print("Command_Start")
            setVar(Station_Command_Start, False)
            setVar(Station_State_Value, C_ACQUISITION_STARTED)
            setVar(Station_Started_At, datetime.now())

        if Station_Command_Stop.get_value():
            print("Command_Stop")
            setVar(Station_Command_Stop, False)
            setVar(Station_State_Value, C_ACQUISITION_STOPPED)
            setVar(Station_Stopped_At, datetime.now())

        if Station_Command_Reset.get_value():
            print("Command_Reset")
            setVar(Station_Command_Reset, False)
            setVar(Station_State_Value, C_IDLE)

        # Acquisition
        state = Station_State_Value.get_value()
        if state == C_ACQUISITION_STARTED:
            if time.perf_counter() - last_time >= 1.0:
                last_time = time.perf_counter()
                counter += 1
                if counter == 13:
                    sampleIndex += 1
                    setSampleValue(value3[index], sampleIndex, P01_SampleValue, P01_SampleIndex)
                    index = (index + 1) % len(value3)
                    counter = 0

finally:
    print("🛑 Arrêt du serveur OPC UA")
    server.stop()
