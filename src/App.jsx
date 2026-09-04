import React, { useState, useEffect, useRef } from 'react';
import {
  ComposedChart, LineChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  Sun, Wind, Battery, BatteryCharging, Zap, AlertTriangle, Fuel, Activity, Wrench, Radio,
  TrendingDown, Snowflake, CloudSnow, Cpu, Play, Pause, Info, ShieldAlert,
} from 'lucide-react';

/* ---------------------------------------------------------------
   Domain config
--------------------------------------------------------------- */

const SEASON_CONFIG = {
  summer:  { label: 'Austral summer', sub: '24h daylight · ~ -15°C avg',  heatingLoad: 6  },
  equinox: { label: 'Equinox',        sub: '12h/12h cycle · ~ -30°C avg', heatingLoad: 10 },
  winter:  { label: 'Polar night',    sub: 'zero daylight · ~ -45°C avg', heatingLoad: 16 },
};

const LOAD_TEMPLATE = [
  { id: 'life',    name: 'Life support & heating',      priority: 1, kw: 18, sheddable: false },
  { id: 'comms',   name: 'Comms & navigation',           priority: 1, kw: 4,  sheddable: false },
  { id: 'coldsci', name: 'Sample freezers (-80°C)',       priority: 1, kw: 6,  sheddable: false },
  { id: 'lab',     name: 'Active lab equipment',          priority: 2, kw: 9,  sheddable: true  },
  { id: 'kitchen', name: 'Galley & water treatment',      priority: 2, kw: 7,  sheddable: true  },
  { id: 'common',  name: 'Common area lighting / HVAC',   priority: 3, kw: 5,  sheddable: true  },
  { id: 'workshop',name: 'Workshop & garage heaters',     priority: 3, kw: 6,  sheddable: true  },
  { id: 'rec',     name: 'Recreation room',               priority: 4, kw: 3,  sheddable: true  },
];

const PRIORITY_LABEL = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };
const PRIORITY_COLOR = { 1: 'var(--red)', 2: 'var(--amber)', 3: 'var(--cyan)', 4: 'var(--ice-dim)' };
const LEVEL_COLOR = { critical: 'var(--red)', warning: 'var(--amber)', action: 'var(--cyan)', info: 'var(--ice-dim)' };
const LEVEL_ICON = { critical: AlertTriangle, warning: ShieldAlert, action: Activity, info: Info };

/* ---------------------------------------------------------------
   Small numeric helpers
--------------------------------------------------------------- */

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const round1 = (v) => Math.round(v * 10) / 10;

function solarFactorFor(season, hour) {
  if (season === 'winter') return 0; // true polar night: no solar input at all
  if (season === 'summer') return 0.55 + 0.25 * Math.sin((hour / 24) * 2 * Math.PI); // midnight sun
  if (hour < 6 || hour > 18) return 0;
  return Math.sin(((hour - 6) / 12) * Math.PI);
}

function windCapacityFraction(speed) {
  const cutIn = 3, rated = 12, cutOut = 27;
  if (speed < cutIn || speed >= cutOut) return 0;
  if (speed >= rated) return 1;
  const x = (speed - cutIn) / (rated - cutIn);
  return Math.min(1, x * x * x);
}

/* ---------------------------------------------------------------
   Core simulation tick — this is the "AI dispatch" decision logic.
   In production this block is where a trained forecasting model +
   an MPC/RL dispatch policy + an anomaly detector would run; here
   the same decision structure is implemented directly so the
   dashboard behaves like the real system would.
--------------------------------------------------------------- */

