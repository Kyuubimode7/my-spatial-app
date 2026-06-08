import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, GeoJSON, Marker, Tooltip, useMapEvents, ZoomControl } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { solveCarePathway } from '../services/turfService';

// ── Constants ────────────────────────────────────────────────────────────────

const CARE_BANDS = [
    { color: '#3700ff', label: '0 – 50 km' },
    { color: '#00b93e', label: '50 – 100 km' },
    { color: '#ffa600', label: '100 – 200 km' },
    { color: '#7c0d0d', label: '200+ km' },
];

const HOSPITAL_TYPES = ['Public', 'Private (For Profit)', 'Private (Not for Profit)'];
const EMPANELMENT_OPTIONS = ['', 'PMJAY', 'Yes (Not Specified)'];

const BOOLEAN_FIELDS = [
    'Radiation Oncology', 'Medical Oncology', 'Surgical Oncology',
    'Medical Education', 'Medical Research', 'Mammography',
    'CT-Scan', 'MRI', 'PET-CT', 'Ultrasound', 'Brachytherapy',
    'Palliative Care', 'Bone Marrow Transplant',
];

const DEFAULT_PROPS = {
    name: '', 'Hospital Type': 'Public', city: '', state: 'Maharashtra',
    'Regional Hospital': false, 'Year Established': '', Links: '', description: '',
    'Bed Count': '', 'ICU Bed Count': '', 'ot count': '', 'Doctor Count': '',
    'Staff Count': '', 'Built up area  ( sq ft )': '', Accreditation: '',
    'Empanelment Type': '', 'Sub-District ID': '', 'Radiation Bunker LINAC': '',
    ...Object.fromEntries(BOOLEAN_FIELDS.map(f => [f, false])),
    source: 'user_added',
};

const FUNCTION_KEYS = ['carepathway', 'voronoi', 'weighted-voronoi', 'circles', 'fn5', 'fn6'];
const FUNCTION_NAMES = {
    'carepathway':      'Care Pathways',
    'voronoi':          'Voronoi',
    'weighted-voronoi': 'Weighted Voronoi',
    'circles':          'Overlapping Circles',
    'fn5':              'Function 5',
    'fn6':              'Function 6',
};

const BASEMAPS = {
    satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri',
        label: 'SAT',
    },
    terrain: {
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        attribution: '© OpenTopoMap contributors',
        label: 'TER',
    },
    osm: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© OpenStreetMap contributors',
        label: 'OSM',
    },
};

const baseHospitalIcon = L.divIcon({
    className: '',
    html: '<div style="width:10px;height:10px;background:#111;border:2px solid white;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.5)"></div>',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
});

const userHospitalIcon = L.divIcon({
    className: '',
    html: '<div style="width:12px;height:12px;background:#1d6ef5;border:2px solid white;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.5)"></div>',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
});

// ── Sub-components ────────────────────────────────────────────────────────────

function MapClickHandler({ activeToolMode, onAddClick }) {
    useMapEvents({
        click: (e) => { if (activeToolMode === 'add') onAddClick(e.latlng); },
    });
    return null;
}

