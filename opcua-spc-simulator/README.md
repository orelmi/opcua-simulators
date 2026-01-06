# OPC UA Control Chart Simulator

Simulateur OPC UA pour tester les cartes de contrôle SPC (Statistical Process Control) avec support de l'historisation et cache SQLite.

## Fonctionnalités

- **Serveur OPC UA** compatible avec la spécification MSP (namespace `http://opcua-simulators.local/UA/msp`)
- **24 paramètres** (P01 à P24) de type `CCParameterType` - toujours créés, activables via `--params`
- **Paramètres de soudage réalistes** avec unités appropriées (A, V, °C, mm, bar, etc.)
- **Historisation** des valeurs SPC (`SampleValue`) avec cache SQLite
- **Machine d'état d'acquisition** conforme au XML NodeSet
- **10 scénarios de simulation** pour tester différentes situations de contrôle qualité
- **Fréquences séparées** : EngValue (100ms) et SPC samples (5s)
- **Dashboard web** temps réel pour visualiser l'état, les paramètres et changer de scénario dynamiquement

## Installation

```bash
npm install
```

## Utilisation

### Démarrer le simulateur

```bash
# Démarrage avec paramètres par défaut
npm run dev

# Avec options personnalisées
npm run dev -- --params 12 --scenario trend_up

# Compiler et exécuter
npm run build
npm start -- --params 24 --scenario realistic
```

### Machine d'état de la Station

Le serveur démarre en état `NotConfigured`. Workflow :

1. **Configure** → `Configuring` → `Idle`
2. **Start** → `AcquisitionStarted`
3. **Stop** → `AcquisitionStopped`
4. **Reset** → `Idle` (peut redémarrer avec Start)

États possibles :
| Code | État | Description |
|------|------|-------------|
| 0 | NotConfigured | État initial au démarrage |
| 1 | Idle | Prêt à démarrer l'acquisition |
| 2 | AcquisitionStarted | Acquisition en cours |
| 3 | AcquisitionStopped | Acquisition arrêtée |
| 8 | Configuring | Configuration en cours |
| 9 | ConfigurationError | Erreur de configuration |

### Options de ligne de commande

| Option | Description | Défaut |
|--------|-------------|--------|
| `-P, --port <port>` | Port du serveur OPC UA | 4840 |
| `-p, --params <count>` | Nombre de paramètres activés (1-24, les 24 sont toujours créés) | 24 |
| `-t, --target <value>` | Valeur cible par défaut (utilisé si pas de valeur spécifique) | 100.0 |
| `--usl-offset <percent>` | Écart USL par rapport à la cible en % | 5.0 |
| `--lsl-offset <percent>` | Écart LSL par rapport à la cible en % | 5.0 |
| `-s, --scenario <name>` | Scénario de simulation | realistic |
| `-r, --sample-rate <ms>` | Taux de simulation interne en ms | 100 |
| `-f, --spc-frequency <ms>` | Fréquence des échantillons SPC (SampleValue) | 5000 |
| `-e, --eng-frequency <ms>` | Fréquence de mise à jour EngValue | 100 |
| `-d, --db <path>` | Chemin de la base SQLite | ./data/cc_history.db |
| `-v, --verbose` | Activer les logs détaillés | false |
| `--list-scenarios` | Lister les scénarios disponibles | - |
| `-n, --namespace-index <index>` | Index du namespace (1=serveur, 2+=personnalisé) | 2 |
| `--node-id-format <format>` | Format des NodeId: "string" (ns=X;s=Path) ou "numeric" (ns=X;i=NNN) | string |
| `-w, --dashboard-port <port>` | Port du dashboard web (0 pour désactiver) | 3000 |

### Initialiser la base de données avec des données historiques

```bash
# Générer 24h de données historiques
npm run init-db

# Avec options personnalisées
npx ts-node src/scripts/init-database.ts --hours 48 --scenario cyclic --params 12
```

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

## Scénarios de simulation

| Scénario | Description | Règle SPC testée |
|----------|-------------|------------------|
| `normal` | Processus sous contrôle - distribution normale | Aucune violation |
| `trend_up` | Dérive progressive vers le haut | Règle 2 (9 points consécutifs) |
| `trend_down` | Dérive progressive vers le bas | Règle 2 |
| `shift` | Décalage soudain de la moyenne | Règle 1 ou 2 |
| `cyclic` | Oscillation périodique | Pattern cyclique |
| `stratification` | Valeurs groupées près de la ligne centrale | Faible variation |
| `mixture` | Distribution bimodale | Valeurs évitant le centre |
| `out_of_control` | Points occasionnels hors limites | Règle 1 (hors 3σ) |
| `increasing_variance` | Variance croissante | Processus instable |
| `nelson_rules` | Test des règles de Nelson | Violations multiples |
| `realistic` | Combinaison d'effets réalistes | Simulation réaliste |

