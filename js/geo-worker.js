/**
 * geo-worker.js
 * Dedicated Web Worker for Heavy Geodetic Computations & Spatial Sharding.
 * 
 * Capable of running both inside a Web Worker context or as an asynchronous direct fallback.
 * Operations:
 * 1. Haversine Great-Circle Distance Matrix
 * 2. Point-in-Polygon (Ray-Casting Algorithm)
 * 3. Hexagonal Spatial Aggregation & Point Density Binning
 * 4. K-Nearest Neighbors (k-NN) Spatial Search
 */

/* eslint-disable no-restricted-globals */
(function () {
    'use strict';

    const EARTH_RADIUS_METERS = 6378137.0;
    const DEG_TO_RAD = Math.PI / 180.0;

    /**
     * Haversine distance between two points in meters.
     */
    function haversineDistance(lat1, lon1, lat2, lon2) {
        const dLat = (lat2 - lat1) * DEG_TO_RAD;
        const dLon = (lon2 - lon1) * DEG_TO_RAD;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return EARTH_RADIUS_METERS * c;
    }

    /**
     * Point-in-Polygon (Ray Casting) algorithm.
     * point: [lon, lat]
     * polygon: [[lon, lat], [lon, lat], ...]
     */
    function pointInPolygon(point, polygon) {
        const x = point[0];
        const y = point[1];
        let inside = false;

        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i][0];
            const yi = polygon[i][1];
            const xj = polygon[j][0];
            const yj = polygon[j][1];

            const intersect = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }

        return inside;
    }

    /**
     * Bins point features into hexagonal cells and computes density.
     */
    function aggregateHexDensity(hexagons, features) {
        // hexagons: Array of { h3Index, center: { latitude, longitude }, vertices: [[lat, lon], ...] }
        // features: Array of GeoJSON Feature objects
        const results = {};

        for (const hex of hexagons) {
            results[hex.h3Index] = {
                h3Index: hex.h3Index,
                center: hex.center,
                count: 0,
                featureIds: [],
                layers: {},
                maxWeight: 0
            };
        }

        for (const feat of features) {
            const coords = feat.geometry.coordinates; // [lon, lat]
            const lon = coords[0];
            const lat = coords[1];
            const layer = feat.properties.layer || 'general';

            // Find matching hex by point-in-polygon or spatial proximity
            for (const hex of hexagons) {
                // Approximate hex boundary check (vertices are [lat, lon])
                const polyCoords = hex.vertices.map(v => [v[1], v[0]]); // convert to [lon, lat]
                if (pointInPolygon([lon, lat], polyCoords)) {
                    const bin = results[hex.h3Index];
                    bin.count++;
                    bin.featureIds.push(feat.id || feat.properties.osm_id);
                    bin.layers[layer] = (bin.layers[layer] || 0) + 1;
                    break;
                }
            }
        }

        return Object.values(results);
    }

    /**
     * k-Nearest Neighbors (k-NN) search
     */
    function findKNearest(targetPoint, features, k = 5) {
        const targetLat = targetPoint.latitude;
        const targetLon = targetPoint.longitude;

        const distances = features.map(feat => {
            const coords = feat.geometry.coordinates;
            const dist = haversineDistance(targetLat, targetLon, coords[1], coords[0]);
            return {
                feature: feat,
                distanceMeters: Math.round(dist)
            };
        });

        distances.sort((a, b) => a.distanceMeters - b.distanceMeters);
        return distances.slice(0, k);
    }

    /**
     * Message router for Web Worker
     */
    function processTask(type, payload) {
        const startTime = performance.now();
        let result = null;

        switch (type) {
            case 'AGGREGATE_HEX_DENSITY':
                result = aggregateHexDensity(payload.hexagons, payload.features);
                break;
            case 'HAVERSINE_MATRIX':
                result = payload.points.map(p1 =>
                    payload.points.map(p2 => haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon))
                );
                break;
            case 'POINT_IN_POLYGON_BULK':
                result = payload.points.filter(pt => pointInPolygon([pt.lon, pt.lat], payload.polygon));
                break;
            case 'KNN_SEARCH':
                result = findKNearest(payload.target, payload.features, payload.k || 5);
                break;
            default:
                throw new Error(`Unknown GeoWorker task type: ${type}`);
        }

        const elapsedMs = performance.now() - startTime;
        return { result, elapsedMs };
    }

    // Check if running in worker thread or main thread
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
        self.onmessage = function (e) {
            const { taskId, type, payload } = e.data;
            try {
                const { result, elapsedMs } = processTask(type, payload);
                self.postMessage({ taskId, success: true, result, elapsedMs });
            } catch (err) {
                self.postMessage({ taskId, success: false, error: err.message });
            }
        };
    } else {
        // Expose to window for synchronous fallback
        if (typeof window !== 'undefined') {
            window.GeoWorkerFallback = {
                processTask: function (type, payload) {
                    return Promise.resolve(processTask(type, payload));
                }
            };
        }
    }
})();
