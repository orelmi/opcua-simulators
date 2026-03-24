# Implémentation du simulateur

Ce document décrit les choix d'implémentation spécifiques au simulateur OPC UA SPC. Pour le modèle de données OPC UA, voir [OPC-UA-DATAMODEL.md](OPC-UA-DATAMODEL.md).

## Paramètres de soudage simulés

Les 24 paramètres (P01-P24) simulent des mesures typiques d'un processus de soudage :

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

## Calcul des limites de contrôle

Les limites de contrôle (UCL/LCL) sont calculées automatiquement à **75% de la plage de tolérance** :

```
UCL = CL + 0.75 × (USL - CL)
LCL = CL - 0.75 × (CL - LSL)
```

La ligne centrale (CL) correspond à la valeur cible du paramètre.

## Scénarios de simulation

Les scénarios génèrent des patterns SPC pour tester les règles de contrôle (Western Electric, Nelson).

| Scénario | Description | Pattern SPC |
|----------|-------------|-------------|
| `normal` | Distribution normale autour de CL | Processus sous contrôle |
| `trend_up` | Dérive progressive vers le haut | Usure outil, dérive thermique |
| `trend_down` | Dérive progressive vers le bas | Idem, direction opposée |
| `shift` | Décalage brutal de la moyenne | Changement de lot, réglage |
| `oscillation` | Oscillation périodique | Vibration, cycle thermique |
| `instability` | Variance croissante | Dégradation processus |
| `stratification` | Points concentrés autour de CL | Sur-contrôle, mélange lots |
| `mixture` | Points aux extrêmes, peu au centre | Deux populations mélangées |
| `realistic` | Combinaison réaliste avec événements | Simulation production réelle |
| `spike` | Pics aléatoires hors limites | Points aberrants |

Chaque scénario est paramétrable via le dashboard web (vitesse de dérive, amplitude, fréquence, etc.).

## Valeurs simulées spécifiques

Certains nœuds ont un comportement simulé propre au simulateur :

| Nœud | Comportement simulé |
|------|---------------------|
| `Station.Name` | Nom auto-généré (ex: "station-A3F2B1") |
| `Station.SerialNumber` | Généré au format "SN-YYYYMMDD-XXXXXX" |
| `Station.Manufacturer` | Fixé à "OPC UA SPC Simulator" |
| `Station.Metrics.CycleTime` | Valeur aléatoire simulée |
| `Station.Metrics.Info1` | Valeur aléatoire simulée |
| `Station.Metrics.Info2` | Valeur statique |
| `Station.Context.DoubleInfo1` | Révolution 0-360° (simulé) |
| `Pxx.Config.SampleRate` | Configurable via `--sample-rate` (défaut: 1000 ms) |

## Persistance

L'état de la station et les données historiques sont persistés dans une base SQLite. Au redémarrage, le simulateur restaure :
- L'état de la machine d'état
- Les timestamps de démarrage/arrêt
- Les données historiques de `SampleValue`
