from opcua import Server, ua
from opcua.server.history import HistoryStorageInterface
from datetime import datetime, timezone
import math
import time


C_NOT_CONFIGURED = 0
C_IDLE = 1
C_ACQUISITION_STARTED = 2
C_ACQUISITION_STOPPED = 3
C_CONFIGURING_ERROR = 9
C_CONFIGURING = 8

# Classe de stockage historique personnalisée

class SinusoidalHistoricalData(HistoryStorageInterface):
    def __init__(self):
        # Utilisation d’un dictionnaire pour stocker les données par identifiant
        self.data = {}
 
    def save_node_value(self, nodeid, value):
        key = str(nodeid.Identifier)
        timestamp = datetime.now(timezone.utc)
        self.data.setdefault(key, []).append((timestamp, value))
 
    def insert_data_value(self, node, data_value):
        key = str(node.nodeid.Identifier)
        timestamp = datetime.now(timezone.utc)
        self.data.setdefault(key, []).append((timestamp, data_value))
 
    def read_raw(self, nodeid, starttime, endtime, numvalues, cont, reverse, tsreturn):
        if starttime.tzinfo is None:
            starttime = starttime.replace(tzinfo=timezone.utc)
        if endtime.tzinfo is None:
            endtime = endtime.replace(tzinfo=timezone.utc)
 
        key = str(nodeid.Identifier)
        result = []
 
        for timestamp, value in self.data.get(key, []):
            if starttime <= timestamp <= endtime:
                dv = ua.DataValue()
                dv.Value = value.Value
                dv.SourceTimestamp = timestamp
                dv.ServerTimestamp = timestamp
                result.append(dv)
 
        if reverse:
            result.reverse()
        if numvalues:
            result = result[:numvalues]
        return result, None
 
    def read_node_history(self, nodeid, starttime, endtime, numvalues):
        return self.read_raw(nodeid, starttime, endtime, numvalues, None, False, None)
 
    def new_historized_node(self, nodeid, period, count):
        # Requis pour éviter l'erreur NotImplementedError
        pass

def creVar(parent, varName, varValue, writable):
    nodeid = ua.NodeId(varName, 1)    # idx doit être 1 si ns=1
    varObj = parent.add_variable(nodeid, varName, varValue)
    if ( writable):
        varObj.set_writable()
    return varObj

def setVar(timestamp, varObj, varValue, varType):
    if varType == "double":
        dv1 = ua.DataValue(ua.Variant(varValue, ua.VariantType.Double))
    elif varType == "boolean":
        dv1 = ua.DataValue(ua.Variant(varValue, ua.VariantType.Boolean))
    elif varType == "integer":
        dv1 = ua.DataValue(ua.Variant(varValue, ua.VariantType.Int32))
    elif varType == "time":
        dv1 = ua.DataValue(ua.Variant(varValue, ua.VariantType.DateTime))
    dv1.SourceTimestamp = timestamp
    dv1.ServerTimestamp = timestamp

    varObj.set_value(dv1)
    
def setSampleValue(value):
    timestamp = datetime.now(timezone.utc)
    value = usedValue[index]
    print("P01_SampleValue value=", value, "date=", timestamp)
    setVar(timestamp, P01_SampleValue, value, "double")
    setVar(timestamp, P02_SampleValue, value + 10, "double")
    setVar(timestamp, P04_SampleValue, value - 10, "double")
    setVar(timestamp, P05_SampleValue, value - 10, "double")
       
# Création du serveur OPC UA
server = Server()
#server.set_endpoint("opc.tcp://0.0.0.0:4840/freeopcua/server/")
server.set_endpoint("opc.tcp://localhost:4840")
uri = "http://example.org/simulation"
idx = server.register_namespace(uri)

# Création de l'objet et de la variable
objects = server.get_objects_node()
sim_obj = objects.add_object(idx, "Simulation")


Station_Command_Configure = creVar(sim_obj, "Station.Command.Configure", False, True)
Station_Command_Start = creVar(sim_obj, "Station.Command.Start", False, True)
Station_Command_Stop = creVar(sim_obj, "Station.Command.Stop", False, True)
Station_Command_Reset = creVar(sim_obj, "Station.Command.Reset", False, True)
Station_Parameters_List = creVar(sim_obj, "Station.ParameterList", "P01;P02;P04;P05", False)
Station_Name = creVar(sim_obj, "Station.Name", "Fil-Flux Poste 1", False)

Station_State_Value = creVar(sim_obj, "Station.State.Value", C_NOT_CONFIGURED, True)
Station_Started_At = creVar(sim_obj, "Station.State.StartedAt", 0, False)
Station_Stopped_At = creVar(sim_obj, "Station.State.StoppedAt", 0, False)

P01_Name = creVar(sim_obj, "P01.Name", "Courant", False)
P02_Name = creVar(sim_obj, "P02.Name", "Tension", False)
P04_Name = creVar(sim_obj, "P04.Name", "Vitesse du fil", False)
P05_Name = creVar(sim_obj, "P05.Name", "Vitesse de rotation", False)

