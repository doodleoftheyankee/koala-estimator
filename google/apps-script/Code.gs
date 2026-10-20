/**
 * Koala Hub: Google Sheets + Google Calendar for the Koala Estimator.
 *
 * Paste this whole file into Extensions → Apps Script of a Google Sheet, save, reload the sheet,
 * then use the 🐨 Koala menu:
 *   • Refresh data now            Estimates, Jobs and Dashboard tabs from the app
 *   • Sync jobs to Google Calendar scheduled jobs on a "Koala Jobs" calendar (updates in place)
 *   • Open attic visualizer        animated before/after of an area's insulation, per option
 *   • Turn on hourly auto-refresh  keeps the sheet and calendar current on its own
 *
 * Reads the app's read-only feed (/api/export/google). The app stays the source of truth: edits
 * made in the sheet are overwritten on the next refresh.
 */
const KOALA = {
  feedUrl: 'https://koala-estimator-indol.vercel.app/api/export/google',
  key: 'PASTE_GOOGLE_EXPORT_KEY',
  calendarName: 'Koala Jobs (demo)',
  calendarDaysBack: 60, // completed jobs older than this stay off the calendar
};

// -------------------------------------------------------------------------------------------
// Menu
// -------------------------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🐨 Koala')
    .addItem('Refresh data now', 'refreshAll')
    .addItem('Sync jobs to Google Calendar', 'syncCalendar')
    .addItem('Open attic visualizer', 'openVisualizer')
    .addSeparator()
    .addItem('Turn on hourly auto-refresh', 'installHourlyRefresh')
    .addToUi();
}

function fetchFeed_() {
  const res = UrlFetchApp.fetch(KOALA.feedUrl + '?key=' + encodeURIComponent(KOALA.key), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('The Koala app answered ' + res.getResponseCode() + '. Check KOALA.feedUrl and KOALA.key.');
  return JSON.parse(res.getContentText());
}

/** Refresh the tabs, then the calendar. Also what the hourly trigger runs. */
function refreshAll() {
  const data = fetchFeed_();
  writeEstimates_(data.estimates);
  writeJobs_(data.jobs);
  writeDashboard_(data);
  SpreadsheetApp.getActive().toast('Updated ' + data.estimates.length + ' estimates and ' + data.jobs.length + ' jobs.', '🐨 Koala', 5);
}

function installHourlyRefresh() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hourlyRefresh_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyRefresh_').timeBased().everyHours(1).create();
  SpreadsheetApp.getActive().toast('The sheet and calendar now refresh every hour.', '🐨 Koala', 5);
}

function hourlyRefresh_() {
  refreshAll();
  syncCalendar();
}

// -------------------------------------------------------------------------------------------
// Tabs
// -------------------------------------------------------------------------------------------

function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function writeTable_(name, headers, rows, formats) {
  const sh = sheet_(name);
  sh.clear();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.setFrozenRows(1);
  Object.keys(formats || {}).forEach(function (col) {
    if (rows.length) sh.getRange(2, Number(col), rows.length, 1).setNumberFormat(formats[col]);
  });
  if (sh.getFilter()) sh.getFilter().remove();
  sh.getRange(1, 1, Math.max(rows.length, 1) + 1, headers.length).createFilter();
  sh.autoResizeColumns(1, headers.length);
  return sh;
}

function writeEstimates_(estimates) {
  const headers = ['Customer', 'Address', 'Phone', 'Lead source', 'Estimator', 'Job types', 'Sq ft', 'Created', 'Outcome', 'Decided',
                   'Good', 'Better', 'Best', 'Signed option', 'Signed price', 'Lost reason'];
  const rows = estimates.map(function (e) {
    return [e.customer, e.address, e.phone, e.source, e.estimator, e.jobTypes, e.sqft, e.created, e.outcome, e.decided,
            e.good, e.better, e.best, e.signedTier, e.signedPrice, e.lostReason];
  });
  const sh = writeTable_('Estimates', headers, rows, { 11: '$#,##0', 12: '$#,##0', 13: '$#,##0', 15: '$#,##0' });
  const outcome = sh.getRange(2, 9, Math.max(rows.length, 1), 1);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Won').setBackground('#d1fae5').setRanges([outcome]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Lost').setBackground('#fee2e2').setRanges([outcome]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Open').setBackground('#fef3c7').setRanges([outcome]).build(),
  ]);
}

