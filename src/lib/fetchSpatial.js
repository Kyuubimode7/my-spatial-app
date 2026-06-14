import { supabase } from './supabase';

function toFC(rows, propsFn) {
    return {
        type: 'FeatureCollection',
        features: rows.map(row => ({
            type: 'Feature',
            geometry: JSON.parse(row.geometry),
            properties: propsFn(row),
        })),
    };
}

async function fetchAll(viewName) {
    const pageSize = 1000;
    let from = 0;
    let all = [];
    while (true) {
        const { data, error } = await supabase
            .from(viewName)
            .select('*')
            .range(from, from + pageSize - 1);
        if (error) throw error;
        all = all.concat(data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return all;
}

export async function fetchHospitals() {
    const rows = await fetchAll('hospitals_view');
    return toFC(rows, row => ({
        name: row.name,
        'Hospital Type': row.hospital_type,
        'Bed Count': row.bed_count,
        'ICU Bed Count': row.icu_bed_count,
        'ot count': row.ot_count,
        'Doctor Count': row.doctor_count,
        'Staff Count': row.staff_count,
        city: row.city,
        state: row.state,
        subdistrict: row.subdistrict,
        Links: row.links,
        description: row.description,
        'Built up area  ( sq ft )': row.built_up_area,
        'Regional Hospital': row.regional_h,
        'Year Established': row.year_established,
        Accreditation: row.accreditation,
        'Empanelment Type': row.empanelment,
        'Radiation Oncology': row.radiation,
        'Medical Oncology': row.medical_oncology,
        'Surgical Oncology': row.surgical_oncology,
        'Medical Education': row.medical_edu,
        'Medical Research': row.medical_research,
        Mammography: row.mammography,
        'CT-Scan': row.ct_scan,
        MRI: row.mri,
        'PET-CT': row.pet_ct,
        Ultrasound: row.ultrasound,
        Brachytherapy: row.brachytherapy,
        'Palliative Care': row.palliative,
        'Bone Marrow Transplant': row.bone_marrow,
    }));
}

export async function fetchMetroRegions() {
    const rows = await fetchAll('metro_regions_view');
    return toFC(rows, row => ({ id: row.id, name: row.name }));
}

export async function fetchIndiaBoundary() {
    const rows = await fetchAll('india_boundary_view');
    // One (or more) boundary rows merged into a single Feature for clipping.
    const fc = toFC(rows, row => ({ id: row.id }));
    return fc.features.length === 1 ? fc.features[0] : fc;
}

export async function fetchPoiSubdistricts() {
    const rows = await fetchAll('poi_subdistricts_view');
    return toFC(rows, row => ({
        master_id: row.master_id,
        subdistrict_name: row.subdistrict_name,
        pc11_subdistrict_id: row.pc11_subdistrict_id,
    }));
}

export async function fetchSubdistrictBoundaries(masterIds) {
    if (!masterIds?.length) return { type: 'FeatureCollection', features: [] };
    const chunk = 200; // keep .in() lists reasonable
    let rows = [];
    for (let i = 0; i < masterIds.length; i += chunk) {
        const { data, error } = await supabase
            .from('subdistrict_boundaries_view')
            .select('*')
            .in('master_id', masterIds.slice(i, i + chunk));
        if (error) throw error;
        rows = rows.concat(data);
    }
    return toFC(rows, row => ({ master_id: row.master_id, subdistrict_name: row.subdistrict_name }));
}

export async function fetchSplitRoads() {
    const rows = await fetchAll('roads_split_view');
    return {
        type: 'FeatureCollection',
        features: rows.map(row => ({
            type: 'Feature',
            geometry: JSON.parse(row.geometry),
            properties: { is_connector: row.is_connector },
        })),
    };
}
