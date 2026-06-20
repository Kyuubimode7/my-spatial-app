import * as turf from '@turf/turf';
import RBush from 'rbush';
import createGraph from 'ngraph.graph';
import { aStar } from 'ngraph.path';
import { fetchMetroRegions, fetchIndiaBoundary, fetchSubdistrictBoundaries } from '../lib/fetchSpatial';

const DEFAULT_CLUSTER_RADIUS = 0.4;
const DEFAULT_SEARCH_RADIUS = 0.1;

// India-clipped Voronoi repair tuning.
const BOUNDARY_TOLERANCE = 0.01;   // deg (~1km) — India outline simplification for clipping
const MIN_PIECE_AREA     = 1e5;    // m² (0.1 km²) — ignore clip slivers smaller than this as orphans
const OVERLAP_TOLERANCE  = 0.001;  // km — turf.lineOverlap tolerance for shared-border length

const careBands = [
    { upTo: 50,       color: '#3700ff', weight: 6 },
    { upTo: 100,      color: '#00b93e', weight: 5 },
    { upTo: 200,      color: '#ffa600', weight: 4 },
    { upTo: Infinity, color: '#7c0d0d', weight: 3 },
];

function mergeToPoint(features) {
    return turf.centroid(turf.featureCollection(features));
}

// ── Per-cell cache ───────────────────────────────────────────────────────────
// Keyed by `${filterSig}|${regionLabel}|${polygonHash}`. A cell's cached routes
// stay valid as long as its filter, cluster label, and catchment polygon are
// unchanged — so adding/moving a point only invalidates the few cells near it.
const CELL_CACHE_CAP = 2000;
const CLIP_CACHE_CAP = 2000;
const cellCache = new Map(); // cellSig -> { features, bands }
const clipCache = new Map(); // unclipped cell hash -> { pieces: Polygon[] }

function lruGet(map, key) {
    if (!map.has(key)) return undefined;
    const v = map.get(key);
    map.delete(key);   // LRU: re-insert as most-recently-used
    map.set(key, v);
    return v;
}

function lruSet(map, key, v, cap) {
    map.set(key, v);
    if (map.size > cap) {
        map.delete(map.keys().next().value); // evict oldest
    }
}

// India national outline, fetched once and simplified for fast Voronoi clipping.
let indiaBoundary = null;
async function ensureIndiaBoundary() {
    if (indiaBoundary) return indiaBoundary;
    let b = await fetchIndiaBoundary();
    if (b && b.type === 'FeatureCollection') {
        b = b.features.length === 1 ? b.features[0] : turf.union(turf.featureCollection(b.features));
    }
    try {
        b = turf.simplify(b, { tolerance: BOUNDARY_TOLERANCE, highQuality: false, mutate: true });
    } catch (e) {
        console.warn('[turf] india boundary simplify failed:', e?.message);
    }
    indiaBoundary = b;
    return indiaBoundary;
}

function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

// Hash any Polygon/MultiPolygon feature or geometry by all its coordinates.
function polygonHash(featureOrGeom) {
    const coords = turf.coordAll(featureOrGeom);
    let s = '';
    for (const c of coords) s += c[0].toFixed(6) + ',' + c[1].toFixed(6) + ';';
    return hashStr(s);
}

// Stable hash for a repaired region (one or more polygon pieces).
function regionHash(pieces) {
    return pieces.map((p) => polygonHash(p)).sort().join('|');
}

// ── Road segment index (built once per session) ──────────────────────────────
let roadTree = null;       // RBush over segment bboxes (reserved for future use)
let roadSig = null;
let roadSegments = null;    // array of [ [x,y], [x,y] ] coordinate pairs

function ensureRoadIndex(roadFC) {
    const first = roadFC.features[0]?.geometry?.coordinates?.[0];
    const sig = roadFC.features.length + ':' + (Array.isArray(first) ? first.join(',') : '');
    if (roadSegments && roadSig === sig) return;
    roadSig = sig;

    const segs = [];
    const items = [];
    roadFC.features.forEach((road) => {
        const coords = road.geometry.coordinates;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i], b = coords[i + 1];
            items.push({
                minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]),
                maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]),
                idx: segs.length,
            });
            segs.push([a, b]);
        }
    });
    roadSegments = segs;
    roadTree = new RBush();
    roadTree.load(items);
}

