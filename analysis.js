// Track parsing and jump analysis. Pure functions with no DOM access, so Node can load this file for tests.

const G = 9.80665;
const FT_PER_M = 3.28084;

// FAI ISC Wingsuit Flying Competition Rules 2026, section 2.3 and 6.3 (acrobatic event).
// Altitudes in the rules are "Geometric Altitude": GNSS height above ground level.
const ACRO = {
  minExitM: 12000 / FT_PER_M,   // 6.3.1  minimum exit altitude, 3658 m / 12,000 ft
  maxExitM: 12500 / FT_PER_M,   // 6.3.1  maximum exit altitude, 3810 m / 12,500 ft
  topVd: 10,             // 2.3    window upper boundary: vertical speed reaches 10 m/s after exit
  windowFt: 7500,        // 6.3.3  lower boundary below the upper boundary
  loweredWindowFt: 5000, // 6.3.5  when the exit altitude is lowered to 11,500 ft or less
};

// Reads FlySight 2 TRACK.CSV ($GNSS rows) and FlySight 1 CSV. Returns columns of numbers; t is epoch seconds.
function parseTrack(text) {
  const track = { t: [], lat: [], lon: [], h: [], vn: [], ve: [], vd: [] };
  let cols = null, tagged = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('$COL,GNSS,')) { cols = line.split(',').slice(2); tagged = true; continue; }
    if (!cols && line.startsWith('time,lat,lon,hMSL')) { cols = line.split(','); continue; }
    if (!cols || (tagged && !line.startsWith('$GNSS,'))) continue;
    const f = line.split(',');
    if (tagged) f.shift();
    const num = name => parseFloat(f[cols.indexOf(name)]);
    const t = Date.parse(f[cols.indexOf('time')]) / 1000, h = num('hMSL'), vd = num('velD');
    if (!Number.isFinite(t) || !Number.isFinite(h) || !Number.isFinite(vd)) continue;
    track.t.push(t); track.h.push(h); track.vd.push(vd);
    track.lat.push(num('lat')); track.lon.push(num('lon'));
    track.vn.push(num('velN')); track.ve.push(num('velE'));
  }
  return track;
}

// Linear interpolation of one column at time t
function valueAt(track, col, t) {
  const T = track.t, n = T.length;
  if (t <= T[0]) return track[col][0];
  if (t >= T[n - 1]) return track[col][n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid; }
  const f = (t - T[lo]) / (T[hi] - T[lo] || 1);
  return track[col][lo] + f * (track[col][hi] - track[col][lo]);
}

// The exit is where vertical speed first climbs through 10 m/s and stays there.
// Returns the time of that crossing (the window's upper boundary), or null if the track has no jump in it.
function findTopCrossing(track) {
  const { t, vd } = track;
  for (let i = 1; i < t.length; i++) {
    if (vd[i - 1] >= ACRO.topVd || vd[i] < ACRO.topVd) continue;
    let j = i, sustained = true;
    while (j < t.length && t[j] - t[i] < 5) { if (vd[j] < ACRO.topVd) { sustained = false; break; } j++; }
    if (!sustained || t[Math.min(j, t.length - 1)] - t[i] < 4) continue;
    const f = (ACRO.topVd - vd[i - 1]) / (vd[i] - vd[i - 1]);
    return t[i - 1] + f * (t[i] - t[i - 1]);
  }
  return null;
}

// Keep only the part of a track around the jump, so stored jumps stay small
function trimToJump(track, before = 30, after = 240) {
  const tTop = findTopCrossing(track);
  if (tTop === null) return null;
  const out = {};
  const keep = track.t.map(t => t >= tTop - before && t <= tTop + after);
  for (const col of Object.keys(track)) out[col] = track[col].filter((_, i) => keep[i]);
  return out;
}

