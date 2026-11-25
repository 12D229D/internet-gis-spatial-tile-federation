# Distributed Internet GIS, H3/S2 Spatial Sharding & OSM Tile Federation

[![Version](https://img.shields.io/badge/version-v1.0.0-blue.svg)](./plan.md)
[![License: ODbL 1.0](https://img.shields.io/badge/License-ODbL_1.0-green.svg)](https://opendatacommons.org/licenses/odbl/1-0/)
[![Specification: OKFN Frictionless](https://img.shields.io/badge/Frictionless-Data_Package-orange.svg)](https://frictionlessdata.io/)
[![Standard: DGGS H3](https://img.shields.io/badge/DGGS-Uber_H3_Hexagonal-purple.svg)](https://h3geo.org/)

Distributed spatial sharding and Internet GIS federation laboratory built on open standards from the **OpenStreetMap Foundation (OSMF)** and the **Open Knowledge Foundation (OKFN)**.

---

## 🌐 1. Overview & Core Architecture

The **Internet GIS Spatial Tile Federation** system demonstrates how modern distributed Geographic Information Systems (GIS) partition spatial telemetries, tile queries, and vector features without central database bottlenecks (*shared-nothing spatial sharding*).

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                           Client Viewport                                │
│        Canvas 2D / Slippy Tile Renderer / EPSG:3857 & WGS84              │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                   Spatial Indexer & Shard Router                         │
│   - DGGS Uber H3 (Axial Coordinates & Polygon Vertices)                  │
│   - Geohash (Base32 & Neighbor Bounds)                                   │
│   - Quadtree Tile Quadkey (Level 0..18)                                  │
│   - Consistent Hashing Shard Partitions (Jenkins32)                      │
└──────────────────┬──────────────────────────────────────┬────────────────┘
                   │                                      │
                   ▼                                      ▼
┌──────────────────────────────────────┐┌──────────────────────────────────┐
│     Local SQLite / IndexedDB Cache   ││   Federated Overpass & OSM API   │
│   - R-Tree 2D Bounding Box Index     ││   - Infrastructure & Telecom     │
│   - Tile Cache & Hit/Miss Telemetry  ││   - Hydrography & Amenities      │
│   - Offline-First Failover Engine    ││   - Mandatory ODbL Attribution   │
└──────────────────┬───────────────────┘└─────────────────┬────────────────┘
                   │                                      │
                   └──────────────────┬───────────────────┘
                                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       Heavy Geo Web Worker                               │
│   - Point-in-Polygon (Ray Casting)                                       │
│   - Haversine Geodesic Distance Matrix                                   │
│   - Hexagonal Cell Density Aggregation & k-NN                            │
└─────────────────────────────────────┬────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    Frictionless Open Data Exporter                       │
│   - datapackage.json (Tabular Data Package Standard)                     │
│   - Standard GeoJSON FeatureCollection                                   │
│   - Relational SQLite SQL Dump & CSV                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## ⚖️ 2. Open Data Licensing & Attribution Compliance

This software complies strictly with the requirements of the **OpenStreetMap Foundation (OSMF)** and the **Open Database License (ODbL 1.0)**:

- **Attribution Notice**: Any map rendered, exported, or federated through this system carries the attribution notice:  
  `Map data © OpenStreetMap contributors (ODbL)`
- **Open Knowledge Foundation (OKFN)**: Dataset packaging adheres to the **Frictionless Data Specifications** (`datapackage.json`), ensuring open reusability, semantic data schema definitions, and cryptographic checksum validation.

---

## 🚀 3. Key Components

| File | Purpose |
| :--- | :--- |
| [`index.html`](./index.html) | Semantic cartographic application view, dark mode glassmorphism HUD, resolution controls and export dialog. |
| [`css/style.css`](./css/style.css) | Custom HSL color tokens conforming to `DESIGN.md`, backdrop blur effects, responsive controls. |
| [`js/spatial-indexer.js`](./js/spatial-indexer.js) | Geodetic calculations, Slippy Map Web Mercator math, Quadtree, Geohash, and Uber H3 hexagonal DGGS indexing. |
| [`js/osm-federation-client.js`](./js/osm-federation-client.js) | Live Overpass API federator with automatic mirror switching and 100% Offline-First synthetic fallback. |
| [`js/geo-worker.js`](./js/geo-worker.js) | Web Worker for background Haversine distance, ray casting Point-in-Polygon, and hex binning. |
| [`js/frictionless-export.js`](./js/frictionless-export.js) | Frictionless Data Package generator, CSV, GeoJSON, and SQLite SQL dump exporter. |
| [`js/db.js`](./js/db.js) | Offline spatial cache with Bounding Box R-Tree query emulation and IndexedDB persistence. |
| [`schema.sql`](./schema.sql) | Relational SQLite / Cloudflare D1 spatial schema with virtual R-Tree tables and shard registries. |
| [`js/app.js`](./js/app.js) | Main controller, 60 FPS Canvas 2D map engine, pan/zoom, interactive hex picking, and telemetry update loop. |

---

## 🛠️ 4. Quick Start & Execution

Since the project is built as a pure client-side SPA with standard Web APIs and Web Workers, it requires no compilation:

1. Open `index.html` in any modern web browser or serve via static HTTP server:
   ```powershell
   # Example with python or npx serve
   npx serve .
   ```
2. **Pan and Zoom**: Drag the map or use the wheel / UI buttons.
3. **Switch DGGS Partitioning**: Select between **Uber H3 Hex**, **Quadtree**, or **Geohash**.
4. **Adjust H3 Resolution**: Move the slider between Resolution 6 and 9 to observe hexagonal binning.
5. **Inspect Nodes and Shards**: Click on any node or hexagon cell to inspect which distributed shard handles that geospatial region.
6. **Export**: Click **Export Datasets** to download `datapackage.json`, GeoJSON, or SQLite dumps.
