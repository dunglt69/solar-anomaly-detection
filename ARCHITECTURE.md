# EnergiaMind — System Architecture

> **Version:** 5.0 | **Last Updated:** 2026-06-18

---

## 1. System Overview

EnergiaMind is a decoupled, injection-agnostic solar monitoring platform. The architecture separates data ingestion from visualization — the application consumes telemetry via standard APIs regardless of whether the source is live sensors or a CSV replay tool.

> **Injection-Agnostic Architecture:** The server exposes a standard REST endpoint (`POST /api/v1/telemetry`) that accepts JSON telemetry batches. It does not care *how* the data was produced — CSV replay, physics-based simulator, or real Modbus RTU sensors all feed the same pipeline.

> **Modbus TCP Master & Slave Integration:** The system includes a real Modbus TCP client/server communication channel. The simulator (`tools/simulator-modbus.ts`) acts as a Modbus TCP Slave (running on port 5020), mapping simulation sensor data (from `simulation.csv`) directly to Modbus holding registers (address 0 to 5). The backend server (`server/src/services/modbus.service.ts`) runs a Modbus TCP Master that connects to the simulator, polling the registers at a configurable interval (default: 5000ms), and feeding the data into the ingestion and AI pipelines. It features robust auto-reconnection logic to handle connection drops or simulator restarts.

> **AI Model:** The production fault classifier is **InceptionTime** (depth=6, filters=32, kernels=5/11/23), served via ONNX Runtime. Earlier LSTM attempts failed (11.66% accuracy). The service file is `ai.service.ts` (renamed from `lstm.service.ts` during the D11 audit).

```
┌─────────────────────────────────────────────────────────────────┐
│                     BROWSER (Vite + React 19)                   │
│  ┌───────────┐ ┌──────────────┐ ┌─────────┐ ┌────────────────┐  │
│  │ Dashboard │ │Alerts/Tickets│ │  Admin  │ │   Analytics    │  │
│  │ (ECharts) │ │  (Unified)   │ │ (Users) │ │ (Charts/Stats) │  │
│  └─────┬─────┘ └──────┬───────┘ └────┬────┘ └───────┬────────┘  │
│        └──────────────┴──────────────┴──────────────┘           │
│                           Zustand Store                          │
│                     WebSocket ↕ REST (fetch)                     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────────────┐
│                    FASTIFY 5 SERVER                              │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐     │
│  │  REST API   │  │  WebSocket   │  │   Auth Middleware    │     │
│  │ /api/v1/*   │  │  /ws/*       │  │  JWT + RBAC          │     │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬──────────┘     │
│         │                │                     │                 │
│  ┌──────┴────────────────┴─────────────────────┴──────────┐     │
│  │               Business Logic Services                   │     │
│  │  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐ │     │
│  │  │  Telemetry   │  │   Anomaly     │  │   Ticket     │ │     │
│  │  │  Service     │  │   Detector    │  │   Service    │ │     │
│  │  └──────┬───────┘  └───────┬───────┘  └──────┬───────┘ │     │
│  │         │      InceptionTime(ONNX)            │         │     │
│  └─────────┼──────────────────┼──────────────────┼─────────┘     │
│            │                  │                   │               │
│  ┌─────────┴──────────────────┴───────────────────┴───────┐     │
│  │              SQLite (via Drizzle ORM)                    │     │
│  │  telemetry | users | tickets | alerts | logs | config   │     │
│  └─────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow

### 2.1 Telemetry Ingestion Pipeline

```
Sensor/Injector → POST /api/v1/telemetry (batch JSON)
                         │
                    ┌────▼─────┐
                    │ Validate  │ JSON Schema (Fastify)
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ Compute   │ Derived metrics (P, ratios)
                    │ Features  │ 13-feature vector
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │  Store    │ INSERT INTO telemetry (SQLite)
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │   AI     │ InceptionTime ONNX Inference
                    │Detection │ (Service: ai.service.ts)
                    └────┬─────┘
                         │
                         ▼
                    ┌────────────┐
                    │ Alert      │ If anomaly detected
                    │ Dispatcher │
                    └─────┬──────┘
                ┌─────────┼─────────┐
                ▼         ▼         ▼
           Store in   WebSocket  Auto-create
           alert_log  broadcast  ticket (INC-)
```

### 2.2 Real-Time Update Flow

```
Server: New telemetry stored → WebSocket broadcast to all clients
Client: WebSocket message → Zustand store update → ECharts re-render
         (no polling — pure push architecture)
