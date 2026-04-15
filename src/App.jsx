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
  if (typeof v === 'number') { const ms = v < 1e10 ? v * 1000 : v; const d = new Date(ms); return isNaN(d) ? null : d; }
  if (typeof v === 'string') { const d = new Date(v); return isNaN(d) ? null : d; }
  return null;
}
function toCivilDate(v) {
  const d = toJsDate(v);
  return d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000) : null;
}
const DATE_FMT = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' });
function formatCivil(v) { const d = toCivilDate(v); return d ? DATE_FMT.format(d) : String(v); }

// ── Colour helpers ────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = (hex || '').trim().replace(/^#/, '');
  const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (f.length !== 6) return [60, 121, 200];
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}
function lerpColor(lo, hi, t) {
  const [lr, lg, lb] = hexToRgb(lo), [hr, hg, hb] = hexToRgb(hi);
  return `rgb(${Math.round(lr + t * (hr - lr))},${Math.round(lg + t * (hg - lg))},${Math.round(lb + t * (hb - lb))})`;
}

const PALETTE = [
  '#3c79c8', '#e06c4a', '#4caf7d', '#f0b429', '#9b59b6',
  '#17a2b8', '#e91e63', '#8bc34a', '#ff7043', '#5c6bc0',
  '#26a69a', '#ef5350',
];

function buildPaletteMap(keys) {
  const map = {};
  let idx = 0;
  keys.forEach(k => { if (!(k in map)) map[k] = PALETTE[idx++ % PALETTE.length]; });
  return map;
}

function buildColours(values, colorKeys, mode, barColour, gradLow) {
  if (mode === 'gradient') {
    const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
    return values.map(v => lerpColor(gradLow, barColour, (v - min) / range));
  }
  if (mode === 'palette') {
    const map = buildPaletteMap(colorKeys);
    return colorKeys.map(k => map[k]);
  }
  return values.map(() => barColour);
}

// ── Value formatter ───────────────────────────────────────────────────────────
function fmtValue(v, prefix, suffix, decimals) {
  const dp = parseInt(decimals);
  const num = isNaN(dp) ? v : Number(v).toFixed(dp);
  return `${prefix}${num}${suffix}`;
}

// ── Persistent chart — lives outside React, never destroyed ──────────────────
// Sigma remounts the React component on every config change (new DOM container).
// By keeping the chart div and ECharts instance at module level, they survive
// remounts entirely. Zoom state is never lost because the chart never reinits.
const _div = document.createElement('div');
_div.style.cssText = 'width:100%;height:100vh;';
const _chart = echarts.init(_div);
const _ro = new ResizeObserver(() => _chart.resize());
_ro.observe(_div);
let _zoomReady = false;
let _prevHoriz = null;

// ── Editor fields ─────────────────────────────────────────────────────────────
const EDITOR_FIELDS = [
  { name: 'source',         type: 'element' },
  { name: 'dimensionCol',   type: 'column',   source: 'source', label: 'Axis',           allowedTypes: ['text', 'datetime'] },
  { name: 'measureCol',     type: 'column',   source: 'source', label: 'Measure',         allowedTypes: ['number', 'integer'] },
  { name: 'orientation',    type: 'radio',                      label: 'Orientation',      values: ['vertical', 'horizontal'], defaultValue: 'vertical', singleLine: true },
  { name: 'labelRotate',    type: 'text',                       label: 'Label rotation',   defaultValue: '45' },
  { name: 'showLabels',     type: 'checkbox',                   label: 'Show labels',      defaultValue: true },
  { name: 'labelSize',      type: 'text',                       label: 'Label size',       defaultValue: '12' },
  { name: 'labelWidth',     type: 'text',                       label: 'Max label width' },
  { name: 'axisTitle',      type: 'text',                       label: 'Axis title' },
  { name: 'yPrefix',        type: 'text',                       label: 'Value prefix' },
  { name: 'ySuffix',        type: 'text',                       label: 'Value suffix' },
  { name: 'yDecimals',      type: 'text',                       label: 'Decimal places' },
  { name: 'barRadius',      type: 'text',                       label: 'Rounded corners',  defaultValue: '0' },
  { name: 'showDataLabels', type: 'checkbox',                   label: 'Show data labels' },
  { name: 'dataLabelSize',  type: 'text',                       label: 'Data label size',  defaultValue: '11' },
  { name: 'dataLabelPos',   type: 'radio',                      label: 'Label position',   values: ['top', 'inside'], defaultValue: 'top', singleLine: true },
  { name: 'colorMode',      type: 'radio',                      label: 'Color mode',       values: ['single', 'gradient', 'palette'], defaultValue: 'single', singleLine: true },
  { name: 'barColor',       type: 'color',                      label: 'Bar color' },
  { name: 'gradientLow',    type: 'color',                      label: 'Gradient low' },
  { name: 'colorCol',       type: 'column',   source: 'source', label: 'Palette column',  allowedTypes: ['text', 'number', 'integer', 'datetime'] },
  { name: 'showLegend',     type: 'checkbox',                   label: 'Show legend' },
];

