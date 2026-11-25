/**
 * osm-federation-client.js
 * Federated Client for OpenStreetMap, Overpass API & Nominatim Geocoding.
 * 
 * Features:
 * - Direct queries to Overpass API (infrastructure, telecom, water, amenities)
 * - Geocoding via Nominatim
 * - 100% Offline-First synthetic/local fallback generator for zero-latency offline GIS
 * - Mandatory compliance with OSMF ODbL Attribution: "© OpenStreetMap contributors (ODbL)"
 * - Frictionless GeoJSON standard output transformation
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(['./spatial-indexer.js'], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./spatial-indexer.js'));
    } else {
        root.OsmFederationClient = factory(root.SpatialIndexer);
    }
}(typeof self !== 'undefined' ? self : this, function (SpatialIndexer) {
    'use strict';

    const OVERPASS_ENDPOINTS = [
        'https://overpass-api.de/api/interpreter',
        'https://lz4.overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter'
    ];

    const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
    const ODBL_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

    // Predefined layer query filters for Overpass QL
    const LAYER_FILTERS = {
        telecom: 'node["communication:mobile_phone"](bbox);node["man_made"="mast"](bbox);node["man_made"="tower"]["tower:type"="communication"](bbox);',
        infrastructure: 'node["power"="substation"](bbox);node["power"="transformer"](bbox);way["power"="line"](bbox);node["railway"="station"](bbox);',
        water: 'way["natural"="water"](bbox);way["waterway"="river"](bbox);node["natural"="spring"](bbox);',
        amenities: 'node["amenity"="hospital"](bbox);node["amenity"="university"](bbox);node["amenity"="fire_station"](bbox);node["amenity"="police"](bbox);'
    };

    class OsmFederationClient {
        constructor(options = {}) {
            this.timeoutMs = options.timeoutMs || 4000;
            this.forceOfflineFallback = options.forceOfflineFallback || false;
            this.indexer = SpatialIndexer;
            this.router = options.router || (this.indexer ? new this.indexer.SpatialShardRouter() : null);
            this.lastActiveEndpointIndex = 0;
        }

        /**
         * Builds an Overpass QL query string for a bounding box and layer.
         * bbox: [minLat, minLon, maxLat, maxLon]
         */
        buildOverpassQuery(bbox, layer = 'telecom') {
            const bboxStr = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
            const filter = LAYER_FILTERS[layer] || LAYER_FILTERS.telecom;
            const queryBody = filter.replace(/\(bbox\)/g, `(${bboxStr})`);

            return `[out:json][timeout:5];(
                ${queryBody}
            );out body 50;>;out skel qt;`;
        }

        /**
         * Executes query against public Overpass mirrors with automatic fallback.
         */
        async queryFederatedOverpass(bbox, layer = 'telecom') {
            if (this.forceOfflineFallback) {
                return this.generateSyntheticOsmDataset(bbox, layer, 25);
            }

            const query = this.buildOverpassQuery(bbox, layer);
            const endpoint = OVERPASS_ENDPOINTS[this.lastActiveEndpointIndex];

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'User-Agent': 'Internet-GIS-Spatial-Federation-Lab/1.0 (ODbL Compliance)'
                    },
                    body: 'data=' + encodeURIComponent(query),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`Overpass HTTP ${response.status}`);
                }

                const json = await response.json();
                return this.convertOverpassToGeoJSON(json, layer, bbox);
            } catch (err) {
                console.warn(`[OSM Federation] Live mirror query failed (${err.message}). Falling back to local offline-first generator.`);
                this.lastActiveEndpointIndex = (this.lastActiveEndpointIndex + 1) % OVERPASS_ENDPOINTS.length;
                return this.generateSyntheticOsmDataset(bbox, layer, 30);
            }
        }

        /**
         * Transforms Overpass JSON nodes/elements into standardized GeoJSON FeatureCollection.
         */
        convertOverpassToGeoJSON(overpassJson, layerCategory, bbox) {
            const elements = (overpassJson && overpassJson.elements) || [];
            const features = [];

            for (const elem of elements) {
                if (!elem.lat || !elem.lon) continue;

                const lat = elem.lat;
                const lon = elem.lon;
                const tags = elem.tags || {};
                const name = tags.name || `${layerCategory.toUpperCase()} Node #${elem.id}`;

                let h3_7 = 'h3_7_default';
                let h3_9 = 'h3_9_default';
                let geohash = 'gh_default';
                let quadkey = '0';
                let shardId = 'shard-001';

                if (this.indexer) {
                    h3_7 = this.indexer.HexGrid.latLonToH3Index(lat, lon, 7);
                    h3_9 = this.indexer.HexGrid.latLonToH3Index(lat, lon, 9);
                    geohash = this.indexer.Geohash.encode(lat, lon, 7);
                    const tile = this.indexer.SlippyTile.latLonToTile(lat, lon, 14);
                    quadkey = this.indexer.SlippyTile.tileToQuadkey(tile.x, tile.y, tile.z);

                    if (this.router) {
                        shardId = this.router.route(h3_7).shardId;
                    }
                }

                features.push({
                    type: 'Feature',
                    id: `${elem.type}/${elem.id}`,
                    geometry: {
                        type: 'Point',
                        coordinates: [lon, lat]
                    },
                    properties: {
                        osm_id: elem.id,
                        osm_type: elem.type,
                        layer: layerCategory,
                        name: name,
                        h3_resolution_7: h3_7,
                        h3_resolution_9: h3_9,
                        geohash_7: geohash,
                        quadkey: quadkey,
                        shard_id: shardId,
                        tags: tags,
                        attribution: ODBL_ATTRIBUTION,
                        source: 'OpenStreetMap Overpass API (Live / Cache)'
                    }
                });
            }

            return {
                type: 'FeatureCollection',
                bbox: bbox,
                metadata: {
                    layer: layerCategory,
                    count: features.length,
                    attribution: ODBL_ATTRIBUTION,
                    license: 'Open Database License (ODbL) 1.0',
                    is_live: true,
                    timestamp: new Date().toISOString()
                },
                features: features
            };
        }

        /**
         * 100% Offline-First Synthetic Generator:
         * Generates deterministic, highly realistic OpenStreetMap nodes and infrastructure
         * for testing spatial sharding, H3 hex aggregations, and edge caching without network access.
         */
        generateSyntheticOsmDataset(bbox, layerCategory = 'telecom', count = 35) {
            const [minLat, minLon, maxLat, maxLon] = bbox;
            const features = [];

            const sampleNames = {
                telecom: ['5G Edge Tower Alpha', 'Base Station BTS-404', 'Microwave Repeater Peak', 'Optical Fiber Point-of-Presence (PoP)', 'Satellite Ground Station Gateway', 'Submarine Cable Landing Facility', 'Microcell Mast 102', 'Federated RAN Transceiver'],
                infrastructure: ['Regional Power Substation', 'HVDC Converter Facility', 'High-Speed Railway Hub', 'Distribution Transformer 45kVA', 'Metro Switching Depot', 'Photovoltaic Array Grid Tie', 'Wind Turbine Cluster Interconnect'],
                water: ['Municipal Reservoir Dam', 'Aqueduct Siphon Junction', 'Natural Freshwater Spring', 'River Flow Monitoring Station', 'Hydrological Telemetry Gauge', 'Canal Lock Basin #3'],
                amenities: ['Central Metropolitan Hospital', 'Polytechnic Engineering Campus', 'Emergency Civil Defense Dispatch', 'Federal Geospatial Archive', 'Metropolitan Fire HQ', 'Regional Public Library & Data Bank']
            };

            const pool = sampleNames[layerCategory] || sampleNames.telecom;

            for (let i = 0; i < count; i++) {
                // Deterministic pseudo-randomness based on loop and coordinate hash
                const seedLat = (Math.sin(i * 997.13 + minLat) + 1) / 2;
                const seedLon = (Math.cos(i * 389.77 + minLon) + 1) / 2;

                const lat = minLat + (maxLat - minLat) * (0.05 + 0.90 * seedLat);
                const lon = minLon + (maxLon - minLon) * (0.05 + 0.90 * seedLon);
                const osmId = 10000000 + Math.floor(seedLat * 89999999);
                const name = `${pool[i % pool.length]} #${100 + i}`;

                let h3_7 = '872830828ffffff';
                let h3_9 = '89283082803ffff';
                let geohash = 'd229d99';
                let quadkey = '0320112';
                let shardId = 'shard-001';

                if (this.indexer) {
                    h3_7 = this.indexer.HexGrid.latLonToH3Index(lat, lon, 7);
                    h3_9 = this.indexer.HexGrid.latLonToH3Index(lat, lon, 9);
                    geohash = this.indexer.Geohash.encode(lat, lon, 7);
                    const tile = this.indexer.SlippyTile.latLonToTile(lat, lon, 14);
                    quadkey = this.indexer.SlippyTile.tileToQuadkey(tile.x, tile.y, tile.z);

                    if (this.router) {
                        shardId = this.router.route(h3_7).shardId;
                    }
                }

                features.push({
                    type: 'Feature',
                    id: `node/${osmId}`,
                    geometry: {
                        type: 'Point',
                        coordinates: [parseFloat(lon.toFixed(6)), parseFloat(lat.toFixed(6))]
                    },
                    properties: {
                        osm_id: osmId,
                        osm_type: 'node',
                        layer: layerCategory,
                        name: name,
                        h3_resolution_7: h3_7,
                        h3_resolution_9: h3_9,
                        geohash_7: geohash,
                        quadkey: quadkey,
                        shard_id: shardId,
                        tags: {
                            'man_made': layerCategory === 'telecom' ? 'mast' : 'substation',
                            'operator': 'Open GIS Federation / Municipal Carrier',
                            'network': 'Internet GIS Backbone',
                            'source:date': '2026-10-22'
                        },
                        attribution: ODBL_ATTRIBUTION,
                        source: 'OpenStreetMap Synthetic Offline Simulator (ODbL)'
                    }
                });
            }

            return {
                type: 'FeatureCollection',
                bbox: bbox,
                metadata: {
                    layer: layerCategory,
                    count: features.length,
                    attribution: ODBL_ATTRIBUTION,
                    license: 'Open Database License (ODbL) 1.0',
                    is_live: false,
                    is_synthetic_offline: true,
                    timestamp: new Date().toISOString()
                },
                features: features
            };
        }

        /**
         * Nominatim search query for bounding box or coordinate jump
         */
        async geocode(queryText) {
            const url = `${NOMINATIM_ENDPOINT}?q=${encodeURIComponent(queryText)}&format=json&limit=5`;
            try {
                const res = await fetch(url, {
                    headers: { 'User-Agent': 'Internet-GIS-Spatial-Federation-Lab/1.0' }
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                return data.map(item => ({
                    display_name: item.display_name,
                    lat: parseFloat(item.lat),
                    lon: parseFloat(item.lon),
                    boundingbox: item.boundingbox.map(Number) // [minLat, maxLat, minLon, maxLon]
                }));
            } catch (err) {
                console.warn('[Nominatim] Geocoding lookup failed, returning preset cities.');
                // Preset fallbacks
                const presets = [
                    { display_name: 'Frankfurt am Main, Hesse, Germany (DE-CIX IXP Hub)', lat: 50.1109, lon: 8.6821, boundingbox: [50.05, 50.18, 8.55, 8.78] },
                    { display_name: 'Bogotá, D.C., Colombia (Andean Telecom Gateway)', lat: 4.7110, lon: -74.0721, boundingbox: [4.55, 4.85, -74.20, -73.95] },
                    { display_name: 'Tokyo, Japan (East Asia Edge Cluster)', lat: 35.6762, lon: 139.6503, boundingbox: [35.50, 35.80, 139.50, 139.85] },
                    { display_name: 'London, United Kingdom (LINX Internet Exchange)', lat: 51.5074, lon: -0.1278, boundingbox: [51.40, 51.60, -0.30, 0.05] }
                ];
                return presets.filter(p => p.display_name.toLowerCase().includes(queryText.toLowerCase())) || presets;
            }
        }
    }

    return OsmFederationClient;
}));
