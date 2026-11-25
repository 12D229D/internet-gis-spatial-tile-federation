/**
 * frictionless-export.js
 * Open Data Package and Geospatial Exporter (OKFN Frictionless Data Specifications).
 * 
 * Supports:
 * - Frictionless Data Package (`datapackage.json`) compliant with OKFN specs
 * - Standard GeoJSON FeatureCollection with ODbL attribution
 * - Normalized CSV for tabular analysis
 * - SQLite SQL DUMP schema script with inserted data rows
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.FrictionlessExport = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const ODBL_LICENSE = {
        name: 'ODbL-1.0',
        title: 'Open Data Commons Open Database License (ODbL)',
        path: 'https://opendatacommons.org/licenses/odbl/1-0/'
    };

    class FrictionlessExporter {
        /**
         * Builds an OKFN Frictionless Data Package descriptor (datapackage.json).
         */
        static generateDataPackage(features, metadata = {}) {
            const count = features.length;
            const bbox = metadata.bbox || [-180, -90, 180, 90];
            const pkgName = (metadata.title || 'osm-federated-spatial-dataset')
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, '-');

            return {
                profile: 'tabular-data-package',
                name: pkgName,
                id: `urn:uuid:${FrictionlessExporter.generateUUID()}`,
                title: metadata.title || 'Distributed Internet GIS Federated Spatial Extract',
                description: 'Geospatial node and infrastructure federation partitioned across H3 hexagonal cells and spatial shards.',
                version: '1.0.0',
                homepage: 'https://www.openstreetmap.org',
                created: new Date().toISOString(),
                licenses: [ODBL_LICENSE],
                sources: [
                    {
                        title: 'OpenStreetMap Foundation (OSMF)',
                        path: 'https://www.openstreetmap.org',
                        attribution: '© OpenStreetMap contributors (ODbL)'
                    }
                ],
                spatial: {
                    type: 'Polygon',
                    coordinates: [[
                        [bbox[1], bbox[0]],
                        [bbox[3], bbox[0]],
                        [bbox[3], bbox[2]],
                        [bbox[1], bbox[2]],
                        [bbox[1], bbox[0]]
                    ]]
                },
                resources: [
                    {
                        profile: 'geojson',
                        name: 'spatial-nodes-geojson',
                        path: 'data/spatial-nodes.geojson',
                        title: 'GeoJSON Point Features with H3 & Shard Partition Keys',
                        format: 'geojson',
                        mediatype: 'application/geo+json',
                        encoding: 'utf-8',
                        schema: {
                            fields: [
                                { name: 'osm_id', type: 'integer', description: 'OSM Unique Node Identifier' },
                                { name: 'name', type: 'string', description: 'Entity Name or Label' },
                                { name: 'layer', type: 'string', description: 'Federated Layer Category' },
                                { name: 'h3_res_7', type: 'string', description: 'Uber H3 Hexagonal Cell Index (Resolution 7)' },
                                { name: 'h3_res_9', type: 'string', description: 'Uber H3 Hexagonal Cell Index (Resolution 9)' },
                                { name: 'geohash', type: 'string', description: 'Geohash Coordinate Partition' },
                                { name: 'quadkey', type: 'string', description: 'Quadtree Tile Quadkey' },
                                { name: 'shard_id', type: 'string', description: 'Distributed Federation Partition Shard' }
                            ]
                        }
                    },
                    {
                        profile: 'tabular-data-resource',
                        name: 'spatial-nodes-csv',
                        path: 'data/spatial-nodes.csv',
                        title: 'Tabular OpenStreetMap Nodes Extract',
                        format: 'csv',
                        mediatype: 'text/csv',
                        encoding: 'utf-8',
                        schema: {
                            primaryKey: 'osm_id',
                            fields: [
                                { name: 'osm_id', type: 'integer' },
                                { name: 'name', type: 'string' },
                                { name: 'layer', type: 'string' },
                                { name: 'latitude', type: 'number' },
                                { name: 'longitude', type: 'number' },
                                { name: 'h3_resolution_7', type: 'string' },
                                { name: 'h3_resolution_9', type: 'string' },
                                { name: 'geohash_7', type: 'string' },
                                { name: 'shard_id', type: 'string' },
                                { name: 'attribution', type: 'string' }
                            ]
                        }
                    }
                ],
                custom_metrics: {
                    total_records: count,
                    federation_status: 'HEALTHY',
                    sharding_algorithm: 'Consistent-Hash-H3-Jenkins32'
                }
            };
        }

        /**
         * Converts GeoJSON features to CSV string.
         */
        static exportToCSV(features) {
            const headers = [
                'osm_id',
                'name',
                'layer',
                'latitude',
                'longitude',
                'h3_resolution_7',
                'h3_resolution_9',
                'geohash_7',
                'shard_id',
                'attribution'
            ];

            const rows = [headers.join(',')];

            for (const f of features) {
                const p = f.properties || {};
                const coords = f.geometry && f.geometry.coordinates ? f.geometry.coordinates : [0, 0];
                const cleanName = (p.name || '').replace(/"/g, '""');

                const row = [
                    p.osm_id || '',
                    `"${cleanName}"`,
                    `"${p.layer || ''}"`,
                    coords[1],
                    coords[0],
                    p.h3_resolution_7 || '',
                    p.h3_resolution_9 || '',
                    p.geohash_7 || '',
                    p.shard_id || '',
                    `"${p.attribution || '© OpenStreetMap contributors (ODbL)'}"`
                ];
                rows.push(row.join(','));
            }

            return rows.join('\r\n');
        }

        /**
         * Exports valid GeoJSON FeatureCollection string.
         */
        static exportToGeoJSON(features, metadata = {}) {
            const fc = {
                type: 'FeatureCollection',
                bbox: metadata.bbox || [-180, -90, 180, 90],
                metadata: {
                    title: metadata.title || 'Distributed Internet GIS Spatial Extract',
                    generated_at: new Date().toISOString(),
                    attribution: '© OpenStreetMap contributors (ODbL)',
                    license: 'ODbL-1.0',
                    total_features: features.length
                },
                features: features
            };
            return JSON.stringify(fc, null, 2);
        }

        /**
         * Generates SQLite INSERT SQL statements for local database seeding.
         */
        static exportToSQLiteScript(features) {
            const lines = [
                '-- SQLite Ingestion Script for OpenStreetMap Federated Features',
                '-- Conforms to Open Database License (ODbL)',
                'BEGIN TRANSACTION;'
            ];

            for (const f of features) {
                const p = f.properties || {};
                const coords = f.geometry && f.geometry.coordinates ? f.geometry.coordinates : [0, 0];
                const featId = f.id || `node/${p.osm_id || Math.floor(Math.random() * 1e8)}`;
                const nameEscaped = (p.name || '').replace(/'/g, "''");
                const layer = p.layer || 'general';
                const h3_7 = p.h3_resolution_7 || '';
                const h3_9 = p.h3_resolution_9 || '';
                const gh = p.geohash_7 || '';
                const quadkey = p.quadkey || '';
                const shard = p.shard_id || 'shard-001';
                const tagsJson = JSON.stringify(p.tags || {}).replace(/'/g, "''");
                const geomJson = JSON.stringify(f.geometry).replace(/'/g, "''");

                lines.push(`INSERT OR REPLACE INTO osm_spatial_features (feature_id, osm_type, layer_category, name, latitude, longitude, h3_resolution_7, h3_resolution_9, geohash_7, quadkey, shard_id, tags_json, geojson_geometry) VALUES ('${featId}', 'node', '${layer}', '${nameEscaped}', ${coords[1]}, ${coords[0]}, '${h3_7}', '${h3_9}', '${gh}', '${quadkey}', '${shard}', '${tagsJson}', '${geomJson}');`);
            }

            lines.push('COMMIT;');
            return lines.join('\n');
        }

        /**
         * Browser utility to download any text blob as a file.
         */
        static downloadFile(content, fileName, mimeType = 'application/json') {
            const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
        }

        static generateUUID() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        }
    }

    return FrictionlessExporter;
}));