function writeJobs_(jobs) {
  const headers = ['Customer', 'Address', 'Phone', 'Crew', 'Status', 'Start', 'Days', 'Option', 'Revenue', 'What gets installed',
                   'Planned hours', 'Actual hours', 'Hours vs plan', 'Verified', 'Completed'];
  const rows = jobs.map(function (j) {
    return [j.customer, j.address, j.phone, j.crew, j.status.replace('_', ' '), j.start, j.days, j.signedTier, j.revenue, j.scope,
            j.estHours, j.actualHours === null ? '' : j.actualHours, j.hoursVariance === null ? '' : j.hoursVariance,
            j.verified ? 'Yes' : '', j.completed];
  });
  const sh = writeTable_('Jobs', headers, rows, { 9: '$#,##0', 13: '+0%;-0%;0%' });
  const variance = sh.getRange(2, 13, Math.max(rows.length, 1), 1);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0.1).setFontColor('#b91c1c').setRanges([variance]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(-0.1).setFontColor('#047857').setRanges([variance]).build(),
  ]);
}

/** KPI tiles and charts, computed here so the tab needs no formulas. */
function writeDashboard_(data) {
  const sh = sheet_('Dashboard');
  sh.clear();
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  SpreadsheetApp.getActive().setActiveSheet(sh);
  SpreadsheetApp.getActive().moveActiveSheet(1);

  const decided = data.estimates.filter(function (e) { return e.outcome === 'Won' || e.outcome === 'Lost'; });
  const won = decided.filter(function (e) { return e.outcome === 'Won'; });
  const revenue = won.reduce(function (s, e) { return s + (e.signedPrice || 0); }, 0);
  const open = data.estimates.filter(function (e) { return e.outcome === 'Open'; });
  const pipeline = open.reduce(function (s, e) { return s + (e.better || e.good || 0); }, 0);
  const done = data.jobs.filter(function (j) { return j.actualHours !== null && j.estHours > 0; });
  const hoursOff = done.length ? done.reduce(function (s, j) { return s + Math.abs(j.hoursVariance); }, 0) / done.length : null;

  sh.getRange('A1').setValue('Koala Insulation of Newark: dashboard').setFontSize(18).setFontWeight('bold');
  sh.getRange('A2').setValue('Updated ' + new Date(data.generatedAt).toLocaleString()).setFontColor('#64748b');
  const tiles = [
    ['Win rate', decided.length ? won.length / decided.length : 0, '0%'],
    ['Jobs won', won.length, '0'],
    ['Revenue won', revenue, '$#,##0'],
    ['Average job', won.length ? revenue / won.length : 0, '$#,##0'],
    ['Open quotes', pipeline, '$#,##0'],
    ['Crew hours vs plan', hoursOff === null ? '' : hoursOff, '±0%'],
  ];
  tiles.forEach(function (t, i) {
    const col = 1 + i * 2;
    sh.getRange(4, col).setValue(t[0]).setFontColor('#64748b');
    sh.getRange(5, col).setValue(t[1]).setNumberFormat(t[2]).setFontSize(20).setFontWeight('bold').setFontColor('#0f766e');
  });

  // Tables behind the charts.
  const bySource = group_(decided, function (e) { return e.source || 'Unknown'; });
  const srcRows = Object.keys(bySource).sort().map(function (k) {
    const g = bySource[k];
    const w = g.filter(function (e) { return e.outcome === 'Won'; }).length;
    return [k, g.length, w, w / g.length];
  });
  sh.getRange(8, 1, 1, 4).setValues([['Lead source', 'Quotes', 'Won', 'Win rate']]).setFontWeight('bold');
  if (srcRows.length) sh.getRange(9, 1, srcRows.length, 4).setValues(srcRows);
  sh.getRange(9, 4, Math.max(srcRows.length, 1), 1).setNumberFormat('0%');

  const byMonth = group_(won, function (e) { return (e.decided || e.created).slice(0, 7); });
  const monthRows = Object.keys(byMonth).sort().map(function (m) {
    return [m, byMonth[m].reduce(function (s, e) { return s + (e.signedPrice || 0); }, 0)];
  });
  sh.getRange(8, 7, 1, 2).setValues([['Month', 'Revenue won']]).setFontWeight('bold');
  if (monthRows.length) sh.getRange(9, 7, monthRows.length, 2).setValues(monthRows);
  sh.getRange(9, 8, Math.max(monthRows.length, 1), 1).setNumberFormat('$#,##0');

  const jobRows = done.slice(0, 15).map(function (j) { return [j.customer, j.estHours, j.actualHours]; });
  sh.getRange(8, 10, 1, 3).setValues([['Job', 'Planned hours', 'Actual hours']]).setFontWeight('bold');
  if (jobRows.length) sh.getRange(9, 10, jobRows.length, 3).setValues(jobRows);

  if (srcRows.length) {
    sh.insertChart(sh.newChart().setChartType(Charts.ChartType.COLUMN)
      .addRange(sh.getRange(8, 1, srcRows.length + 1, 1)).addRange(sh.getRange(8, 4, srcRows.length + 1, 1))
      .setPosition(26, 1, 0, 0).setOption('title', 'Win rate by lead source').setOption('legend', { position: 'none' })
      .setOption('vAxis', { format: 'percent' }).setOption('colors', ['#0f766e']).build());
  }
  if (monthRows.length) {
    sh.insertChart(sh.newChart().setChartType(Charts.ChartType.COLUMN)
      .addRange(sh.getRange(8, 7, monthRows.length + 1, 2))
      .setPosition(26, 6, 0, 0).setOption('title', 'Revenue won by month').setOption('legend', { position: 'none' })
      .setOption('colors', ['#14b8a6']).build());
  }
  if (jobRows.length) {
    sh.insertChart(sh.newChart().setChartType(Charts.ChartType.BAR)
      .addRange(sh.getRange(8, 10, jobRows.length + 1, 3))
      .setPosition(46, 1, 0, 0).setOption('title', 'Crew hours: planned vs actual (latest jobs)')
      .setOption('colors', ['#94a3b8', '#0f766e']).setOption('height', 420).build());
  }
}

