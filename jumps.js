// Jump logbook: storage, import from the FlySight or a file, and the acro analysis screen.

/* ── Storage (IndexedDB; tracks are too big for localStorage) ──────────── */

let dbPromise = null;
function db() {
  return dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('le-live', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('jumps', { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function jumpStore(mode, op) {
  const store = (await db()).transaction('jumps', mode).objectStore('jumps');
  return new Promise((resolve, reject) => {
    const request = op(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const jumpsAll = () => jumpStore('readonly', s => s.getAll());
const jumpGet = id => jumpStore('readonly', s => s.get(id));
const jumpPut = jump => jumpStore('readwrite', s => s.put(jump));
const jumpDelete = id => jumpStore('readwrite', s => s.delete(id));

// Analyse a track file and save the jump in it. The id comes from the exit time, so re-importing replaces.
async function addJump(text, name) {
  const track = trimToJump(parseTrack(text));
  if (!track) throw new Error(`No exit found in ${name}.`);
  const id = String(Math.round(findTopCrossing(track) * 10));
  const dz = activeDz(), existing = await jumpGet(id);
  const jump = existing
    ? { ...existing, name, track }
    : { id, name, dz: dz ? { ...dz } : null, round: 'free', windowFt: ACRO.windowFt, track };
  await jumpPut(jump);
  return jump;
}

// Attach barometric height from a SENSOR.CSV (whole file as one string, or sampled frames) to a saved jump
async function addBaro(jump, pieces) {
  const baro = baroForJump(parseSensor(pieces), jump.track);
  if (!baro) throw new Error('That sensor file has no barometer data covering this jump.');
  jump.baro = baro;
  await jumpPut(jump);
}

/* ── Formatting ────────────────────────────────────────────────────────── */

const altUnit = () => state.feet ? 'ft' : 'm';
const toAlt = m => state.feet ? m * FT_PER_M : m;
const fmtAlt = m => `${Math.round(toAlt(m)).toLocaleString()} ${altUnit()}`;
const speedUnit = () => state.feet ? 'mph' : 'km/h';
const toSpeed = ms => ms * (state.feet ? 2.23694 : 3.6);
const fmtSpeed = ms => `${Math.round(toSpeed(ms))} ${speedUnit()}`;
const fmtDistance = m => state.feet ? `${(m / 1609.344).toFixed(2)} mi` : `${(m / 1000).toFixed(2)} km`;
const fmtWhen = t => new Date(t * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sameDz = (a, b) => a && b && a.name === b.name && a.elev === b.elev && a.unit === b.unit;

const VERDICT_LABEL = {
  'ok': 'Within limits', 'low': 'Below minimum', 'high-free': 'Above maximum',
  'high-compulsory': 'Above max, no rejump', 'no-dz': 'No dropzone', 'lowered': 'Lowered exit',
};

function verdictCopy(v, a) {
  const min = fmtAlt(ACRO.minExitM), max = fmtAlt(ACRO.maxExitM);
  const exit = v.exitAgl === undefined ? '' : `${fmtAlt(v.exitAgl)} above ground`;
  const copy = {
    'ok': ['No rejump needed', `Exit was ${exit}, inside the ${min} to ${max} limits.`],
    'low': ['Rejump available', `Exit was ${exit}, ${fmtAlt(v.by)} below the ${min} minimum. The team may accept the score; otherwise a rejump is granted.`],
    'high-free': ['Rejump available', `Exit was ${exit}, ${fmtAlt(v.by)} above the ${max} maximum. In a free round the team may accept the score; otherwise a rejump is granted.`],
    'high-compulsory': ['No rejump', `Exit was ${exit}, ${fmtAlt(v.by)} above the ${max} maximum. In a compulsory round that is not grounds for a rejump.`],
    'no-dz': ['Set a dropzone', 'Exit limits are measured above ground. Choose the dropzone below to check this jump against the rules.'],
    'lowered': ['Lowered exit', `Exit was ${exit}. With a lowered exit the Meet Director sets the altitude, so the standard ${min} to ${max} limits are not checked.`],
  }[v.code];
  if (!a.complete) copy[1] += ' The track ends before the lower boundary, so there is no working time.';
  return copy;
}

/* ── Jump list ─────────────────────────────────────────────────────────── */

async function showJumpList() {
  const jumps = (await jumpsAll()).sort((x, y) => y.id - x.id);
  $('jumpList').innerHTML = jumps.length ? jumps.map(jump => {
    const a = analyseAcro(jump.track, jump.windowFt);
    const elev = jump.dz ? dzElevM(jump.dz) : null, v = acroVerdict(a, elev, jump.round);
    const exit = elev === null ? `${fmtAlt(a.exitMsl)} MSL` : fmtAlt(a.exitMsl - elev);
    return `<a class="jumpRow" href="#jump/${jump.id}">
      <span class="mono">${fmtWhen(a.tExit)}${jump.dz ? ' // ' + esc(jump.dz.name) : ''}</span>
      <b>${exit}<i>exit</i>${a.complete ? `${a.workingTime.toFixed(1)} s<i>working</i>` : ''}</b>
      <span class="chip ${v.level}">${VERDICT_LABEL[v.code]}</span>
    </a>`;
  }).join('') : '<p class="empty">No jumps yet. Import a track from the FlySight, or pick a TRACK.CSV file.</p>';
}

/* ── Charts: hand-drawn SVG, all three share one time axis so the cursor lines up ── */

const CW = 340, CH = 176, ML = 42, MR = 10, MT = 12, MB = 22;

function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find(m => m * mag >= raw) * mag, out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

// o: { x0, x1, y0, y1, win (window length in s), yFmt, series: [{ y: [], cls }], hlines: [{ y, label }] }, xs shared
function chartSvg(xs, o) {
  const sx = x => ML + (x - o.x0) / (o.x1 - o.x0) * (CW - ML - MR);
  const sy = y => MT + (o.y1 - y) / (o.y1 - o.y0) * (CH - MT - MB);
  let g = `<rect class="band" x="${sx(0)}" y="${MT}" width="${sx(o.win) - sx(0)}" height="${CH - MT - MB}"/>`;
  for (const y of niceTicks(o.y0, o.y1, 4)) {
    g += `<line class="grid" x1="${ML}" x2="${CW - MR}" y1="${sy(y)}" y2="${sy(y)}"/>`;
    g += `<text class="tick" x="${ML - 5}" y="${sy(y) + 3}" text-anchor="end">${o.yFmt(y)}</text>`;
  }
  for (const x of niceTicks(0, o.x1, 5)) g += `<text class="tick" x="${sx(x)}" y="${CH - 6}" text-anchor="middle">${x}s</text>`;
  for (const line of o.hlines || []) {
    g += `<line class="ref" x1="${ML}" x2="${CW - MR}" y1="${sy(line.y)}" y2="${sy(line.y)}"/>`;
    g += `<text class="reflabel" x="${CW - MR - 3}" y="${sy(line.y) - 4}" text-anchor="end">${line.label}</text>`;
  }
  for (const s of o.series) {
    let d = '', pen = false;
    s.y.forEach((y, i) => {
      if (y === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${sx(xs[i]).toFixed(1)} ${sy(Math.min(o.y1, Math.max(o.y0, y))).toFixed(1)}`;
      pen = true;
    });
    g += `<path class="line ${s.cls}" d="${d}"/>`;
  }
  g += `<line class="cur" y1="${MT}" y2="${CH - MB}" hidden/>`;
  return `<svg viewBox="0 0 ${CW} ${CH}" role="img">${g}</svg>`;
}

/* ── Jump detail ───────────────────────────────────────────────────────── */

let shown = null;   // { jump, a, s, x0, x1 } for the jump on screen

async function showJump(id) {
  const jump = await jumpGet(id);
  if (!jump) { location.hash = 'jumps'; return; }
  const a = analyseAcro(jump.track, jump.windowFt), s = jumpSeries(jump.track, a);
  const elev = jump.dz ? dzElevM(jump.dz) : null, ref = elev ?? 0, datum = elev === null ? 'MSL' : 'AGL';
  const v = acroVerdict(a, elev, jump.round), [title, text] = verdictCopy(v, a);
  const win = a.tEnd - a.tTop, x0 = s.x[0], x1 = s.x[s.x.length - 1];
  shown = { jump, a, s, x0, x1, ref };

  const dzOptions = [
    `<option value="none"${jump.dz ? '' : ' selected'}>No dropzone</option>`,
    ...state.dzs.map((dz, i) => `<option value="${i}"${sameDz(dz, jump.dz) ? ' selected' : ''}>${esc(dz.name)} (${dz.elev} ${dz.unit})</option>`),
    jump.dz && !state.dzs.some(dz => sameDz(dz, jump.dz)) ? `<option value="keep" selected>${esc(jump.dz.name)} (${jump.dz.elev} ${jump.dz.unit})</option>` : '',
    '<option value="manage">Add or edit dropzones…</option>',
  ].join('');

  const alt = s.h.map(h => toAlt(h - ref)), top = toAlt(a.topMsl - ref), bottom = toAlt(a.bottomMsl - ref);
  const pad = (top - bottom) * 0.08;
  const hs = s.hs.map(toSpeed), vs = s.vs.map(toSpeed);
  const grMax = Math.min(6, Math.max(3, Math.ceil(Math.max(...s.gr.filter((g, i) => g !== null && s.x[i] >= 0 && s.x[i] <= win)))));
  const speedMax = Math.ceil(Math.max(...hs, ...vs) / 20) * 20;
  const axis = { x0, x1, win };

  $('jumpView').innerHTML = `
    <a class="back mono" href="#jumps">← Jumps</a>
    <div class="mono">[ ${fmtWhen(a.tExit)} // ${esc(jump.name)} ]</div>
    <div class="tabs2"><span class="on">Acro</span><span class="soon">Performance (later)</span></div>

    <div class="verdict ${v.level}">
      <h2>${title}</h2>
      <p>${text}</p>
    </div>

    <div class="settings">
      <label class="mono">Dropzone<select id="jDz">${dzOptions}</select></label>
      <label class="mono">Round<select id="jRound">
        <option value="free"${jump.round === 'free' ? ' selected' : ''}>Free</option>
        <option value="compulsory"${jump.round === 'compulsory' ? ' selected' : ''}>Compulsory</option></select></label>
      <label class="mono">Window<select id="jWindow">
        <option value="7500"${jump.windowFt === 7500 ? ' selected' : ''}>7,500 ft</option>
        <option value="5000"${jump.windowFt === 5000 ? ' selected' : ''}>5,000 ft (lowered exit)</option></select></label>
    </div>

    <div class="stats">
      <div><b>${fmtAlt(a.exitMsl - ref)}</b><span class="mono">Exit altitude ${datum}</span></div>
      <div><b>${a.complete ? a.workingTime.toFixed(1) + ' s' : 'n/a'}</b><span class="mono">Working time</span></div>
      <div><b>${a.glide.toFixed(2)}</b><span class="mono">Avg glide ratio</span></div>
      <div><b>${fmtDistance(a.distance)}</b><span class="mono">Distance flown</span></div>
      <div><b>${fmtSpeed(a.avgH)}</b><span class="mono">Avg horizontal</span></div>
      <div><b>${fmtSpeed(a.avgV)}</b><span class="mono">Avg vertical</span></div>
    </div>

    ${baroBlock(jump, a, ref, datum)}

    <div id="readout" class="mono">Drag across a chart to read values</div>

    <div class="chart"><div class="mono">Altitude ${datum} (${altUnit()}) <i class="key band"></i>window</div>
      ${chartSvg(s.x, { ...axis, y0: bottom - pad * 2, y1: toAlt(a.exitMsl - ref) + pad, yFmt: y => (y / 1000).toFixed(1) + 'k',
        series: [{ y: alt, cls: 'white' }],
        hlines: [{ y: top, label: `window top ${Math.round(top).toLocaleString()}` }, { y: bottom, label: `window bottom ${Math.round(bottom).toLocaleString()}` }] })}</div>

    <div class="chart"><div class="mono">Glide ratio</div>
      ${chartSvg(s.x, { ...axis, y0: 0, y1: grMax, yFmt: y => y.toFixed(1),
        series: [{ y: s.gr, cls: 'white' }], hlines: [{ y: a.glide, label: `average ${a.glide.toFixed(2)}` }] })}</div>

    <div class="chart"><div class="mono">Speed (${speedUnit()}) <i class="key cyan"></i>horizontal <i class="key orange"></i>vertical</div>
      ${chartSvg(s.x, { ...axis, y0: 0, y1: speedMax, yFmt: y => Math.round(y),
        series: [{ y: hs, cls: 'cyan' }, { y: vs, cls: 'orange' }] })}</div>

    <p class="note">Window top is where vertical speed first reaches 10 m/s. Exit is taken about one second before that. Averages cover the window only.</p>
    <button id="jDelete">Delete this jump</button>`;

  const update = async change => { Object.assign(jump, change); await jumpPut(jump); showJump(id); };
  $('jDz').onchange = e => {
    const value = e.target.value;
    if (value === 'manage') return openDzDialog();
    if (value !== 'keep') update({ dz: value === 'none' ? null : { ...state.dzs[value] } });
  };
  $('jRound').onchange = e => update({ round: e.target.value });
  $('jWindow').onchange = e => update({ windowFt: Number(e.target.value) });
  $('jDelete').onclick = async () => { if (confirm('Delete this jump?')) { await jumpDelete(id); location.hash = 'jumps'; } };
  if ($('jBaro')) {
    $('jBaro').onclick = () => $('jBaroFile').click();
    $('jBaroFile').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      $('jBaroStatus').textContent = 'Reading…';
      try { await addBaro(jump, [await file.text()]); showJump(id); }
      catch (err) { $('jBaroStatus').textContent = err.message; }
    };
  }
}

// Barometric height at the three moments that matter, beside the GPS figure for the same instant
function baroBlock(jump, a, ref, datum) {
  if (!jump.baro) return `
    <div class="mono sub">Barometric height</div>
    <button id="jBaro">Add barometer data (SENSOR.CSV)</button>
    <input id="jBaroFile" type="file" accept=".csv,.CSV,text/csv,text/comma-separated-values" hidden>
    <div id="jBaroStatus" class="note">The barometer is logged in SENSOR.CSV, in the same folder as the track.</div>`;
  const cell = (label, t) => t === null ? `<div><b>n/a</b><span class="mono">${label}</span></div>` : `
    <div><b>${fmtAlt(baroAt(jump.baro, jump.track, t))}</b><span class="mono">${label}</span>
    <i>GPS ${fmtAlt(valueAt(jump.track, 'h', t) - ref)}${datum === 'MSL' ? ' MSL' : ''}</i></div>`;
  return `
    <div class="mono sub">Barometric height // zeroed on the ground</div>
    <div class="stats three">
      ${cell('Aircraft exit', a.tExit)}${cell('Window entry', a.tTop)}${cell('Window exit', a.tBottom)}
    </div>`;
}

// One cursor across all three charts, with the values under it
function scrub(e) {
  const svg = e.target.closest?.('.chart svg');
  if (!svg || !shown) return;
  const box = svg.getBoundingClientRect(), { s, x0, x1, ref } = shown;
  const vx = Math.min(CW - MR, Math.max(ML, (e.clientX - box.left) / box.width * CW));
  const x = x0 + (vx - ML) / (CW - ML - MR) * (x1 - x0);
  let i = 0;
  while (i < s.x.length - 1 && s.x[i + 1] <= x) i++;
  for (const cur of document.querySelectorAll('.chart .cur')) { cur.setAttribute('x1', vx); cur.setAttribute('x2', vx); cur.removeAttribute('hidden'); }
  $('readout').textContent = `T${s.x[i] < 0 ? '' : '+'}${s.x[i].toFixed(1)} s // ${fmtAlt(s.h[i] - ref)} // GR ${s.gr[i] === null ? 'n/a' : s.gr[i].toFixed(2)} // H ${fmtSpeed(s.hs[i])} // V ${fmtSpeed(s.vs[i])}`;
}
$('jumpView').addEventListener('pointerdown', scrub);
$('jumpView').addEventListener('pointermove', scrub);

/* ── Import ────────────────────────────────────────────────────────────── */

function importStatus(text) { $('importStatus').textContent = text || ''; }

$('importFile').onclick = () => $('fileInput').click();
$('fileInput').onchange = async e => {
  const files = [...e.target.files], failed = [];
  let last = null;
  e.target.value = '';
  for (const file of files) {
    try { last = await addJump(await file.text(), file.name); } catch (err) { failed.push(err.message); }
  }
  importStatus(failed.join(' '));
  if (last && files.length === 1) location.hash = 'jump/' + last.id; else showJumpList();
};

// Browse the FlySight's card: folders, plus the TRACK.CSV inside each recording
let fsPath = '/', fsSensorSize = 0;
let fsTzOffset = 0;   // seconds; the FlySight names recording folders in UTC plus its TZ_Offset setting

// A recording folder is /YY-MM-DD/HH-MM-SS in the FlySight's own time zone. Returns that moment in this
// phone's time zone, or null when the path is not a recording folder.
function recordingLocalTime(datePath, name) {
  const d = /^\/(\d\d)-(\d\d)-(\d\d)$/.exec(datePath), t = /^(\d\d)-(\d\d)-(\d\d)$/.exec(name);
  if (!d || !t) return null;
  const when = new Date(Date.UTC(2000 + +d[1], d[2] - 1, +d[3], +t[1], +t[2], +t[3]) - fsTzOffset * 1000);
  return when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const SENSOR_SAMPLE_BYTES = 300 * 1024;   // roughly how much of SENSOR.CSV to pull over Bluetooth
async function fsShow(path) {
  fsPath = path;
  $('fsPath').textContent = `[ FlySight // ${path} ]`;
  $('fsStatus').textContent = 'Reading…';
  $('fsList').innerHTML = '';
  try {
    const entries = (await fsListDir(path))
      .filter(e => e.dir ? !/^(\.|SYSTEM~)/.test(e.name) : /^(TRACK|SENSOR)\.CSV$/i.test(e.name))
      // Newest first. Date folders sort by name; /TEMP recordings are numbered, so use their timestamps.
      .sort((x, y) => /^TEMP$/i.test(path.slice(1)) ? (y.stamp?.order || 0) - (x.stamp?.order || 0) || y.name.localeCompare(x.name) : y.name.localeCompare(x.name));
    fsSensorSize = entries.find(e => /^SENSOR\.CSV$/i.test(e.name))?.size || 0;
    entries.splice(0, entries.length, ...entries.filter(e => !/^SENSOR\.CSV$/i.test(e.name)));
    $('fsList').innerHTML = (path === '/' ? '' : '<button data-up="1">← Up</button>') + entries.map(e =>
      `<button data-name="${esc(e.name)}" ${e.dir ? 'data-dir="1"' : `data-size="${e.size}"`}>${
        !e.dir ? `${esc(e.name)} // ${Math.round(e.size / 1024)} KB // import`
        : /^TEMP$/i.test(e.name) && path === '/' ? `${esc(e.name)} // unfinished recordings →`
        : recordingLocalTime(path, e.name) ? `${recordingLocalTime(path, e.name)} // ${esc(e.name)} →`
        : `${esc(e.name)}${e.stamp ? ' // ' + e.stamp.text : ''} →`}</button>`).join('');
    const folders = entries.filter(e => e.dir).length;
    $('fsStatus').textContent = !entries.length ? 'No tracks in this folder.'
      : path === '/' ? `${folders} folders, newest date first. A recording that was not closed cleanly stays in TEMP.`
      : entries.some(e => recordingLocalTime(path, e.name)) ? "Times are in this phone's time zone; the folder name follows." : '';
  } catch (err) { $('fsStatus').textContent = err.message; }
}

$('importFlysight').onclick = async () => {
  $('fsDialog').showModal();
  $('fsPath').textContent = '[ FlySight ]';
  $('fsList').innerHTML = '';
  $('fsStatus').textContent = 'Checking the FlySight…';
  try {
    await crsOpen();
    // Logging locks the card, so offer to stop it rather than fail
    if (await fsMode() === 'active' && confirm('The FlySight is on and logging, which locks its card. Stop logging and put it to sleep so its tracks can be read?')) {
      $('fsStatus').textContent = 'Putting the FlySight to sleep…';
      await fsRequestSleep().catch(() => {});
    }
  } catch (err) { $('fsStatus').textContent = err.message; return; }
  // Read-only: the FlySight's own time zone setting, needed to convert its folder names. UTC if unreadable.
  try { fsTzOffset = Number(/^TZ_Offset:\s*(-?\d+)/m.exec(await fsReadFile('/CONFIG.TXT'))?.[1]) || 0; } catch { fsTzOffset = 0; }
  fsShow('/');
};
$('fsClose').onclick = () => $('fsDialog').close();
$('fsList').onclick = async e => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.up) return fsShow(fsPath.slice(0, fsPath.lastIndexOf('/')) || '/');
  const path = joinPath(fsPath, button.dataset.name);
  if (button.dataset.dir) return fsShow(path);
  const size = Number(button.dataset.size) || 1;
  for (const b of $('fsList').children) b.disabled = true;
  try {
    const text = await fsReadFile(path, got => { $('fsStatus').textContent = `Downloading ${Math.min(99, Math.round(got / size * 100))}%`; });
    const jump = await addJump(text, fsPath.slice(1) || 'TRACK.CSV');
    if (fsSensorSize) {
      // SENSOR.CSV is mostly gyro data and can be many megabytes, so read evenly spaced frames of it:
      // enough barometer rows for the jump without downloading the lot. A failure here is not fatal.
      const every = Math.max(1, Math.ceil(fsSensorSize / SENSOR_SAMPLE_BYTES)), expect = fsSensorSize / every;
      try {
        const frames = await fsReadFrames(joinPath(fsPath, 'SENSOR.CSV'),
          got => { $('fsStatus').textContent = `Reading barometer ${Math.min(99, Math.round(got / expect * 100))}%`; }, every);
        const decoder = new TextDecoder();
        await addBaro(jump, every === 1 ? [decoder.decode(await new Blob(frames).arrayBuffer())] : frames.map(f => decoder.decode(f)));
      } catch (err) { importStatus('Track imported, but the barometer could not be read: ' + err.message); }
    }
    $('fsDialog').close();
    location.hash = 'jump/' + jump.id;
  } catch (err) {
    $('fsStatus').textContent = err.message;
    for (const b of $('fsList').children) b.disabled = false;
  }
};
