# Modèle de données OPC UA

Ce document décrit la structure complète des nœuds OPC UA exposés par le simulateur.

## Namespace

- **URI** : `http://opcua-simulators.local/UA/msp`
- **Index par défaut** : 2 (configurable via `--namespace-index`)

## Format des NodeId

Par défaut, les NodeId sont au format string :
```
ns=2;s=Station.Name
ns=2;s=P01.SampleValue
```

Format numérique disponible via `--node-id-format numeric` :
```
ns=2;i=6000
ns=2;i=6001
```

## Structure complète

```
Objects/
├── Station/
│   ├── Name                   (String)
│   ├── SerialNumber           (String)
│   ├── Manufacturer           (String)
│   ├── Heartbeat              (UInt32)
│   ├── HeartbeatAck           (UInt32)
│   ├── State/
│   │   ├── Value              (UInt16)
│   │   ├── StartedAt          (DateTime)
│   │   └── StoppedAt          (DateTime)
│   ├── Command/
│   │   ├── Configure          (Boolean)
│   │   ├── Start              (Boolean)
│   │   ├── Stop               (Boolean)
│   │   └── Reset              (Boolean)
│   ├── Config/
│   │   ├── StartCondition/
│   │   │   ├── Type           (UInt16)
│   │   │   └── ParameterIndex (UInt32)
│   │   └── StopCondition/
│   │       ├── Type           (UInt16)
│   │       └── ParameterIndex (UInt32)
│   ├── Metrics/
│   │   ├── CycleTime              (UInt32)
│   │   ├── Info1                  (Double)
│   │   ├── Info2                  (Double)
│   │   ├── StartupTime            (DateTime)
│   │   ├── StorageFillPercentage  (Double)
│   │   └── UpTimeSeconds          (UInt32)
│   └── Context/
│       ├── DoubleInfo1            (Double)
│       ├── DoubleInfo2            (Double)
│       ├── DoubleInfo3            (Double)
│       ├── OperationId            (String)
│       ├── ProductionOrderId      (String)
│       ├── RoutingId              (String)
│       ├── SpecDouble1            (Double)
│       ├── SpecDouble2            (Double)
│       ├── SpecDouble3            (Double)
│       ├── SpecString1            (String)
│       ├── SpecString2            (String)
│       └── SpecString3            (String)
├── P01/
│   ├── SampleValue            (Double) ← Historisé
│   ├── EngValue               (Double)
│   ├── SampleIndex            (UInt32)
│   ├── Name                   (String)
│   ├── ParameterIndex         (UInt32)
│   ├── Enabled                (Boolean)
│   ├── PhysicalUnit           (String)
│   └── Config/
│       ├── EngRange/
│       │   ├── MinimumValue   (Double)
│       │   └── MaximumValue   (Double)
│       ├── Processing/
│       │   ├── Function       (UInt16)
│       │   └── WindowSize     (UInt32)
│       ├── ProcessingFilter/
│       │   ├── FilterType     (Int16)
│       │   ├── Order          (Int16)
│       │   ├── LowCut         (Double)
│       │   ├── HighCut        (Double)
│       │   └── BandType       (Int16)
│       └── SampleRate         (UInt32)
├── P02/ ... P24/
│   └── (même structure que P01)
```

## Détail des nœuds

### Station

| Nœud | Type | Accès | Description |
|------|------|-------|-------------|
| `Station.Name` | String | R | Nom auto-généré (ex: "station-A3F2B1") |
| `Station.SerialNumber` | String | R | Numéro de série (ex: "SN-20260106-B4C8A2") |
| `Station.Manufacturer` | String | R | "OPC UA SPC Simulator" |
| `Station.Heartbeat` | UInt32 | RW | Bit de vie - écriture client |
| `Station.HeartbeatAck` | UInt32 | R | Recopie automatique du Heartbeat |

### État de la station

| Nœud | Type | Accès | Description |
|------|------|-------|-------------|
| `Station.State.Value` | UInt16 | R | Code d'état d'acquisition |
| `Station.State.StartedAt` | DateTime | R | Timestamp de démarrage |
| `Station.State.StoppedAt` | DateTime | R | Timestamp d'arrêt |

**Codes d'état :**

| Code | Nom | Description |
|------|-----|-------------|
| 0 | NotConfigured | État initial au démarrage |
| 1 | Idle | Prêt à démarrer l'acquisition |
| 2 | AcquisitionStarted | Acquisition en cours |
| 3 | AcquisitionStopped | Acquisition arrêtée |
| 8 | Configuring | Configuration en cours |
| 9 | ConfigurationError | Erreur de configuration |

### Commandes

| Nœud | Type | Accès | Action |
|------|------|-------|--------|
| `Station.Command.Configure` | Boolean | RW | Écrire `true` pour configurer |
| `Station.Command.Start` | Boolean | RW | Écrire `true` pour démarrer |
| `Station.Command.Stop` | Boolean | RW | Écrire `true` pour arrêter |
| `Station.Command.Reset` | Boolean | RW | Écrire `true` pour réinitialiser |

### Métriques