```

---

## 3. Database Schema (Logical)

### Core Tables

| Table | Key Columns | Purpose |
|---|---|---|
| **users** | id, employeeId, username, email, personalEmail, dob, displayName, passwordHash, role, failedAttempts, lockedUntil, createdAt, updatedAt | Auth + RBAC |
| **sessions** | id, userId, refreshToken, tokenFamily, ip, userAgent, revoked, expiresAt, createdAt | Token management |
| **telemetry** | id, timestamp, vdc1, vdc2, idc1, idc2, irr, pvt, pdc1, pdc2, pdcTotal, faultLabel | Dual-string time-series data |
| **alerts** | id, timestamp, severity, faultType, confidence, detectionLayer, telemetryId, acknowledged, acknowledgedBy, acknowledgedAt, ticketId | Anomaly alerts |
| **tickets** | id, status, severity, faultType, affectedComponent, title, description, assigneeId, createdBy, alertId, wasEscalated, createdAt, updatedAt, resolvedAt, resolutionSummary | Incident tracking |
| **ticket_comments** | id, ticketId, authorId, content, createdAt | Discussion thread |
| **activity_log** | id, timestamp, actorId, actorRole, action, target, details, ip, userAgent | Audit trail |
| **config** | key, value, updatedBy, updatedAt | System settings |
| **registered_devices**| id, userId, deviceToken, hwSignature, browser, os, registeredAt, lastSeenAt, isActive | Employee device binding registry |

### Indexes

- `telemetry(timestamp)` — Range queries
- `alerts(timestamp, severity)` — Alert history
- `tickets(status, assignee_id)` — Incident ticket queries
- `activity_log(timestamp, actor_id)` — Audit search

---

## 4. Component Hierarchy (Frontend)

```
App
├── AuthProvider (JWT context)
├── ThemeProvider (dark/light)
├── Router
│   ├── /login → LoginPage
│   ├── / → DashboardLayout
│   │   ├── Sidebar (nav + user menu)
│   │   ├── Header (breadcrumb + time range + alerts badge)
│   │   └── Content
│   │       ├── /dashboard → DashboardPage
│   │       │   ├── KPICardGrid (Instant Power, Daily Yield, Faults)
│   │       │   ├── PowerChart (bar & line)
│   │       │   ├── VoltageCurrentChart (bar, dual-axis)
│   │       │   └── TemperatureChart (bar, dual-axis)
│   │       ├── /alerts → AlertsPage (Unified Alert-Ticket Flow)
│   │       │   ├── AlertHistoryTable (filterable)
│   │       │   └── AlertDetailModal (with linked incident tickets & comments)
│   │       ├── /analytics → AnalyticsPage
│   │       │   ├── IVCurveChart
│   │       │   ├── EnergyHeatmap
│   │       │   └── EfficiencyTrend
│   │       ├── /admin → AdminPage (Admin only)
│   │       │   ├── UserManagement
│   │       │   ├── HardwareManager (Panels, Strings, Location config)
│   │       │   ├── ActivityLogViewer
│   │       │   └── SystemSettings
│   │       └── /settings → ProfileSettings
└── WebSocketProvider (global connection)
```

---

## 5. API Surface

### REST Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/auth/login` | Public | Returns access + refresh tokens |
| POST | `/api/v1/auth/register` | Admin | Create new user |
| POST | `/api/v1/auth/refresh` | Refresh | Rotate tokens |
| POST | `/api/v1/auth/logout` | Auth | Invalidate session |
| POST | `/api/v1/telemetry` | API Key | Batch ingest telemetry |
| GET | `/api/v1/telemetry` | Auth | Query with time range + aggregation |
| GET | `/api/v1/telemetry/latest` | Auth | Latest readings |
| GET | `/api/v1/alerts` | Auth | List alerts (paginated, filterable) |
| PATCH | `/api/v1/alerts/:id` | Auth | Acknowledge alert |
| GET | `/api/v1/tickets` | Auth | List tickets |
| POST | `/api/v1/tickets` | Auth | Create ticket |
| PATCH | `/api/v1/tickets/:id` | Auth | Update status/assignee |
| POST | `/api/v1/tickets/:id/comments` | Auth | Add comment |
| GET | `/api/v1/users` | Admin | List users |
| POST | `/api/v1/users` | Admin | Create user |
| PATCH | `/api/v1/users/:id` | Admin | Update user |
| GET | `/api/v1/activity-log` | Admin | Audit log |
| GET | `/api/v1/config` | Admin | System settings |
| PATCH | `/api/v1/config` | Admin | Update settings |
| POST | `/api/v1/admin/users/:id/unlock` | Admin | Unlock a locked user account |
| POST | `/api/v1/admin/device-bindings/:userId/reset` | Admin | Reset device binding for an employee |

### WebSocket

| Path | Direction | Payload |
|---|---|---|
| `/ws/telemetry` | Server → Client | Real-time telemetry + derived metrics |
| `/ws/alerts` | Server → Client | New alert notifications |

---

## 6. Security Architecture