P01_SampleValue = creVar(sim_obj, "P01.SampleValue", 0.0, False)
P02_SampleValue = creVar(sim_obj, "P02.SampleValue", 0.0, False)
P04_SampleValue = creVar(sim_obj, "P04.SampleValue", 0.0, False)
P05_SampleValue = creVar(sim_obj, "P05.SampleValue", 0.0, False)

P01_ParameterIndex = creVar(sim_obj, "P01.ParameterIndex", 1, False)
P02_ParameterIndex = creVar(sim_obj, "P02.ParameterIndex", 2, False)
P05_ParameterIndex = creVar(sim_obj, "P04.ParameterIndex", 4, False)
P04_ParameterIndex = creVar(sim_obj, "P05.ParameterIndex", 5, False)

P01_ParameterEnabled = creVar(sim_obj, "P01.Enabled", True, False)
P02_ParameterEnabled = creVar(sim_obj, "P02.Enabled", True, False)
P04_ParameterEnabled = creVar(sim_obj, "P04.Enabled", True, False)
P05_ParameterEnabled = creVar(sim_obj, "P05.Enabled", True, False)

# Configuration de l’historisation
history = SinusoidalHistoricalData()
server.iserver.history_manager.set_storage(history)

# Démarrage du serveur
server.start()
print("Serveur OPC UA démarré sur opc.tcp://0.0.0.0:4840/freeopcua/server/")

# Activation de l’historisation après démarrage
server.historize_node_data_change(P01_SampleValue, history)
server.historize_node_data_change(P02_SampleValue, history)
server.historize_node_data_change(P04_SampleValue, history)
server.historize_node_data_change(P05_SampleValue, history)

value1 = [
    48, 49, 51, 52, 54, 49, 47, 46, 48, 49, 52, 54, 58, 72, 73, 54, 54, 105, 102, 54,
    88, 54, 54, 28, 29, 54, 20, 22, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 58, 59,
    60, 62, 54, 53, 52, 51, 50, 49, 48, 47, 46, 45, 55, 56, 54, 57, 55, 55, 52, 54,
    52, 55, 55, 48, 47, 48, 47, 48, 47, 48, 47, 48, 47, 48, 47, 48, 47, 48, 20, 21, 22, 40
]
 
value2 = [
    48, 49, 50, 51, 51, 50, 49, 48, 48, 49, 50, 51, 51, 50, 49, 48, 48, 49, 50, 51, 51, 50, 49, 48 #wave no alert
]

value3 = [
    50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51 #wave no alert
]

valueTEST = [48, 49, 51, 52, 54, 49, 47, 46, 48, 49, 52, 54, 58, 72, 72, 69, 67, 58, 48, 32, 31, 30, 28, 28, 52, 50, 48, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 58, 59, 60, 55, 54, 53, 52, 51, 50, 49, 48, 47, 46, 45, 52, 53, 52, 53, 52, 53, 52, 53, 52, 53, 52, 48, 47, 48, 47, 48, 47, 48, 47, 48, 47, 48, 47, 48, 47, 48, 47]

try:
    index = 0
    counter = 0
    usedValue = value3 #to adapt
    
    last_time = time.perf_counter()
    while True:
        time.sleep(0.01)
        
        #read every 1s
        timestamp = datetime.now(timezone.utc)
        Command_Configure = Station_Command_Configure.get_value()
        if Command_Configure == True:
            print("Command_Configure =", Command_Configure)
            setVar(timestamp, Station_Command_Configure, False, "boolean")
            setVar(timestamp, Station_State_Value, C_CONFIGURING, "integer")
            time.sleep(5)
            setVar(timestamp, Station_State_Value, C_IDLE, "integer")
            
        Command_Start = Station_Command_Start.get_value()
        if Command_Start == True:
            print("Command_Start =", Command_Start)
            setVar(timestamp, Station_Command_Start, False, "boolean")
            setVar(timestamp, Station_State_Value, C_ACQUISITION_STARTED, "integer")
            setVar(timestamp, Station_Started_At, datetime.now(), "time")
            
        Command_Stop = Station_Command_Stop.get_value()
        if Command_Stop == True:
            print("Command_Stop =", Command_Stop)
            setVar(timestamp, Station_Command_Stop, False, "boolean")
            setVar(timestamp, Station_State_Value, C_ACQUISITION_STOPPED, "integer")
            setVar(timestamp, Station_Stopped_At, datetime.now(), "time")
            
        Command_Reset = Station_Command_Reset.get_value()
        if Command_Reset == True:
            print("Command_Reset =", Command_Reset)
            setVar(timestamp, Station_Command_Reset, False, "boolean")
            setVar(timestamp, Station_State_Value, C_IDLE, "integer")
            #setVar(timestamp, Station_Stopped_At, 0, "time")
            #setVar(timestamp, Station_Started_At, 0, "time")

        State = Station_State_Value.get_value()
        if State == C_ACQUISITION_STARTED:
            if time.perf_counter() - last_time >= 1.0:
                last_time = time.perf_counter()
                counter = counter + 1
                if counter == 13:
                    setSampleValue(usedValue[index])
                    index = index + 1
                    if index >= len(usedValue) :
                        index = 0
                    counter = 0
        
except KeyboardInterrupt:
    print("Arrêt du serveur...")
finally:
    server.stop()
