# Architecture du Projet

## Vue d'ensemble

Le simulateur OPC UA SPC est construit autour d'une architecture modulaire composée de plusieurs couches :

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI (index.ts)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  OPC UA      │  │  Dashboard   │  │  State Persistence    │ │
│  │  Server      │  │  Web Server  │  │  (SQLite)             │ │
│  │              │◄─┼──────────────┼──►                       │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────────────────┘ │
│         │                 │                                     │
│         ▼                 ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Parameter Simulator                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │  │ Scenarios   │  │ Event       │  │ State       │       │  │
│  │  │ Generator   │  │ Injection   │  │ Machine     │       │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Structure des fichiers

```
src/
├── index.ts                     # Point d'entrée CLI
├── types/
│   └── index.ts                 # Définitions TypeScript
├── database/
│   └── sqlite-store.ts          # Gestion historique SQLite + persistance
├── simulation/
│   ├── scenarios.ts             # 10 scénarios de simulation SPC
│   ├── parameter-simulator.ts   # Moteur de simulation + injection d'événements
│   └── station-state-machine.ts # Machine d'état d'acquisition
├── opcua/
│   ├── server.ts                # Serveur OPC UA principal
│   └── address-space-builder.ts # Construction de l'espace d'adresses
├── dashboard/
│   └── dashboard-server.ts      # Serveur web dashboard + WebSocket
└── scripts/
    └── init-database.ts         # Script d'initialisation des données

docs/
├── ARCHITECTURE.md              # Ce fichier
└── OPC-UA-DATAMODEL.md         # Structure des nœuds OPC UA

public/
└── overview.png                 # Screenshot du dashboard
```

## Composants principaux

### 1. Serveur OPC UA (`src/opcua/server.ts`)

Le serveur OPC UA est le cœur du simulateur. Il gère :
- L'initialisation et le démarrage du serveur node-opcua
- La coordination entre le simulateur, le dashboard et la persistance
- La déconnexion des clients (simulation de perte de communication)
- Les statistiques de connexion

```typescript
class CCSimulatorServer {
  // Gestion du cycle de vie
  start(): Promise<void>
  stop(): Promise<void>

  // Scénarios
  setScenario(name: string): void

  // Gestion des clients OPC UA
  disconnectAllClients(): number
  getConnectedClientCount(): number
  getConnectedClientsInfo(): ClientInfo
}
```

### 2. Simulateur de paramètres (`src/simulation/parameter-simulator.ts`)

Le simulateur génère les valeurs pour les 24 paramètres de soudage :

- **EngValue** : Valeur temps réel (100ms par défaut), sans événements injectés
- **SampleValue** : Valeur SPC (5s par défaut), avec événements injectés

```typescript
class ParameterSimulator {
  // Gestion des paramètres
  addParameter(config: ParameterConfig): void
  getAllStates(): Map<number, ParameterState>

  // Scénarios
  setScenario(name: string): void
  setScenarioParams(params: ScenarioParams): void

  // Injection d'événements SPC
  injectEvent(type: string, duration: number, params?: object): void
  clearInjectedEvents(): void

  // Persistance
  restoreParameterStates(states: PersistedState[]): void
  getParameterStatesForPersistence(): PersistedState[]
}
```

### 3. Machine d'état (`src/simulation/station-state-machine.ts`)

Implémente le workflow d'acquisition conforme au XML NodeSet :

```
NotConfigured ──Configure──► Configuring ──auto──► Idle
                                  │                  │
                                  ▼                  │
                         ConfigurationError         │
                                  │                  │
                         Configure─┘                │
                                                    │
                                                    ▼
                                              AcquisitionStarted
                                                    │
                                                 Stop
                                                    │
                                                    ▼
                                            AcquisitionStopped
                                                    │
                                                 Reset
                                                    │
                                                    ▼
                                                  Idle
```

### 4. Dashboard Web (`src/dashboard/dashboard-server.ts`)

Interface web temps réel utilisant :
- **Express** pour les API REST
- **WebSocket** pour les mises à jour temps réel
- **Chart.js** pour les graphiques

APIs disponibles :
| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/state` | État complet du simulateur |
| GET | `/api/scenarios` | Liste des scénarios |
| POST | `/api/scenario` | Changer de scénario |
| POST | `/api/scenario-params` | Modifier paramètres scénario |
| POST | `/api/frequency` | Changer fréquences |
| POST | `/api/inject-event` | Injecter événement SPC |
| POST | `/api/clear-events` | Effacer événements |
| POST | `/api/command/:cmd` | Commande machine d'état |
| GET | `/api/opcua-clients` | Info clients OPC UA |
| POST | `/api/disconnect-clients` | Déconnecter clients |

### 5. Persistance SQLite (`src/database/sqlite-store.ts`)

Gère deux types de données :

**Données historiques** (table `historical_data`) :
- Historisation des SampleValue pour HistoryRead OPC UA
- Index par paramètre et timestamp

**État du simulateur** (tables `simulator_state` et `parameter_state`) :
- État de la machine d'acquisition
- Scénario actif
- Index et valeurs des échantillons par paramètre

## Flux de données

### Mise à jour des valeurs

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Scenario   │────►│   Simulator     │────►│  OPC UA      │
│  Generator  │     │  (tick 100ms)   │     │  Variables   │
└─────────────┘     └────────┬────────┘     └──────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Dashboard  │     │   SQLite        │     │  WebSocket   │
│  State      │     │   History       │     │  Broadcast   │
└─────────────┘     └─────────────────┘     └──────────────┘
```

### Injection d'événements

```
Dashboard              Simulator              OPC UA
    │                     │                     │
    │  POST /inject-event │                     │
    │────────────────────►│                     │
    │                     │  Queue event        │
    │                     │  (duration = N)     │
    │                     │                     │
    │                     │  Next SPC sample    │
    │                     │  Apply event        │
    │                     │────────────────────►│ SampleValue
    │                     │  duration--         │
    │                     │                     │
    │                     │  (repeat until N=0) │
```

## Sécurité

- **OPC UA** : Support SecurityPolicy.None et Basic256Sha256
- **Authentification** : Connexions anonymes autorisées par défaut
- **Dashboard** : Pas d'authentification (prévu pour utilisation locale)

## Performance

- **Tick interne** : 100ms (configurable via `--sample-rate`)
- **EngValue** : Mise à jour tous les 100ms
- **SampleValue** : Mise à jour toutes les 5s (configurable)
- **WebSocket** : Broadcast tous les 500ms
- **SQLite** : Mode WAL pour accès concurrent
