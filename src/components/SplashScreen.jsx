import React, { useState } from 'react';

// How-to-use carousel shown over the map on first load. The map mounts
// underneath and fetches spatial data in the background while this is up.
const ABOUT_SLIDES = [
    {
        title: 'About',
        body: 'About this platform — content coming soon.',
    },
];

const SLIDES = [
    {
        title: 'Welcome',
        body: 'Explore hospital care pathways across India. This quick guide shows you how to get around.',
    },
    {
        title: 'Pick a function',
        body: 'Use the function switcher in the navbar to choose an analysis. Each one partitions the map and routes subdistricts to their nearest hospital.',
    },
    {
        title: 'Filter & explore',
        body: 'Toggle hospital types, switch basemaps, and turn on the Voronoi overlay to see catchment regions.',
    },
    {
        title: 'Click for catchment',
        body: 'Click any hospital marker to see the subdistricts it serves and a summary of its catchment.',
    },
    {
        title: 'For educational use only',
        body: 'This data is for educational use only. It should not be relied upon for clinical, operational, or commercial decisions.',
        notice: true,
    },
];

export default function SplashScreen({ onClose, variant = 'howto' }) {
    const slides = variant === 'about' ? ABOUT_SLIDES : SLIDES;
    const [index, setIndex] = useState(0);
    const isLast = index === slides.length - 1;
    const slide = slides[index];

    const next = () => {
        if (isLast) onClose();
        else setIndex(i => i + 1);
    };
    const back = () => setIndex(i => Math.max(0, i - 1));

    return (
        <div style={styles.overlay}>
            <div style={styles.card}>
                <div style={{ ...styles.slide, ...(slide.notice ? styles.noticeSlide : null) }}>
                    <h2 style={styles.title}>{slide.title}</h2>
                    <p style={styles.body}>{slide.body}</p>
                </div>

                <div style={styles.dots}>
                    {slides.map((_, i) => (
                        <span
                            key={i}
                            onClick={() => setIndex(i)}
                            style={{
                                ...styles.dot,
                                ...(i === index ? styles.dotActive : null),
                            }}
                        />
                    ))}
                </div>

                <div style={styles.controls}>
                    <button
                        onClick={back}
                        disabled={index === 0}
                        style={{ ...styles.btn, ...styles.btnGhost, ...(index === 0 ? styles.btnDisabled : null) }}
                    >
                        Back
                    </button>
                    <button onClick={onClose} style={{ ...styles.btn, ...styles.btnGhost }}>
                        Skip
                    </button>
                    <button onClick={next} style={{ ...styles.btn, ...styles.btnPrimary }}>
                        {isLast ? (variant === 'about' ? 'Close' : 'Get started') : 'Next'}
                    </button>
                </div>
            </div>
        </div>
    );
}

const styles = {
    overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    },
    card: {
        width: 'min(560px, 92vw)',
        background: '#ffffff',
        borderRadius: 16,
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        padding: '28px 28px 20px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
    },
    slide: {
        minHeight: 220,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '12px 16px',
    },
    noticeSlide: {
        background: '#fff7ed',
        borderRadius: 12,
        border: '1px solid #fed7aa',
    },
    title: {
        margin: '0 0 14px',
        fontSize: 24,
        fontWeight: 700,
        color: '#0f172a',
    },
    body: {
        margin: 0,
        fontSize: 16,
        lineHeight: 1.55,
        color: '#475569',
        maxWidth: 420,
    },
    dots: {
        display: 'flex',
        justifyContent: 'center',
        gap: 8,
        margin: '18px 0',
    },
    dot: {
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: '#cbd5e1',
        cursor: 'pointer',
        transition: 'background 0.2s',
    },
    dotActive: {
        background: '#2563eb',
    },
    controls: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
    },
    btn: {
        padding: '9px 18px',
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 600,
        cursor: 'pointer',
        border: '1px solid transparent',
    },
    btnPrimary: {
        background: '#2563eb',
        color: '#fff',
        marginLeft: 'auto',
    },
    btnGhost: {
        background: 'transparent',
        color: '#475569',
        border: '1px solid #e2e8f0',
    },
    btnDisabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
    },
};