// ── Dissolve routes into deduplicated, banded, chained polylines ─────────────
function dissolveRoutes(routeLines) {
    const edgeBandMap = new Map();
    routeLines.forEach((route) => {
        const coords = route.geometry.coordinates;
        let cumDist = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            const segDist   = turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]));
            const bandIndex = careBands.findIndex((b) => cumDist < b.upTo);
            const edgeKey   = [coords[i].join(','), coords[i + 1].join(',')].sort().join('|');
            if (!edgeBandMap.has(edgeKey) || bandIndex < edgeBandMap.get(edgeKey).bandIndex) {
                edgeBandMap.set(edgeKey, { bandIndex, coordA: coords[i], coordB: coords[i + 1] });
            }
            cumDist += segDist;
        }
    });

    // Group edges by band, then chain adjacent degree-2 edges into longer polylines.
    const byBand = new Map();
    edgeBandMap.forEach(({ bandIndex, coordA, coordB }) => {
        if (!byBand.has(bandIndex)) byBand.set(bandIndex, []);
        byBand.get(bandIndex).push([coordA, coordB]);
    });

    const dissolvedSegments = [];
    const ek = (a, b) => (a < b ? `${a}§${b}` : `${b}§${a}`);

    byBand.forEach((edges, bandIndex) => {
        const band = careBands[bandIndex];
        const adj      = new Map();
        const coordMap = new Map();
        const usedEdge = new Set();

        edges.forEach(([a, b]) => {
            const ak = a.join(','), bk = b.join(',');
            coordMap.set(ak, a); coordMap.set(bk, b);
            if (!adj.has(ak)) adj.set(ak, new Set());
            if (!adj.has(bk)) adj.set(bk, new Set());
            adj.get(ak).add(bk);
            adj.get(bk).add(ak);
        });

        adj.forEach((_, startKey) => {
            adj.get(startKey).forEach((neighborKey) => {
                const key = ek(startKey, neighborKey);
                if (usedEdge.has(key)) return;
                usedEdge.add(key);

                const chain = [coordMap.get(startKey), coordMap.get(neighborKey)];
                let curr = neighborKey;
                while (true) {
                    const nexts = [...(adj.get(curr) || [])].filter((n) => !usedEdge.has(ek(curr, n)));
                    if (nexts.length !== 1) break;
                    const next = nexts[0];
                    usedEdge.add(ek(curr, next));
                    chain.push(coordMap.get(next));
                    curr = next;
                }

                dissolvedSegments.push(turf.lineString(chain, {
                    careColor:      band.color,
                    careLineWeight: band.weight,
                }));
            });
        });
    });

    return dissolvedSegments;
}

