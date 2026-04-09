import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import {
  useConfig,
  useEditorPanelConfig,
  useElementData,
  useElementColumns,
} from '@sigmacomputing/plugin';

// ── Date helpers ──────────────────────────────────────────────────────────────
function toJsDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') { const ms = v < 1e10 ? v*1000 : v; const d = new Date(ms); return isNaN(d) ? null : d; }
  if (typeof v === 'string') { const d = new Date(v); return isNaN(d) ? null : d; }
  return null;
}
function toCivilDate(v) {
  const d = toJsDate(v);
  return d ? new Date(d.getTime() - d.getTimezoneOffset()*60000) : null;
}
const DATE_FMT = new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit', timeZone:'UTC' });
function formatCivil(v) { const d = toCivilDate(v); return d ? DATE_FMT.format(d) : String(v); }

// ── Colour helpers ────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = (hex || '').trim().replace(/^#/, '');
  const f = h.length === 3 ? h.split('').map(c => c+c).join('') : h;
  if (f.length !== 6) return [60, 121, 200];
  return [parseInt(f.slice(0,2),16), parseInt(f.slice(2,4),16), parseInt(f.slice(4,6),16)];
}
function lerpColor(lo, hi, t) {
  const [lr,lg,lb] = hexToRgb(lo), [hr,hg,hb] = hexToRgb(hi);
  return `rgb(${Math.round(lr+t*(hr-lr))},${Math.round(lg+t*(hg-lg))},${Math.round(lb+t*(hb-lb))})`;
}

// Palette for 'dimension' mode — 12 distinct colours
const PALETTE = [
  '#3c79c8','#e06c4a','#4caf7d','#f0b429','#9b59b6',
  '#17a2b8','#e91e63','#8bc34a','#ff7043','#5c6bc0',
  '#26a69a','#ef5350',
];

function buildColours(values, labels, mode, barColour, gradLow) {
  if (mode === 'gradient') {
    const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
    return values.map(v => lerpColor(gradLow, barColour, (v - min) / range));
  }
  if (mode === 'palette') {
    // Assign palette colour by unique label so the same category always gets
    // the same colour even if the sort order changes.
    const map = {};
    let idx = 0;
    return labels.map(l => {
      if (!(l in map)) map[l] = PALETTE[idx++ % PALETTE.length];
      return map[l];
    });
  }
  // 'single' (default)
  return values.map(() => barColour);
}

// ── Editor fields ─────────────────────────────────────────────────────────────
const EDITOR_FIELDS = [
  { name: 'source',       type: 'element' },
  { name: 'dimensionCol', type: 'column', source: 'source', label: 'Axis',           allowedTypes: ['text', 'datetime'] },
  { name: 'measureCol',   type: 'column', source: 'source', label: 'Measure',        allowedTypes: ['number', 'integer'] },
  { name: 'labelRotate',  type: 'text',                     label: 'Label rotation',  defaultValue: '45' },
  { name: 'colorMode',   type: 'radio',                    label: 'Color mode',     values: ['single', 'gradient', 'palette'], defaultValue: 'single', singleLine: true },
  { name: 'barColor',    type: 'color',                    label: 'Bar color' },
  { name: 'gradientLow', type: 'color',                    label: 'Gradient low' },
  { name: 'colorCol',    type: 'column', source: 'source', label: 'Palette column', allowedTypes: ['text', 'number', 'integer', 'datetime'] },
];

export default function App() {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);

  useEditorPanelConfig(EDITOR_FIELDS);

  const config   = useConfig();
  const sourceId = config?.source;
  const dimId    = config?.dimensionCol;
  const mesId    = config?.measureCol;

  const labelRotate = Math.min(90, Math.max(0, parseInt(config?.labelRotate) || 45));
  const colorMode   = config?.colorMode   || 'single';
  const barColor    = config?.barColor    || '#3c79c8';
  const gradientLow = config?.gradientLow || '#c8dff8';
  const colorColId  = config?.colorCol;

  const data = useElementData(sourceId);
  const cols = useElementColumns(sourceId);

  const dimIsDate = cols?.[dimId]?.columnType === 'datetime';
  const labels    = (data?.[dimId]    ?? []).map(v => dimIsDate ? formatCivil(v) : String(v));
  const values    = (data?.[mesId]    ?? []).map(Number);
  // Color keys: use colorCol if selected, otherwise fall back to labels
  const colorKeys = (colorColId && data?.[colorColId])
    ? data[colorColId].map(String)
    : labels;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !labels.length) return;

    if (!chartRef.current) {
      chartRef.current = echarts.init(container);
      const ro = new ResizeObserver(() => chartRef.current?.resize());
      ro.observe(container);
    }

    const colours = buildColours(values, colorKeys, colorMode, barColor, gradientLow);

    // For palette mode ECharts needs per-bar itemStyle; for others a single
    // color on the series is fine — but using per-bar data works for all modes.
    const seriesData = values.map((v, i) => ({
      value: v,
      itemStyle: { color: colours[i] },
    }));

    chartRef.current.setOption({
      animation: false,
      grid: { top: 40, right: 20, bottom: 40, left: 20, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { rotate: labelRotate },
      },
      yAxis: {
        type: 'value',
        name: cols?.[mesId]?.name ?? '',
        nameLocation: 'end',
        nameGap: 8,
      },
      series: [{
        type: 'bar',
        data: seriesData,
      }],
      dataZoom: [
        { type: 'slider', xAxisIndex: 0, bottom: 8, height: 20 },
        { type: 'inside', xAxisIndex: 0 },
      ],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
      },
    });
  });

  useEffect(() => {
    return () => { chartRef.current?.dispose(); chartRef.current = null; };
  }, []);

  if (!dimId || !mesId) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', color:'#999', fontSize:13 }}>
        Select a dimension and measure column.
      </div>
    );
  }

  return <div ref={containerRef} style={{ width:'100%', height:'100vh' }} />;
}
