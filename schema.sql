-- ==============================================================================
-- internet-gis-spatial-tile-federation: Relational Spatial Schema & R-Tree Cache
-- Compatible with SQLite 3.45+ / Cloudflare D1 / GeoPackage Standards
-- Conforms to OpenStreetMap ODbL & Frictionless Data Specifications
-- ==============================================================================

-- 1. Spatial Tile Cache Table (Edge / Local Offline-First Cache)
CREATE TABLE IF NOT EXISTS spatial_tile_cache (
    tile_id TEXT PRIMARY KEY,               -- Format: "z/x/y" or "h3/resolution/index"
    zoom_level INTEGER NOT NULL,            -- Zoom level (0-19)
    tile_x INTEGER NOT NULL,                -- X index in Web Mercator
    tile_y INTEGER NOT NULL,                -- Y index in Web Mercator
    h3_index TEXT,                          -- Equivalent H3 parent index if applicable
    geohash TEXT,                           -- Bounding box Geohash representation
    shard_id TEXT NOT NULL,                 -- Distributed partition identifier (e.g. "shard-eu-w1")
    format TEXT DEFAULT 'image/png',        -- 'image/png', 'mvt', or 'geojson'
    tile_data BLOB,                         -- Raw byte payload or base64 raster/vector tile
    etag TEXT,                              -- Cache invalidation header
    hit_count INTEGER DEFAULT 0,            -- Cache hit counter for eviction heuristics
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookup by coordinate coordinates and zoom
CREATE INDEX IF NOT EXISTS idx_tile_coords ON spatial_tile_cache (zoom_level, tile_x, tile_y);
CREATE INDEX IF NOT EXISTS idx_tile_shard ON spatial_tile_cache (shard_id);

-- 2. OpenStreetMap Spatial Features (Nodes, Ways & Relations)
CREATE TABLE IF NOT EXISTS osm_spatial_features (
    feature_id TEXT PRIMARY KEY,            -- e.g. "node/123456", "way/78910"
    osm_type TEXT NOT NULL,                 -- 'node', 'way', 'relation'
    layer_category TEXT NOT NULL,           -- 'telecom', 'infrastructure', 'water', 'amenity'
    name TEXT,                              -- Primary name attribute
    latitude REAL NOT NULL,                 -- WGS84 EPSG:4326
    longitude REAL NOT NULL,                -- WGS84 EPSG:4326
    h3_resolution_7 TEXT NOT NULL,          -- H3 Index at res 7 (~1.2km edge)
    h3_resolution_9 TEXT NOT NULL,          -- H3 Index at res 9 (~174m edge)
    geohash_7 TEXT NOT NULL,                -- 7-char geohash (~150m)
    quadkey TEXT NOT NULL,                  -- Bing/OSM Quadkey hierarchy
    shard_id TEXT NOT NULL,                 -- Partition hash shard
    tags_json TEXT,                         -- Full OSM tags dictionary serialized as JSON
    geojson_geometry TEXT NOT NULL,         -- GeoJSON geometry feature string
    odbl_attribution TEXT DEFAULT '© OpenStreetMap contributors (ODbL)',
    last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_osm_layer ON osm_spatial_features (layer_category);
CREATE INDEX IF NOT EXISTS idx_osm_h3_7 ON osm_spatial_features (h3_resolution_7);
CREATE INDEX IF NOT EXISTS idx_osm_shard ON osm_spatial_features (shard_id);

-- 3. R-Tree Virtual Index for Fast 2D Bounding Box Lookups (SQLite R*Tree Module)
-- minX (min_lon), maxX (max_lon), minY (min_lat), maxY (max_lat)
CREATE VIRTUAL TABLE IF NOT EXISTS spatial_index_rtree USING rtree(
    id,                                     -- Numerical row id referencing spatial_features_rtree_ref
    min_lon REAL,                           -- Min Longitude (Degrees)
    max_lon REAL,                           -- Max Longitude (Degrees)
    min_lat REAL,                           -- Min Latitude (Degrees)
    max_lat REAL                            -- Max Latitude (Degrees)
);

-- Reference bridge table between R-Tree integer id and OSM feature string ID
CREATE TABLE IF NOT EXISTS spatial_features_rtree_ref (
    rtree_id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id TEXT NOT NULL UNIQUE,
    layer_category TEXT NOT NULL,
    FOREIGN KEY(feature_id) REFERENCES osm_spatial_features(feature_id) ON DELETE CASCADE
);

-- 4. Spatial Federation Shards Registry
CREATE TABLE IF NOT EXISTS spatial_shards_registry (
    shard_id TEXT PRIMARY KEY,              -- Partition key (e.g. "shard-001")
    region_name TEXT NOT NULL,              -- Name of geographical cluster
    center_lat REAL NOT NULL,
    center_lon REAL NOT NULL,
    radius_km REAL NOT NULL,
    h3_base_cell INTEGER NOT NULL,          -- H3 resolution 0 base cell (0..121)
    status TEXT DEFAULT 'ONLINE',           -- ONLINE, DEGRADED, REBALANCING
    total_features INTEGER DEFAULT 0,
    latency_ms REAL DEFAULT 15.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Frictionless Data Package Metadata Log
CREATE TABLE IF NOT EXISTS frictionless_exports_log (
    export_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    profile TEXT DEFAULT 'tabular-data-package',
    record_count INTEGER NOT NULL,
    bounding_box TEXT NOT NULL,             -- "[minLon, minLat, maxLon, maxLat]"
    file_format TEXT NOT NULL,              -- 'datapackage.json', 'geojson', 'csv'
    license TEXT DEFAULT 'ODbL-1.0',
    exported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