// ── Route one cell: build a subgraph from its road slice, A* every POI to the
//    cell centroid, dissolve to banded polylines. Self-contained (worker-ready).
function computeCell(cellSegs, centroid, poisInCell, searchRadius) {
    const bands = {}; // master_id -> care band index (by routed distance, straight-line fallback)
    const straightBands = () => {
        poisInCell.forEach((poi) => {
            const mid = poi.properties.master_id;
            if (!mid) return;
            const distKm = turf.distance(poi, centroid, { units: 'kilometers' });
            bands[mid] = careBands.findIndex((b) => distKm < b.upTo);
        });
        return { features: [], bands };
    };

    if (cellSegs.length === 0 || poisInCell.length === 0) return straightBands();

    const graph = createGraph();
    cellSegs.forEach(([a, b]) => {
        const ak = a.join(','), bk = b.join(',');
        const weight = turf.distance(turf.point(a), turf.point(b));
        graph.addLink(ak, bk, { weight });
        graph.addLink(bk, ak, { weight });
    });

    const nodeItems = [];
    graph.forEachNode((n) => {
        const [x, y] = n.id.split(',').map(Number);
        nodeItems.push({ minX: x, minY: y, maxX: x, maxY: y, id: n.id });
    });
    if (nodeItems.length === 0) return straightBands();
    const nodeTree = new RBush();
    nodeTree.load(nodeItems);

    function nearestNodeId(coord) {
        const [px, py] = coord;
        const r = searchRadius;
        const candidates = nodeTree.search({ minX: px - r, minY: py - r, maxX: px + r, maxY: py + r });
        if (!candidates.length) return null;
        let best = null, minD = Infinity;
        candidates.forEach((c) => {
            const dx = c.id.split(',')[0] - px;
            const dy = c.id.split(',')[1] - py;
            const d = dx * dx + dy * dy;
            if (d < minD) { minD = d; best = c.id; }
        });
        return best;
    }

    const toId = nearestNodeId(centroid.geometry.coordinates);
    if (!toId) return straightBands();

    const pathFinder = aStar(graph, {
        distance: (_, __, link) => link.data.weight,
        heuristic: (from, to) => {
            const [fx, fy] = from.id.split(',').map(Number);
            const [tx, ty] = to.id.split(',').map(Number);
            return turf.distance(turf.point([fx, fy]), turf.point([tx, ty]));
        },
    });

    const routeLines = [];
    poisInCell.forEach((poi) => {
        const mid = poi.properties.master_id;
        const fromId = nearestNodeId(poi.geometry.coordinates);
        let routed = null;
        if (fromId) {
            const result = pathFinder.find(fromId, toId);
            if (result && result.length >= 2) {
                const coords = result.map((node) => node.id.split(',').map(Number));
                routed = turf.lineString(coords, { ...poi.properties });
            }
        }
        if (routed) {
            routeLines.push(routed);
            const distKm = turf.length(routed, { units: 'kilometers' });
            if (mid) bands[mid] = careBands.findIndex((b) => distKm < b.upTo);
        } else if (mid) {
            // Unroutable POI — fall back to straight-line band so it's still coloured.
            const distKm = turf.distance(poi, centroid, { units: 'kilometers' });
            bands[mid] = careBands.findIndex((b) => distKm < b.upTo);
        }
    });

    return { features: dissolveRoutes(routeLines), bands };
}

