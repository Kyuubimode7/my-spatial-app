import * as turf from '@turf/turf';
import RBush from 'rbush';
import createGraph from 'ngraph.graph';
import { aStar } from 'ngraph.path';

const DEFAULT_CLUSTER_RADIUS = 0.4;
const DEFAULT_SEARCH_RADIUS = 0.1;

function mergeToPoint(features) {
    return turf.centroid(turf.featureCollection(features));
}

function isInRegion(pt, regionGeoJson) {
    return regionGeoJson.features.some((poly) => turf.booleanPointInPolygon(pt, poly));
}

function buildIndex(roads) {
    const tree = new RBush();
    const items = roads.map((road, index) => {
        const [minX, minY, maxX, maxY] = turf.bbox(road);
        return { minX, minY, maxX, maxY, index };
    });
    tree.load(items);
    return tree;
}

function splitNetworkWithPoints(network, pts, searchRadius) {
    let tree = buildIndex(network);
    const snappedPts = pts.map((shatterPt) => {
        const [px, py] = shatterPt.geometry.coordinates;
        const candidates = tree.search({
            minX: px - searchRadius,
            minY: py - searchRadius,
            maxX: px + searchRadius,
            maxY: py + searchRadius,
        });

        let minDistance = Infinity;
        let targetRoadIndex = -1;

        candidates.forEach(({ index }) => {
            const dist = turf.pointToLineDistance(shatterPt, network[index]);
            if (dist < minDistance) {
                minDistance = dist;
                targetRoadIndex = index;
            }
        });

        if (targetRoadIndex !== -1) {
            const roadToSplit = network[targetRoadIndex];
            const snapped = turf.nearestPointOnLine(roadToSplit, shatterPt);
            const splitResult = turf.lineSplit(roadToSplit, snapped);

            if (splitResult.features.length > 1) {
                network.splice(targetRoadIndex, 1);
                network.push(...splitResult.features);
                tree = buildIndex(network);
                const nodeCoord = splitResult.features[1].geometry.coordinates[0];
                return turf.point(nodeCoord, { ...shatterPt.properties });
            } else {
                const coords = roadToSplit.geometry.coordinates;
                const first = coords[0];
                const last = coords[coords.length - 1];
                const dFirst = turf.distance(shatterPt, turf.point(first));
                const dLast = turf.distance(shatterPt, turf.point(last));
                const nodeCoord = dFirst < dLast ? first : last;
                return turf.point(nodeCoord, { ...shatterPt.properties });
            }
        }
        return null;
    });
    return turf.featureCollection(snappedPts.filter(Boolean));
}

const careBands = [
    { upTo: 50,       color: '#3700ff', weight: 6 },
    { upTo: 100,      color: '#00b93e', weight: 5 },
    { upTo: 200,      color: '#ffa600', weight: 4 },
    { upTo: Infinity, color: '#7c0d0d', weight: 3 },
];