function computeTick(prev) {
  let hour = prev.hour + 1;
  let day = prev.day;
  if (hour >= 24) { hour = 0; day += 1; }

  let storm = prev.storm;
  let stormTicksLeft = prev.stormTicksLeft;
  if (storm) {
    stormTicksLeft -= 1;
    if (stormTicksLeft <= 0) storm = false;
  }

  const windMean = storm ? 30 : (prev.season === 'winter' ? 12 : prev.season === 'equinox' ? 9 : 7);
  const windSpeed = storm ? rand(28, 36) : clamp(windMean + rand(-3, 3), 0, 26);
  const cloudCover = storm ? rand(0.9, 1) : clamp(rand(0.1, 0.6), 0, 1);

  const equipment = { ...prev.equipment };
  equipment.gen1 = clamp(equipment.gen1 - (prev.lastDieselOutput > 0 ? rand(0.02, 0.08) : rand(0, 0.01)), 0, 100);
  equipment.wind = clamp(equipment.wind - (windSpeed > 18 ? rand(0.03, 0.09) : rand(0, 0.02)), 0, 100);
  equipment.solar = clamp(equipment.solar - rand(0, 0.015), 0, 100);
  equipment.battery = clamp(equipment.battery - (prev.battery.soc < 30 ? rand(0.02, 0.05) : rand(0, 0.01)), 0, 100);

  const solarFactor = solarFactorFor(prev.season, hour);
  const solarMax = 25 * (equipment.solar / 100);
  const solarKW = solarFactor * solarMax * (1 - cloudCover);

  const windMax = 20 * (equipment.wind / 100);
  const windKW = windCapacityFraction(windSpeed) * windMax;

  const heatingExtra = SEASON_CONFIG[prev.season].heatingLoad;
  const workHourFactor = (hour >= 8 && hour <= 20) ? 1 : 0.8;
  const flexIds = new Set(['lab', 'kitchen', 'common', 'workshop', 'rec']);
  let loads = prev.loads.map((l) => ({ ...l }));
  const activeLoads = loads.filter((l) => !l.shed);
  const baseDemand = activeLoads.reduce((s, l) => s + l.kw * (flexIds.has(l.id) ? workHourFactor : 1), 0);
  const demandKW = Math.max(5, baseDemand + heatingExtra + rand(-1, 1));

  const forecastKW = prev.history.length
    ? prev.history[prev.history.length - 1].demand * 0.6 + demandKW * 0.4 + rand(-1.5, 1.5)
    : demandKW;

  const dieselMax = 45 * (equipment.gen1 / 100);
  const battReserve = 25;
  const battMaxDischarge = 25;
  const battMaxCharge = 20;

  const renewable = solarKW + windKW;
  let remaining = demandKW - renewable;
  let battDischarge = 0, battCharge = 0, dieselOutput = 0, curtailed = 0;
  const reasoningParts = [];

  if (remaining > 0) {
    const socAboveReserve = prev.battery.soc > battReserve;
    battDischarge = socAboveReserve ? Math.min(battMaxDischarge, remaining) : Math.min(battMaxDischarge * 0.25, remaining);
    remaining -= battDischarge;

    if (remaining > 0.5) {
      dieselOutput = Math.min(dieselMax, remaining);
      remaining -= dieselOutput;
    }

    if (remaining > 0.5) {
      let deficit = remaining;
      const sheddable = loads.filter((l) => l.sheddable && !l.shed).sort((a, b) => b.priority - a.priority);
      for (const l of sheddable) {
        if (deficit <= 0) break;
        const target = loads.find((x) => x.id === l.id);
        target.shed = true;
        deficit -= l.kw;
        reasoningParts.push(`Shedding "${l.name}" to protect critical loads.`);
      }
      remaining = Math.max(0, deficit);
    }
  } else {
    const surplus = -remaining;
    battCharge = prev.battery.soc < 97 ? Math.min(battMaxCharge, surplus) : 0;
    curtailed = surplus - battCharge;

    if ((surplus - battCharge > 3 || prev.battery.soc > 55) && !storm) {
      const shedList = loads.filter((l) => l.sheddable && l.shed).sort((a, b) => a.priority - b.priority);
      if (shedList.length) {
        const target = loads.find((x) => x.id === shedList[0].id);
        target.shed = false;
        reasoningParts.push(`Restoring "${shedList[0].name}" — surplus capacity available.`);
      }
    }
  }

  const socDelta = ((battCharge - battDischarge) / 200) * 100; // 200 kWh bank, 1h tick
  const soc = clamp(prev.battery.soc + socDelta, 2, 100);

  const litersUsed = dieselOutput * 0.32;
  const baselineLiters = demandKW * 0.32;
  const dieselFuelPct = clamp(prev.dieselFuelPct - (litersUsed / 50000) * 100, 0, 100);
  const cumDieselLiters = prev.cumDieselLiters + litersUsed;
  const cumBaselineLiters = prev.cumBaselineLiters + baselineLiters;

  const point = {
    hour, label: `D${day} ${String(hour).padStart(2, '0')}:00`,
    solar: round1(solarKW), wind: round1(windKW), diesel: round1(dieselOutput), batt: round1(battDischarge),
    demand: round1(demandKW), forecast: round1(forecastKW), soc: round1(soc), fuel: round1(dieselFuelPct),
  };
  const history = [...prev.history, point].slice(-24);

  let alerts = [...prev.alerts];
  const pushAlert = (level, msg) => {
    alerts = [{ id: Date.now() + Math.random(), t: point.label, level, msg }, ...alerts].slice(0, 14);
  };
  reasoningParts.forEach((r) => pushAlert('action', r));
  if (!prev.storm && storm) pushAlert('critical', 'Storm system detected — turbine feathering above safe wind speed, switching to battery + diesel buffer.');
  if (prev.storm && !storm) pushAlert('info', 'Storm cleared — resuming normal renewable-led dispatch.');
  if (equipment.gen1 < 60 && prev.equipment.gen1 >= 60) pushAlert('warning', `Generator wear signature detected — health ${equipment.gen1.toFixed(0)}%. Maintenance window recommended within 10 days.`);
  if (soc < battReserve && prev.battery.soc >= battReserve) pushAlert('warning', `Battery reserve threshold reached (${soc.toFixed(0)}%) — entering conservation mode.`);
  if (dieselFuelPct < 20 && prev.dieselFuelPct >= 20) pushAlert('warning', 'Diesel reserve below 20% of annual allocation — dispatch weighting shifted further toward renewables and battery.');

  return {
    ...prev, hour, day, storm, stormTicksLeft, windSpeed, cloudCover, equipment,
    battery: { soc }, dieselFuelPct, loads, history, alerts, lastDieselOutput: dieselOutput,
    cumDieselLiters, cumBaselineLiters,
    dispatch: { solarKW, windKW, battDischarge, battCharge, dieselOutput, curtailed, demandKW },
  };
}