export async function solveCarePathway(hospitalsStr, roadsStr, subdistStr, settings = {}, filterSig = '') {
    const CLUSTER_RADIUS = settings.clusterRadius ?? DEFAULT_CLUSTER_RADIUS;
    const SEARCH_RADIUS  = settings.searchRadius  ?? DEFAULT_SEARCH_RADIUS;
    const inputHospital = JSON.parse(hospitalsStr);
    const inputRoad     = JSON.parse(roadsStr);
    const inputSubdist  = JSON.parse(subdistStr);

    console.log('[turf] inputs — hospitals:', inputHospital.features.length, 'roads:', inputRoad.features.length, 'subdist:', inputSubdist.features.length);

    const metroRegions = await fetchMetroRegions();
    console.log('[turf] metro regions loaded:', metroRegions.features.length);

    ensureRoadIndex(inputRoad);

    // --- Hospital clustering ---
    // Merge all hospitals within each metro region into a single centroid.
    // Remaining hospitals (outside all metro regions) go through DBSCAN.
    const mergedPoints = [];
    const assignedIdxSet = new Set();

    metroRegions.features.forEach((regionFeature) => {
        const inRegion = inputHospital.features
            .map((h, i) => ({ h, i }))
            .filter(({ h }) => turf.booleanPointInPolygon(h, regionFeature));
        if (inRegion.length === 0) return;
        inRegion.forEach(({ i }) => assignedIdxSet.add(i));
        const c = mergeToPoint(inRegion.map(({ h }) => h));
        c.properties.regionLabel = regionFeature.properties?.name ?? 'metro';
        mergedPoints.push(c);
    });

    const otherHospitals = inputHospital.features.filter((_, i) => !assignedIdxSet.has(i));

    if (otherHospitals.length > 0) {
        const clustered = turf.clustersDbscan(
            turf.featureCollection(otherHospitals),
            CLUSTER_RADIUS,
            { units: 'kilometers', minPoints: 1 }
        );
        const clusterMap = new Map();
        clustered.features.forEach((f, i) => {
            const key = f.properties.dbscan === 'noise' ? `noise_${i}` : `cluster_${f.properties.cluster}`;
            if (!clusterMap.has(key)) clusterMap.set(key, []);
            clusterMap.get(key).push(f);
        });
        clusterMap.forEach((pts) => {
            const c = mergeToPoint(pts);
            c.properties.regionLabel = 'dbscan';
            mergedPoints.push(c);
        });
    }

    const mergedHospitals = turf.featureCollection(mergedPoints);
    mergedHospitals.features.forEach((f, i) => { f.properties._id = i; });
    const centroids = mergedHospitals.features;
    console.log('[turf] clustering — metro regions used:', assignedIdxSet.size, 'other:', otherHospitals.length, 'merged total:', centroids.length);

    if (centroids.length === 0) {
        return { carepathway: turf.featureCollection([]) };
    }

    if (inputSubdist.features.length === 0) {
        console.warn('[turf] WARNING: 0 subdistrict POI points — check poi_subdistricts_view');
    }

    // --- Voronoi → India-clipped, orphan-repaired regions ---
    const subdistBbox = turf.bbox(inputSubdist);
    const voronoiHospital = turf.voronoi(mergedHospitals, { bbox: subdistBbox });
    const boundary = await ensureIndiaBoundary();

    function nearestCentroidId(coord) {
        let best = -1, min = Infinity;
        for (const c of centroids) {
            const dx = c.geometry.coordinates[0] - coord[0];
            const dy = c.geometry.coordinates[1] - coord[1];
            const d = dx * dx + dy * dy;
            if (d < min) { min = d; best = c.properties._id; }
        }
        return best;
    }

    // Clip one Voronoi cell to India → its polygon pieces (cached by unclipped hash).
    function clipCellToIndia(poly) {
        const key = polygonHash(poly);
        const hit = lruGet(clipCache, key);
        if (hit) return hit.pieces;
        let pieces = [];
        if (boundary) {
            try {
                const inter = turf.intersect(turf.featureCollection([poly, boundary]));
                if (inter) pieces = turf.flatten(inter).features;
            } catch (e) { /* leave empty on failure */ }
        }
        if (pieces.length === 0) pieces = turf.flatten(poly).features; // fallback: unclipped
        lruSet(clipCache, key, { pieces }, CLIP_CACHE_CAP);
        return pieces;
    }

    // Home piece (contains centroid) + orphan pieces per cell.
    const homePieces = []; // { cellId, regionLabel, poly }
    const orphans = [];    // { fromCellId, poly }
    voronoiHospital.features.forEach((poly) => {
        if (!poly) return;
        const match = centroids.find((pt) => turf.booleanPointInPolygon(pt, poly));
        if (!match) return;
        const cellId = match.properties._id;
        const regionLabel = match.properties.regionLabel ?? 'cell';
        const pieces = clipCellToIndia(poly);
        if (pieces.length === 0) return;

        let home = pieces.find((pc) => turf.booleanPointInPolygon(match, pc));
        if (!home) home = pieces.reduce((a, b) => (turf.area(a) >= turf.area(b) ? a : b));
        homePieces.push({ cellId, regionLabel, poly: home });
        pieces.forEach((pc) => {
            if (pc === home) return;
            if (turf.area(pc) < MIN_PIECE_AREA) return; // ignore clip slivers
            orphans.push({ fromCellId: cellId, poly: pc });
        });
    });

    const regionsByCell = new Map(); // cellId -> { regionLabel, pieces: Feature<Polygon>[] }
    homePieces.forEach(({ cellId, regionLabel, poly }) => {
        regionsByCell.set(cellId, { regionLabel, pieces: [poly] });
    });

    // Merge each orphan into the home piece it shares the longest border with.
    const homeTree = new RBush();
    homePieces.forEach((hp, i) => {
        const [minX, minY, maxX, maxY] = turf.bbox(hp.poly);
        homeTree.insert({ minX, minY, maxX, maxY, i });
    });
    orphans.forEach(({ fromCellId, poly }) => {
        const [minX, minY, maxX, maxY] = turf.bbox(poly);
        const cand = homeTree.search({ minX, minY, maxX, maxY });
        const orphanLine = turf.polygonToLine(poly);
        let bestId = -1, bestLen = -1;
        cand.forEach(({ i }) => {
            const hp = homePieces[i];
            if (hp.cellId === fromCellId) return; // must move to another cell
            let len = 0;
            try {
                const ov = turf.lineOverlap(orphanLine, turf.polygonToLine(hp.poly), { tolerance: OVERLAP_TOLERANCE });
                ov.features.forEach((f) => { len += turf.length(f, { units: 'kilometers' }); });
            } catch (e) { /* ignore */ }
            if (len > bestLen) { bestLen = len; bestId = hp.cellId; }
        });
        const target = bestId !== -1 && bestLen > 0 ? bestId : fromCellId;
        regionsByCell.get(target)?.pieces.push(poly);
    });

    // --- Assign roads & POIs to cells by containment in the repaired regions ---
    const regionTree = new RBush();
    regionsByCell.forEach((reg, cellId) => {
        reg.pieces.forEach((poly) => {
            const [minX, minY, maxX, maxY] = turf.bbox(poly);
            regionTree.insert({ minX, minY, maxX, maxY, poly, cellId });
        });
    });

    function assignCell(coord) {
        const pt = turf.point(coord);
        const cand = regionTree.search({ minX: coord[0], minY: coord[1], maxX: coord[0], maxY: coord[1] });
        for (const c of cand) {
            if (turf.booleanPointInPolygon(pt, c.poly)) return c.cellId;
        }
        return nearestCentroidId(coord); // fallback for clip-precision misses
    }

    const segsByCell = new Map();
    roadSegments.forEach((seg) => {
        const mx = (seg[0][0] + seg[1][0]) / 2;
        const my = (seg[0][1] + seg[1][1]) / 2;
        const id = assignCell([mx, my]);
        if (!segsByCell.has(id)) segsByCell.set(id, []);
        segsByCell.get(id).push(seg);
    });

    const poisByCell = new Map();
    inputSubdist.features.forEach((poi) => {
        const id = assignCell(poi.geometry.coordinates);
        if (!poisByCell.has(id)) poisByCell.set(id, []);
        poisByCell.get(id).push(poi);
    });

    // --- Per-cell compute with caching (keyed on the repaired region) ---
    console.time('routing');
    const allFeatures = [];
    const cellBandsById = {}; // cellId -> { master_id: bandIndex } (routed distance)
    let total = 0, cached = 0, recomputed = 0;

    regionsByCell.forEach((reg, cellId) => {
        total++;
        const cellSig = `${filterSig}|${reg.regionLabel}|${regionHash(reg.pieces)}`;
        let cellData = lruGet(cellCache, cellSig);
        if (cellData) {
            cached++;
        } else {
            cellData = computeCell(
                segsByCell.get(cellId) || [],
                centroids[cellId],
                poisByCell.get(cellId) || [],
                SEARCH_RADIUS
            );
            lruSet(cellCache, cellSig, cellData, CELL_CACHE_CAP);
            recomputed++;
        }
        for (const f of cellData.features) allFeatures.push(f);
        cellBandsById[cellId] = cellData.bands;
    });
    console.timeEnd('routing');
    console.log('[turf] cells — total:', total, 'cached:', cached, 'recomputed:', recomputed);

    const routesDissolved = turf.featureCollection(allFeatures);
    console.log('[turf] done — dissolved segments:', allFeatures.length);

    // Repaired regions for the overlay / catchment (already India-clipped).
    const voronoiOut = turf.featureCollection(
        [...regionsByCell.entries()].flatMap(([cellId, reg]) =>
            reg.pieces.map((poly) => turf.feature(poly.geometry, { _cellId: cellId, regionLabel: reg.regionLabel }))
        )
    );

    // Lightweight per-cell metadata for click-to-catchment: centroid, POI master_ids,
    // and each POI's care band (by routed road distance, computed in computeCell).
    const cells = centroids.map((c) => {
        const cellPois = poisByCell.get(c.properties._id) || [];
        return {
            centroid: c.geometry.coordinates,
            masterIds: cellPois.map((p) => p.properties.master_id).filter(Boolean),
            bands: cellBandsById[c.properties._id] || {},
        };
    });

    return {
        carepathway: routesDissolved,
        voronoi: voronoiOut,
        cells,
    };
}