function group_(rows, keyOf) {
  return rows.reduce(function (acc, r) {
    const k = keyOf(r);
    (acc[k] = acc[k] || []).push(r);
    return acc;
  }, {});
}

// -------------------------------------------------------------------------------------------
// Google Calendar
// -------------------------------------------------------------------------------------------

/** One all-day event per scheduled job, kept up to date (dates, crew, status, details). */
function syncCalendar() {
  const data = fetchFeed_();
  const cal = CalendarApp.getCalendarsByName(KOALA.calendarName)[0] || CalendarApp.createCalendar(KOALA.calendarName, { color: CalendarApp.Color.TEAL });
  const props = PropertiesService.getDocumentProperties();
  const cutoff = new Date(Date.now() - KOALA.calendarDaysBack * 86400000).toISOString().slice(0, 10);
  let created = 0, updated = 0, removed = 0;

  data.jobs.forEach(function (j) {
    const key = 'event_' + j.id;
    const existingId = props.getProperty(key);
    const existing = existingId ? cal.getEventById(existingId) : null;
    const show = j.start && j.status !== 'cancelled' && (j.status !== 'completed' || j.start >= cutoff);
    if (!show) {
      if (existing) { existing.deleteEvent(); removed++; }
      if (existingId) props.deleteProperty(key);
      return;
    }
    const start = new Date(j.start + 'T00:00:00');
    const end = new Date(start.getTime() + Math.max(1, Math.ceil(j.days || 1)) * 86400000);
    const icon = j.status === 'completed' ? '✅' : j.status === 'in_progress' ? '🔨' : '📅';
    const title = icon + ' ' + j.customer + ' · ' + (j.crew || 'No crew') + (j.signedTier ? ' · ' + j.signedTier : '');
    const description = [
      'Customer: ' + j.customer + (j.phone ? ' (' + j.phone + ')' : ''),
      'Address: ' + j.address,
      'Crew: ' + (j.crew || 'not assigned'),
      'Option: ' + j.signedTier,
      'Installs: ' + j.scope,
      'Planned: ' + (j.days || 1) + ' day(s), ' + j.estHours + ' person-hours',
      'Status: ' + j.status.replace('_', ' ') + (j.actualHours !== null ? ' · actual ' + j.actualHours + ' h' : ''),
      '',
      'From the Koala Estimator. Changes made here are replaced on the next sync.',
    ].join('\n');
    let event = existing;
    if (event) {
      event.setTitle(title);
      event.setAllDayDates(start, end);
      event.setDescription(description);
      event.setLocation(j.address);
      updated++;
    } else {
      event = cal.createAllDayEvent(title, start, end, { description: description, location: j.address });
      props.setProperty(key, event.getId());
      created++;
    }
    event.setColor(j.status === 'completed' ? CalendarApp.EventColor.GRAY : j.status === 'in_progress' ? CalendarApp.EventColor.ORANGE : CalendarApp.EventColor.CYAN);
  });
  SpreadsheetApp.getActive().toast('Calendar "' + KOALA.calendarName + '": ' + created + ' added, ' + updated + ' updated, ' + removed + ' removed.', '🐨 Koala', 6);
}

