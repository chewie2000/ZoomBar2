import { useEffect, useRef, useMemo, useState } from 'react';
import * as echarts from 'echarts';
import {
  useConfig,
  useEditorPanelConfig,
  useElementData,
  useElementColumns,
} from '@sigmacomputing/plugin';

const DEFAULT_COLOR    = '#3c79c8';
const DEFAULT_FONTSIZE = '11';
const DEFAULT_MAXCHARS = '30';
const DEFAULT_TICKAREA = '120';
const DEFAULT_GRAD_LOW = '#c8dff8';

// ── Module-level chart — survives React remounts ──────────────────────────────
let _chart   = null;
let _roClean = null; // ResizeObserver cleanup

// ── Editor panel fields — stable array reference, never recreated ─────────────
const EDITOR_FIELDS = [
  { name:'source',        type:'element' },
  { name:'dimensionCol',  type:'column', source:'source', allowedTypes:['text','datetime'] },
  { name:'measureCol',    type:'column', source:'source', allowedTypes:['number','integer'] },
  { name:'barColor',      type:'text',   defaultValue:DEFAULT_COLOR },
  { name:'labelFontSize', type:'text',   defaultValue:DEFAULT_FONTSIZE },
  { name:'labelMaxChars', type:'text',   defaultValue:DEFAULT_MAXCHARS },
  { name:'tickAreaPx',    type:'text',   defaultValue:DEFAULT_TICKAREA },
  { name:'numberFormat',  type:'text',   defaultValue:'default' },
  { name:'showLabels',    type:'toggle' },
  { name:'horizontal',    type:'toggle' },
  { name:'gradientMode',  type:'toggle' },
  { name:'gradientLow',   type:'text',   defaultValue:DEFAULT_GRAD_LOW },
];

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

// ── Color helpers ─────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = (hex||'').trim().replace(/^#/,'');
  const f = h.length===3 ? h.split('').map(c=>c+c).join('') : h;
  if (f.length!==6) return [60,121,200];
  return [parseInt(f.slice(0,2),16), parseInt(f.slice(2,4),16), parseInt(f.slice(4,6),16)];
}
function lerpColor(lo, hi, t) {
  const [lr,lg,lb]=hexToRgb(lo), [hr,hg,hb]=hexToRgb(hi);
  return `rgb(${Math.round(lr+t*(hr-lr))},${Math.round(lg+t*(hg-lg))},${Math.round(lb+t*(hb-lb))})`;
}
function dimColor(c) {
  if (!c) return 'rgba(0,0,0,0.12)';
  if (c.startsWith('#')) { const [r,g,b]=hexToRgb(c); return `rgba(${r},${g},${b},0.2)`; }
  if (c.startsWith('rgb(')) return c.replace('rgb(','rgba(').replace(')',',0.2)');
  return c;
}
function computeColors(values, gradientMode, gradientLow, barColor) {
  const min=Math.min(...values), max=Math.max(...values), range=max-min||1;
  return values.map(v => gradientMode ? lerpColor(gradientLow, barColor, (v-min)/range) : barColor+'cc');
}

// ── Number formatters ─────────────────────────────────────────────────────────
function makeFormatter(fmt) {
  switch ((fmt||'').toLowerCase().trim()) {
    case 'compact':  return new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1});
    case 'currency': return new Intl.NumberFormat('en',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:1});
    case 'percent':  return new Intl.NumberFormat('en',{style:'percent',maximumFractionDigits:1});
    default:         return new Intl.NumberFormat('en');
  }
}

// ── Zoom persistence (start/end are 0-100 percentages as ECharts uses) ────────
function zKey(s,d,m,h) { return `zb2|${s}|${d}|${m}|${h?'h':'v'}`; }
function saveZ(start,end,s,d,m,h) { try { sessionStorage.setItem(zKey(s,d,m,h),JSON.stringify({start,end})); } catch(_){} }
function loadZ(s,d,m,h) { try { const r=sessionStorage.getItem(zKey(s,d,m,h)); return r?JSON.parse(r):null; } catch(_){return null;} }
function clearZ(s,d,m,h) { try { sessionStorage.removeItem(zKey(s,d,m,h)); } catch(_){} }

// ── Build ECharts series data with per-bar colors ─────────────────────────────
function buildSeriesData(values, colors, selIdx) {
  return values.map((v, i) => ({
    value: v,
    itemStyle: { color: selIdx !== null && selIdx !== i ? dimColor(colors[i]) : colors[i] },
  }));
}

