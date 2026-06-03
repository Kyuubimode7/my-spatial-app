const turf = require('@turf/turf');
const RBush = require('rbush').default;
const createGraph = require('ngraph.graph');
const { aStar } = require('ngraph.path');
const fs = require('fs');
const { json } = require('stream/consumers');

const inputRoad = JSON.parse(fs.readFileSync('./geojsons/input/laturRoad.geojson','utf-8'));
const inputHospital = JSON.parse(fs.readFileSync('./geojsons/input/laturHospital.geojson','utf-8'));
const inputSubdist = JSON.parse(fs.readFileSync('./geojsons/input/laturSubdistrict.geojson','utf-8'));
const hyderabadMR = JSON.parse(fs.readFileSync('./geojsons/input/Hydrabad_MR.geojson','utf-8'));
const puneMR = JSON.parse(fs.readFileSync('./geojsons/input/Pune_MR.geojson','utf-8'));

const CLUSTER_RADIUS = 0.4; // km — hospitals within this distance are merged into one point

function mergeToPoint(features) {
    return turf.centroid(turf.featureCollection(features));
}

function isInRegion(pt, regionGeoJson) {
    return regionGeoJson.features.some((poly) => turf.booleanPointInPolygon(pt, poly));
}

const hyderabadHospitals = inputHospital.features.filter((h) => isInRegion(h, hyderabadMR));
const puneHospitals = inputHospital.features.filter((h) => isInRegion(h, puneMR));
const otherHospitals = inputHospital.features.filter(
    (h) => !isInRegion(h, hyderabadMR) && !isInRegion(h, puneMR)
);

const mergedPoints = [];

if (hyderabadHospitals.length > 0) mergedPoints.push(mergeToPoint(hyderabadHospitals));
if (puneHospitals.length > 0) mergedPoints.push(mergeToPoint(puneHospitals));

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


let network = [...inputRoad.features];

const SEARCH_RADIUS = 0.1; // degrees, ~11km — expand if roads are missed

function buildIndex(roads) {
    const tree = new RBush();
    const items = roads.map((road, index) => {
        const [minX, minY, maxX, maxY] = turf.bbox(road);
        return { minX, minY, maxX, maxY, index };
    });
    tree.load(items);
    return tree;
}