export async function solveCarePathway(hospitalsStr, roadsStr, subdistStr, settings = {}) {
    const CLUSTER_RADIUS = settings.clusterRadius ?? DEFAULT_CLUSTER_RADIUS;
    const SEARCH_RADIUS  = settings.searchRadius  ?? DEFAULT_SEARCH_RADIUS;
    const inputHospital = JSON.parse(hospitalsStr);
    const inputRoad     = JSON.parse(roadsStr);
    const inputSubdist  = JSON.parse(subdistStr);

    console.log('[turf] inputs — hospitals:', inputHospital.features.length, 'roads:', inputRoad.features.length, 'subdist:', inputSubdist.features.length);

    const base = import.meta.env.BASE_URL;
    const [hyderabadMR, puneMR] = await Promise.all([
        fetch(`${base}Hydrabad_MR.geojson`).then((r) => r.json()),
        fetch(`${base}Pune_MR.geojson`).then((r) => r.json()),
    ]);
    console.log('[turf] MR regions — hyderabad:', hyderabadMR.features.length, 'pune:', puneMR.features.length);

    // --- Hospital clustering ---
    const hyderabadHospitals = inputHospital.features.filter((h) => isInRegion(h, hyderabadMR));
    const puneHospitals      = inputHospital.features.filter((h) => isInRegion(h, puneMR));
    const otherHospitals     = inputHospital.features.filter(
        (h) => !isInRegion(h, hyderabadMR) && !isInRegion(h, puneMR)
    );

    const mergedPoints = [];
    if (hyderabadHospitals.length > 0) mergedPoints.push(mergeToPoint(hyderabadHospitals));
    if (puneHospitals.length > 0)      mergedPoints.push(mergeToPoint(puneHospitals));

    if (otherHospitals.length > 0) {
        const clustered = turf.clustersDbscan(
            turf.featureCollection(otherHospitals),
            CLUSTER_RADIUS,
            { units: 'kilometers' }
        );
        const clusterMap = new Map();
        clustered.features.forEach((f, i) => {
            const key = f.properties.dbscan === 'noise' ? `noise_${i}` : `cluster_${f.properties.cluster}`;
            if (!clusterMap.has(key)) clusterMap.set(key, []);
            clusterMap.get(key).push(f);
        });
        clusterMap.forEach((pts) => mergedPoints.push(mergeToPoint(pts)));
    }

    const mergedHospitals = turf.featureCollection(mergedPoints);
    mergedHospitals.features.forEach((f, i) => { f.properties._id = i; });
    console.log('[turf] clustering — hyderabad:', hyderabadHospitals.length, 'pune:', puneHospitals.length, 'other:', otherHospitals.length, 'merged total:', mergedPoints.length);

    // --- Subdistrict visual centres ---
    const withWkt = inputSubdist.features.filter(f => f.properties.POA_WKT).length;
    const vcSubdist = turf.featureCollection(
        inputSubdist.features
            .map((f) => {
                const wkt = f.properties.POA_WKT;
                if (!wkt) return null;
                const [lng, lat] = wkt
                    .replace(/point \(/i, '')
                    .replace(')', '')
                    .split(' ')
                    .map(Number);
                return turf.point([lng, lat], { ...f.properties });
            })
            .filter(Boolean)
    );
    console.log('[turf] vcSubdist — total:', inputSubdist.features.length, 'with POA_WKT:', withWkt, 'vc points:', vcSubdist.features.length);
    if (vcSubdist.features.length === 0) console.warn('[turf] WARNING: 0 subdistrict visual centres — POA_WKT missing; check sample props:', inputSubdist.features[0]?.properties);

    // --- Road network splitting ---
    const network = [...inputRoad.features];

    console.time('road-splitting');
    const snappedHospitals = splitNetworkWithPoints(network, mergedHospitals.features, SEARCH_RADIUS);
    const snappedSubdist   = splitNetworkWithPoints(network, vcSubdist.features, SEARCH_RADIUS);
    console.timeEnd('road-splitting');
    console.log('[turf] after splitting — snapped hospitals:', snappedHospitals.features.length, 'snapped subdist:', snappedSubdist.features.length, 'network segments:', network.length);

    // --- Voronoi hospital catchments ---
    const subdistBbox = turf.bbox(inputSubdist);
    const voronoiHospital = turf.voronoi(mergedHospitals, { bbox: subdistBbox });
    voronoiHospital.features.forEach((polygon) => {
        const match = mergedHospitals.features.find((pt) =>
            turf.booleanPointInPolygon(pt, polygon)
        );
        polygon.properties = match ? { ...match.properties } : { _unmatched: true };
    });
    console.log('[turf] voronoi cells:', voronoiHospital.features.length, 'unmatched:', voronoiHospital.features.filter(f => f.properties._unmatched).length);

    // --- Road graph ---
    const graph = createGraph();
    network.forEach((road) => {
        const coords = road.geometry.coordinates;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i].join(',');
            const b = coords[i + 1].join(',');
            const weight = turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]));
            graph.addLink(a, b, { weight });
            graph.addLink(b, a, { weight });
        }
    });
    let nodeCount = 0, linkCount = 0;
    graph.forEachNode(() => nodeCount++);
    graph.forEachLink(() => linkCount++);
    console.log('[turf] graph — nodes:', nodeCount, 'links:', linkCount);

    const pathFinder = aStar(graph, {
        distance: (_, __, link) => link.data.weight,
        heuristic: (from, to) => {
            const [fx, fy] = from.id.split(',').map(Number);
            const [tx, ty] = to.id.split(',').map(Number);
            return turf.distance(turf.point([fx, fy]), turf.point([tx, ty]));
        },
    });

    // --- A* routing ---
    const hospitalNodeIds = new Map();
    snappedHospitals.features.forEach((h) => {
        hospitalNodeIds.set(h.properties._id, h.geometry.coordinates.join(','));
    });

    console.time('routing');
    const routeLines = snappedSubdist.features.map((subdistPt, i) => {
        const cell = voronoiHospital.features.find((polygon) =>
            turf.booleanPointInPolygon(subdistPt, polygon)
        );
        if (i === 0) console.log('[turf] routing sample[0] — cell found:', !!cell, 'unmatched:', cell?.properties?._unmatched);
        if (!cell || cell.properties._unmatched) return null;

        const fromId = subdistPt.geometry.coordinates.join(',');
        const toId   = hospitalNodeIds.get(cell.properties._id);
        if (i === 0) console.log('[turf] routing sample[0] — fromId:', fromId, 'toId:', toId);
        if (!fromId || !toId) return null;

        const result = pathFinder.find(fromId, toId);
        if (i === 0) console.log('[turf] routing sample[0] — path nodes:', result?.length);
        if (!result || result.length < 2) return null;

        const coords = result.map((node) => node.id.split(',').map(Number));
        return turf.lineString(coords, { ...subdistPt.properties });
    }).filter(Boolean);
    console.timeEnd('routing');
    console.log('[turf] routing done — route lines:', routeLines.length, 'dissolved segments will follow');

    // --- Deduplicated edge band map ---
    const edgeBandMap = new Map();
    routeLines.forEach((route) => {
        const coords = route.geometry.coordinates;
        let cumDist = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            const segDist  = turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]));
            const bandIndex = careBands.findIndex((b) => cumDist < b.upTo);
            const edgeKey   = [coords[i].join(','), coords[i + 1].join(',')].sort().join('|');
            if (!edgeBandMap.has(edgeKey) || bandIndex < edgeBandMap.get(edgeKey).bandIndex) {
                edgeBandMap.set(edgeKey, { bandIndex, coordA: coords[i], coordB: coords[i + 1] });
            }
            cumDist += segDist;
        }
    });

    const dissolvedSegments = [];
    edgeBandMap.forEach(({ bandIndex, coordA, coordB }) => {
        const band = careBands[bandIndex];
        dissolvedSegments.push(turf.lineString([coordA, coordB], {
            careColor:      band.color,
            careLineWeight: band.weight,
        }));
    });

    const routesDissolved = turf.featureCollection(dissolvedSegments);
    console.log('[turf] done — dissolved segments:', dissolvedSegments.length);
    return { carepathway: routesDissolved };
}
