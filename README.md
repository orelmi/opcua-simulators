# OPC UA Simulators

Collection de simulateurs OPC UA pour tester différents scénarios industriels.

## Simulateurs disponibles

| Simulateur | Description | Statut |
|------------|-------------|--------|
| [opcua-spc-simulator](./opcua-spc-simulator/) | Simulateur SPC (Statistical Process Control) avec historisation et cartes de contrôle | Disponible |

## Structure du projet

```
opcua-simulators/
├── README.md                    # Ce fichier
├── opcua-spc-simulator/         # Simulateur SPC
│   ├── src/                     # Code source
│   ├── package.json
│   └── README.md                # Documentation spécifique
└── [autres-simulateurs]/        # À venir
```

## Utilisation

Chaque simulateur est autonome avec ses propres dépendances. Pour utiliser un simulateur :

```bash
# Naviguer vers le dossier du simulateur
cd opcua-spc-simulator

# Installer les dépendances
npm install

# Démarrer le simulateur
npm run dev
```

## Simulateur SPC

Le simulateur SPC permet de tester les cartes de contrôle statistique avec :

- **24 paramètres de soudage** (P01 à P24) avec unités réalistes
- **Machine d'état d'acquisition** conforme MSP
- **Historisation SQLite** des valeurs SPC
- **10 scénarios de simulation** (normal, trend, shift, cyclic, etc.)

Voir [opcua-spc-simulator/README.md](./opcua-spc-simulator/README.md) pour la documentation complète.

## Licence

MIT