function seedState() {
  let s = {
    hour: 5, day: 1, season: 'equinox', storm: false, stormTicksLeft: 0,
    windSpeed: 8, cloudCover: 0.3,
    equipment: { gen1: 94, wind: 90, solar: 96, battery: 97 },
    battery: { soc: 72 }, dieselFuelPct: 64,
    loads: LOAD_TEMPLATE.map((l) => ({ ...l, shed: false })),
    history: [],
    alerts: [{ id: 0, t: '—', level: 'info', msg: 'AI dispatch engine online. Digital twin initialised from station baseline telemetry.' }],
    lastDieselOutput: 0, cumDieselLiters: 0, cumBaselineLiters: 0,
    dispatch: { solarKW: 0, windKW: 0, battDischarge: 0, battCharge: 0, dieselOutput: 0, curtailed: 0, demandKW: 40 },
  };
  for (let i = 0; i < 10; i++) s = computeTick(s);
  return s;
}

function buildReasoning(sim) {
  const d = sim.dispatch;
  const demand = Math.max(d.demandKW, 1);
  const lines = [];
  if (sim.season === 'winter' && d.solarKW === 0) {
    lines.push('Polar night in effect — solar array is offline for the season, so dispatch leans on wind, battery reserves and diesel.');
  }
  if (d.windKW > d.solarKW && d.windKW > 5) {
    lines.push(`Wind is the primary source right now (${d.windKW.toFixed(1)} kW), covering ${((d.windKW / demand) * 100).toFixed(0)}% of demand.`);
  } else if (d.solarKW > 3) {
    lines.push(`Solar is contributing ${d.solarKW.toFixed(1)} kW, covering ${((d.solarKW / demand) * 100).toFixed(0)}% of demand.`);
  }
  if (d.dieselOutput > 0.5) {
    lines.push(`Diesel genset topping up ${d.dieselOutput.toFixed(1)} kW — held to the minimum needed to protect battery depth-of-discharge.`);
  } else {
    lines.push('Diesel genset idle — demand fully covered by renewables and battery.');
  }
  if (d.battCharge > 0.5) lines.push(`Surplus of ${d.battCharge.toFixed(1)} kW routed to battery charging.`);
  if (d.curtailed > 0.5) lines.push(`${d.curtailed.toFixed(1)} kW curtailed — battery full, no further useful sink for the surplus.`);
  if (sim.storm) lines.push('Storm protocol active: turbine feathered for safety, heating load held at top priority.');
  return lines;
}