// ── Default visible range: show ~20 bars or all if fewer ─────────────────────
function defaultEnd(n) { return n <= 20 ? 100 : Math.round((20 / n) * 100); }

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const containerRef = useRef(null);
  const colorsRef    = useRef([]);
  const valuesRef    = useRef([]);
  const labelsRef    = useRef([]);
  const fmtRef       = useRef(makeFormatter('default'));
  const isHorizRef   = useRef(false);
  const selIdxRef    = useRef(null);
  const styleRef     = useRef(null);
  const [selInfo, setSelInfo] = useState('');

  useEditorPanelConfig(EDITOR_FIELDS);

  // ── Config ────────────────────────────────────────────────────────────────
  const config        = useConfig();
  const sourceId      = config?.source;
  const dimId         = config?.dimensionCol;
  const mesId         = config?.measureCol;
  const barColor      = config?.barColor      || DEFAULT_COLOR;
  const labelFontSize = Math.max(6, Math.min(24, parseInt(config?.labelFontSize)||11));
  const labelMaxChars = Math.max(4, parseInt(config?.labelMaxChars)||30);
  const tickAreaPx    = Math.max(40, Math.min(400, parseInt(config?.tickAreaPx)||120));
  const numberFormat  = config?.numberFormat  || 'default';
  const showLabels    = Boolean(config?.showLabels);
  const isHorizontal  = Boolean(config?.horizontal);
  const gradientMode  = Boolean(config?.gradientMode);
  const gradientLow   = config?.gradientLow   || DEFAULT_GRAD_LOW;

  // ── Data ──────────────────────────────────────────────────────────────────
  const data      = useElementData(sourceId);
  const cols      = useElementColumns(sourceId);
  const dimIsDate = cols?.[dimId]?.columnType === 'datetime';

  // Structural memo — new ref only when data/columns actually change
  const { labels, values, measureName } = useMemo(() => ({
    labels:      (data?.[dimId]??[]).map(v => dimIsDate ? formatCivil(v) : String(v)),
    values:      (data?.[mesId]??[]).map(v => Number(v)),
    measureName: cols?.[mesId]?.name ?? 'Value',
  }), [data, dimId, mesId, dimIsDate, cols]);

  // Cosmetic memo — new ref only when style config changes
  const styleOpts = useMemo(() => ({
    barColor, gradientMode, gradientLow, showLabels, numberFormat,
    labelFontSize, labelMaxChars, tickAreaPx,
  }), [barColor, gradientMode, gradientLow, showLabels, numberFormat, labelFontSize, labelMaxChars, tickAreaPx]);

  // Keep refs current
  valuesRef.current  = values;
  labelsRef.current  = labels;
  isHorizRef.current = isHorizontal;
  styleRef.current   = styleOpts;

  // ── Unmount cleanup ───────────────────────────────────────────────────────
  useEffect(() => () => {
    _roClean?.();
    _chart?.dispose();
    _chart = null; _roClean = null;
  }, []);

  // ── Effect 1: STRUCTURAL — create or update chart when data changes ───────
  // Style is read from styleRef (not a dep) — cosmetic changes don't run this.
  // ECharts setOption in merge mode leaves dataZoom untouched on data updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !labels.length) return;

    const { barColor: bc, gradientMode: gm, gradientLow: gl, showLabels: sl,
            numberFormat: nf, labelFontSize: lfs, labelMaxChars: lmc, tickAreaPx: ta } = styleRef.current;

    const fmt = makeFormatter(nf);
    fmtRef.current = fmt;

    const colors = computeColors(values, gm, gl, bc);
    colorsRef.current = colors;
    const seriesData = buildSeriesData(values, colors, selIdxRef.current);
    const isH = isHorizontal;

    // Axis keys depending on orientation
    const catAxis = isH ? 'yAxis' : 'xAxis';
    const valAxis = isH ? 'xAxis' : 'yAxis';
    const dzKey   = isH ? 'yAxisIndex' : 'xAxisIndex';

    // ── CREATE: no chart yet, or container changed (remount) ─────────────
    if (!_chart || _chart.getDom() !== container) {
      _roClean?.();
      _chart?.dispose();
      _chart = null;

      _chart = echarts.init(container);

      // Keep chart sized to container
      const ro = new ResizeObserver(() => _chart?.resize());
      ro.observe(container);
      _roClean = () => ro.disconnect();

      // Click bar to select/crossfilter
      _chart.on('click', (params) => {
        if (params.componentType !== 'series') return;
        const idx = params.dataIndex;
        selIdxRef.current = idx;
        setSelInfo(`${labelsRef.current[idx]}  ·  ${fmtRef.current.format(valuesRef.current[idx])}`);
        _chart.setOption({
          series: [{ data: buildSeriesData(valuesRef.current, colorsRef.current, idx) }],
        });
      });

      // Persist zoom state on every zoom/pan interaction
      _chart.on('dataZoom', () => {
        const opt = _chart.getOption();
        const dz = opt.dataZoom?.[0];
        if (dz) saveZ(dz.start, dz.end, sourceId, dimId, mesId, isH);
      });

      // Restore saved zoom or use default visible window
      const saved = loadZ(sourceId, dimId, mesId, isH);
      const dzStart = saved?.start ?? 0;
      const dzEnd   = saved?.end   ?? defaultEnd(labels.length);

      _chart.setOption({
        animation: false,
        grid: {
          left:         isH ? 20    : ta,
          right:        isH ? 50    : 20,
          top:          30,
          bottom:       isH ? ta    : 55,
          containLabel: false,
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (params) => {
            const p = params[0];
            return `<b>${p.name}</b><br/>${p.seriesName}: ${fmt.format(p.value)}`;
          },
        },
        [catAxis]: [{
          type: 'category',
          data: labels,
          inverse: isH,
          axisLabel: {
            fontSize: lfs,
            rotate: isH ? 0 : 90,
            formatter: (val) => typeof val==='string' && val.length>lmc ? val.slice(0,lmc-1)+'…' : val,
          },
        }],
        [valAxis]: [{
          type: 'value',
          name: measureName,
          nameLocation: 'end',
          axisLabel: { formatter: v => fmt.format(v) },
        }],
        series: [{
          type: 'bar',
          name: measureName,
          data: seriesData,
          barMaxWidth: 60,
          label: {
            show: sl,
            position: isH ? 'right' : 'top',
            formatter: (p) => fmt.format(p.value),
            fontSize: Math.max(8, lfs-1),
          },
        }],
        dataZoom: [
          // Slider bar below (or right of) chart
          {
            type:        'slider',
            [dzKey]:     0,
            start:       dzStart,
            end:         dzEnd,
            height:      isH ? undefined : 18,
            width:       isH ? 18 : undefined,
            right:       isH ? 8 : undefined,
            bottom:      isH ? undefined : 8,
            brushSelect: false,
            showDetail:  false,
          },
          // Inside: mouse wheel + drag to pan
          {
            type:             'inside',
            [dzKey]:          0,
            start:            dzStart,
            end:              dzEnd,
            zoomOnMouseWheel: true,
            moveOnMouseMove:  true,
          },
        ],
      });

      return;
    }

    // ── UPDATE: merge new data into existing chart ─────────────────────────
    // dataZoom component is NOT included here — ECharts merge mode leaves it
    // exactly as-is, so zoom/scroll position is naturally preserved.
    _chart.setOption({
      [catAxis]: [{ data: labels }],
      [valAxis]: [{ name: measureName, axisLabel: { formatter: v => fmt.format(v) } }],
      series: [{
        data: seriesData,
        name: measureName,
        label: {
          show: sl,
          formatter: (p) => fmt.format(p.value),
          fontSize: Math.max(8, lfs-1),
        },
      }],
    });

  }, [labels, values, measureName, isHorizontal, sourceId, dimId, mesId]);

  // ── Effect 2: COSMETIC — style changes only, never touches axis data ───────
  // ECharts setOption merge mode: anything not mentioned is preserved,
  // so dataZoom position is untouched regardless of what we change here.
  useEffect(() => {
    if (!_chart) return;

    const isH = isHorizRef.current;
    const { barColor: bc, gradientMode: gm, gradientLow: gl, showLabels: sl,
            numberFormat: nf, labelFontSize: lfs, labelMaxChars: lmc, tickAreaPx: ta } = styleOpts;

    const fmt = makeFormatter(nf);
    fmtRef.current = fmt;

    const colors = computeColors(valuesRef.current, gm, gl, bc);
    colorsRef.current = colors;
    const seriesData = buildSeriesData(valuesRef.current, colors, selIdxRef.current);

    _chart.setOption({
      grid: {
        left:   isH ? 20 : ta,
        bottom: isH ? ta : 55,
      },
      [isH ? 'yAxis' : 'xAxis']: [{
        axisLabel: {
          fontSize: lfs,
          formatter: (val) => typeof val==='string' && val.length>lmc ? val.slice(0,lmc-1)+'…' : val,
        },
      }],
      [isH ? 'xAxis' : 'yAxis']: [{
        axisLabel: { formatter: v => fmt.format(v) },
      }],
      series: [{
        data: seriesData,
        label: {
          show: sl,
          formatter: (p) => fmt.format(p.value),
          fontSize: Math.max(8, lfs-1),
        },
      }],
    });
  }, [styleOpts]);

  // ── Reset ─────────────────────────────────────────────────────────────────
  const handleReset = () => {
    clearZ(sourceId, dimId, mesId, isHorizontal);
    selIdxRef.current = null;
    setSelInfo('');
    if (!_chart) return;
    const end = defaultEnd(labelsRef.current.length);
    _chart.setOption({
      dataZoom: [
        { type: 'slider', start: 0, end },
        { type: 'inside', start: 0, end },
      ],
      series: [{ data: buildSeriesData(valuesRef.current, colorsRef.current, null) }],
    });
  };

  if (!dimId || !mesId) {
    return <div style={placeholderStyle}>Open the editor panel and select a dimension and measure column.</div>;
  }

  return (
    <div style={{ fontFamily:'sans-serif', padding:'12px', height:'100vh', display:'flex', flexDirection:'column' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
        <span style={{ fontSize:12, color:'#888' }}>Scroll · Mouse wheel to zoom · Click bar to select</span>
        <button onClick={handleReset} style={btnStyle}>Reset</button>
      </div>
      <div ref={containerRef} style={{ flex:1 }} />
      {selInfo && <div style={{ marginTop:6, fontSize:12, color:'#666' }}>{selInfo}</div>}
    </div>
  );
}

const btnStyle = { fontSize:12, padding:'3px 10px', border:'0.5px solid #ccc', borderRadius:4, background:'transparent', cursor:'pointer' };
const placeholderStyle = { display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontSize:13, color:'#999', textAlign:'center', padding:24 };
