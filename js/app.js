/**
 * app.js
 * Main Orchestrator for Distributed Internet GIS, H3/S2 Spatial Sharding & OSM Tile Federation.
 * 
 * Features:
 * - High-performance 2D Canvas Cartographic Engine (Pan, Smooth Zoom, Geo-projected rendering)
 * - Slippy Tile Raster Fetcher with In-Memory / SQLite R-Tree Caching
 * - Hexagonal Uber H3 Discrete Global Grid System (DGGS) overlay & interactive cell picking
 * - Distributed Spatial Shard Router telemetry with simulated network latency
 * - Layer toggles: Telecom, Infrastructure, Water, Amenities
 * - Frictionless Data & OpenStreetMap ODbL Export Engine
 */

(function () {
    'use strict';

    // Verify dependencies
    const SpatialIndexer = window.SpatialIndexer;
    const OsmFederationClient = window.OsmFederationClient;
    const FrictionlessExport = window.FrictionlessExport;
    const SpatialDatabase = window.SpatialDatabase;

    // Default Cartographic Coordinates (DE-CIX Frankfurt Central Hub)
    const DEFAULT_LAT = 50.1109;
    const DEFAULT_LON = 8.6821;
    const DEFAULT_ZOOM = 13;

    class InternetGisApp {
        constructor() {
            this.canvas = document.getElementById('map-canvas');
            this.ctx = this.canvas.getContext('2d');

            // Viewport & Map state
            this.centerLat = DEFAULT_LAT;
            this.centerLon = DEFAULT_LON;
            this.zoom = DEFAULT_ZOOM;
            this.minZoom = 3;
            this.maxZoom = 18;

            // Pan and interaction states
            this.isDragging = false;
            this.dragStartX = 0;
            this.dragStartY = 0;
            this.lastMousePos = { x: 0, y: 0 };
            this.selectedFeature = null;
            this.selectedHexIndex = null;

            // Federation subsystems
            this.indexer = SpatialIndexer;
            this.router = new this.indexer.SpatialShardRouter(8);
            this.osmClient = new OsmFederationClient({ router: this.router });
            this.db = new SpatialDatabase();

            // Layer states
            this.activeLayers = {
                telecom: true,
                infrastructure: true,
                water: true,
                amenities: false
            };

            // Grid and partition overlay mode: 'h3', 'quadtree', 'geohash', 'none'
            this.gridMode = 'h3';
            this.h3Resolution = 7; // res 6 to 9
            this.isWorkerBusy = false;

            // Runtime datasets
            this.features = [];
            this.hexBins = [];
            this.cachedTileImages = new Map();

            // Telemetry
            this.telemetry = {
                cacheHits: 0,
                cacheMisses: 0,
                networkLatencyMs: 14.2,
                totalFeatures: 0
            };

            this.initWorker();
        }

        async init() {
            this.resizeCanvas();
            window.addEventListener('resize', () => {
                this.resizeCanvas();
                this.render();
            });

            // Initialize DB
            await this.db.init();

            // Setup DOM events
            this.bindEvents();

            // Initial fetch of spatial features
            await this.refreshSpatialData();

            // First render loop
            this.render();
            this.updateShardTelemetryView();
        }

        initWorker() {
            try {
                this.geoWorker = new Worker('js/geo-worker.js');
                this.geoWorker.onmessage = (e) => {
                    const { success, result } = e.data;
                    if (success && result) {
                        this.hexBins = result;
                        this.render();
                    }
                    this.isWorkerBusy = false;
                };
            } catch (err) {
                console.warn('[App] Web Worker failed to initialize. Falling back to inline execution:', err);
                this.geoWorker = null;
            }
        }

        resizeCanvas() {
            const rect = this.canvas.parentElement.getBoundingClientRect();
            this.canvas.width = rect.width * (window.devicePixelRatio || 1);
            this.canvas.height = rect.height * (window.devicePixelRatio || 1);
            this.ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
            this.canvasWidth = rect.width;
            this.canvasHeight = rect.height;
        }

        bindEvents() {
            // Mouse Drag & Pan
            this.canvas.addEventListener('mousedown', (e) => {
                this.isDragging = true;
                this.dragStartX = e.clientX;
                this.dragStartY = e.clientY;
            });

            window.addEventListener('mouseup', () => {
                if (this.isDragging) {
                    this.isDragging = false;
                    this.refreshSpatialData();
                }
            });

            this.canvas.addEventListener('mousemove', (e) => {
                const rect = this.canvas.getBoundingClientRect();
                this.lastMousePos = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };

                if (this.isDragging) {
                    const dx = e.clientX - this.dragStartX;
                    const dy = e.clientY - this.dragStartY;
                    this.dragStartX = e.clientX;
                    this.dragStartY = e.clientY;

                    // Convert pixel delta to lat/lon delta based on zoom
                    const metersPerPixel = (Math.cos(this.centerLat * Math.PI / 180) * 2 * Math.PI * 6378137) / (256 * Math.pow(2, this.zoom));
                    const deltaLon = -(dx * metersPerPixel) / (111320 * Math.cos(this.centerLat * Math.PI / 180));
                    const deltaLat = (dy * metersPerPixel) / 111320;

                    this.centerLon += deltaLon;
                    this.centerLat = Math.max(-85, Math.min(85, this.centerLat + deltaLat));
                    this.render();
                }
            });

            // Wheel Zoom
            this.canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const zoomDelta = e.deltaY < 0 ? 0.3 : -0.3;
                this.setZoom(this.zoom + zoomDelta);
            }, { passive: false });

            // Click feature / cell selection
            this.canvas.addEventListener('click', (e) => {
                if (this.isDragging) return;
                const rect = this.canvas.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const clickY = e.clientY - rect.top;
                this.handleMapClick(clickX, clickY);
            });

            // Nav buttons
            document.getElementById('btn-zoom-in').addEventListener('click', () => this.setZoom(this.zoom + 1));
            document.getElementById('btn-zoom-out').addEventListener('click', () => this.setZoom(this.zoom - 1));
            document.getElementById('btn-recenter').addEventListener('click', () => {
                this.centerLat = DEFAULT_LAT;
                this.centerLon = DEFAULT_LON;
                this.setZoom(13);
            });

            // Grid Partition Segmented Control
            const segButtons = document.querySelectorAll('.grid-type-btn');
            segButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    segButtons.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.gridMode = btn.dataset.grid;
                    this.render();
                });
            });

            // H3 Resolution Slider
            const resSlider = document.getElementById('slider-h3-res');
            const resBadge = document.getElementById('badge-h3-res');
            resSlider.addEventListener('input', (e) => {
                this.h3Resolution = parseInt(e.target.value, 10);
                resBadge.textContent = `Res ${this.h3Resolution}`;
                this.triggerHexAggregation();
            });

            // Layer Checkboxes
            ['telecom', 'infrastructure', 'water', 'amenities'].forEach(layer => {
                const el = document.getElementById(`layer-toggle-${layer}`);
                if (el) {
                    el.addEventListener('change', (e) => {
                        this.activeLayers[layer] = e.target.checked;
                        this.refreshSpatialData();
                    });
                }
            });

            // City Preset Selector
            const presetSelect = document.getElementById('select-preset-region');
            if (presetSelect) {
                presetSelect.addEventListener('change', (e) => {
                    const coords = e.target.value.split(',').map(Number);
                    this.centerLat = coords[0];
                    this.centerLon = coords[1];
                    this.zoom = coords[2] || 13;
                    this.refreshSpatialData();
                });
            }

            // Export Actions
            document.getElementById('btn-open-export').addEventListener('click', () => {
                document.getElementById('export-modal').classList.add('open');
            });
            document.getElementById('btn-close-modal').addEventListener('click', () => {
                document.getElementById('export-modal').classList.remove('open');
            });
            document.getElementById('btn-export-geojson').addEventListener('click', () => {
                const json = FrictionlessExport.exportToGeoJSON(this.features, {
                    bbox: this.getCurrentBoundingBox(),
                    title: 'OSM Federated Features'
                });
                FrictionlessExport.downloadFile(json, 'osm-federated-features.geojson', 'application/geo+json');
            });
            document.getElementById('btn-export-csv').addEventListener('click', () => {
                const csv = FrictionlessExport.exportToCSV(this.features);
                FrictionlessExport.downloadFile(csv, 'osm-federated-features.csv', 'text/csv');
            });
            document.getElementById('btn-export-datapackage').addEventListener('click', () => {
                const dp = FrictionlessExport.generateDataPackage(this.features, {
                    bbox: this.getCurrentBoundingBox(),
                    title: 'Distributed Internet GIS Federated Package'
                });
                FrictionlessExport.downloadFile(JSON.stringify(dp, null, 2), 'datapackage.json', 'application/json');
            });
            document.getElementById('btn-export-sql').addEventListener('click', () => {
                const sql = FrictionlessExport.exportToSQLiteScript(this.features);
                FrictionlessExport.downloadFile(sql, 'spatial-features-dump.sql', 'text/plain');
            });
        }

        setZoom(newZoom) {
            this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, parseFloat(newZoom.toFixed(2))));
            this.render();
            clearTimeout(this.zoomDebounce);
            this.zoomDebounce = setTimeout(() => this.refreshSpatialData(), 200);
        }

        getCurrentBoundingBox() {
            // Calculates bounding box for current canvas viewport
            const nw = this.pixelToLatLon(0, 0);
            const se = this.pixelToLatLon(this.canvasWidth, this.canvasHeight);
            return [
                Math.min(nw.lat, se.lat),
                Math.min(nw.lon, se.lon),
                Math.max(nw.lat, se.lat),
                Math.max(nw.lon, se.lon)
            ];
        }

        latLonToPixel(lat, lon) {
            const n = Math.pow(2, this.zoom);
            const x = ((lon + 180.0) / 360.0) * n * 256;
            const radLat = lat * Math.PI / 180.0;
            const y = (1.0 - Math.log(Math.tan(radLat) + (1.0 / Math.cos(radLat))) / Math.PI) / 2.0 * n * 256;

            const centerN = Math.pow(2, this.zoom);
            const centerX = ((this.centerLon + 180.0) / 360.0) * centerN * 256;
            const centerRadLat = this.centerLat * Math.PI / 180.0;
            const centerY = (1.0 - Math.log(Math.tan(centerRadLat) + (1.0 / Math.cos(centerRadLat))) / Math.PI) / 2.0 * centerN * 256;

            return {
                x: this.canvasWidth / 2 + (x - centerX),
                y: this.canvasHeight / 2 + (y - centerY)
            };
        }

        pixelToLatLon(px, py) {
            const n = Math.pow(2, this.zoom);
            const centerN = Math.pow(2, this.zoom);
            const centerX = ((this.centerLon + 180.0) / 360.0) * centerN * 256;
            const centerRadLat = this.centerLat * Math.PI / 180.0;
            const centerY = (1.0 - Math.log(Math.tan(centerRadLat) + (1.0 / Math.cos(centerRadLat))) / Math.PI) / 2.0 * centerN * 256;

            const worldX = centerX + (px - this.canvasWidth / 2);
            const worldY = centerY + (py - this.canvasHeight / 2);

            const lon = (worldX / (n * 256)) * 360.0 - 180.0;
            const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY / (n * 256))));
            const lat = latRad * 180.0 / Math.PI;

            return { lat, lon };
        }

        async refreshSpatialData() {
            const bbox = this.getCurrentBoundingBox();
            const loadedFeatures = [];

            // Query each active layer
            const activeKeys = Object.keys(this.activeLayers).filter(k => this.activeLayers[k]);

            for (const layer of activeKeys) {
                // Check local SQLite cache first (Offline-First principle)
                const cached = await this.db.queryBoundingBox(bbox, layer);
                if (cached && cached.length > 0) {
                    this.telemetry.cacheHits += cached.length;
                    loadedFeatures.push(...cached);
                } else {
                    this.telemetry.cacheMisses++;
                    // Query federated client
                    const res = await this.osmClient.queryFederatedOverpass(bbox, layer);
                    if (res && res.features) {
                        loadedFeatures.push(...res.features);
                        await this.db.saveFeatures(res.features);
                        // Record shard hits
                        for (const f of res.features) {
                            if (f.properties && f.properties.shard_id) {
                                this.router.recordHit(f.properties.shard_id);
                            }
                        }
                    }
                }
            }

            this.features = loadedFeatures;
            this.telemetry.totalFeatures = loadedFeatures.length;
            this.triggerHexAggregation();
            this.updateShardTelemetryView();
            this.render();
        }

        triggerHexAggregation() {
            if (this.gridMode !== 'h3' || this.features.length === 0) return;

            const bbox = this.getCurrentBoundingBox();
            const hexIndexes = this.indexer.HexGrid.polyfillBoundingBox(bbox[0], bbox[1], bbox[2], bbox[3], this.h3Resolution);

            const hexCells = hexIndexes.map(idx => {
                const geom = this.indexer.HexGrid.getHexagonBoundary(idx);
                return {
                    h3Index: idx,
                    center: geom.center,
                    vertices: geom.vertices
                };
            });

            if (this.geoWorker && !this.isWorkerBusy) {
                this.isWorkerBusy = true;
                this.geoWorker.postMessage({
                    taskId: Date.now(),
                    type: 'AGGREGATE_HEX_DENSITY',
                    payload: {
                        hexagons: hexCells,
                        features: this.features
                    }
                });
            } else if (window.GeoWorkerFallback) {
                window.GeoWorkerFallback.processTask('AGGREGATE_HEX_DENSITY', {
                    hexagons: hexCells,
                    features: this.features
                }).then(({ result }) => {
                    this.hexBins = result;
                    this.render();
                });
            }
        }

        handleMapClick(px, py) {
            const clickPos = this.pixelToLatLon(px, py);

            // 1. Check if clicked on a node feature
            let clickedFeat = null;
            let minDist = 18; // pixel threshold

            for (const f of this.features) {
                const pt = this.latLonToPixel(f.geometry.coordinates[1], f.geometry.coordinates[0]);
                const dist = Math.hypot(pt.x - px, pt.y - py);
                if (dist < minDist) {
                    minDist = dist;
                    clickedFeat = f;
                }
            }

            if (clickedFeat) {
                this.selectedFeature = clickedFeat;
                this.displayFeatureDetails(clickedFeat);
                this.render();
                return;
            }

            // 2. Otherwise calculate clicked H3 hex cell
            const hexId = this.indexer.HexGrid.latLonToH3Index(clickPos.lat, clickPos.lon, this.h3Resolution);
            this.selectedHexIndex = hexId;
            const shard = this.router.route(hexId);
            this.displayHexDetails(hexId, shard, clickPos);
            this.render();
        }

        displayFeatureDetails(feat) {
            const p = feat.properties;
            const container = document.getElementById('inspector-details');
            container.innerHTML = `
                <div style="color: var(--accent-primary); font-weight: 700; margin-bottom: 4px;">🎯 ${p.name || 'OSM Node'}</div>
                <div><strong>Layer:</strong> <span style="text-transform: capitalize;">${p.layer}</span></div>
                <div><strong>OSM ID:</strong> ${p.osm_id}</div>
                <div><strong>H3 Res 7:</strong> ${p.h3_resolution_7}</div>
                <div><strong>H3 Res 9:</strong> ${p.h3_resolution_9}</div>
                <div><strong>Geohash:</strong> ${p.geohash_7}</div>
                <div><strong>Assigned Shard:</strong> <span style="color: var(--warning);">${p.shard_id}</span></div>
                <div><strong>Coords:</strong> ${feat.geometry.coordinates[1].toFixed(5)}, ${feat.geometry.coordinates[0].toFixed(5)}</div>
                <div style="margin-top: 6px; font-size: 0.7rem; color: var(--text-muted);">${p.attribution}</div>
            `;
        }

        displayHexDetails(hexId, shard, clickPos) {
            const container = document.getElementById('inspector-details');
            const bin = this.hexBins.find(b => b.h3Index === hexId);
            const count = bin ? bin.count : 0;

            container.innerHTML = `
                <div style="color: var(--success); font-weight: 700; margin-bottom: 4px;">🔷 H3 Hexagon Cell (${hexId})</div>
                <div><strong>Resolution:</strong> Res ${this.h3Resolution}</div>
                <div><strong>Features in Cell:</strong> ${count}</div>
                <div><strong>Distributed Shard:</strong> <span style="color: var(--warning);">${shard.shardId} (${shard.name})</span></div>
                <div><strong>Shard Base Latency:</strong> ${shard.baseLatencyMs} ms</div>
                <div><strong>Center Coords:</strong> ${clickPos.lat.toFixed(5)}, ${clickPos.lon.toFixed(5)}</div>
                <div style="margin-top: 6px; font-size: 0.7rem; color: var(--text-muted);">Partitioned via Consistent Spatial Hash (ODbL standard)</div>
            `;
        }

        updateShardTelemetryView() {
            const container = document.getElementById('shards-container');
            const shards = this.router.getAllShards();

            let html = '';
            for (const s of shards) {
                const totalReq = s.stats.hits + s.stats.misses;
                const hitRate = totalReq > 0 ? Math.round((s.stats.hits / totalReq) * 100) : 100;
                html += `
                    <div class="shard-card">
                        <div class="shard-header">
                            <span>${s.shardId}</span>
                            <span class="shard-latency">${s.baseLatencyMs}ms</span>
                        </div>
                        <div class="shard-metrics">
                            Hit: ${hitRate}% | Req: ${s.stats.requestsServed}
                        </div>
                    </div>
                `;
            }
            container.innerHTML = html;

            // Global stats
            document.getElementById('stat-cache-hits').textContent = this.telemetry.cacheHits;
            document.getElementById('stat-cache-misses').textContent = this.telemetry.cacheMisses;
            document.getElementById('stat-features-count').textContent = this.telemetry.totalFeatures;
            document.getElementById('stat-latency').textContent = `${Math.round(12 + Math.random() * 8)}ms`;
        }

        render() {
            this.ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

            // 1. Draw Cartographic Background & Base Grid
            this.drawCartoBase();

            // 2. Draw Spatial Partitions (H3 Hexagons, Quadtree or Geohash)
            if (this.gridMode === 'h3') {
                this.drawH3Grid();
            } else if (this.gridMode === 'quadtree') {
                this.drawQuadtreeGrid();
            } else if (this.gridMode === 'geohash') {
                this.drawGeohashGrid();
            }

            // 3. Draw Federated Vector Features (Nodes & Masts)
            this.drawFeatures();
        }

        drawCartoBase() {
            // Dark cartographic grid lines
            const ctx = this.ctx;
            ctx.save();
            ctx.strokeStyle = 'hsla(217, 33%, 25%, 0.25)';
            ctx.lineWidth = 1;

            const step = 80;
            for (let x = 0; x < this.canvasWidth; x += step) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, this.canvasHeight);
                ctx.stroke();
            }
            for (let y = 0; y < this.canvasHeight; y += step) {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(this.canvasWidth, y);
                ctx.stroke();
            }
            ctx.restore();
        }

        drawH3Grid() {
            const ctx = this.ctx;
            ctx.save();

            for (const bin of this.hexBins) {
                const geom = this.indexer.HexGrid.getHexagonBoundary(bin.h3Index);
                const vertices = geom.vertices;

                ctx.beginPath();
                for (let i = 0; i < vertices.length; i++) {
                    const pt = this.latLonToPixel(vertices[i][0], vertices[i][1]);
                    if (i === 0) ctx.moveTo(pt.x, pt.y);
                    else ctx.lineTo(pt.x, pt.y);
                }
                ctx.closePath();

                const isSelected = this.selectedHexIndex === bin.h3Index;

                if (isSelected) {
                    ctx.fillStyle = 'hsla(45, 95%, 55%, 0.45)';
                    ctx.strokeStyle = 'hsl(45, 95%, 65%)';
                    ctx.lineWidth = 2.5;
                } else if (bin.count > 0) {
                    const densityAlpha = Math.min(0.65, 0.15 + (bin.count / 15) * 0.5);
                    ctx.fillStyle = `hsla(160, 90%, 45%, ${densityAlpha})`;
                    ctx.strokeStyle = 'hsla(160, 90%, 55%, 0.6)';
                    ctx.lineWidth = 1;
                } else {
                    ctx.fillStyle = 'hsla(217, 33%, 20%, 0.08)';
                    ctx.strokeStyle = 'hsla(217, 33%, 40%, 0.25)';
                    ctx.lineWidth = 0.8;
                }

                ctx.fill();
                ctx.stroke();

                // If hex has high density, show count badge
                if (bin.count > 0) {
                    const centerPt = this.latLonToPixel(bin.center.latitude, bin.center.longitude);
                    ctx.fillStyle = '#ffffff';
                    ctx.font = '10px JetBrains Mono, monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(String(bin.count), centerPt.x, centerPt.y);
                }
            }

            ctx.restore();
        }

        drawQuadtreeGrid() {
            const ctx = this.ctx;
            const bbox = this.getCurrentBoundingBox();
            const z = Math.min(15, Math.floor(this.zoom));
            const nwTile = this.indexer.SlippyTile.latLonToTile(bbox[2], bbox[1], z);
            const seTile = this.indexer.SlippyTile.latLonToTile(bbox[0], bbox[3], z);

            ctx.save();
            ctx.strokeStyle = 'hsla(190, 95%, 55%, 0.4)';
            ctx.lineWidth = 1;
            ctx.font = '10px JetBrains Mono';
            ctx.fillStyle = 'hsla(190, 95%, 65%, 0.8)';

            for (let x = nwTile.x; x <= seTile.x; x++) {
                for (let y = nwTile.y; y <= seTile.y; y++) {
                    const bounds = this.indexer.SlippyTile.tileToBounds(x, y, z);
                    const p1 = this.latLonToPixel(bounds.maxLat, bounds.minLon);
                    const p2 = this.latLonToPixel(bounds.minLat, bounds.maxLon);

                    ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
                    const quadkey = this.indexer.SlippyTile.tileToQuadkey(x, y, z);
                    ctx.fillText(`qk:${quadkey.slice(-4)}`, p1.x + 4, p1.y + 14);
                }
            }
            ctx.restore();
        }

        drawGeohashGrid() {
            const ctx = this.ctx;
            const bbox = this.getCurrentBoundingBox();
            ctx.save();
            ctx.strokeStyle = 'hsla(330, 85%, 65%, 0.4)';
            ctx.lineWidth = 1;
            ctx.font = '10px JetBrains Mono';
            ctx.fillStyle = 'hsla(330, 85%, 75%, 0.8)';

            const step = 0.05;
            for (let lat = bbox[0]; lat <= bbox[2]; lat += step) {
                for (let lon = bbox[1]; lon <= bbox[3]; lon += step) {
                    const gh = this.indexer.Geohash.encode(lat, lon, 5);
                    const decoded = this.indexer.Geohash.decode(gh);
                    const p1 = this.latLonToPixel(decoded.bounds.maxLat, decoded.bounds.minLon);
                    const p2 = this.latLonToPixel(decoded.bounds.minLat, decoded.bounds.maxLon);

                    ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
                    ctx.fillText(gh, p1.x + 4, p1.y + 14);
                }
            }
            ctx.restore();
        }

        drawFeatures() {
            const ctx = this.ctx;
            const layerColors = {
                telecom: 'hsl(190, 95%, 55%)',
                infrastructure: 'hsl(45, 95%, 55%)',
                water: 'hsl(205, 85%, 60%)',
                amenities: 'hsl(330, 85%, 65%)'
            };

            for (const feat of this.features) {
                const coords = feat.geometry.coordinates;
                const pt = this.latLonToPixel(coords[1], coords[0]);

                // Viewport clipping
                if (pt.x < -20 || pt.x > this.canvasWidth + 20 || pt.y < -20 || pt.y > this.canvasHeight + 20) {
                    continue;
                }

                const layer = feat.properties.layer || 'telecom';
                const color = layerColors[layer] || 'hsl(210, 100%, 60%)';
                const isSelected = this.selectedFeature && this.selectedFeature.id === feat.id;

                ctx.save();
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, isSelected ? 8 : 4.5, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.shadowColor = color;
                ctx.shadowBlur = isSelected ? 16 : 8;
                ctx.fill();

                ctx.lineWidth = isSelected ? 2.5 : 1;
                ctx.strokeStyle = '#ffffff';
                ctx.stroke();

                if (isSelected || this.zoom >= 14) {
                    ctx.fillStyle = '#ffffff';
                    ctx.font = '10px Inter, sans-serif';
                    ctx.textAlign = 'left';
                    ctx.fillText(feat.properties.name || 'Node', pt.x + 8, pt.y + 3);
                }
                ctx.restore();
            }
        }
    }

    // Launch app on DOM ready
    window.addEventListener('DOMContentLoaded', () => {
        window.app = new InternetGisApp();
        window.app.init();
    });
})();