| Nœud | Type | Accès | Description |
|------|------|-------|-------------|
| `Station.Metrics.CycleTime` | UInt32 | R | Temps de cycle en ms (simulé) |
| `Station.Metrics.Info1` | Double | R | Valeur aléatoire (simulé) |
| `Station.Metrics.Info2` | Double | R | Valeur statique |
| `Station.Metrics.StartupTime` | DateTime | R | Timestamp démarrage serveur |
| `Station.Metrics.StorageFillPercentage` | Double | R | % remplissage stockage |
| `Station.Metrics.UpTimeSeconds` | UInt32 | R | Uptime en secondes |

### Contexte (écriture client)

| Nœud | Type | Accès | Description |
|------|------|-------|-------------|
| `Station.Context.OperationId` | String | RW | ID opération |
| `Station.Context.ProductionOrderId` | String | RW | ID ordre de production |
| `Station.Context.RoutingId` | String | RW | ID routage |
| `Station.Context.DoubleInfo1` | Double | R | Révolution 0-360° (simulé) |
| `Station.Context.DoubleInfo2/3` | Double | RW | Libre |
| `Station.Context.SpecDouble1/2/3` | Double | RW | Libre |
| `Station.Context.SpecString1/2/3` | String | RW | Libre |

### Paramètres (P01-P24)

| Nœud | Type | Accès | Description |
|------|------|-------|-------------|
| `Pxx.SampleValue` | Double | R | Valeur SPC **historisée** |
| `Pxx.EngValue` | Double | R | Valeur temps réel |
| `Pxx.SampleIndex` | UInt32 | R | Index de l'échantillon |
| `Pxx.Name` | String | R | Nom technique |
| `Pxx.ParameterIndex` | UInt32 | R | Index du paramètre |
| `Pxx.Enabled` | Boolean | R | Paramètre actif |
| `Pxx.PhysicalUnit` | String | R | Unité de mesure |

### Configuration paramètre

| Nœud | Type | Accès | Description |
|------|------|-------|-------------|
| `Pxx.Config.EngRange.MinimumValue` | Double | R | LSL (limite basse) |
| `Pxx.Config.EngRange.MaximumValue` | Double | R | USL (limite haute) |
| `Pxx.Config.Processing.Function` | UInt16 | R | 0=None, 1=Average, 2=MovingAverage |
| `Pxx.Config.Processing.WindowSize` | UInt32 | R | Taille fenêtre traitement |
| `Pxx.Config.SampleRate` | UInt32 | R | Fréquence échantillonnage (ms) |

## Paramètres de soudage simulés

Les 24 paramètres représentent des mesures typiques d'un processus de soudage :

| Param | Nom | Unité | Cible | Description |
|-------|-----|-------|-------|-------------|
| P01 | WeldCurrent | A | 180 | Courant de soudage |
| P02 | ArcVoltage | V | 24 | Tension d'arc |
| P03 | WireSpeed | m/min | 8.5 | Vitesse du fil |
| P04 | TravelSpeed | mm/s | 12 | Vitesse d'avance |
| P05 | GasFlow | L/min | 18 | Débit de gaz |
| P06 | GasPressure | bar | 2.5 | Pression de gaz |
| P07 | PreheatTemp | °C | 150 | Température de préchauffage |
| P08 | InterpassTemp | °C | 200 | Température inter-passes |
| P09 | PostheatTemp | °C | 250 | Température de post-chauffage |
| P10 | BeadWidth | mm | 8.0 | Largeur du cordon |
| P11 | BeadHeight | mm | 2.5 | Hauteur du cordon |
| P12 | Penetration | mm | 4.0 | Pénétration |
| P13 | TorchAngle | ° | 15 | Angle de la torche |
| P14 | WorkAngle | ° | 45 | Angle de travail |
| P15 | CTWD | mm | 18 | Distance tube contact-pièce |
| P16 | StickOut | mm | 12 | Stick-out |
| P17 | HeatInput | kJ/mm | 1.2 | Apport de chaleur |
| P18 | ArcPower | kW | 4.3 | Puissance d'arc |
| P19 | ArcEnergy | J/mm | 360 | Énergie d'arc |
| P20 | ArcOnTime | s | 45 | Temps d'arc |
| P21 | WeldDuration | s | 120 | Durée de soudage |
| P22 | PulseFreq | Hz | 120 | Fréquence de pulsation |
| P23 | ArcStability | % | 95 | Stabilité d'arc |
| P24 | SpatterIndex | % | 2.0 | Index de projections |

## Historisation

Seul `SampleValue` est historisé. Utiliser le service OPC UA **HistoryRead** pour accéder aux données historiques.

**Exemple de requête HistoryRead :**
- NodeId : `ns=2;s=P01.SampleValue`
- StartTime : `2026-01-06T00:00:00Z`
- EndTime : `2026-01-07T00:00:00Z`

## Limites de contrôle vs Limites de tolérance

### Limites de Tolérance (USL/LSL)
- Définies par les spécifications de fabrication
- Représentent les limites absolues acceptables
- Exposées via `Config.EngRange.MinimumValue/MaximumValue`

### Limites de Contrôle (UCL/LCL)
- Calculées statistiquement (±3σ)
- Plus serrées que les limites de tolérance
- Calculées automatiquement à 75% de la plage de tolérance

```
        USL ─────────────────────────────── (Limite haute absolue)
        UCL ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  (Limite contrôle haute)
         CL ═════════════════════════════  (Ligne centrale / Target)
        LCL ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  (Limite contrôle basse)
        LSL ─────────────────────────────── (Limite basse absolue)
```
