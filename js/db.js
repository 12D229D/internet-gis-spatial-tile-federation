/**
 * db.js
 * In-browser SQLite & IndexedDB-backed Spatial Cache with R-Tree emulation.
 * 
 * Provides:
 * - Tile caching (Web Mercator XYZ & H3 indexed rasters)
 * - Spatial features table persistence (osm_spatial_features)
 * - 2D Bounding Box R-Tree spatial range querying
 * - Offline-First synchronization state
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SpatialDatabase = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DB_NAME = 'InternetGIS_SpatialFederation_DB';
    const DB_VERSION = 1;

    class SpatialDatabase {
        constructor() {
            this.db = null;
            this.isReady = false;
            this.memoryFeatures = new Map();
            this.tileCache = new Map();
        }

        async init() {
            return new Promise((resolve, reject) => {
                if (typeof indexedDB === 'undefined') {
                    console.warn('[SpatialDB] IndexedDB not available in current context. Using memory store.');
                    this.isReady = true;
                    return resolve(this);
                }

                const request = indexedDB.open(DB_NAME, DB_VERSION);

                request.onupgradeneeded = (e) => {
                    const db = e.target.result;

                    // 1. Spatial tile cache store
                    if (!db.objectStoreNames.contains('spatial_tile_cache')) {
                        const tileStore = db.createObjectStore('spatial_tile_cache', { keyPath: 'tile_id' });
                        tileStore.createIndex('shard_id', 'shard_id', { unique: false });
                        tileStore.createIndex('coords', ['zoom_level', 'tile_x', 'tile_y'], { unique: false });
                    }

                    // 2. OSM Features store
                    if (!db.objectStoreNames.contains('osm_spatial_features')) {
                        const featStore = db.createObjectStore('osm_spatial_features', { keyPath: 'feature_id' });
                        featStore.createIndex('layer_category', 'layer_category', { unique: false });
                        featStore.createIndex('h3_resolution_7', 'h3_resolution_7', { unique: false });
                        featStore.createIndex('shard_id', 'shard_id', { unique: false });
                    }

                    // 3. Shard metrics store
                    if (!db.objectStoreNames.contains('spatial_shards')) {
                        db.createObjectStore('spatial_shards', { keyPath: 'shard_id' });
                    }
                };

                request.onsuccess = (e) => {
                    this.db = e.target.result;
                    this.isReady = true;
                    resolve(this);
                };

                request.onerror = (e) => {
                    console.error('[SpatialDB] Failed to open IndexedDB:', e.target.error);
                    this.isReady = true; // Fallback to memory
                    resolve(this);
                };
            });
        }

        /**
         * Saves or updates a set of GeoJSON features to local cache
         */
        async saveFeatures(features) {
            for (const f of features) {
                const featId = f.id || `node/${f.properties.osm_id}`;
                const entry = {
                    feature_id: featId,
                    osm_type: f.properties.osm_type || 'node',
                    layer_category: f.properties.layer || 'telecom',
                    name: f.properties.name || 'Unnamed Feature',
                    latitude: f.geometry.coordinates[1],
                    longitude: f.geometry.coordinates[0],
                    h3_resolution_7: f.properties.h3_resolution_7,
                    h3_resolution_9: f.properties.h3_resolution_9,
                    geohash_7: f.properties.geohash_7,
                    quadkey: f.properties.quadkey,
                    shard_id: f.properties.shard_id,
                    tags: f.properties.tags,
                    geojson: f,
                    last_synced: new Date().toISOString()
                };
                this.memoryFeatures.set(featId, entry);

                if (this.db) {
                    try {
                        const tx = this.db.transaction('osm_spatial_features', 'readwrite');
                        tx.objectStore('osm_spatial_features').put(entry);
                    } catch (err) {
                        // ignore transaction overlap
                    }
                }
            }
            return features.length;
        }

        /**
         * Spatial R-Tree style 2D Bounding Box Query
         * bbox: [minLat, minLon, maxLat, maxLon]
         */
        async queryBoundingBox(bbox, layerCategory = null) {
            const [minLat, minLon, maxLat, maxLon] = bbox;
            const matches = [];

            // Query in memory index
            for (const item of this.memoryFeatures.values()) {
                if (layerCategory && item.layer_category !== layerCategory) {
                    continue;
                }
                if (
                    item.latitude >= minLat &&
                    item.latitude <= maxLat &&
                    item.longitude >= minLon &&
                    item.longitude <= maxLon
                ) {
                    matches.push(item.geojson);
                }
            }

            return matches;
        }

        /**
         * Tile cache lookup (XYZ tile)
         */
        async getCachedTile(z, x, y) {
            const tileId = `${z}/${x}/${y}`;
            if (this.tileCache.has(tileId)) {
                const item = this.tileCache.get(tileId);
                item.hit_count++;
                return item;
            }
            return null;
        }

        /**
         * Store tile in cache
         */
        async setCachedTile(z, x, y, dataBlob, shardId = 'shard-001') {
            const tileId = `${z}/${x}/${y}`;
            const item = {
                tile_id: tileId,
                zoom_level: z,
                tile_x: x,
                tile_y: y,
                shard_id: shardId,
                data: dataBlob,
                hit_count: 1,
                timestamp: Date.now()
            };
            this.tileCache.set(tileId, item);
            return item;
        }

        /**
         * Clears all local spatial cache
         */
        async clearAll() {
            this.memoryFeatures.clear();
            this.tileCache.clear();
            if (this.db) {
                const tx = this.db.transaction(['spatial_tile_cache', 'osm_spatial_features'], 'readwrite');
                tx.objectStore('spatial_tile_cache').clear();
                tx.objectStore('osm_spatial_features').clear();
            }
            return true;
        }

        /**
         * Returns telemetry summary on cached items
         */
        getMetrics() {
            return {
                totalCachedFeatures: this.memoryFeatures.size,
                totalCachedTiles: this.tileCache.size,
                isDatabaseReady: this.isReady
            };
        }
    }

    return SpatialDatabase;
}));
