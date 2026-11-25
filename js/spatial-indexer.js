/**
 * spatial-indexer.js
 * Comprehensive Spatial Indexing & Distributed Sharding Engine.
 * 
 * Implementations:
 * 1. Geohash Encoding / Decoding & Neighbor Calculation
 * 2. Slippy Map Web Mercator Tiles (EPSG:3857 <-> WGS84 EPSG:4326)
 * 3. Quadtree Recursive Spatial Indexing (Quadkey)
 * 4. Hexagonal Discrete Global Grid System (DGGS) - Uber H3 Style Deterministic Math
 * 5. Consistent Shard Hasher (Federated Distributed Sharding)
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SpatialIndexer = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Constants & Geodetic Parameters (WGS84)
    // -------------------------------------------------------------------------
    const EARTH_RADIUS_METERS = 6378137.0;
    const DEG_TO_RAD = Math.PI / 180.0;
    const RAD_TO_DEG = 180.0 / Math.PI;
    const BASE32_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

    // -------------------------------------------------------------------------
    // 1. Geohash Indexing
    // -------------------------------------------------------------------------
    const Geohash = {
        encode: function (lat, lon, precision = 7) {
            let latInterval = [-90.0, 90.0];
            let lonInterval = [-180.0, 180.0];
            let isEven = true;
            let bit = 0;
            let ch = 0;
            let geohash = '';

            while (geohash.length < precision) {
                let mid;
                if (isEven) {
                    mid = (lonInterval[0] + lonInterval[1]) / 2;
                    if (lon > mid) {
                        ch |= (1 << (4 - bit));
                        lonInterval[0] = mid;
                    } else {
                        lonInterval[1] = mid;
                    }
                } else {
                    mid = (latInterval[0] + latInterval[1]) / 2;
                    if (lat > mid) {
                        ch |= (1 << (4 - bit));
                        latInterval[0] = mid;
                    } else {
                        latInterval[1] = mid;
                    }
                }
                isEven = !isEven;
                if (bit < 4) {
                    bit++;
                } else {
                    geohash += BASE32_ALPHABET[ch];
                    bit = 0;
                    ch = 0;
                }
            }
            return geohash;
        },

        decode: function (geohash) {
            let latInterval = [-90.0, 90.0];
            let lonInterval = [-180.0, 180.0];
            let isEven = true;

            for (let i = 0; i < geohash.length; i++) {
                const char = geohash[i].toLowerCase();
                const cd = BASE32_ALPHABET.indexOf(char);
                if (cd === -1) continue;

                for (let j = 0; j < 5; j++) {
                    const mask = 1 << (4 - j);
                    if (isEven) {
                        const mid = (lonInterval[0] + lonInterval[1]) / 2;
                        if ((cd & mask) !== 0) {
                            lonInterval[0] = mid;
                        } else {
                            lonInterval[1] = mid;
                        }
                    } else {
                        const mid = (latInterval[0] + latInterval[1]) / 2;
                        if ((cd & mask) !== 0) {
                            latInterval[0] = mid;
                        } else {
                            latInterval[1] = mid;
                        }
                    }
                    isEven = !isEven;
                }
            }

            return {
                latitude: (latInterval[0] + latInterval[1]) / 2,
                longitude: (lonInterval[0] + lonInterval[1]) / 2,
                bounds: {
                    minLat: latInterval[0],
                    maxLat: latInterval[1],
                    minLon: lonInterval[0],
                    maxLon: lonInterval[1]
                }
            };
        }
    };

    // -------------------------------------------------------------------------
    // 2. Slippy Map Web Mercator Tiles (XYZ & Quadkey)
    // -------------------------------------------------------------------------
    const SlippyTile = {
        latLonToTile: function (lat, lon, zoom) {
            const z = Math.max(0, Math.min(22, zoom));
            const n = Math.pow(2, z);
            const radLat = lat * DEG_TO_RAD;
            const x = Math.floor((lon + 180.0) / 360.0 * n);
            let y = Math.floor((1.0 - Math.log(Math.tan(radLat) + (1.0 / Math.cos(radLat))) / Math.PI) / 2.0 * n);
            y = Math.max(0, Math.min(n - 1, y));
            return { z: z, x: Math.max(0, Math.min(n - 1, x)), y: y };
        },

        tileToLatLon: function (x, y, z) {
            const n = Math.pow(2, z);
            const lonDeg = x / n * 360.0 - 180.0;
            const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
            const latDeg = latRad * RAD_TO_DEG;
            return { latitude: latDeg, longitude: lonDeg };
        },

        tileToBounds: function (x, y, z) {
            const nw = this.tileToLatLon(x, y, z);
            const se = this.tileToLatLon(x + 1, y + 1, z);
            return {
                minLon: nw.longitude,
                maxLon: se.longitude,
                minLat: se.latitude,
                maxLat: nw.latitude
            };
        },

        tileToQuadkey: function (x, y, z) {
            let quadKey = '';
            for (let i = z; i > 0; i--) {
                let digit = 0;
                const mask = 1 << (i - 1);
                if ((x & mask) !== 0) digit += 1;
                if ((y & mask) !== 0) digit += 2;
                quadKey += digit.toString();
            }
            return quadKey;
        },

        quadkeyToTile: function (quadkey) {
            let tileX = 0;
            let tileY = 0;
            const levelOfDetail = quadkey.length;
            for (let i = levelOfDetail; i > 0; i--) {
                const mask = 1 << (i - 1);
                switch (quadkey[levelOfDetail - i]) {
                    case '0':
                        break;
                    case '1':
                        tileX |= mask;
                        break;
                    case '2':
                        tileY |= mask;
                        break;
                    case '3':
                        tileX |= mask;
                        tileY |= mask;
                        break;
                    default:
                        throw new Error('Invalid QuadKey digit sequence.');
                }
            }
            return { x: tileX, y: tileY, z: levelOfDetail };
        }
    };

    // -------------------------------------------------------------------------
    // 3. Recursive Quadtree Index
    // -------------------------------------------------------------------------
    class QuadtreeNode {
        constructor(bounds, capacity = 8, depth = 0, maxDepth = 12) {
            this.bounds = bounds; // { minLon, maxLon, minLat, maxLat }
            this.capacity = capacity;
            this.depth = depth;
            this.maxDepth = maxDepth;
            this.points = [];
            this.divided = false;
            this.children = null; // [NW, NE, SW, SE]
        }

        contains(point) {
            return (
                point.longitude >= this.bounds.minLon &&
                point.longitude <= this.bounds.maxLon &&
                point.latitude >= this.bounds.minLat &&
                point.latitude <= this.bounds.maxLat
            );
        }

        subdivide() {
            const { minLon, maxLon, minLat, maxLat } = this.bounds;
            const midLon = (minLon + maxLon) / 2;
            const midLat = (minLat + maxLat) / 2;
            const nextDepth = this.depth + 1;

            this.children = [
                new QuadtreeNode({ minLon, maxLon: midLon, minLat: midLat, maxLat }, this.capacity, nextDepth, this.maxDepth), // NW
                new QuadtreeNode({ minLon: midLon, maxLon, minLat: midLat, maxLat }, this.capacity, nextDepth, this.maxDepth), // NE
                new QuadtreeNode({ minLon, maxLon: midLon, minLat, maxLat: midLat }, this.capacity, nextDepth, this.maxDepth), // SW
                new QuadtreeNode({ minLon: midLon, maxLon, minLat, maxLat: midLat }, this.capacity, nextDepth, this.maxDepth)  // SE
            ];
            this.divided = true;

            // Re-insert existing points into children
            const oldPoints = this.points;
            this.points = [];
            for (const pt of oldPoints) {
                this.insert(pt);
            }
        }

        insert(point) {
            if (!this.contains(point)) return false;

            if (this.points.length < this.capacity || this.depth >= this.maxDepth) {
                if (!this.divided) {
                    this.points.push(point);
                    return true;
                }
            }

            if (!this.divided) {
                this.subdivide();
            }

            for (const child of this.children) {
                if (child.insert(point)) return true;
            }
            return false;
        }

        queryRange(range, found = []) {
            // Check bounding box intersection
            if (
                this.bounds.maxLon < range.minLon ||
                this.bounds.minLon > range.maxLon ||
                this.bounds.maxLat < range.minLat ||
                this.bounds.minLat > range.maxLat
            ) {
                return found;
            }

            if (this.divided) {
                for (const child of this.children) {
                    child.queryRange(range, found);
                }
            } else {
                for (const pt of this.points) {
                    if (
                        pt.longitude >= range.minLon &&
                        pt.longitude <= range.maxLon &&
                        pt.latitude >= range.minLat &&
                        pt.latitude <= range.maxLat
                    ) {
                        found.push(pt);
                    }
                }
            }
            return found;
        }

        getStats() {
            let nodeCount = 1;
            let pointCount = this.points.length;
            if (this.divided) {
                for (const child of this.children) {
                    const childStats = child.getStats();
                    nodeCount += childStats.nodeCount;
                    pointCount += childStats.pointCount;
                }
            }
            return { nodeCount, pointCount, depth: this.depth };
        }
    }

    // -------------------------------------------------------------------------
    // 4. Hexagonal Discrete Global Grid System (Uber H3 Inspired Math)
    // -------------------------------------------------------------------------
    // Hexagonal indexing uses axial/cube coordinate transformations projected onto planar hexagons
    // Resolves coordinates deterministically into unique 64-bit style hex string IDs.
    const HexGrid = {
        // Approximate average edge lengths per resolution (meters)
        RESOLUTION_EDGE_METERS: {
            0: 1107712, 1: 418676, 2: 158244, 3: 59810, 4: 22606, 5: 8544,
            6: 3229,    7: 1220,   8: 461,    9: 174,   10: 65,  11: 24, 12: 9
        },

        // Converts Lat/Lon to Axial Coordinates (q, r) at specified resolution
        latLonToAxial: function (lat, lon, res = 7) {
            const edge = this.RESOLUTION_EDGE_METERS[res] || 1220;
            // Project to spherical Mercator meters
            const x = lon * DEG_TO_RAD * EARTH_RADIUS_METERS;
            const y = Math.log(Math.tan((90 + lat) * DEG_TO_RAD / 2)) * EARTH_RADIUS_METERS;

            // Hexagon layout: flat topped or pointy topped
            // Using pointy topped:
            // q = (sqrt(3)/3 * x - 1/3 * y) / edge
            // r = (2/3 * y) / edge
            const q = (Math.sqrt(3) / 3 * x - (1 / 3) * y) / edge;
            const r = ((2 / 3) * y) / edge;

            return this.axialRound(q, r);
        },

        // Cube coordinate rounding algorithm
        axialRound: function (q, r) {
            const x = q;
            const z = r;
            const y = -x - z;

            let rx = Math.round(x);
            let ry = Math.round(y);
            let rz = Math.round(z);

            const xDiff = Math.abs(rx - x);
            const yDiff = Math.abs(ry - y);
            const zDiff = Math.abs(rz - z);

            if (xDiff > yDiff && xDiff > zDiff) {
                rx = -ry - rz;
            } else if (yDiff > zDiff) {
                ry = -rx - rz;
            } else {
                rz = -rx - ry;
            }

            return { q: rx, r: rz };
        },

        // Converts Axial (q, r) back to center Lat/Lon
        axialToLatLon: function (q, r, res = 7) {
            const edge = this.RESOLUTION_EDGE_METERS[res] || 1220;
            // Inverse pointy-topped hex:
            // x = edge * sqrt(3) * (q + r/2)
            // y = edge * (3/2) * r
            const x = edge * Math.sqrt(3) * (q + r / 2);
            const y = edge * (3 / 2) * r;

            const lon = (x / EARTH_RADIUS_METERS) * RAD_TO_DEG;
            const latRad = 2 * Math.atan(Math.exp(y / EARTH_RADIUS_METERS)) - Math.PI / 2;
            const lat = latRad * RAD_TO_DEG;

            return { latitude: lat, longitude: lon };
        },

        // Generates canonical 15-char Hexadecimal Index (H3 representation string)
        latLonToH3Index: function (lat, lon, res = 7) {
            const { q, r } = this.latLonToAxial(lat, lon, res);
            // Sign encoding into positive offset 32-bit registers
            const qOffset = (q + 0x7FFFF) & 0xFFFFFF;
            const rOffset = (r + 0x7FFFF) & 0xFFFFFF;
            const resHex = res.toString(16);
            const qHex = qOffset.toString(16).padStart(6, '0');
            const rHex = rOffset.toString(16).padStart(6, '0');
            return `8${resHex}${qHex}${rHex}`;
        },

        // Parses H3 Index string back to axial coordinates & resolution
        h3IndexToAxial: function (h3Index) {
            if (!h3Index || h3Index.length < 14) return { q: 0, r: 0, res: 7 };
            const res = parseInt(h3Index.substr(1, 1), 16);
            const qOffset = parseInt(h3Index.substr(2, 6), 16);
            const rOffset = parseInt(h3Index.substr(8, 6), 16);
            return {
                res: isNaN(res) ? 7 : res,
                q: qOffset - 0x7FFFF,
                r: rOffset - 0x7FFFF
            };
        },

        // Computes the 6 polygon vertices (Lat/Lon) of a hexagonal cell
        getHexagonBoundary: function (h3Index) {
            const { q, r, res } = this.h3IndexToAxial(h3Index);
            const center = this.axialToLatLon(q, r, res);
            const edge = this.RESOLUTION_EDGE_METERS[res] || 1220;

            // In meters on projected sphere
            const centerX = center.longitude * DEG_TO_RAD * EARTH_RADIUS_METERS;
            const centerY = Math.log(Math.tan((90 + center.latitude) * DEG_TO_RAD / 2)) * EARTH_RADIUS_METERS;

            const vertices = [];
            for (let i = 0; i < 6; i++) {
                // Pointy-topped angles: 30°, 90°, 150°, 210°, 270°, 330°
                const angleDeg = 60 * i + 30;
                const angleRad = angleDeg * DEG_TO_RAD;
                const vx = centerX + edge * Math.cos(angleRad);
                const vy = centerY + edge * Math.sin(angleRad);

                const vLon = (vx / EARTH_RADIUS_METERS) * RAD_TO_DEG;
                const vLatRad = 2 * Math.atan(Math.exp(vy / EARTH_RADIUS_METERS)) - Math.PI / 2;
                const vLat = vLatRad * RAD_TO_DEG;

                vertices.push([vLat, vLon]);
            }
            // Close the polygon loop
            vertices.push([vertices[0][0], vertices[0][1]]);
            return {
                center,
                vertices
            };
        },

        // Gets 6 immediate neighboring hex cell indices (k-ring 1)
        kRing: function (h3Index, radius = 1) {
            const { q, r, res } = this.h3IndexToAxial(h3Index);
            const neighbors = [];
            // Axial directions: (+1, 0), (+1, -1), (0, -1), (-1, 0), (-1, +1), (0, +1)
            for (let dq = -radius; dq <= radius; dq++) {
                for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
                    const nQ = q + dq;
                    const nR = r + dr;
                    const qOffset = (nQ + 0x7FFFF) & 0xFFFFFF;
                    const rOffset = (nR + 0x7FFFF) & 0xFFFFFF;
                    const resHex = res.toString(16);
                    neighbors.push(`8${resHex}${qOffset.toString(16).padStart(6, '0')}${rOffset.toString(16).padStart(6, '0')}`);
                }
            }
            return neighbors;
        },

        // Decomposes a bounding box into covered H3 hexagon indices
        polyfillBoundingBox: function (minLat, minLon, maxLat, maxLon, res = 7) {
            const edge = this.RESOLUTION_EDGE_METERS[res] || 1220;
            // Calculate step size in degrees (roughly 1.5 * edge / meters_per_deg)
            const metersPerDegLat = 111320;
            const midLatRad = ((minLat + maxLat) / 2) * DEG_TO_RAD;
            const metersPerDegLon = 111320 * Math.cos(midLatRad);

            const stepLat = Math.max(0.0005, (edge * 1.3) / metersPerDegLat);
            const stepLon = Math.max(0.0005, (edge * 1.3) / metersPerDegLon);

            const hexSet = new Set();
            for (let lat = minLat; lat <= maxLat + stepLat; lat += stepLat) {
                for (let lon = minLon; lon <= maxLon + stepLon; lon += stepLon) {
                    const h3Id = this.latLonToH3Index(lat, lon, res);
                    hexSet.add(h3Id);
                }
            }
            return Array.from(hexSet);
        }
    };

    // -------------------------------------------------------------------------
    // 5. Distributed Spatial Sharding Engine (Consistent Hashing)
    // -------------------------------------------------------------------------
    class SpatialShardRouter {
        constructor(shardCount = 8) {
            this.shardCount = shardCount;
            this.shards = [];
            this.initShards();
        }

        initShards() {
            const regions = [
                { id: 'shard-na-east', name: 'North America East', center: [39.0, -77.0], latency: 14 },
                { id: 'shard-na-west', name: 'North America West', center: [37.7, -122.4], latency: 22 },
                { id: 'shard-eu-central', name: 'Europe Central (Frankfurt)', center: [50.1, 8.6], latency: 18 },
                { id: 'shard-eu-west', name: 'Europe West (London)', center: [51.5, -0.1], latency: 16 },
                { id: 'shard-ap-southeast', name: 'Asia Pacific (Singapore)', center: [1.35, 103.8], latency: 38 },
                { id: 'shard-ap-northeast', name: 'Asia Pacific (Tokyo)', center: [35.6, 139.7], latency: 42 },
                { id: 'shard-sa-east', name: 'South America (São Paulo)', center: [-23.5, -46.6], latency: 28 },
                { id: 'shard-me-central', name: 'Middle East (Dubai)', center: [25.2, 55.3], latency: 32 }
            ];

            for (let i = 0; i < this.shardCount; i++) {
                const reg = regions[i % regions.length];
                this.shards.push({
                    shardId: `shard-${(i + 1).toString().padStart(3, '0')}`,
                    name: reg.name,
                    virtualRingPosition: (i * (0xFFFFFFFF / this.shardCount)) >>> 0,
                    centerLat: reg.center[0],
                    centerLon: reg.center[1],
                    baseLatencyMs: reg.latency,
                    stats: {
                        cachedTiles: 0,
                        featuresIndexed: 0,
                        requestsServed: 0,
                        hits: 0,
                        misses: 0
                    }
                });
            }
        }

        // Fast Jenkins 32-bit hash function
        hashString(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash += str.charCodeAt(i);
                hash += (hash << 10);
                hash ^= (hash >>> 6);
            }
            hash += (hash << 3);
            hash ^= (hash >>> 11);
            hash += (hash << 15);
            return hash >>> 0; // Return unsigned 32-bit integer
        }

        // Routes spatial entity (by H3, Geohash, or Quadkey) to specific partition
        route(spatialKey) {
            const hash = this.hashString(String(spatialKey));
            const shardIndex = hash % this.shards.length;
            return this.shards[shardIndex];
        }

        // Records metrics for telemetry dashboard
        recordHit(shardId) {
            const shard = this.shards.find(s => s.shardId === shardId);
            if (shard) {
                shard.stats.requestsServed++;
                shard.stats.hits++;
            }
        }

        recordMiss(shardId) {
            const shard = this.shards.find(s => s.shardId === shardId);
            if (shard) {
                shard.stats.requestsServed++;
                shard.stats.misses++;
            }
        }

        getAllShards() {
            return this.shards;
        }
    }

    // -------------------------------------------------------------------------
    // Public API Bundle
    // -------------------------------------------------------------------------
    return {
        Geohash,
        SlippyTile,
        QuadtreeNode,
        HexGrid,
        SpatialShardRouter,
        constants: {
            EARTH_RADIUS_METERS,
            DEG_TO_RAD,
            RAD_TO_DEG
        }
    };
}));