## Format des NodeId

Par défaut, les NodeId sont générés au format string avec le chemin du nœud (namespace index 2) :

```
ns=2;s=Station.Name
ns=2;s=P01.SampleValue
ns=2;s=P01.Config.EngRange.MinimumValue
```

Pour utiliser le namespace du serveur (index 1) :

```bash
npm start -- --namespace-index 1
# Génère: ns=1;s=Station.Name, ...
```

Pour utiliser des NodeId numériques :

```bash
npm start -- --node-id-format numeric
# Génère: ns=2;i=6000, ns=2;i=6001, ...
```

## Structure des nœuds OPC UA

```
Objects/
├── Station/
│   ├── Name                   (String) - Nom auto-généré (ex: "station-A3F2B1")
│   ├── SerialNumber           (String) - Numéro de série auto-généré (ex: "SN-20260106-B4C8A2")
│   ├── Manufacturer           (String) - "OPC UA SPC Simulator"
│   ├── Heartbeat              (UInt32) - Bit de vie écriture client
│   ├── HeartbeatAck           (UInt32) - Recopie automatique du Heartbeat
│   ├── State/
│   │   ├── Value              (UInt16) - État d'acquisition (0-9)
│   │   ├── StartedAt          (DateTime)
│   │   └── StoppedAt          (DateTime)
│   ├── Command/
│   │   ├── Configure          (Boolean) - Écrire true pour configurer
│   │   ├── Start              (Boolean) - Écrire true pour démarrer
│   │   ├── Stop               (Boolean) - Écrire true pour arrêter
│   │   └── Reset              (Boolean) - Écrire true pour réinitialiser
│   ├── Config/
│   │   ├── StartCondition/
│   │   │   ├── Type           (UInt16)
│   │   │   └── ParameterIndex (UInt32)
│   │   └── StopCondition/
│   │       ├── Type           (UInt16)
│   │       └── ParameterIndex (UInt32)
│   ├── Metrics/
│   │   ├── CycleTime              (UInt32) - Temps de cycle en ms (simulé)
│   │   ├── Info1                  (Double) - Valeur aléatoire (simulé)
│   │   ├── Info2                  (Double) - Valeur statique (pas de simulation)
│   │   ├── StartupTime            (DateTime) - Timestamp de démarrage du serveur
│   │   ├── StorageFillPercentage  (Double) - Pourcentage de remplissage stockage
│   │   └── UpTimeSeconds          (UInt32) - Temps de fonctionnement en secondes
│   └── Context/
│       ├── DoubleInfo1            (Double) - Révolution perpétuelle 0-360° (simulé)
│       ├── DoubleInfo2            (Double) - Pas de simulation
│       ├── DoubleInfo3            (Double) - Pas de simulation
│       ├── OperationId            (String) - Écrit par client OPC UA
│       ├── ProductionOrderId      (String) - Écrit par client OPC UA
│       ├── RoutingId              (String) - Écrit par client OPC UA
│       ├── SpecDouble1            (Double) - Écrit par client OPC UA
│       ├── SpecDouble2            (Double) - Écrit par client OPC UA
│       ├── SpecDouble3            (Double) - Écrit par client OPC UA
│       ├── SpecString1            (String) - Écrit par client OPC UA
│       ├── SpecString2            (String) - Écrit par client OPC UA
│       └── SpecString3            (String) - Écrit par client OPC UA
├── P01/
│   ├── SampleValue            (Double, historisé)
│   ├── EngValue               (Double, temps réel, non historisé)
│   ├── SampleIndex            (UInt32)
│   ├── Name                   (String) - Nom technique (ex: "WeldCurrent")
│   ├── ParameterIndex         (UInt32)
│   ├── Enabled                (Boolean) - Paramètre actif ou non
│   ├── PhysicalUnit           (String) - Unité de mesure (A, V, °C, etc.)
│   └── Config/
│       ├── EngRange/
│       │   ├── MinimumValue   (Double) - LSL
│       │   └── MaximumValue   (Double) - USL
│       ├── Processing/
│       │   ├── Function       (UInt16) - 0=None, 1=Average, 2=MovingAverage
│       │   └── WindowSize     (UInt32) - Taille de la fenêtre de traitement
│       ├── ProcessingFilter/
│       │   ├── FilterType     (Int16) - Type de filtre
│       │   ├── Order          (Int16) - Ordre du filtre
│       │   ├── LowCut         (Double) - Fréquence de coupure basse
│       │   ├── HighCut        (Double) - Fréquence de coupure haute
│       │   └── BandType       (Int16) - Type de bande
│       └── SampleRate         (UInt32) - Fréquence d'échantillonnage en ms
├── P02/
│   └── ...
├── ...
└── P24/
```