function splitNetworkWithPoints(pts) {
    let tree = buildIndex(network);
    const snappedPts = pts.map((shatterPt) => {
        const [px, py] = shatterPt.geometry.coordinates;
        const candidates = tree.search({
            minX: px - SEARCH_RADIUS,
            minY: py - SEARCH_RADIUS,
            maxX: px + SEARCH_RADIUS,
            maxY: py + SEARCH_RADIUS,
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
                // use the actual coordinate from the split result — guaranteed to be a graph node
                const nodeCoord = splitResult.features[1].geometry.coordinates[0];
                return turf.point(nodeCoord, { ...shatterPt.properties });
            } else {
                // split failed — point is near an endpoint, use the closest endpoint of the road
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

console.time('road-splitting');
const snappedHospitals = splitNetworkWithPoints(mergedHospitals.features);
const snappedSubdist = splitNetworkWithPoints(vcSubdist.features);
console.timeEnd('road-splitting');

const subdistBbox = turf.bbox(inputSubdist);
const voronoiHospital = turf.voronoi(mergedHospitals, {bbox: subdistBbox});

voronoiHospital.features.forEach((polygon) => {
    const match = mergedHospitals.features.find((pt) =>
        turf.booleanPointInPolygon(pt, polygon)
    );
    if (match) {
        polygon.properties = { ...match.properties };
    } else {
        polygon.properties = { _unmatched: true };
    }
});

// build road graph — nodes are coordinate strings, edges are segments weighted by length
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

const pathFinder = aStar(graph, {
    distance: (_, __, link) => link.data.weight,
    heuristic: (from, to) => {
        const [fx, fy] = from.id.split(',').map(Number);
        const [tx, ty] = to.id.split(',').map(Number);
        return turf.distance(turf.point([fx, fy]), turf.point([tx, ty]));
    },
});

const careColor1 = '#3700ff';
const careColor2 = '#00b93e';
const careColor3 = '#ffa600';
const careColor4 = '#7c0d0d';

const careLineWeight1 = 6;
const careLineWeight2 = 5;
const careLineWeight3 = 4;
const careLineWeight4 = 3;

const dist1 = 50;   // km
const dist2 = 100;  // km
const dist3 = 200;  // km

const careBands = [
    { upTo: dist1, color: careColor1, weight: careLineWeight1 },
    { upTo: dist2, color: careColor2, weight: careLineWeight2 },
    { upTo: dist3, color: careColor3, weight: careLineWeight3 },
    { upTo: Infinity, color: careColor4, weight: careLineWeight4 },
];

// pre-build hospital _id → snapped node ID map
const hospitalNodeIds = new Map();
snappedHospitals.features.forEach((h) => {
    hospitalNodeIds.set(h.properties._id, h.geometry.coordinates.join(','));
});

console.time('routing');
const routeLines = snappedSubdist.features.map((subdistPt) => {
    const cell = voronoiHospital.features.find((polygon) =>
        turf.booleanPointInPolygon(subdistPt, polygon)
    );
    if (!cell || cell.properties._unmatched) return null;

    const fromId = subdistPt.geometry.coordinates.join(',');
    const toId = hospitalNodeIds.get(cell.properties._id);
    if (!fromId || !toId) return null;

    const result = pathFinder.find(fromId, toId);
    if (!result || result.length < 2) return null;

    // ngraph returns path reversed (dest→src), result[0] = hospital → subdistrict
    const coords = result.map((node) => node.id.split(',').map(Number));
    return turf.lineString(coords, { ...subdistPt.properties });
}).filter(Boolean);

console.timeEnd('routing');

const routeSegments = [];
routeLines.forEach((route) => {
    const totalLength = turf.length(route, { units: 'kilometers' });
    let prevDist = 0;
    for (const band of careBands) {
        if (prevDist >= totalLength) break;
        const endDist = Math.min(band.upTo, totalLength);
        const segment = turf.lineSliceAlong(route, prevDist, endDist, { units: 'kilometers' });
        segment.properties = {
            ...route.properties,
            careColor: band.color,
            careLineWeight: band.weight,
        };
        routeSegments.push(segment);
        prevDist = endDist;
    }
});

const routes = turf.featureCollection(routeSegments);

// deduplicated edges — each road segment assigned to the band closest to a hospital
// if two routes share an edge at different distances, the lower band (closer) wins
const edgeBandMap = new Map();
routeLines.forEach((route) => {
    const coords = route.geometry.coordinates;
    let cumDist = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        const segDist = turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]));
        const bandIndex = careBands.findIndex((b) => cumDist < b.upTo);
        const edgeKey = [coords[i].join(','), coords[i + 1].join(',')].sort().join('|');
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
        careColor: band.color,
        careLineWeight: band.weight,
    }));
});

const routesDissolved = turf.featureCollection(dissolvedSegments);

const updatedRoads = turf.featureCollection(network);

fs.writeFileSync('./geojsons/output/mergedHospitals.geojson', JSON.stringify(mergedHospitals));
fs.writeFileSync('./geojsons/output/visualcenters.geojson', JSON.stringify(vcSubdist));
fs.writeFileSync('./geojsons/output/cutroads.geojson', JSON.stringify(updatedRoads));
fs.writeFileSync('./geojsons/output/voronoi.geojson', JSON.stringify(voronoiHospital));
fs.writeFileSync('./geojsons/output/routes.geojson', JSON.stringify(routes));
fs.writeFileSync('./geojsons/output/routesDissolved.geojson', JSON.stringify(routesDissolved));
fs.writeFileSync('./geojsons/output/routesRaw.geojson', JSON.stringify(turf.featureCollection(routeLines)));