function HospitalDialog({ dialogState, onSubmit, onClose }) {
    const [form, setForm] = useState(dialogState.data);
    const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

    const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 2, marginTop: 10 };
    const inputStyle = {
        width: '100%', padding: '4px 6px', boxSizing: 'border-box',
        fontSize: 13, border: '1px solid #ccc', borderRadius: 4, background: 'white', color: '#222',
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
            <div style={{
                background: 'white', borderRadius: 10, width: 480, maxHeight: '85vh',
                display: 'flex', flexDirection: 'column', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            }}>
                <div style={{ padding: '14px 18px', borderBottom: '1px solid #eee', fontWeight: 'bold', fontSize: 15 }}>
                    {dialogState.mode === 'add' ? 'Add Hospital' : 'Edit Hospital'}
                </div>

                <div style={{ padding: '10px 18px', overflowY: 'auto', flex: 1 }}>
                    <label style={labelStyle}>Name</label>
                    <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} />

                    <label style={labelStyle}>Hospital Type</label>
                    <select style={inputStyle} value={form['Hospital Type']} onChange={e => set('Hospital Type', e.target.value)}>
                        {HOSPITAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>

                    <label style={labelStyle}>City</label>
                    <input style={inputStyle} value={form.city} onChange={e => set('city', e.target.value)} />

                    <label style={labelStyle}>State</label>
                    <input style={inputStyle} value={form.state} onChange={e => set('state', e.target.value)} />

                    <label style={labelStyle}>Regional Hospital</label>
                    <select style={inputStyle} value={form['Regional Hospital'] ? 'yes' : 'no'} onChange={e => set('Regional Hospital', e.target.value === 'yes')}>
                        <option value="no">No</option>
                        <option value="yes">Yes</option>
                    </select>

                    <label style={labelStyle}>Year Established</label>
                    <input style={inputStyle} value={form['Year Established'] || ''} onChange={e => set('Year Established', e.target.value)} />

                    <label style={labelStyle}>Links</label>
                    <input style={inputStyle} value={form.Links || ''} onChange={e => set('Links', e.target.value)} />

                    <label style={labelStyle}>Description</label>
                    <textarea style={{ ...inputStyle, height: 56, resize: 'vertical' }} value={form.description || ''} onChange={e => set('description', e.target.value)} />

                    <div style={{ marginTop: 12, marginBottom: 4, fontWeight: 700, fontSize: 12, color: '#555', textTransform: 'uppercase', letterSpacing: 1 }}>Capacity</div>
                    {[
                        ['Bed Count', 'Bed Count'], ['ICU Bed Count', 'ICU Bed Count'],
                        ['ot count', 'OT Count'], ['Doctor Count', 'Doctor Count'],
                        ['Staff Count', 'Staff Count'], ['Radiation Bunker LINAC', 'Radiation Bunker LINAC'],
                    ].map(([key, label]) => (
                        <React.Fragment key={key}>
                            <label style={labelStyle}>{label}</label>
                            <input style={inputStyle} type="number" min="0"
                                value={form[key] ?? ''}
                                onChange={e => set(key, e.target.value === '' ? null : Number(e.target.value))} />
                        </React.Fragment>
                    ))}

                    <label style={labelStyle}>Built-up Area (sq ft)</label>
                    <input style={inputStyle} value={form['Built up area  ( sq ft )'] || ''}
                        onChange={e => set('Built up area  ( sq ft )', e.target.value)} />

                    <div style={{ marginTop: 12, marginBottom: 6, fontWeight: 700, fontSize: 12, color: '#555', textTransform: 'uppercase', letterSpacing: 1 }}>Services</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
                        {BOOLEAN_FIELDS.map(f => (
                            <label key={f} style={{ fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                                <input type="checkbox" checked={!!form[f]} onChange={e => set(f, e.target.checked)} />
                                {f}
                            </label>
                        ))}
                    </div>

                    <div style={{ marginTop: 12, marginBottom: 4, fontWeight: 700, fontSize: 12, color: '#555', textTransform: 'uppercase', letterSpacing: 1 }}>Admin</div>
                    <label style={labelStyle}>Accreditation</label>
                    <input style={inputStyle} value={form.Accreditation || ''} onChange={e => set('Accreditation', e.target.value)} />

                    <label style={labelStyle}>Empanelment Type</label>
                    <select style={inputStyle} value={form['Empanelment Type'] || ''} onChange={e => set('Empanelment Type', e.target.value)}>
                        {EMPANELMENT_OPTIONS.map(o => <option key={o} value={o}>{o || '—'}</option>)}
                    </select>

                    <label style={labelStyle}>Sub-District ID</label>
                    <input style={inputStyle} value={form['Sub-District ID'] || ''} onChange={e => set('Sub-District ID', e.target.value)} />
                </div>

                <div style={{ padding: '12px 18px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button onClick={onClose} style={{ padding: '6px 14px', border: '1px solid #ccc', borderRadius: 5, cursor: 'pointer', background: 'white' }}>
                        Cancel
                    </button>
                    <button onClick={() => onSubmit(form)} style={{ padding: '6px 14px', border: 'none', borderRadius: 5, cursor: 'pointer', background: '#1d6ef5', color: 'white', fontWeight: 600 }}>
                        {dialogState.mode === 'add' ? 'Add' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}

function FunctionSettingsDialog({ activeFunction, settings, onSave, onClose }) {
    const [local, setLocal] = useState({ ...settings });
    const set = (key, val) => setLocal(s => ({ ...s, [key]: val }));

    const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 2, marginTop: 10 };
    const inputStyle = {
        width: '100%', padding: '4px 6px', boxSizing: 'border-box',
        fontSize: 13, border: '1px solid #ccc', borderRadius: 4, background: 'white', color: '#222',
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
            <div style={{
                background: 'white', borderRadius: 10, width: 340,
                display: 'flex', flexDirection: 'column', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            }}>
                <div style={{ padding: '14px 18px', borderBottom: '1px solid #eee', fontWeight: 'bold', fontSize: 15 }}>
                    {FUNCTION_NAMES[activeFunction]} — Settings
                </div>
                <div style={{ padding: '10px 18px 18px' }}>
                    {activeFunction === 'carepathway' ? (
                        <>
                            <label style={labelStyle}>Cluster Radius (km)</label>
                            <input style={inputStyle} type="number" step="0.05" min="0.1"
                                value={local.clusterRadius}
                                onChange={e => set('clusterRadius', Number(e.target.value))} />
                            <label style={labelStyle}>Search Radius (degrees)</label>
                            <input style={inputStyle} type="number" step="0.01" min="0.01"
                                value={local.searchRadius}
                                onChange={e => set('searchRadius', Number(e.target.value))} />
                        </>
                    ) : (
                        <div style={{ padding: '16px 0', color: '#888', fontSize: 13, textAlign: 'center' }}>
                            Settings coming soon
                        </div>
                    )}
                </div>
                <div style={{ padding: '12px 18px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button onClick={onClose} style={{ padding: '6px 14px', border: '1px solid #ccc', borderRadius: 5, cursor: 'pointer', background: 'white' }}>
                        Cancel
                    </button>
                    <button onClick={() => onSave(local)} style={{ padding: '6px 14px', border: 'none', borderRadius: 5, cursor: 'pointer', background: '#1d6ef5', color: 'white', fontWeight: 600 }}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MapComponent() {
    const [roads, setRoads] = useState(null);
    const [subdistricts, setSubdistricts] = useState(null);
    const [hospitals, setHospitals] = useState(null);
    const [userAddedHospitals, setUserAddedHospitals] = useState([]);
    const [computedOutputs, setComputedOutputs] = useState({ carepathway: null });
    const [isComputing, setIsComputing] = useState(false);
    const [activeToolMode, setActiveToolMode] = useState(null);
    const [editOpen, setEditOpen] = useState(false);
    const [dialogState, setDialogState] = useState(null);
    const [basemap, setBasemap] = useState('osm');
    const [visibleTypes, setVisibleTypes] = useState(new Set(HOSPITAL_TYPES));
    const [hospitalTypes, setHospitalTypes] = useState(HOSPITAL_TYPES);
    const [activeFunction, setActiveFunction] = useState('carepathway');
    const [functionSettings, setFunctionSettings] = useState({ clusterRadius: 0.4, searchRadius: 0.1 });
    const [functionSettingsOpen, setFunctionSettingsOpen] = useState(false);

    const roadsRef = useRef(null);
    const subdistRef = useRef(null);
    const hospitalsRef = useRef(null);
    const userAddedHospitalsRef = useRef([]);
    const visibleTypesRef = useRef(new Set(HOSPITAL_TYPES));
    const functionSettingsRef = useRef({ clusterRadius: 0.4, searchRadius: 0.1 });
    const spinnerRef = useRef(null);
    const importInputRef = useRef(null);

    useEffect(() => {
        const move = (e) => {
            if (spinnerRef.current) {
                spinnerRef.current.style.left = `${e.clientX + 16}px`;
                spinnerRef.current.style.top = `${e.clientY + 16}px`;
            }
        };
        document.addEventListener('mousemove', move);
        return () => document.removeEventListener('mousemove', move);
    }, []);

    // ── Load data ──────────────────────────────────────────────────────────────

    useEffect(() => {
        const load = async () => {
            try {
                const base = import.meta.env.BASE_URL;
                const [hospRes, roadsRes, subdistRes] = await Promise.all([
                    fetch(`${base}laturHospital.geojson`),
                    fetch(`${base}laturRoad.geojson`),
                    fetch(`${base}laturSubdistrict.geojson`),
                ]);
                const h = await hospRes.json();
                const r = await roadsRes.json();
                const s = await subdistRes.json();

                console.log('[map] fetched — hospitals:', h.features?.length, 'roads:', r.features?.length, 'subdistricts:', s.features?.length);

                const types = [...new Set(h.features.map(f => f.properties?.['Hospital Type']).filter(Boolean))];
                types.push('No Data');
                const initialVisible = new Set(types);
                setHospitalTypes(types);
                setVisibleTypes(initialVisible);
                visibleTypesRef.current = initialVisible;

                roadsRef.current = r;
                subdistRef.current = s;
                hospitalsRef.current = h;

                setHospitals(h);
                setRoads(r);
                setSubdistricts(s);

                triggerCompute(h, [], r, s, initialVisible);
            } catch (err) {
                console.error('Initialization failed:', err);
            }
        };
        load();
    }, []);

    // ── Compute ────────────────────────────────────────────────────────────────

    const triggerCompute = async (baseH, userH, r, s, overrideVisibleTypes, overrideSettings) => {
        setIsComputing(true);
        try {
            const vt = overrideVisibleTypes ?? visibleTypesRef.current;
            const settings = overrideSettings ?? functionSettingsRef.current;
            const filteredBase = baseH.features.filter(f => {
                const t = f.properties?.['Hospital Type'];
                return t ? vt.has(t) : vt.has('No Data');
            });
            const filteredUser = userH.filter(f => {
                const t = f.properties?.['Hospital Type'];
                return t ? vt.has(t) : vt.has('No Data');
            });
            const combined = { ...baseH, features: [...filteredBase, ...filteredUser] };
            const results = await solveCarePathway(JSON.stringify(combined), JSON.stringify(r), JSON.stringify(s), settings);
            console.log('[map] compute result — carepathway features:', results?.carepathway?.features?.length);
            if (results) setComputedOutputs(results);
        } catch (err) {
            console.error('Compute failed:', err);
        } finally {
            setIsComputing(false);
        }
    };

    // ── Tool mode ──────────────────────────────────────────────────────────────

    const setTool = (mode) => setActiveToolMode(prev => prev === mode ? null : mode);

    // ── Add hospital ───────────────────────────────────────────────────────────

    const handleAddClick = (latlng) => {
        setDialogState({ mode: 'add', latlng, data: { ...DEFAULT_PROPS } });
    };

    const handleDialogSubmit = (formData) => {
        const feature = {
            type: 'Feature',
            properties: { ...formData },
            geometry: {
                type: 'Point',
                coordinates: [dialogState.latlng?.lng ?? 0, dialogState.latlng?.lat ?? 0],
            },
        };

        let updated;
        if (dialogState.mode === 'add') {
            updated = [...userAddedHospitals, feature];
        } else {
            updated = [...userAddedHospitals];
            updated[dialogState.idx] = { ...updated[dialogState.idx], properties: formData };
        }

        userAddedHospitalsRef.current = updated;
        setUserAddedHospitals(updated);
        setDialogState(null);
        triggerCompute(hospitalsRef.current, updated, roadsRef.current, subdistRef.current);
    };

    // ── Move hospital ──────────────────────────────────────────────────────────

    const handleDragEnd = (idx, latlng) => {
        const updated = [...userAddedHospitals];
        updated[idx] = { ...updated[idx], geometry: { type: 'Point', coordinates: [latlng.lng, latlng.lat] } };
        userAddedHospitalsRef.current = updated;
        setUserAddedHospitals(updated);
        triggerCompute(hospitalsRef.current, updated, roadsRef.current, subdistRef.current);
    };

    // ── Delete hospital ────────────────────────────────────────────────────────

    const handleDeleteHospital = (idx) => {
        const updated = userAddedHospitals.filter((_, i) => i !== idx);
        userAddedHospitalsRef.current = updated;
        setUserAddedHospitals(updated);
        triggerCompute(hospitalsRef.current, updated, roadsRef.current, subdistRef.current);
    };

    // ── Import / Export ────────────────────────────────────────────────────────

    const handleImport = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target.result);
                if (parsed.type !== 'FeatureCollection') throw new Error('Not a FeatureCollection');
                const points = parsed.features.filter(f => f.geometry?.type === 'Point');
                userAddedHospitalsRef.current = points;
                setUserAddedHospitals(points);
                triggerCompute(hospitalsRef.current, points, roadsRef.current, subdistRef.current);
            } catch (err) {
                console.error('Import failed:', err);
                alert('Invalid GeoJSON file. Must be a FeatureCollection of Points.');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const handleExport = () => {
        const fc = { type: 'FeatureCollection', features: userAddedHospitals };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'user-hospitals.geojson';
        a.click();
        URL.revokeObjectURL(url);
    };

    // ── Filter ─────────────────────────────────────────────────────────────────

    const toggleType = (type) => {
        const next = new Set(visibleTypesRef.current);
        next.has(type) ? next.delete(type) : next.add(type);
        visibleTypesRef.current = next;
        setVisibleTypes(new Set(next));
        if (hospitalsRef.current && roadsRef.current && subdistRef.current) {
            triggerCompute(hospitalsRef.current, userAddedHospitalsRef.current, roadsRef.current, subdistRef.current, next);
        }
    };

    // ── Function switcher ──────────────────────────────────────────────────────

    const handleFunctionClick = (key) => {
        if (key === activeFunction) return;
        setActiveFunction(key);
        if (key === 'carepathway' && hospitalsRef.current && roadsRef.current && subdistRef.current) {
            triggerCompute(hospitalsRef.current, userAddedHospitalsRef.current, roadsRef.current, subdistRef.current);
        } else {
            setComputedOutputs({ carepathway: null });
        }
    };

    const handleFunctionDoubleClick = (key) => {
        if (key === activeFunction) setFunctionSettingsOpen(true);
    };

    const handleFunctionSettingsSave = (newSettings) => {
        functionSettingsRef.current = newSettings;
        setFunctionSettings(newSettings);
        setFunctionSettingsOpen(false);
        if (activeFunction === 'carepathway' && hospitalsRef.current && roadsRef.current && subdistRef.current) {
            triggerCompute(hospitalsRef.current, userAddedHospitalsRef.current, roadsRef.current, subdistRef.current, undefined, newSettings);
        }
    };

    // ── Display filter ─────────────────────────────────────────────────────────

    const displayedHospitals = hospitals
        ? {
            ...hospitals,
            features: hospitals.features.filter(f => {
                const t = f.properties?.['Hospital Type'];
                return t ? visibleTypes.has(t) : visibleTypes.has('No Data');
            }),
          }
        : null;

    // ── Render ─────────────────────────────────────────────────────────────────

    const panelStyle = {
        background: 'white', borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)', padding: '10px 14px',
    };

    const toolBtnStyle = (active) => ({
        padding: '6px 12px', border: '1px solid #ccc', borderRadius: 6,
        cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
        background: active ? '#1d6ef5' : 'white',
        color: active ? 'white' : '#333',
        fontWeight: active ? 600 : 400,
    });

    return (
        <div style={{ height: '100vh', width: '100vw', position: 'relative', overflow: 'hidden' }}>
            <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
                .leaflet-top.leaflet-right .leaflet-control-zoom {
                    border: 2px solid #22aa55 !important;
                    border-radius: 6px !important;
                    overflow: hidden !important;
                    margin-top: 62px !important;
                    margin-right: 10px !important;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.2) !important;
                }
                .leaflet-top.leaflet-right .leaflet-control-zoom a {
                    border-bottom: 1px solid #e0e0e0 !important;
                }
            `}</style>

            {/* Cursor loading spinner */}
            <div ref={spinnerRef} style={{
                position: 'fixed', zIndex: 9999, pointerEvents: 'none',
                width: 20, height: 20, background: 'white', borderRadius: '50%',
                boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                border: '2px solid #ddd', borderTop: '2px solid #1d6ef5',
                animation: 'spin 0.7s linear infinite',
                display: isComputing ? 'block' : 'none',
            }} />

            {/* Navbar */}
            <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1100,
                background: '#111', height: 50,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0 20px',
            }}>
                <span style={{ color: 'white', fontWeight: 700, fontSize: 18, letterSpacing: 0.3 }}>
                    Urban Health Data Platform
                </span>
                <div style={{ display: 'flex', gap: 28 }}>
                    {['home', 'about', 'contact'].map(link => (
                        <a key={link} href="#" onClick={e => e.preventDefault()}
                            style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, textDecoration: 'none' }}>
                            {link}
                        </a>
                    ))}
                </div>
            </div>

            {/* Function switcher — top-left, below navbar */}
            <div style={{
                position: 'absolute', top: 60, left: 10, zIndex: 1000,
                display: 'flex', flexDirection: 'column', gap: 6,
            }}>
                {FUNCTION_KEYS.map((key, i) => {
                    const isActive = activeFunction === key;
                    return (
                        <button
                            key={key}
                            title={FUNCTION_NAMES[key]}
                            onClick={() => handleFunctionClick(key)}
                            onDoubleClick={() => handleFunctionDoubleClick(key)}
                            style={{
                                width: 40, height: 40, borderRadius: 8,
                                background: '#e8354a',
                                border: isActive ? '3px solid white' : '3px solid transparent',
                                boxShadow: isActive
                                    ? '0 0 0 3px #e8354a, 0 2px 10px rgba(232,53,74,0.5)'
                                    : '0 2px 6px rgba(0,0,0,0.25)',
                                color: 'white', fontWeight: 700, fontSize: 14,
                                cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                transition: 'box-shadow 0.15s, border-color 0.15s',
                            }}
                        >
                            {i + 1}
                        </button>
                    );
                })}
            </div>

            {/* Basemap buttons — right side, below zoom control */}
            <div style={{
                position: 'absolute', top: 168, right: 10, zIndex: 1000,
                display: 'flex', flexDirection: 'column', gap: 6,
            }}>
                {Object.entries(BASEMAPS).map(([key, bm]) => {
                    const isActive = basemap === key;
                    return (
                        <button
                            key={key}
                            title={bm.label}
                            onClick={() => setBasemap(key)}
                            style={{
                                width: 40, height: 40, borderRadius: 8,
                                background: isActive ? '#1e40af' : '#1d4ed8',
                                border: isActive ? '3px solid white' : '3px solid transparent',
                                boxShadow: isActive
                                    ? '0 0 0 3px #1d4ed8, 0 2px 10px rgba(29,78,216,0.4)'
                                    : '0 2px 6px rgba(0,0,0,0.25)',
                                color: 'white', fontWeight: 700, fontSize: 10,
                                cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                transition: 'box-shadow 0.15s, border-color 0.15s',
                            }}
                        >
                            {bm.label}
                        </button>
                    );
                })}
            </div>

            {/* Filter — bottom left */}
            <div style={{ position: 'absolute', bottom: 30, left: 10, zIndex: 1000, ...panelStyle }}>
                <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: '#111' }}>Hospital Types</div>
                {hospitalTypes.map(type => (
                    <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 4, color: '#111' }}>
                        <input type="checkbox" checked={visibleTypes.has(type)} onChange={() => toggleType(type)} />
                        {type}
                    </label>
                ))}
            </div>

            {/* Legend — bottom right, dynamic */}
            <div style={{ position: 'absolute', bottom: 30, right: 10, zIndex: 1000, ...panelStyle, minWidth: 160 }}>
                <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: '#111' }}>Legend</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <span style={{
                        display: 'inline-block', width: 10, height: 10, flexShrink: 0,
                        background: '#111', border: '2px solid white', borderRadius: '50%',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                    }} />
                    <span style={{ fontSize: 12, color: '#111' }}>Existing Hospital</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <span style={{
                        display: 'inline-block', width: 10, height: 10, flexShrink: 0,
                        background: '#1d6ef5', border: '2px solid white', borderRadius: '50%',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                    }} />
                    <span style={{ fontSize: 12, color: '#111' }}>User Added Hospital</span>
                </div>
                {activeFunction === 'carepathway' && (
                    <>
                        <hr style={{ border: 'none', borderTop: '1px solid #e8e8e8', margin: '8px 0' }} />
                        <div style={{ fontWeight: 700, fontSize: 11, marginBottom: 6, color: '#111', textTransform: 'uppercase', letterSpacing: 0.5 }}>Care Bands</div>
                        {CARE_BANDS.map(({ color, label }) => (
                            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                                <span style={{ display: 'inline-block', width: 28, height: 4, background: color, borderRadius: 2, flexShrink: 0 }} />
                                <span style={{ fontSize: 12, color: '#111' }}>{label}</span>
                            </div>
                        ))}
                    </>
                )}
            </div>

            {/* Edit toolbar — bottom center */}
            <div style={{
                position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
                zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            }}>
                {editOpen && (
                    <>
                        <div style={{
                            display: 'flex', gap: 6, background: 'white', borderRadius: 8,
                            padding: '8px 10px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                        }}>
                            {['add', 'move', 'delete'].map(mode => (
                                <button key={mode} style={toolBtnStyle(activeToolMode === mode)}
                                    onClick={() => setTool(mode)}>
                                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                                </button>
                            ))}
                            <div style={{ width: 1, background: '#e0e0e0', margin: '0 2px' }} />
                            <button style={toolBtnStyle(false)} onClick={() => importInputRef.current?.click()}>Import</button>
                            <button style={toolBtnStyle(false)} onClick={handleExport}>Export</button>
                            <input ref={importInputRef} type="file" accept=".geojson"
                                style={{ display: 'none' }} onChange={handleImport} />
                        </div>
                        {activeToolMode && (
                            <div style={{
                                fontSize: 11, color: '#555',
                                background: 'rgba(255,255,255,0.9)', borderRadius: 4, padding: '3px 10px',
                                boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
                            }}>
                                {activeToolMode === 'add'    && 'Click on the map to place a hospital'}
                                {activeToolMode === 'move'   && 'Drag to move • click to edit properties'}
                                {activeToolMode === 'delete' && 'Click a user hospital to remove it'}
                            </div>
                        )}
                    </>
                )}
                <button
                    onClick={() => { setEditOpen(o => !o); if (editOpen) setActiveToolMode(null); }}
                    style={{
                        padding: '7px 28px', borderRadius: 20,
                        border: editOpen ? 'none' : '1px solid #ccc',
                        background: editOpen ? '#111' : 'white',
                        color: editOpen ? 'white' : '#333',
                        cursor: 'pointer', fontSize: 13, fontWeight: 600,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                    }}
                >
                    edit
                </button>
            </div>

            {/* Map */}
            <MapContainer
                center={[20.5937, 78.9629]}
                zoom={5}
                zoomControl={false}
                style={{ height: '100%', width: '100%', cursor: activeToolMode === 'add' ? 'crosshair' : undefined }}
            >
                <MapClickHandler activeToolMode={activeToolMode} onAddClick={handleAddClick} />
                <ZoomControl position="topright" />

                <TileLayer
                    key={basemap}
                    url={BASEMAPS[basemap].url}
                    attribution={BASEMAPS[basemap].attribution}
                />

                {/* {roads && <GeoJSON data={roads} style={{ color: 'gray', weight: 1 }} />} */}
                {/*{subdistricts && <GeoJSON data={subdistricts} style={{ color: 'blue', stroke: true, weight: 0.5, fillOpacity: 0.03 }} />}*/}

                {/* Care pathway — rendered before hospitals so hospitals sit on top */}
                {computedOutputs.carepathway && (
                    <GeoJSON
                        key={`path-${computedOutputs.carepathway.features?.length || 0}`}
                        data={computedOutputs.carepathway}
                        style={(f) => ({
                            color: f?.properties?.careColor || 'purple',
                            weight: f?.properties?.careLineWeight || 3,
                        })}
                    />
                )}

                {/* Base hospitals — rendered above carepathway */}
                {displayedHospitals && (
                    <GeoJSON
                        key={`hosp-${displayedHospitals.features.length}-${[...visibleTypes].sort().join(',')}`}
                        data={displayedHospitals}
                        pointToLayer={(f, ll) => L.marker(ll, { icon: baseHospitalIcon })}
                        onEachFeature={(f, layer) => {
                            const name = f.properties?.name || 'Unknown';
                            const beds = f.properties?.['Bed Count'] ?? 'N/A';
                            layer.bindTooltip(`<b>${name}</b><br/>Beds: ${beds}`, { sticky: true, opacity: 0.92 });
                        }}
                    />
                )}

                {/* User-added hospitals — topmost layer */}
                {userAddedHospitals.map((h, idx) => (
                    <Marker
                        key={idx}
                        position={[h.geometry.coordinates[1], h.geometry.coordinates[0]]}
                        draggable={activeToolMode === 'move'}
                        icon={userHospitalIcon}
                        eventHandlers={{
                            dragend: (e) => handleDragEnd(idx, e.target.getLatLng()),
                            click: (e) => {
                                L.DomEvent.stopPropagation(e);
                                if (activeToolMode === 'delete') handleDeleteHospital(idx);
                                if (activeToolMode === 'move') {
                                    setDialogState({
                                        mode: 'edit', idx,
                                        latlng: { lat: h.geometry.coordinates[1], lng: h.geometry.coordinates[0] },
                                        data: { ...h.properties },
                                    });
                                }
                            },
                        }}
                    >
                        <Tooltip>
                            <b>{h.properties.name || 'User Hospital'}</b><br />
                            Beds: {h.properties['Bed Count'] ?? 'N/A'}
                        </Tooltip>
                    </Marker>
                ))}
            </MapContainer>

            {/* Dialogs */}
            {dialogState && (
                <HospitalDialog
                    dialogState={dialogState}
                    onSubmit={handleDialogSubmit}
                    onClose={() => setDialogState(null)}
                />
            )}
            {functionSettingsOpen && (
                <FunctionSettingsDialog
                    activeFunction={activeFunction}
                    settings={functionSettings}
                    onSave={handleFunctionSettingsSave}
                    onClose={() => setFunctionSettingsOpen(false)}
                />
            )}
        </div>
    );
}