// Acro analysis of one jump. windowFt is 7500, or 5000 when the exit altitude was lowered.
function analyseAcro(track, windowFt = ACRO.windowFt) {
  const tTop = findTopCrossing(track);
  if (tTop === null) return null;
  const T = track.t, last = T[T.length - 1];

  // Vertical speed takes about a second to build to 10 m/s, so step back that far for the exit itself
  const tExit = Math.max(T[0], tTop - ACRO.topVd / G);
  const topMsl = valueAt(track, 'h', tTop);
  const bottomMsl = topMsl - windowFt / FT_PER_M;

  let tBottom = null;
  for (let i = 1; i < T.length; i++) {
    if (T[i] <= tTop || track.h[i] > bottomMsl) continue;
    const f = (track.h[i - 1] - bottomMsl) / (track.h[i - 1] - track.h[i] || 1);
    tBottom = T[i - 1] + f * (T[i] - T[i - 1]);
    break;
  }
  const complete = tBottom !== null;
  const tEnd = complete ? tBottom : last;

  // Path length through the window, from ground speed
  const times = [tTop, ...T.filter(t => t > tTop && t < tEnd), tEnd];
  const hs = times.map(t => Math.hypot(valueAt(track, 'vn', t), valueAt(track, 've', t)));
  let distance = 0;
  for (let i = 1; i < times.length; i++) distance += (hs[i] + hs[i - 1]) / 2 * (times[i] - times[i - 1]);

  const duration = tEnd - tTop;
  const drop = topMsl - valueAt(track, 'h', tEnd);
  return {
    tExit, tTop, tBottom, tEnd, complete, windowFt,
    exitMsl: valueAt(track, 'h', tExit), topMsl, bottomMsl,
    workingTime: complete ? Math.round(duration * 10) / 10 : null,
    distance,
    avgH: distance / duration,
    avgV: drop / duration,
    glide: distance / drop,
  };
}

// Smoothed series for charts: x is seconds from the upper boundary
function jumpSeries(track, a, lead = 8, tail = 8, smooth = 0.6) {
  const out = { x: [], h: [], hs: [], vs: [], gr: [] };
  const T = track.t, hsRaw = T.map((_, i) => Math.hypot(track.vn[i], track.ve[i]));
  for (let i = 0; i < T.length; i++) {
    if (T[i] < a.tTop - lead || T[i] > a.tEnd + tail) continue;
    let sh = 0, sv = 0, n = 0;
    for (let j = i; j >= 0 && T[i] - T[j] <= smooth; j--) { sh += hsRaw[j]; sv += track.vd[j]; n++; }
    for (let j = i + 1; j < T.length && T[j] - T[i] <= smooth; j++) { sh += hsRaw[j]; sv += track.vd[j]; n++; }
    const hs = sh / n, vs = sv / n;
    out.x.push(T[i] - a.tTop); out.h.push(track.h[i]); out.hs.push(hs); out.vs.push(vs);
    out.gr.push(vs >= 5 ? hs / vs : null);   // glide ratio means nothing until the suit is flying
  }
  return out;
}

// Rejump check against 6.3.1. dzElevM is the dropzone elevation, or null when no dropzone is set.
function acroVerdict(a, dzElevM, round) {
  if (dzElevM === null) return { level: 'info', code: 'no-dz' };
  const exitAgl = a.exitMsl - dzElevM;
  if (a.windowFt === ACRO.loweredWindowFt) return { level: 'info', code: 'lowered', exitAgl };
  if (exitAgl < ACRO.minExitM) return { level: 'warn', code: 'low', exitAgl, by: ACRO.minExitM - exitAgl };
  if (exitAgl > ACRO.maxExitM) return { level: round === 'compulsory' ? 'ok' : 'warn', code: round === 'compulsory' ? 'high-compulsory' : 'high-free', exitAgl, by: exitAgl - ACRO.maxExitM };
  return { level: 'ok', code: 'ok', exitAgl };
}

/* ── Barometer (FlySight 2 SENSOR.CSV) ─────────────────────────────────── */