export default function App() {
  const rootRef = useRef(null);

  useEditorPanelConfig(EDITOR_FIELDS);

  const config   = useConfig();
  const sourceId = config?.source;
  const dimId    = config?.dimensionCol;
  const mesId    = config?.measureCol;

  const isHorizontal   = (config?.orientation || 'vertical') === 'horizontal';
  const labelRotate    = isHorizontal ? 0 : Math.min(90, Math.max(0, parseInt(config?.labelRotate) || 45));
  const showLabels     = config?.showLabels     !== false;
  const labelSize      = Math.max(8, parseInt(config?.labelSize)     || 12);
  const labelWidth     = parseInt(config?.labelWidth) || null;
  const axisTitle      = config?.axisTitle      || '';
  const yPrefix        = config?.yPrefix        || '';
  const ySuffix        = config?.ySuffix        || '';
  const yDecimals      = config?.yDecimals      || '';
  const barRadius      = Math.max(0, parseInt(config?.barRadius)     || 0);
  const showDataLabels = config?.showDataLabels === true;
  const dataLabelSize  = Math.max(8, parseInt(config?.dataLabelSize) || 11);
  const dataLabelPos   = config?.dataLabelPos   || 'top';
  const colorMode      = config?.colorMode      || 'single';
  const barColor       = config?.barColor       || '#3c79c8';
  const gradientLow    = config?.gradientLow    || '#c8dff8';
  const colorColId     = config?.colorCol;
  const showLegend     = config?.showLegend     === true;

  const data = useElementData(sourceId);
  const cols = useElementColumns(sourceId);

  const dimIsDate = cols?.[dimId]?.columnType === 'datetime';
  const labels    = (data?.[dimId]  ?? []).map(v => dimIsDate ? formatCivil(v) : String(v));
  const values    = (data?.[mesId]  ?? []).map(Number);
  const colorKeys = (colorColId && data?.[colorColId])
    ? data[colorColId].map(String)
    : labels;

  // On every mount (including Sigma-triggered remounts), re-attach the
  // persistent div. The ECharts instance inside it is untouched.
  useEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(_div)) root.appendChild(_div);
  });

  // Update chart data and appearance
  useEffect(() => {
    if (!labels.length) return;

    const colours    = buildColours(values, colorKeys, colorMode, barColor, gradientLow);
    const paletteMap = colorMode === 'palette' ? buildPaletteMap(colorKeys) : {};
    const borderRadius = isHorizontal ? [0, barRadius, barRadius, 0] : [barRadius, barRadius, 0, 0];

    const seriesData = values.map((v, i) => ({
      value: v,
      name: colorMode === 'palette' ? colorKeys[i] : undefined,
      itemStyle: { color: colours[i], borderRadius },
    }));

    const valueFormatter = v => fmtValue(v, yPrefix, ySuffix, yDecimals);

    const catAxis = {
      type: 'category',
      data: labels,
      name: axisTitle,
      nameLocation: 'middle',
      nameGap: isHorizontal ? 50 : (labelRotate > 0 ? labelSize * 2.5 + 16 : 24),
      axisLabel: {
        show: showLabels,
        rotate: isHorizontal ? 0 : labelRotate,
        fontSize: labelSize,
        ...(labelWidth ? { overflow: 'truncate', width: labelWidth } : {}),
      },
    };

    const valAxis = {
      type: 'value',
      name: cols?.[mesId]?.name ?? '',
      nameLocation: 'end',
      nameGap: 8,
      axisLabel: { formatter: valueFormatter },
    };

    const legendOn = showLegend && colorMode === 'palette';
    const legendData = legendOn
      ? Object.entries(paletteMap).map(([name, color]) => ({ name, itemStyle: { color } }))
      : [];

    const orientChanged = _prevHoriz !== isHorizontal;
    _prevHoriz = isHorizontal;
    if (orientChanged) _zoomReady = false;

    const option = {
      animation: false,
      grid: {
        top:    legendOn ? 60 : 40,
        right:  isHorizontal ? 48 : 20,
        bottom: 40,
        left:   20,
        containLabel: true,
      },
      xAxis: isHorizontal ? valAxis : catAxis,
      yAxis: isHorizontal ? catAxis : valAxis,
      series: [{
        type: 'bar',
        data: seriesData,
        label: {
          show: showDataLabels,
          position: dataLabelPos,
          fontSize: dataLabelSize,
          formatter: ({ value }) => valueFormatter(value),
        },
      }],
      legend: { show: legendOn, data: legendData, selectedMode: false },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter },
    };

    if (!_zoomReady) {
      option.dataZoom = isHorizontal ? [
        { type: 'slider', yAxisIndex: 0, right: 8, width: 20, showDetail: false },
        { type: 'inside', yAxisIndex: 0 },
      ] : [
        { type: 'slider', xAxisIndex: 0, bottom: 8, height: 20, showDetail: false },
        { type: 'inside', xAxisIndex: 0 },
      ];
      _zoomReady = true;
    }

    _chart.setOption(option);
  });

  if (!dimId || !mesId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#999', fontSize: 13 }}>
        Select a dimension and measure column.
      </div>
    );
  }

  return <div ref={rootRef} style={{ width: '100%', height: '100vh' }} />;
}