// -------------------------------------------------------------------------------------------
// Attic visualizer (an HTML panel inside the sheet)
// -------------------------------------------------------------------------------------------

function openVisualizer() {
  const html = HtmlService.createHtmlOutput(VISUALIZER_HTML).setTitle('Koala visualizer').setWidth(900).setHeight(640);
  SpreadsheetApp.getUi().showModelessDialog(html, '🐨 Insulation visualizer');
}

/** Called from the panel. */
function getVisualizerAreas() {
  return fetchFeed_().areas;
}

const VISUALIZER_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: Roboto, system-ui, sans-serif; margin: 0; color: #0f172a; }
  .wrap { display: grid; grid-template-columns: 270px 1fr; height: 600px; }
  .side { border-right: 1px solid #e2e8f0; padding: 12px; overflow: auto; }
  .main { padding: 12px 16px; }
  select, button { font: inherit; }
  select { width: 100%; padding: 6px; border-radius: 8px; border: 1px solid #cbd5e1; }
  .tiers { display: flex; gap: 6px; margin: 10px 0; }
  .tiers button { flex: 1; padding: 8px; border-radius: 10px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; }
  .tiers button.on { background: #0f766e; color: #fff; border-color: #0f766e; }
  .facts div { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
  .facts b { font-weight: 600; }
  .play { width: 100%; padding: 10px; border: 0; border-radius: 10px; background: #0f766e; color: #fff; font-weight: 600; cursor: pointer; margin-top: 10px; }
  h2 { margin: 4px 0 2px; font-size: 18px; }
  .sub { color: #64748b; font-size: 13px; margin-bottom: 8px; }
  .meter { height: 14px; border-radius: 7px; background: #e2e8f0; position: relative; margin: 6px 0 2px; overflow: hidden; }
  .meter i { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg,#f59e0b,#10b981); width: 0; transition: width 1.6s ease; }
  .legend { font-size: 12px; color: #64748b; display: flex; justify-content: space-between; }
  .note { font-size: 12px; color: #92400e; background: #fef3c7; padding: 6px 8px; border-radius: 8px; margin-top: 8px; display: none; }
</style></head>
<body>
<div class="wrap">
  <div class="side">
    <label class="sub">Customer and area</label>
    <select id="area"><option>Loading…</option></select>
    <div class="tiers" id="tiers"></div>
    <div class="facts" id="facts"></div>
    <div class="note" id="note">Old insulation is removed first, then the new layer goes in.</div>
    <button class="play" id="play">▶ Play</button>
  </div>
  <div class="main">
    <h2 id="title">Insulation visualizer</h2>
    <div class="sub" id="subtitle"></div>
    <svg id="svg" viewBox="0 0 600 420" width="100%" height="440"></svg>
    <div class="meter"><i id="meter"></i></div>
    <div class="legend"><span>R-0</span><span id="codeMark"></span><span>R-60+</span></div>
  </div>
</div>
<script>
  var AREAS = [], area = null, option = null;
  var COLORS = { 'Blown Cellulose': '#94a3b8', 'Blown Fiberglass': '#f9a8d4', 'Fiberglass Batts': '#f472b6',
                 'Open-Cell Spray Foam': '#fde68a', 'Closed-Cell Spray Foam': '#facc15' };
  var OLD = '#fbcfe8';
  var NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs, parent) { var e = document.createElementNS(NS, name); for (var k in attrs) e.setAttribute(k, attrs[k]); (parent || svg).appendChild(e); return e; }
  var svg = document.getElementById('svg');

  google.script.run.withSuccessHandler(function (areas) {
    AREAS = areas.filter(function (a) { return a.options.length; });
    var sel = document.getElementById('area');
    sel.innerHTML = AREAS.map(function (a, i) { return '<option value="' + i + '">' + a.customer + ' · ' + a.area + ' (' + a.sqft + ' sq ft)</option>'; }).join('');
    sel.onchange = function () { pickArea(+sel.value); };
    pickArea(0);
  }).withFailureHandler(function (e) { document.getElementById('subtitle').textContent = 'Could not load: ' + e.message; }).getVisualizerAreas();

  function pickArea(i) {
    area = AREAS[i];
    var t = document.getElementById('tiers');
    t.innerHTML = area.options.map(function (o, k) { return '<button data-k="' + k + '">' + o.tier + '</button>'; }).join('');
    Array.prototype.forEach.call(t.children, function (b) { b.onclick = function () { pickOption(+b.dataset.k); }; });
    pickOption(Math.min(1, area.options.length - 1));
  }

  function inches(r, perInch) { return perInch ? r / perInch : 0; }

  function pickOption(k) {
    option = area.options[k];
    Array.prototype.forEach.call(document.getElementById('tiers').children, function (b, i) { b.className = i === k ? 'on' : ''; });
    var startR = option.removesOld ? 0 : area.currentR;
    var addR = Math.max(0, (option.targetR || 0) - startR);
    var addIn = inches(addR, option.rPerInch);
    document.getElementById('title').textContent = option.tier + ': ' + option.label;
    document.getElementById('subtitle').textContent = area.customer + ' · ' + area.area + ' · ' + area.jobTypeLabel + ' · ' + area.sqft + ' sq ft · ' + area.access + ' access';
    document.getElementById('facts').innerHTML =
      row('Today', 'R-' + area.currentR) + row('After', 'R-' + (option.targetR || '?')) +
      row('Material', option.product) + row('Adds', addIn.toFixed(1) + ' in') +
      row('Price', option.price ? '$' + Math.round(option.price).toLocaleString() : '—');
    document.getElementById('note').style.display = option.removesOld && area.currentR > 0 ? 'block' : 'none';
    document.getElementById('codeMark').textContent = 'target R-' + (option.targetR || '?');
    draw(0);
  }
  function row(a, b) { return '<div><span>' + a + '</span><b>' + b + '</b></div>'; }

  // Cross-section: joists on the ceiling, old layer, new layer growing in. Attics/garages get a
  // roof; walls, rim joists and crawlspaces show the cavity bays.
  function draw(p) {
    svg.innerHTML = '';
    var attic = ['attic', 'garage', 'commercial'].indexOf(area.jobType) >= 0;
    var floorY = 360, scale = 14; // px per inch
    var oldIn = inches(area.currentR, 3.2);
    var removed = option.removesOld && area.currentR > 0;
    var startR = option.removesOld ? 0 : area.currentR;
    var newIn = inches(Math.max(0, (option.targetR || 0) - startR), option.rPerInch);
    // Phase 1 (removal, if any) then phase 2 (fill).
    var removeP = removed ? Math.min(1, p * 2) : 1, fillP = removed ? Math.max(0, p * 2 - 1) : p;

    el('rect', { x: 0, y: 0, width: 600, height: 420, fill: '#f8fafc' });
    if (attic) {
      el('polygon', { points: '20,' + floorY + ' 300,40 580,' + floorY, fill: '#fff7ed', stroke: '#9a3412', 'stroke-width': 6 });
      el('text', { x: 300, y: 90, 'text-anchor': 'middle', 'font-size': 14, fill: '#9a3412' }).textContent = 'Roof';
    }
    el('rect', { x: 20, y: floorY, width: 560, height: 14, fill: '#e2e8f0', stroke: '#94a3b8' });
    el('text', { x: 300, y: floorY + 34, 'text-anchor': 'middle', 'font-size': 13, fill: '#475569' }).textContent = attic ? 'Ceiling of the rooms below' : 'Wall / floor surface';

    // Old insulation (fades away when removed).
    var oldH = oldIn * scale * (removed ? 1 - removeP : 1);
    if (oldH > 0.5) el('rect', { x: 34, y: floorY - oldH, width: 532, height: oldH, fill: OLD, opacity: removed ? 1 - removeP * 0.6 : 0.9 });
    // New insulation rising.
    var baseY = floorY - (removed ? 0 : oldIn * scale);
    var newH = newIn * scale * easeOut(fillP);
    if (newH > 0.5) {
      el('rect', { x: 34, y: baseY - newH, width: 532, height: newH, fill: COLORS[option.product] || '#cbd5e1', opacity: 0.95 });
      for (var s = 0; s < 120 * fillP; s++) { // texture
        var sx = 40 + ((s * 97) % 520), sy = baseY - ((s * 37) % Math.max(1, newH));
        el('circle', { cx: sx, cy: sy, r: 1.4, fill: 'rgba(255,255,255,0.55)' });
      }
    }
    // Joists over the top (7.25 in tall every 16 in on center).
    for (var x = 34; x < 566; x += 76) el('rect', { x: x, y: floorY - 7.25 * scale, width: 10, height: 7.25 * scale, fill: '#d6a46b', stroke: '#92400e' });
    // Depth labels.
    var topY = baseY - newIn * scale * easeOut(fillP);
    el('line', { x1: 586, y1: floorY, x2: 586, y2: Math.min(floorY, topY), stroke: '#0f766e', 'stroke-width': 2 });
    var totalIn = (removed ? 0 : oldIn) + newIn * easeOut(fillP);
    el('text', { x: 584, y: Math.min(floorY, topY) - 8, 'text-anchor': 'end', 'font-size': 14, 'font-weight': 700, fill: '#0f766e' }).textContent =
      totalIn.toFixed(1) + ' in · R-' + Math.round(startR + (option.targetR - startR) * easeOut(fillP));
    var meter = (startR + ((option.targetR || 0) - startR) * easeOut(fillP)) / 60;
    document.getElementById('meter').style.transition = 'none';
    document.getElementById('meter').style.width = Math.min(100, meter * 100) + '%';
  }

  function easeOut(t) { return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3); }

  document.getElementById('play').onclick = function () {
    var t0 = null, dur = (option.removesOld && area.currentR > 0) ? 3600 : 2200;
    function step(ts) { if (!t0) t0 = ts; var p = Math.min(1, (ts - t0) / dur); draw(p); if (p < 1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  };
</script>
</body></html>`;