## Fréquences de mise à jour

- **EngValue** : Mise à jour toutes les 100ms (configurable via `-e`)
- **SampleValue/SampleIndex** : Échantillon SPC toutes les 5s (configurable via `-f`)
- Seuls les `SampleValue` sont historisés, pas les `EngValue`

## Limites de contrôle vs Limites de tolérance

### Limites de Tolérance (USL/LSL)
- Définies par les spécifications de fabrication
- Représentent les limites absolues acceptables
- Configurées via `--usl-offset` et `--lsl-offset`
- Formule: `USL = target × (1 + usl_offset/100)`

### Limites de Contrôle (UCL/LCL)
- Calculées statistiquement (généralement ±3σ)
- Plus serrées que les limites de tolérance
- Utilisées pour détecter les dérives du processus
- Calculées automatiquement à 75% de la plage de tolérance

## Règles Western Electric / Nelson

Le simulateur permet de tester les règles classiques des cartes de contrôle :

1. **Règle 1** : Un point au-delà de 3σ
2. **Règle 2** : 9 points consécutifs du même côté de la ligne centrale
3. **Règle 3** : 6 points consécutifs en augmentation ou diminution continue
4. **Règle 4** : 14 points alternant haut/bas
5. **Règle 5** : 2 points sur 3 au-delà de 2σ (même côté)
6. **Règle 6** : 4 points sur 5 au-delà de 1σ (même côté)
7. **Règle 7** : 15 points consécutifs dans la zone ±1σ
8. **Règle 8** : 8 points consécutifs au-delà de ±1σ (des deux côtés)

## Exemple d'utilisation

```bash
# Simuler un processus avec dérive pour tester la détection
npm run dev -- --scenario trend_up --params 8

# Simuler un processus instable
npm run dev -- --scenario out_of_control --params 4

# Tester les règles de Nelson
npm run dev -- --scenario nelson_rules --params 1

# Utiliser une fréquence SPC plus rapide
npm run dev -- --spc-frequency 1000 --eng-frequency 50
```

## Dashboard Web

Le simulateur inclut un dashboard web temps réel accessible par défaut sur `http://localhost:3000`.

### Fonctionnalités du dashboard

- **Visualisation de l'état de la station** : Affiche l'état actuel (NotConfigured, Idle, AcquisitionStarted, etc.)
- **Contrôle de la machine d'état** : Boutons Configure, Start, Stop, Reset
- **Changement de scénario** : Sélection dynamique du scénario de simulation
- **Affichage des paramètres** : Cards pour chaque paramètre avec :
  - SampleValue (valeur SPC historisée, mise à jour toutes les 5s)
  - EngValue (valeur temps réel, mise à jour toutes les 100ms)
  - SampleIndex (compteur d'échantillons)
  - Nom technique et unité physique

### Désactiver le dashboard

```bash
npm start -- --dashboard-port 0
```

### Fréquences de mise à jour

- **EngValue** : Mise à jour haute fréquence (100ms par défaut) pour le suivi temps réel
- **SampleValue** : Mise à jour basse fréquence (5s par défaut) pour l'historisation SPC
- Les deux valeurs sont affichées distinctement sur le dashboard pour refléter leurs fréquences différentes

## Connexion client OPC UA

Endpoint: `opc.tcp://localhost:4840/UA/CCSimulator`

Exemple avec UAExpert ou autre client OPC UA :
1. Connecter à l'endpoint
2. Écrire `true` sur `Station/Command/Configure` pour configurer
3. Écrire `true` sur `Station/Command/Start` pour démarrer l'acquisition
4. Parcourir `Objects/P01` pour voir les paramètres
5. Souscrire à `SampleValue` ou `EngValue` pour les valeurs en temps réel
6. Utiliser HistoryRead pour les données historiques de `SampleValue`

## Structure du projet

```
src/
├── index.ts                     # Point d'entrée CLI
├── types/
│   └── index.ts                 # Définitions TypeScript
├── database/
│   └── sqlite-store.ts          # Gestion historique SQLite
├── simulation/
│   ├── scenarios.ts             # Scénarios de simulation
│   ├── parameter-simulator.ts   # Moteur de simulation
│   └── station-state-machine.ts # Machine d'état d'acquisition
├── opcua/
│   ├── server.ts                # Serveur OPC UA
│   └── address-space-builder.ts # Construction de l'espace d'adresses
├── dashboard/
│   └── dashboard-server.ts      # Serveur web dashboard temps réel
└── scripts/
    └── init-database.ts         # Initialisation des données
```

## Licence

MIT