| Concern | Implementation |
|---|---|
| **Password hashing** | argon2id (OWASP recommended) |
| **Password complexity** | Min 8 chars, uppercase, lowercase, digit, special character required (registration + password change) |
| **Input length limits** | Username max 50 chars, password max 128 chars |
| **Access tokens** | JWT (HS256), 15-min TTL |
| **Refresh tokens** | Opaque, HttpOnly cookie, 7-day TTL |
| **Token rotation (RTR)** | Opaque token rotated on each refresh; old token marked `revoked: true` |
| **Reuse detection** | Token family tracking; reuse of revoked token triggers deletion of entire family |
| **Refresh token ownership** | `logout()` validates refreshToken belongs to requesting userId before invalidation |
| **JWT_SECRET validation** | Startup warning if `JWT_SECRET` env var is missing or < 32 characters |
| **Session cleanup** | `cleanupExpiredSessions()` function purges expired sessions from the database |
| **Single Active Session** | SIP constraint: deletes all existing sessions for a user upon successful login |
| **Brute force** | Lockout after 5 failed attempts (30-min). Dummy Argon2id verification for timing attack prevention |
| **RBAC** | Admin (full) / Solar Operator (operations) / Security Engineer (logs) via middleware |
| **SQL injection prevention** | All raw SQL queries use parameterized `sql` tagged template literals (7 injection points fixed in D11 audit) |
| **Device Binding Policy** | 1:1 hardware device binding model. Registers device on first login; mismatch blocks login |
| **Device fingerprint** | SHA-256 hash (upgraded from DJB2 32-bit in D11 audit) |
| **Account Lockout & Unlock** | 5 failed attempts lockout (30-min). Admin can manually unlock account via Admin panel |
| **DDoS & Overload** | `@fastify/rate-limit` (300 req/min) + `@fastify/under-pressure` (1GB heap limit) |
| **HTTP Security Headers**| Helmet integration with hardened production Content-Security-Policy (removed `'unsafe-inline'` from scriptSrc to eliminate XSS vectors) |
| **Health endpoint** | Returns only `{ status: "ok" }` — no uptime, version, or environment info leaked |
| **Audit logging** | All auth, administration, device registrations, resets, and rejects actions logged with actor details, IP, user-agent, and hardware signature |
| **Input validation** | JSON Schema at Fastify boundary |
| **API key** | Separate key for telemetry ingestion (no user auth) |
| **No sensitive logging** | Seed script and auth flows never log passwords or secrets |

---

## 7. Deployment Topology

```
Development (Local):
  ┌─────────────────────────────────┐
  │  Node.js Process                │
  │  ├── Fastify (REST + WS)       │
  │  ├── InceptionTime (ONNX)      │
  │  └── SQLite (file: ./data.db)  │
  └─────────────────────────────────┘
           ↑
  ┌────────┴────────┐
  │ Vite Dev Server  │ (port 5173)
  │ (React + HMR)    │
  └──────────────────┘

Production (Future):
  ┌───────────────────┐
  │ Nginx / Caddy     │ ← Reverse proxy + TLS
  │  ├── /api → :3000 │
  │  ├── /ws  → :3000 │
  │  └── /*   → /dist │ ← Static React build
  └───────────────────┘
```

---

## 8. Verification & Performance Benchmarks

### 8.1 Automated Test Suite
The platform includes **138 test cases** running via Vitest, covering:
- **Authentication**: Lockout cycles, Timing attack defenses, Single session constraints, and Refresh Token Rotation (RTR).
- **Employee Device Binding**: First-login auto-registration, validation of hardware signature components, minor hardware drift auto-updates, and admin-triggered device resets.
- **Access Control**: Role-based access validation, account lockout, and admin-triggered unlock actions.
- **Ingestion & AI Pipeline**: Telemetry parsing, feature scaling, InceptionTime ONNX inference, and auto-ticketing logic (ai.service.ts).
- **Incident Tickets**: State machine transitions (open → resolved/escalated → closed), assignment rules, and thread comments.

### 8.2 Load Test Benchmarks (4,000+ RPS)
Load testing using virtual users (VUs) executed under Node 20 / Windows 11 environment yields the following performance profiles:

#### Phase 1: High-Concurrency Health Check (150 VUs, 750 requests)
- **Throughput**: **4,006.6 req/sec**
- **Success Rate**: 299 requests (200 OK) / 451 rate-limited (429 Too Many Requests)
- **Latency Percentiles**:
  - `p50`: **22.8ms**
  - `p90`: **70.8ms**
  - `p99`: **87.2ms**

#### Phase 2: Authentication Flooding / DDoS Mitigation (30 VUs, 150 requests)
- **Throughput**: **2,644.0 req/sec**
- **Response Distribution**: 0 successful logins / 145 rate-limited (429 Too Many Requests) / 5 validation failures
- **Behavior**: Fastify rate limiter successfully intercepted 96.6% of flood requests prior to resource-heavy hashing computations (Argon2id).