/* ---------------------------------------------------------------
   Small presentational pieces
--------------------------------------------------------------- */

function Kpi({ label, value, icon, tone }) {
  const color = { green: 'var(--green)', cyan: 'var(--cyan)', amber: 'var(--amber)', red: 'var(--red)', ice: 'var(--ice)' }[tone] || 'var(--ice)';
  return (
    <div className="pea-panel rounded-lg p-3">
      <div className="flex items-center gap-1.5 pea-dim text-xs mb-1.5">{icon}<span>{label}</span></div>
      <div className="text-xl font-semibold pea-mono" style={{ color }}>{value}</div>
    </div>
  );
}

function SourceBar({ label, value, max, color, icon }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div>
      <div className="flex items-center justify-between text-xs pea-dim mb-1">
        <span className="flex items-center gap-1">{icon}{label}</span>
        <span className="pea-mono">{value.toFixed(1)} kW</span>
      </div>
      <div className="h-1.5 rounded-full" style={{ background: 'var(--bg-panel-raised)' }}>
        <div className="h-1.5 rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function HealthRow({ label, value, icon }) {
  const color = value >= 80 ? 'var(--green)' : value >= 50 ? 'var(--amber)' : 'var(--red)';
  const status = value >= 80 ? 'Nominal' : value >= 50 ? 'Elevated wear' : 'Maintenance required';
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="flex items-center gap-1.5">{icon}{label}</span>
        <span className="pea-mono text-xs" style={{ color }}>{value.toFixed(0)}% · {status}</span>
      </div>
      <div className="h-1.5 rounded-full" style={{ background: 'var(--bg-panel-raised)' }}>
        <div className="h-1.5 rounded-full transition-all" style={{ width: `${value}%`, background: color }} />
      </div>
    </div>
  );
}

function LoadRow({ load }) {
  return (
    <div className="flex items-center justify-between text-sm py-1.5 border-b" style={{ borderColor: 'var(--border-hair)' }}>
      <div className="flex items-center gap-2">
        <span className="rounded-full flex-shrink-0" style={{ width: 7, height: 7, background: load.shed ? 'var(--red)' : 'var(--green)' }} />
        <span className={load.shed ? 'pea-dim line-through' : ''}>{load.name}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="pea-mono text-xs pea-dim">{load.kw} kW</span>
        <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: PRIORITY_COLOR[load.priority], border: `1px solid ${PRIORITY_COLOR[load.priority]}` }}>
          {PRIORITY_LABEL[load.priority]}
        </span>
      </div>
    </div>
  );
}

function AlertRow({ alert }) {
  const Icon = LEVEL_ICON[alert.level] || Info;
  const color = LEVEL_COLOR[alert.level] || 'var(--ice-dim)';
  return (
    <div className="flex gap-2 text-xs">
      <Icon size={13} style={{ color, marginTop: 2, flexShrink: 0 }} />
      <div>
        <div className="pea-mono pea-dim">{alert.t}</div>
        <p style={{ color: alert.level === 'critical' || alert.level === 'warning' ? color : 'var(--ice)' }}>{alert.msg}</p>
      </div>
    </div>
  );
}