const GPS_EPOCH = 315964800, WEEK_S = 604800;

// Pressure altitude in the standard atmosphere, the same model a skydiving altimeter uses
const pressureAltitude = pa => 44330.77 * (1 - (pa / 101325) ** 0.1902632);

// Reads $BARO and $TIME rows. Pass one string for a whole file, or the separate frames of a sampled
// download; frames start and end mid-line, so their first and last lines are thrown away.
function parseSensor(pieces) {
  const sensor = { baro: [], time: [] };
  const sampled = pieces.length > 1;
  for (const piece of pieces) {
    const lines = piece.split(/\r?\n/);
    for (let i = sampled ? 1 : 0; i < lines.length - (sampled ? 1 : 0); i++) {
      const f = lines[i].split(',');
      if (f[0] === '$BARO' && f.length === 4) {
        const ts = parseFloat(f[1]), pa = parseFloat(f[2]);
        if (Number.isFinite(ts) && pa > 10000 && pa < 110000) sensor.baro.push({ ts, pa });
      } else if (f[0] === '$TIME' && f.length === 4) {
        const ts = parseFloat(f[1]), tow = parseFloat(f[2]), week = parseInt(f[3], 10);
        if (Number.isFinite(ts) && Number.isFinite(tow) && week > 0) sensor.time.push({ ts, tow, week });
      }
    }
  }
  return sensor;
}

const median = values => { const s = [...values].sort((a, b) => a - b); return s[s.length >> 1]; };

// Barometric height for one jump, zeroed on the ground like an altimeter. Returns { t, h } with t in
// epoch seconds to match the track, or null when the sensor file does not cover the jump.
function baroForJump(sensor, track) {
  if (sensor.baro.length < 20 || !sensor.time.length) return null;

  // The $TIME rows tie the sensor clock to GPS week and time of week
  const clockOffset = median(sensor.time.map(r => r.week * WEEK_S + r.tow - r.ts));

  // Ground level is the highest pressure the unit logged: on the dropzone before take-off or after landing
  const byPressure = sensor.baro.map(b => b.pa).sort((a, b) => b - a);
  const ground = pressureAltitude(median(byPressure.slice(0, Math.max(5, Math.ceil(byPressure.length * 0.02)))));

  // The time of week may be UTC or GPS time (18 leap seconds apart), so try both and keep whichever
  // lines the barometer up with the GPS altitude
  const first = track.t[0], last = track.t[track.t.length - 1];
  let best = null;
  for (const leap of [18, 0]) {
    const t = [], h = [];
    let sum = 0, sumSq = 0;
    for (const b of sensor.baro) {
      const utc = GPS_EPOCH + b.ts + clockOffset - leap;
      if (utc < first || utc > last) continue;
      const alt = pressureAltitude(b.pa), diff = alt - valueAt(track, 'h', utc);
      t.push(utc); h.push(alt - ground); sum += diff; sumSq += diff * diff;
    }
    if (t.length < 20) continue;
    const spread = sumSq / t.length - (sum / t.length) ** 2;
    if (!best || spread < best.spread) best = { t, h, spread };
  }
  return best && { t: best.t, h: best.h };
}

// Barometric height at one instant. Barometer samples can be seconds apart (the Bluetooth import only
// samples the file) while height changes fast, so interpolate the slow-moving gap between barometer
// and GPS and add it to the GPS height at that instant, rather than interpolating the height itself.
function baroAt(baro, track, t) {
  const gap = { t: baro.t, d: baro.h.map((h, i) => h - valueAt(track, 'h', baro.t[i])) };
  return valueAt(track, 'h', t) + valueAt(gap, 'd', t);
}

if (typeof module !== 'undefined') module.exports = { ACRO, FT_PER_M, parseTrack, valueAt, findTopCrossing, trimToJump, analyseAcro, jumpSeries, acroVerdict, pressureAltitude, parseSensor, baroForJump, baroAt };
