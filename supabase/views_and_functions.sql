-- =============================================================================
-- Views and functions for my-spatial-app
-- Run sections in order when setting up from scratch.
-- Safe to re-run: all statements use CREATE OR REPLACE / IF NOT EXISTS.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. HOSPITALS VIEW
-- Exposes hospital rows as GeoJSON geometry + all attribute columns.
-- Consumed by fetchHospitals() in src/lib/fetchSpatial.js
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW hospitals_view AS
SELECT
    id,
    ST_AsGeoJSON(geom)      AS geometry,
    name,
    hospital_type,
    bed_count,
    icu_bed_count,
    ot_count,
    doctor_count,
    staff_count,
    city,
    state,
    subdistrict,
    links,
    description,
    built_up_area,
    regional_h,
    year_established,
    accreditation,
    empanelment,
    radiation,
    medical_oncology,
    surgical_oncology,
    medical_edu,
    medical_research,
    mammography,
    ct_scan,
    mri,
    pet_ct,
    ultrasound,
    brachytherapy,
    palliative,
    bone_marrow
FROM hospitals;


-- -----------------------------------------------------------------------------
-- 2. METRO REGIONS VIEW
-- Polygon features for metro areas used in hospital clustering.
-- Consumed by fetchMetroRegions() in src/lib/fetchSpatial.js
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW metro_regions_view AS
SELECT
    id,
    ST_AsGeoJSON(geom)  AS geometry,
    name
FROM metro_regions;


-- -----------------------------------------------------------------------------
-- 3. POI SUBDISTRICTS VIEW
-- Visual centre points for each subdistrict (already Points in the table).
-- Consumed by fetchPoiSubdistricts() in src/lib/fetchSpatial.js
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW poi_subdistricts_view AS
SELECT
    id,
    ST_AsGeoJSON(geom)      AS geometry,
    master_id,
    subdistrict_name,
    pc11_subdistrict_id
FROM poi_subdistricts;


-- -----------------------------------------------------------------------------
-- 3b. INDIA BOUNDARY VIEW
-- National outline polygon used to clip Voronoi catchments to India's shape.
-- Consumed by fetchIndiaBoundary() in src/lib/fetchSpatial.js
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW india_boundary_view AS
SELECT
    id,
    ST_AsGeoJSON(geom)  AS geometry
FROM india_boundary;


-- -----------------------------------------------------------------------------
-- 3c. SUBDISTRICT BOUNDARIES VIEW
-- Real subdistrict MultiPolygons, fetched by master_id on hospital click and
-- unioned into a catchment outline.
-- Consumed by fetchSubdistrictBoundaries() in src/lib/fetchSpatial.js
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW subdistrict_boundaries_view AS
SELECT
    master_id,
    subdistrict_name,
    ST_AsGeoJSON(geom)  AS geometry
FROM subdistrict_boundaries;


-- -----------------------------------------------------------------------------
-- 4. ROADS SPLIT TABLE + VIEW
-- Pre-split road network stored in Supabase so the browser doesn't have to.
-- Populated by build_split_roads() below.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roads_split (
    id              bigserial PRIMARY KEY,
    geom            geometry(LineString, 4326) NOT NULL,
    is_connector    boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS roads_split_geom_gist ON roads_split USING GIST (geom);

DROP VIEW IF EXISTS roads_split_view;
CREATE VIEW roads_split_view AS
SELECT
    id,
    ST_AsGeoJSON(geom)  AS geometry,
    is_connector
FROM roads_split;


-- -----------------------------------------------------------------------------
-- 5. SPATIAL INDEX ON ROADS (required for KNN <-> operator in build function)
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS roads_geom_gist ON roads USING GIST (geom);


-- -----------------------------------------------------------------------------
-- 6. BUILD FUNCTION
-- Rebuilds roads_split from scratch by:
--   a) finding the nearest road to each hospital and POI (KNN)
--   b) splitting that road at the snap fraction
--   c) adding a connector edge from snap point -> original location
--
-- Call manually:  SELECT build_split_roads();
-- Also called by triggers below after data changes.
-- Disable triggers during bulk imports to avoid rebuilding per-batch:
--   ALTER TABLE hospitals DISABLE TRIGGER trg_hosp_split;
--   -- run import --
--   ALTER TABLE hospitals ENABLE TRIGGER trg_hosp_split;
--   SELECT build_split_roads();
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_hosp_split ON hospitals;
DROP TRIGGER IF EXISTS trg_poi_split  ON poi_subdistricts;
DROP FUNCTION IF EXISTS build_split_roads();

CREATE OR REPLACE FUNCTION build_split_roads()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DROP TABLE IF EXISTS _snap_points;

    -- Snap every hospital and POI to its nearest road segment
    CREATE TEMP TABLE _snap_points AS
    SELECT
        h.id::text                              AS point_id,
        'hospital'                              AS point_type,
        h.geom                                  AS orig_geom,
        ST_ClosestPoint(r.geom, h.geom)         AS snap_geom,
        r.id                                    AS road_id,
        ST_LineLocatePoint(r.geom, h.geom)      AS snap_frac
    FROM hospitals h
    CROSS JOIN LATERAL (
        SELECT id, geom FROM roads ORDER BY geom <-> h.geom LIMIT 1
    ) r

    UNION ALL

    SELECT
        p.id::text,
        'poi',
        p.geom,
        ST_ClosestPoint(r.geom, p.geom),
        r.id,
        ST_LineLocatePoint(r.geom, p.geom)
    FROM poi_subdistricts p
    CROSS JOIN LATERAL (
        SELECT id, geom FROM roads ORDER BY geom <-> p.geom LIMIT 1
    ) r;

    TRUNCATE roads_split;

    -- Roads with no snap point: keep whole
    INSERT INTO roads_split (geom, is_connector)
    SELECT geom, false
    FROM roads
    WHERE id NOT IN (SELECT DISTINCT road_id FROM _snap_points);

    -- Roads with a snap point: insert the two sub-segments
    INSERT INTO roads_split (geom, is_connector)
    SELECT ST_LineSubstring(r.geom, 0, sp.snap_frac), false
    FROM _snap_points sp
    JOIN roads r ON r.id = sp.road_id
    WHERE sp.snap_frac > 0.001

    UNION ALL

    SELECT ST_LineSubstring(r.geom, sp.snap_frac, 1), false
    FROM _snap_points sp
    JOIN roads r ON r.id = sp.road_id
    WHERE sp.snap_frac < 0.999;

    -- Connector edges: snap point -> original location (graph connectivity)
    INSERT INTO roads_split (geom, is_connector)
    SELECT ST_MakeLine(snap_geom, orig_geom), true
    FROM _snap_points;

    DROP TABLE IF EXISTS _snap_points;
END;
$$;


-- -----------------------------------------------------------------------------
-- 7. TRIGGER WRAPPER
-- Trigger functions must return TRIGGER, so this thin wrapper calls the main fn.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION build_split_roads_trg()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM build_split_roads();
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_hosp_split
    AFTER INSERT OR UPDATE OR DELETE ON hospitals
    FOR EACH STATEMENT EXECUTE FUNCTION build_split_roads_trg();

CREATE TRIGGER trg_poi_split
    AFTER INSERT OR UPDATE OR DELETE ON poi_subdistricts
    FOR EACH STATEMENT EXECUTE FUNCTION build_split_roads_trg();


-- -----------------------------------------------------------------------------
-- 8. INITIAL POPULATION (run once after setup or after bulk imports)
-- -----------------------------------------------------------------------------
-- SELECT build_split_roads();