function LegendDot({ color, label, line }) {
  return (
    <span className="flex items-center gap-1.5">
      <span style={line ? { width: 10, height: 2, background: color, display: 'inline-block' } : { width: 8, height: 8, borderRadius: 9999, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

/* ---------------------------------------------------------------
   Main component
--------------------------------------------------------------- */

export default function PolarEnergyAI() {
  const [sim, setSim] = useState(seedState);
  const [running, setRunning] = useState(true);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setSim((prev) => computeTick(prev));
      }, 1400);
    }
    return () => clearInterval(intervalRef.current);
  }, [running]);

  const setSeason = (season) => setSim((prev) => ({ ...prev, season }));
  const triggerStorm = () => setSim((prev) => ({ ...prev, storm: true, stormTicksLeft: 5 }));
  const triggerFault = () => setSim((prev) => {
    const equipment = { ...prev.equipment, gen1: clamp(prev.equipment.gen1 - 32, 5, 100) };
    const t = prev.history.length ? prev.history[prev.history.length - 1].label : '—';
    const alerts = [{ id: Date.now(), t, level: 'critical', msg: 'Anomaly detected on diesel generator — abnormal vibration signature. Predicted bearing degradation; failure risk within roughly 9 days if unaddressed.' }, ...prev.alerts].slice(0, 14);
    return { ...prev, equipment, alerts };
  });
  const resetSim = () => { setSim(seedState()); setRunning(true); };

  const dieselSavedPct = sim.cumBaselineLiters > 0 ? Math.max(0, (1 - sim.cumDieselLiters / sim.cumBaselineLiters) * 100) : 0;
  const co2AvoidedKg = Math.max(0, (sim.cumBaselineLiters - sim.cumDieselLiters) * 2.68);
  const shedCount = sim.loads.filter((l) => l.shed).length;
  const sheddableCount = sim.loads.filter((l) => l.sheddable).length;
  const reasoning = buildReasoning(sim);

  return (
    <div className="pea-root min-h-screen w-full p-4 md:p-6">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .pea-root {
          --bg-deep:#0A1420; --bg-panel:#101E30; --bg-panel-raised:#16283D; --border-hair:#22344a;
          --ice:#E7F1FA; --ice-dim:#7E97AD; --orange:#F0621D; --cyan:#4FD1E8; --green:#6EE7A8; --amber:#F5B942; --red:#E5484D;
          background: radial-gradient(ellipse 120% 80% at 50% -10%, #0e2035 0%, var(--bg-deep) 55%);
          color: var(--ice);
          font-family: 'Space Grotesk', sans-serif;
        }
        .pea-mono { font-family: 'JetBrains Mono', monospace; }
        .pea-panel { background: var(--bg-panel); border: 1px solid var(--border-hair); }
        .pea-dim { color: var(--ice-dim); }
        .pea-cyan { color: var(--cyan); }
        .pea-red { color: var(--red); }
        .pea-scroll::-webkit-scrollbar { width: 6px; }
        .pea-scroll::-webkit-scrollbar-thumb { background: var(--border-hair); border-radius: 3px; }
        @keyframes pea-pulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }
        .pea-pulse { animation: pea-pulse 1.6s ease-in-out infinite; }
      `}</style>

      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-5 border-b" style={{ borderColor: 'var(--border-hair)' }}>
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Polar station energy AI</h1>
          <p className="pea-dim text-sm mt-1 max-w-md">Live digital-twin simulation of an AI dispatch system for an Antarctic research station's microgrid.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md overflow-hidden border" style={{ borderColor: 'var(--border-hair)' }}>
            {Object.entries(SEASON_CONFIG).map(([key, cfg]) => (
              <button
                key={key}
                onClick={() => setSeason(key)}
                className="px-3 py-1.5 text-sm transition-colors"
                style={{
                  background: sim.season === key ? 'var(--bg-panel-raised)' : 'transparent',
                  color: sim.season === key ? 'var(--ice)' : 'var(--ice-dim)',
                  fontWeight: sim.season === key ? 600 : 400,
                }}
              >
                {cfg.label}
              </button>
            ))}
          </div>
          <button onClick={triggerStorm} disabled={sim.storm} className="pea-panel rounded-md px-3 py-1.5 text-sm flex items-center gap-1.5 disabled:opacity-40">
            <CloudSnow size={15} /> Simulate storm
          </button>
          <button onClick={triggerFault} className="pea-panel rounded-md px-3 py-1.5 text-sm flex items-center gap-1.5">
            <Wrench size={15} /> Simulate fault
          </button>
          <button onClick={() => setRunning((r) => !r)} className="rounded-md px-3 py-1.5 text-sm flex items-center gap-1.5" style={{ background: 'var(--orange)', color: '#0A1420', fontWeight: 600 }}>
            {running ? <Pause size={15} /> : <Play size={15} />} {running ? 'Pause' : 'Resume'}
          </button>
          <button onClick={resetSim} className="pea-dim text-xs underline px-1">Reset</button>
        </div>
      </div>

      {/* Clock + weather strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 text-sm pea-mono pea-dim">
        <span>Day {sim.day} · {String(sim.hour).padStart(2, '0')}:00</span>
        <span>{SEASON_CONFIG[sim.season].sub}</span>
        <span className="flex items-center gap-1"><Wind size={14} /> {sim.windSpeed.toFixed(1)} m/s</span>
        <span className="flex items-center gap-1"><CloudSnow size={14} /> {(sim.cloudCover * 100).toFixed(0)}% cloud</span>
        {sim.storm && <span className="pea-red pea-pulse flex items-center gap-1"><AlertTriangle size={14} /> Storm protocol active</span>}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 py-3">
        <Kpi label="Diesel saved vs. all-diesel baseline" value={`${dieselSavedPct.toFixed(0)}%`} icon={<TrendingDown size={16} />} tone="green" />
        <Kpi label="CO₂ avoided" value={`${(co2AvoidedKg / 1000).toFixed(2)} t`} icon={<Snowflake size={16} />} tone="cyan" />
        <Kpi label="Battery" value={`${sim.battery.soc.toFixed(0)}%`} icon={<BatteryCharging size={16} />} tone={sim.battery.soc < 25 ? 'red' : 'ice'} />
        <Kpi label="Diesel reserve" value={`${sim.dieselFuelPct.toFixed(0)}%`} icon={<Fuel size={16} />} tone={sim.dieselFuelPct < 20 ? 'amber' : 'ice'} />
        <Kpi label="Loads shed" value={`${shedCount}/${sheddableCount}`} icon={<Zap size={16} />} tone={shedCount > 0 ? 'amber' : 'green'} />
      </div>

      {/* Hero row: generation chart + AI dispatch reasoning */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 pt-2">
        <div className="xl:col-span-2 pea-panel rounded-lg p-4">
          <h2 className="text-sm font-semibold pea-dim mb-3">Generation mix vs. demand — rolling 24h</h2>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={sim.history}>
              <CartesianGrid stroke="var(--border-hair)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="hour" tickFormatter={(h) => `${h}:00`} stroke="var(--ice-dim)" fontSize={11} interval={2} />
              <YAxis stroke="var(--ice-dim)" fontSize={11} width={34} label={{ value: 'kW', angle: -90, position: 'insideLeft', fill: 'var(--ice-dim)', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: 'var(--bg-panel-raised)', border: '1px solid var(--border-hair)', borderRadius: 6, fontSize: 12 }} labelFormatter={(h) => `Hour ${h}:00`} />
              <Area type="monotone" dataKey="solar" stackId="gen" stroke="none" fill="var(--amber)" fillOpacity={0.75} />
              <Area type="monotone" dataKey="wind" stackId="gen" stroke="none" fill="var(--cyan)" fillOpacity={0.75} />
              <Area type="monotone" dataKey="batt" stackId="gen" stroke="none" fill="var(--green)" fillOpacity={0.7} />
              <Area type="monotone" dataKey="diesel" stackId="gen" stroke="none" fill="var(--orange)" fillOpacity={0.8} />
              <Line type="monotone" dataKey="demand" stroke="var(--ice)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="forecast" stroke="var(--ice-dim)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs pea-dim">
            <LegendDot color="var(--amber)" label="Solar" />
            <LegendDot color="var(--cyan)" label="Wind" />
            <LegendDot color="var(--green)" label="Battery discharge" />
            <LegendDot color="var(--orange)" label="Diesel" />
            <LegendDot color="var(--ice)" label="Actual demand" line />
            <LegendDot color="var(--ice-dim)" label="AI forecast" line />
          </div>
        </div>

        <div className="pea-panel rounded-lg p-4 flex flex-col">
          <h2 className="text-sm font-semibold pea-dim mb-3 flex items-center gap-2"><Cpu size={15} /> AI dispatch — right now</h2>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <SourceBar label="Solar" value={sim.dispatch.solarKW} max={25} color="var(--amber)" icon={<Sun size={13} />} />
            <SourceBar label="Wind" value={sim.dispatch.windKW} max={20} color="var(--cyan)" icon={<Wind size={13} />} />
            <SourceBar label="Battery" value={sim.dispatch.battDischarge} max={25} color="var(--green)" icon={<Battery size={13} />} />
            <SourceBar label="Diesel" value={sim.dispatch.dieselOutput} max={45} color="var(--orange)" icon={<Fuel size={13} />} />
          </div>
          <div className="flex-1 space-y-2 text-sm leading-relaxed">
            {reasoning.map((line, i) => (
              <p key={i} className="flex gap-2">
                <span className="pea-cyan flex-shrink-0">›</span>
                <span className="pea-dim">{line}</span>
              </p>
            ))}
          </div>
        </div>
      </div>

      {/* Second row: battery chart + predictive maintenance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-4">
        <div className="pea-panel rounded-lg p-4">
          <h2 className="text-sm font-semibold pea-dim mb-3">Battery state of charge</h2>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={sim.history}>
              <CartesianGrid stroke="var(--border-hair)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="hour" tickFormatter={(h) => `${h}:00`} stroke="var(--ice-dim)" fontSize={11} interval={3} />
              <YAxis domain={[0, 100]} stroke="var(--ice-dim)" fontSize={11} width={30} />
              <Tooltip contentStyle={{ background: 'var(--bg-panel-raised)', border: '1px solid var(--border-hair)', borderRadius: 6, fontSize: 12 }} labelFormatter={(h) => `Hour ${h}:00`} />
              <Line type="monotone" dataKey="soc" stroke="var(--green)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="pea-panel rounded-lg p-4">
          <h2 className="text-sm font-semibold pea-dim mb-3 flex items-center gap-2"><Wrench size={15} /> Predictive maintenance</h2>
          <div className="space-y-3">
            <HealthRow label="Diesel generator" value={sim.equipment.gen1} icon={<Fuel size={14} />} />
            <HealthRow label="Wind turbine" value={sim.equipment.wind} icon={<Wind size={14} />} />
            <HealthRow label="Solar array" value={sim.equipment.solar} icon={<Sun size={14} />} />
            <HealthRow label="Battery bank" value={sim.equipment.battery} icon={<Battery size={14} />} />
          </div>
        </div>
      </div>

      {/* Third row: load ladder + event log */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 py-4">
        <div className="pea-panel rounded-lg p-4">
          <h2 className="text-sm font-semibold pea-dim mb-3 flex items-center gap-2"><Zap size={15} /> Load priority ladder</h2>
          <div>
            {sim.loads.map((l) => <LoadRow key={l.id} load={l} />)}
          </div>
        </div>
        <div className="pea-panel rounded-lg p-4">
          <h2 className="text-sm font-semibold pea-dim mb-3 flex items-center gap-2"><Radio size={15} /> Event log</h2>
          <div className="space-y-2.5 max-h-64 overflow-y-auto pea-scroll pr-1">
            {sim.alerts.map((a) => <AlertRow key={a.id} alert={a} />)}
          </div>
        </div>
      </div>

      <p className="pea-dim text-xs pt-2 border-t" style={{ borderColor: 'var(--border-hair)' }}>
        Simulated digital twin for demonstration. A production deployment would train the forecasting model on real station telemetry (LSTM / temporal transformer),
        the dispatch policy via model-predictive control or reinforcement learning, and the anomaly detector via an isolation forest / autoencoder on real vibration,
        thermal and current sensor streams — all running on an on-site edge server so the system keeps working through satellite-link outages.
      </p>
    </div>
  );
}