// ── Catchment: union of a cell's subdistrict boundaries (cached by master_id set) ──
// Returns { outline, subdistricts }: the dissolved boundary + the individual polygons.
const CATCHMENT_OFFSET = 0.05; // km — buffer out/in to close sliver gaps between non-matching borders
const catchmentCache = new Map();
export async function getCellCatchment(masterIds) {
    const key = [...masterIds].sort().join(',');
    if (catchmentCache.has(key)) return catchmentCache.get(key);

    const fc = await fetchSubdistrictBoundaries(masterIds);
    let outline;
    if (fc.features.length === 0) {
        outline = turf.featureCollection([]);
    } else if (fc.features.length === 1) {
        outline = turf.featureCollection([fc.features[0]]);
    } else {
        try {
            // Offset each boundary out, union (so adjacent ones overlap cleanly), then offset back.
            const buffered = turf.buffer(turf.featureCollection(fc.features), CATCHMENT_OFFSET, { units: 'kilometers' });
            const valid = buffered.features.filter((f) => f && f.geometry);
            let u = turf.union(turf.featureCollection(valid));
            const shrunk = turf.buffer(u, -CATCHMENT_OFFSET, { units: 'kilometers' });
            outline = turf.featureCollection([shrunk && shrunk.geometry ? shrunk : u]);
        } catch (e) {
            console.warn('[turf] catchment union failed:', e?.message);
            outline = fc; // fall back to undissolved boundaries
        }
    }

    let areaKm2 = 0;
    try { areaKm2 = turf.area(outline) / 1e6; } catch { /* ignore */ }

    const result = { outline, subdistricts: fc, areaKm2 };
    catchmentCache.set(key, result);
    return result;
}

