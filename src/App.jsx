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

const EDITOR_FIELDS = [
  { name: 'source',       type: 'element' },
  { name: 'dimensionCol', type: 'column', source: 'source', label: 'Axis',          allowedTypes: ['text', 'datetime'] },
  { name: 'measureCol',   type: 'column', source: 'source', label: 'Measure',       allowedTypes: ['number', 'integer'] },
  { name: 'labelRotate',  type: 'text',                     label: 'Label rotation', defaultValue: '45' },
];

export default function App() {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);

  useEditorPanelConfig(EDITOR_FIELDS);

  const config   = useConfig();
  const sourceId = config?.source;
  const dimId    = config?.dimensionCol;
  const mesId    = config?.measureCol;

  const data = useElementData(sourceId);
  const cols = useElementColumns(sourceId);

  const labelRotate = Math.min(90, Math.max(0, parseInt(config?.labelRotate) || 45));

  const dimIsDate = cols?.[dimId]?.columnType === 'datetime';
  const labels = (data?.[dimId] ?? []).map(v => dimIsDate ? formatCivil(v) : String(v));
  const values = (data?.[mesId] ?? []).map(Number);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !labels.length) return;

    // Create chart once, reuse on every subsequent render
    if (!chartRef.current) {
      chartRef.current = echarts.init(container);
      const ro = new ResizeObserver(() => chartRef.current?.resize());
      ro.observe(container);
    }

    chartRef.current.setOption({
      animation: false,
      // containLabel: true — ECharts sizes the plot area to fit axis labels
      // automatically. We just reserve fixed space for the zoom slider (bottom)
      // and the y-axis title (top).
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
        data: values,
        color: '#3c79c8',
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