// Resolve the subdistrict name for a hospital at [lng, lat].
// 1) polygon containment against the catchment boundaries (has subdistrict_name);
// 2) fallback: nearest POI point's master_id, matched to a boundary name.
export function subdistrictNameAt(boundariesFC, lng, lat, poiFC) {
    const pt = turf.point([lng, lat]);
    const feats = boundariesFC?.features || [];
    for (const f of feats) {
        if (!f?.geometry) continue;
        try { if (turf.booleanPointInPolygon(pt, f)) return f.properties?.subdistrict_name || null; }
        catch { /* ignore */ }
    }
    // Fallback: nearest POI (restricted to catchment subdistricts) → name.
    const pois = poiFC?.features || [];
    if (!pois.length || !feats.length) return null;
    const nameById = new Map(feats.map((f) => [f.properties?.master_id, f.properties?.subdistrict_name]));
    let bestId = null, min = Infinity;
    for (const p of pois) {
        const id = p?.properties?.master_id;
        const c = p?.geometry?.coordinates;
        if (!c || !nameById.has(id)) continue;
        const dx = c[0] - lng, dy = c[1] - lat, d = dx * dx + dy * dy;
        if (d < min) { min = d; bestId = id; }
    }
    return bestId == null ? null : (nameById.get(bestId) || null);
}

// Returns the hospital features that fall inside a catchment outline FeatureCollection.
export function hospitalsInCatchment(outline, hospitalFeatures) {
    const polys = (outline?.features || []).filter((f) => f?.geometry);
    if (!polys.length || !hospitalFeatures?.length) return [];
    return hospitalFeatures.filter((h) => {
        const c = h?.geometry?.coordinates;
        if (!c) return false;
        const pt = turf.point(c);
        return polys.some((poly) => {
            try { return turf.booleanPointInPolygon(pt, poly); }
            catch { return false; }
        });
    });
}
