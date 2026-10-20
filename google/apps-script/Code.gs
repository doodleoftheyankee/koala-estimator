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
  arrangeTabs_();
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

const THEME = {
  brand: '#0f766e', brandDark: '#134e4a',
  page: '#f1f5f9', card: '#ffffff', stripe: '#f8fafc', line: '#e2e8f0',
  ink: '#0f172a', muted: '#64748b', font: 'Roboto',
};
// Background and text colour for status "chips".
const CHIPS = {
  Won: ['#dcfce7', '#166534'], Lost: ['#fee2e2', '#991b1b'], Open: ['#fef3c7', '#92400e'], Draft: ['#e2e8f0', '#475569'],
  Scheduled: ['#dbeafe', '#1e40af'], 'In progress': ['#ffedd5', '#9a3412'], Completed: ['#dcfce7', '#166534'], Cancelled: ['#e2e8f0', '#475569'],
};
const DATE_FMT = 'mmm d, yyyy';
const MONEY_FMT = '$#,##0';

function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** Wipes a tab completely (charts, banding, filter, merges, values, formats) so a refresh redraws it cleanly. */
function resetSheet_(sh) {
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  sh.getBandings().forEach(function (b) { b.remove(); });
  if (sh.getFilter()) sh.getFilter().remove();
  sh.setFrozenRows(0);
  sh.setFrozenColumns(0);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.clearConditionalFormatRules();
}

/** Makes the tab exactly `cols` columns wide and `rows` rows tall, so nothing trails off to the right or bottom. */
function fitSize_(sh, rows, cols) {
  const c = sh.getMaxColumns(), r = sh.getMaxRows();
  if (c > cols) sh.deleteColumns(cols + 1, c - cols);
  if (c < cols) sh.insertColumnsAfter(c, cols - c);
  if (r > rows) sh.deleteRows(rows + 1, r - rows);
  if (r < rows) sh.insertRowsAfter(r, rows - r);
}

function day_(s) { return s ? new Date(String(s).slice(0, 10) + 'T12:00:00') : ''; }
function label_(s) { s = String(s || '').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); }

function chipRules_(range, values) {
  return values.map(function (v) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(v)
      .setBackground(CHIPS[v][0]).setFontColor(CHIPS[v][1]).setBold(true).setRanges([range]).build();
  });
}

/**
 * A data tab: teal header, fixed column widths, striped rows on a light grid, a filter, and the
 * header row and first column frozen. columns: [{h: header, w: width px, fmt?: number format, align?}]
 */
function writeTable_(name, tabColor, columns, rows) {
  const sh = sheet_(name);
  resetSheet_(sh);
  const n = Math.max(rows.length, 1);
  fitSize_(sh, n + 1, columns.length);
  sh.setTabColor(tabColor).setHiddenGridlines(true);

  const all = sh.getRange(1, 1, n + 1, columns.length);
  const header = sh.getRange(1, 1, 1, columns.length);
  header.setValues([columns.map(function (c) { return c.h; })]);
  if (rows.length) sh.getRange(2, 1, rows.length, columns.length).setValues(rows);

  all.setFontFamily(THEME.font).setFontSize(10).setFontColor(THEME.ink).setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  all.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false)
    .setHeaderRowColor(THEME.brand).setFirstRowColor(THEME.card).setSecondRowColor(THEME.stripe);
  all.setBorder(true, true, true, true, true, true, THEME.line, SpreadsheetApp.BorderStyle.SOLID);
  header.setFontWeight('bold').setFontColor('#ffffff').setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);

  columns.forEach(function (c, i) {
    sh.setColumnWidth(i + 1, c.w);
    sh.getRange(1, i + 1, n + 1, 1).setHorizontalAlignment(c.align || (c.fmt ? 'right' : 'left'));
    if (c.fmt) sh.getRange(2, i + 1, n, 1).setNumberFormat(c.fmt);
  });
  sh.setRowHeight(1, 36);
  sh.setRowHeightsForced(2, n, 26);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  all.createFilter();
  return sh;
}

function writeEstimates_(estimates) {
  const columns = [
    { h: 'Customer', w: 170 }, { h: 'Address', w: 250 }, { h: 'Phone', w: 120, align: 'center' },
    { h: 'Lead source', w: 120 }, { h: 'Estimator', w: 110 }, { h: 'Job types', w: 160 },
    { h: 'Sq ft', w: 80, fmt: '#,##0' }, { h: 'Created', w: 105, fmt: DATE_FMT, align: 'center' },
    { h: 'Outcome', w: 95, align: 'center' }, { h: 'Decided', w: 105, fmt: DATE_FMT, align: 'center' },
    { h: 'Good', w: 95, fmt: MONEY_FMT }, { h: 'Better', w: 95, fmt: MONEY_FMT }, { h: 'Best', w: 95, fmt: MONEY_FMT },
    { h: 'Signed option', w: 110, align: 'center' }, { h: 'Signed price', w: 110, fmt: MONEY_FMT }, { h: 'Lost reason', w: 220 },
  ];
  const rows = estimates.slice().sort(function (a, b) { return a.created < b.created ? 1 : -1; }).map(function (e) {
    return [e.customer, e.address, e.phone, e.source, e.estimator, e.jobTypes, e.sqft, day_(e.created), e.outcome, day_(e.decided),
            e.good, e.better, e.best, e.signedTier, e.signedPrice, label_(e.lostReason)];
  });
  const sh = writeTable_('Estimates', '#14b8a6', columns, rows);
  sh.setConditionalFormatRules(chipRules_(sh.getRange(2, 9, Math.max(rows.length, 1), 1), ['Won', 'Lost', 'Open', 'Draft']));
}

function writeJobs_(jobs) {
  const columns = [
    { h: 'Customer', w: 170 }, { h: 'Address', w: 250 }, { h: 'Phone', w: 120, align: 'center' },
    { h: 'Crew', w: 100, align: 'center' }, { h: 'Status', w: 110, align: 'center' },
    { h: 'Start', w: 105, fmt: DATE_FMT, align: 'center' }, { h: 'Days', w: 60, fmt: '0.#', align: 'center' },
    { h: 'Option', w: 90, align: 'center' }, { h: 'Revenue', w: 100, fmt: MONEY_FMT }, { h: 'What gets installed', w: 280 },
    { h: 'Planned hours', w: 100, fmt: '0.0' }, { h: 'Actual hours', w: 100, fmt: '0.0' },
    { h: 'Hours vs plan', w: 105, fmt: '+0%;-0%;0%', align: 'center' }, { h: 'Verified', w: 80, align: 'center' },
    { h: 'Completed', w: 105, fmt: DATE_FMT, align: 'center' },
  ];
  const rows = jobs.slice().sort(function (a, b) { return (a.start || '') < (b.start || '') ? 1 : -1; }).map(function (j) {
    return [j.customer, j.address, j.phone, j.crew, label_(j.status), day_(j.start), j.days, j.signedTier, j.revenue, j.scope,
            j.estHours, j.actualHours === null ? '' : j.actualHours, j.hoursVariance === null ? '' : j.hoursVariance,
            j.verified ? '✓' : '', day_(j.completed)];
  });
  const sh = writeTable_('Jobs', '#5eead4', columns, rows);
  const n = Math.max(rows.length, 1);
  const variance = sh.getRange(2, 13, n, 1);
  sh.setConditionalFormatRules(chipRules_(sh.getRange(2, 5, n, 1), ['Scheduled', 'In progress', 'Completed', 'Cancelled']).concat([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0.1).setBackground('#fee2e2').setFontColor('#991b1b').setBold(true).setRanges([variance]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(-0.1).setBackground('#dcfce7').setFontColor('#166534').setBold(true).setRanges([variance]).build(),
  ]));
  sh.getRange(2, 14, n, 1).setFontColor('#166534').setFontWeight('bold');
}

// Dashboard grid: six "blocks", each two 100px columns, with 16px gutters between blocks and a
// 24px margin either side. KPI cards take one block, charts three, so everything lines up.
const GRID = { blocks: 6, colW: 100, gutter: 16, margin: 24, cols: 19 };
function blockCol_(i) { return 2 + i * 3; }
function spanCols_(count) { return count * 3 - 1; }
function spanPx_(count) { return count * 2 * GRID.colW + (count - 1) * GRID.gutter; }

const DASH_ROWS = {
  title: 2, subtitle: 3, kpi: 5,
  sales: 9, salesCharts: 11, crew: 27, crewCharts: 29, details: 45, tables: 47, last: 60,
};
const CHART_H = 300; // 15 rows of 21px = 315px reserved per chart row

function writeDashboard_(data) {
  const ss = SpreadsheetApp.getActive();
  const sh = sheet_('Dashboard');
  resetSheet_(sh);
  fitSize_(sh, DASH_ROWS.last, GRID.cols);
  sh.setTabColor(THEME.brand).setHiddenGridlines(true);

  // Grid and page.
  sh.setColumnWidth(1, GRID.margin);
  sh.setColumnWidth(GRID.cols, GRID.margin);
  for (let i = 0; i < GRID.blocks; i++) {
    sh.setColumnWidths(blockCol_(i), 2, GRID.colW);
    if (i < GRID.blocks - 1) sh.setColumnWidth(blockCol_(i) + 2, GRID.gutter);
  }
  sh.setRowHeightsForced(1, DASH_ROWS.last, 21);
  sh.getRange(1, 1, DASH_ROWS.last, GRID.cols).setBackground(THEME.page).setFontFamily(THEME.font)
    .setFontColor(THEME.ink).setFontSize(10).setVerticalAlignment('middle');

  // Numbers.
  const decided = data.estimates.filter(function (e) { return e.outcome === 'Won' || e.outcome === 'Lost'; });
  const won = decided.filter(function (e) { return e.outcome === 'Won'; });
  const open = data.estimates.filter(function (e) { return e.outcome === 'Open'; });
  const revenue = won.reduce(function (s, e) { return s + (e.signedPrice || 0); }, 0);
  const pipeline = open.reduce(function (s, e) { return s + (e.better || e.good || 0); }, 0);
  const done = data.jobs.filter(function (j) { return j.actualHours !== null && j.estHours > 0; });
  const hoursOff = done.length ? done.reduce(function (s, j) { return s + Math.abs(j.hoursVariance); }, 0) / done.length : null;
  const upcoming = data.jobs.filter(function (j) { return j.start && (j.status === 'scheduled' || j.status === 'in_progress'); });

  // Title.
  const stamp = Utilities.formatDate(new Date(data.generatedAt), ss.getSpreadsheetTimeZone(), 'MMM d, yyyy h:mm a');
  sh.setRowHeight(1, 16);
  sh.setRowHeight(DASH_ROWS.title, 40);
  sh.getRange(DASH_ROWS.title, 2, 1, spanCols_(6)).merge().setValue('Koala Insulation of Newark').setFontSize(20).setFontWeight('bold');
  sh.getRange(DASH_ROWS.subtitle, 2, 1, spanCols_(6)).merge()
    .setValue('Sales and crew dashboard  ·  ' + data.estimates.length + ' estimates  ·  ' + data.jobs.length + ' jobs  ·  updated ' + stamp)
    .setFontColor(THEME.muted);
  sh.setRowHeight(DASH_ROWS.subtitle + 1, 12);

  // KPI cards.
  const tiles = [
    { label: 'Win rate', value: decided.length ? won.length / decided.length : 0, fmt: '0%', note: won.length + ' won · ' + (decided.length - won.length) + ' lost' },
    { label: 'Jobs won', value: won.length, fmt: '0', note: 'signed quotes' },
    { label: 'Revenue won', value: revenue, fmt: MONEY_FMT, note: 'total of signed prices' },
    { label: 'Average job', value: won.length ? revenue / won.length : 0, fmt: MONEY_FMT, note: 'per signed quote' },
    { label: 'Open quotes', value: pipeline, fmt: MONEY_FMT, note: open.length + ' waiting on an answer' },
    { label: 'Crew hours vs plan', value: hoursOff === null ? '—' : hoursOff, fmt: '"±"0%', note: 'average miss, ' + done.length + ' jobs' },
  ];
  const k = DASH_ROWS.kpi;
  sh.setRowHeight(k, 28);
  sh.setRowHeight(k + 1, 44);
  sh.setRowHeight(k + 2, 26);
  sh.setRowHeight(k + 3, 20);
  tiles.forEach(function (t, i) {
    const c = blockCol_(i);
    sh.getRange(k, c, 3, 2).mergeAcross().setBackground(THEME.card).setHorizontalAlignment('center')
      .setBorder(true, true, true, true, null, null, THEME.line, SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(k, c, 1, 2).setBorder(true, null, null, null, null, null, THEME.brand, SpreadsheetApp.BorderStyle.SOLID_THICK);
    sh.getRange(k, c).setValue(t.label.toUpperCase()).setFontSize(9).setFontWeight('bold').setFontColor(THEME.muted);
    sh.getRange(k + 1, c).setValue(t.value).setNumberFormat(t.fmt).setFontSize(22).setFontWeight('bold').setFontColor(THEME.brand);
    sh.getRange(k + 2, c).setValue(t.note).setFontSize(9).setFontColor(THEME.muted);
  });

  // Data behind the charts lives on its own tab.
  const bySource = group_(decided, function (e) { return e.source || 'Unknown'; });
  const sources = Object.keys(bySource).map(function (s) {
    const g = bySource[s], w = g.filter(function (e) { return e.outcome === 'Won'; }).length;
    return [s, g.length, w, w / g.length];
  }).sort(function (a, b) { return b[1] - a[1]; });
  const byMonth = group_(won, function (e) { return (e.decided || e.created).slice(0, 7); });
  const months = Object.keys(byMonth).sort().map(function (m) {
    return [monthLabel_(m), byMonth[m].reduce(function (s, e) { return s + (e.signedPrice || 0); }, 0)];
  });
  const recent = done.slice().sort(function (a, b) { return a.completed < b.completed ? 1 : -1; }).slice(0, 12)
    .map(function (j) { return [j.customer, j.estHours, j.actualHours]; });
  const outcomes = ['Won', 'Lost', 'Open'].map(function (o) {
    return [o, data.estimates.filter(function (e) { return e.outcome === o; }).length];
  });
  const cd = writeChartData_([
    { key: 'sources', headers: ['Lead source', 'Quotes', 'Won', 'Win rate'], rows: sources, fmts: [null, '0', '0', '0%'] },
    { key: 'months', headers: ['Month', 'Revenue won'], rows: months, fmts: [null, MONEY_FMT] },
    { key: 'hours', headers: ['Job', 'Planned hours', 'Actual hours'], rows: recent, fmts: [null, '0.0', '0.0'] },
    { key: 'outcomes', headers: ['Outcome', 'Estimates'], rows: outcomes, fmts: [null, '0'] },
  ]);
  const axis = { gridlines: { color: THEME.line }, textStyle: { color: THEME.muted } };

  // Sales charts.
  section_(sh, DASH_ROWS.sales, 'Sales');
  if (sources.length) {
    chart_(sh, Charts.ChartType.COLUMN, [cd.col('sources', 0), cd.col('sources', 3)], DASH_ROWS.salesCharts, 0, {
      title: 'Win rate by lead source', colors: [THEME.brand],
      vAxis: Object.assign({ format: 'percent', viewWindow: { min: 0, max: 1 } }, axis), hAxis: { textStyle: { color: THEME.muted } },
    });
  }
  if (months.length) {
    chart_(sh, Charts.ChartType.COLUMN, [cd.col('months', 0), cd.col('months', 1)], DASH_ROWS.salesCharts, 3, {
      title: 'Revenue won by month', colors: ['#14b8a6'],
      vAxis: Object.assign({ format: '$#,##0' }, axis), hAxis: { textStyle: { color: THEME.muted } },
    });
  }

  // Crew and outcome charts.
  section_(sh, DASH_ROWS.crew, 'Crew and outcomes');
  if (recent.length) {
    chart_(sh, Charts.ChartType.BAR, [cd.col('hours', 0), cd.col('hours', 1), cd.col('hours', 2)], DASH_ROWS.crewCharts, 0, {
      title: 'Crew hours: planned vs actual (latest jobs)', colors: ['#cbd5e1', THEME.brand],
      legend: { position: 'top', textStyle: { color: THEME.muted } }, hAxis: axis, vAxis: { textStyle: { color: THEME.muted } },
    });
  }
  chart_(sh, Charts.ChartType.PIE, [cd.col('outcomes', 0), cd.col('outcomes', 1)], DASH_ROWS.crewCharts, 3, {
    title: 'Estimate outcomes', pieHole: 0.55, colors: ['#16a34a', '#dc2626', '#f59e0b'],
    legend: { position: 'right', textStyle: { color: THEME.ink } }, pieSliceText: 'percentage',
  });

  // Detail tables.
  section_(sh, DASH_ROWS.details, 'Details');
  blockTable_(sh, DASH_ROWS.tables, 0, 'Lead sources',
    ['Lead source', 'Won / quotes', 'Win rate'],
    sources.slice(0, 10).map(function (s) { return [s[0], s[2] + ' / ' + s[1], s[3]]; }), [null, null, '0%']);
  blockTable_(sh, DASH_ROWS.tables, 3, 'Coming up',
    ['Start', 'Customer', 'Crew'],
    upcoming.sort(function (a, b) { return a.start < b.start ? -1 : 1; }).slice(0, 10)
      .map(function (j) { return [day_(j.start), j.customer, j.crew || 'Not assigned']; }), [DATE_FMT, null, null]);
}

function monthLabel_(ym) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
}

/** A section heading across the full dashboard width, underlined in the brand colour. */
function section_(sh, row, text) {
  sh.setRowHeight(row, 30);
  sh.setRowHeight(row + 1, 8);
  sh.getRange(row, 2, 1, spanCols_(GRID.blocks)).merge().setValue(text).setFontSize(12).setFontWeight('bold')
    .setFontColor(THEME.brandDark).setBorder(null, null, true, null, null, null, THEME.brand, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
}

/** A white chart card three blocks wide, anchored to the grid. */
function chart_(sh, type, ranges, row, firstBlock, opts) {
  let b = sh.newChart().setChartType(type).setNumHeaders(1);
  ranges.forEach(function (r) { b = b.addRange(r); });
  b = b.setPosition(row, blockCol_(firstBlock), 0, 0)
    .setOption('width', spanPx_(3)).setOption('height', CHART_H)
    .setOption('backgroundColor', THEME.card).setOption('fontName', THEME.font)
    .setOption('titleTextStyle', { color: THEME.ink, fontSize: 13, bold: true })
    .setOption('legend', { position: 'none' });
  Object.keys(opts).forEach(function (key) { b = b.setOption(key, opts[key]); });
  sh.insertChart(b.build());
}

/**
 * A table on the dashboard grid. Each table column spans one block (its two columns plus the
 * gutter after it), so tables line up with the cards and charts above.
 */
function blockTable_(sh, row, firstBlock, title, headers, rows, fmts) {
  const c0 = blockCol_(firstBlock), width = spanCols_(headers.length);
  const body = Math.max(rows.length, 1);
  sh.setRowHeight(row, 30);
  sh.setRowHeights(row + 1, body + 1, 26);
  sh.getRange(row, c0, 1, width).merge().setValue(title).setFontSize(11).setFontWeight('bold').setBackground(THEME.card)
    .setBorder(true, true, null, true, null, null, THEME.line, SpreadsheetApp.BorderStyle.SOLID);
  for (let r = 0; r < body; r++) sh.getRange(row + 2 + r, c0, 1, width).setBackground(r % 2 ? THEME.stripe : THEME.card);
  sh.getRange(row + 1, c0, 1, width).setBackground(THEME.brand).setFontColor('#ffffff').setFontWeight('bold');
  headers.forEach(function (h, i) {
    const c = blockCol_(firstBlock + i);
    const span = i < headers.length - 1 ? 3 : 2;
    sh.getRange(row + 1, c, body + 1, span).mergeAcross().setHorizontalAlignment(i === 0 ? 'left' : 'center');
    sh.getRange(row + 1, c).setValue(h);
    if (rows.length) sh.getRange(row + 2, c, rows.length, 1).setValues(rows.map(function (r) { return [r[i]]; }));
    if (fmts[i]) sh.getRange(row + 2, c, body, 1).setNumberFormat(fmts[i]);
  });
  if (!rows.length) sh.getRange(row + 2, c0).setValue('Nothing yet').setFontColor(THEME.muted);
  sh.getRange(row + 1, c0, body + 1, width).setBorder(true, true, true, true, null, true, THEME.line, SpreadsheetApp.BorderStyle.SOLID);
}

/** Writes the chart tables side by side on the "Chart data" tab; col(key, i) is a column of one table. */
function writeChartData_(tables) {
  const sh = sheet_('Chart data');
  resetSheet_(sh);
  const width = tables.reduce(function (s, t) { return s + t.headers.length + 1; }, 0);
  const height = tables.reduce(function (m, t) { return Math.max(m, t.rows.length + 1); }, 2);
  fitSize_(sh, height, width);
  sh.setTabColor('#94a3b8').setHiddenGridlines(true);
  sh.getRange(1, 1, height, width).setFontFamily(THEME.font).setFontSize(10).setVerticalAlignment('middle');
  const at = {};
  let col = 1;
  tables.forEach(function (t) {
    const n = t.rows.length;
    sh.getRange(1, col, 1, t.headers.length).setValues([t.headers]).setFontWeight('bold').setBackground(THEME.brand).setFontColor('#ffffff');
    if (n) sh.getRange(2, col, n, t.headers.length).setValues(t.rows);
    t.fmts.forEach(function (f, i) { if (f && n) sh.getRange(2, col + i, n, 1).setNumberFormat(f); });
    sh.getRange(1, col, n + 1, t.headers.length).setBorder(true, true, true, true, true, true, THEME.line, SpreadsheetApp.BorderStyle.SOLID);
    sh.setColumnWidths(col, t.headers.length, 120);
    sh.setColumnWidth(col + t.headers.length, 24);
    at[t.key] = { col: col, rows: n };
    col += t.headers.length + 1;
  });
  sh.setRowHeightsForced(1, height, 24);
  return {
    col: function (key, i) { return sh.getRange(1, at[key].col + i, at[key].rows + 1, 1); },
  };
}

/** Dashboard first, then the data tabs; drops the empty "Sheet1" a new spreadsheet starts with. */
function arrangeTabs_() {
  const ss = SpreadsheetApp.getActive();
  ['Dashboard', 'Estimates', 'Jobs', 'Chart data'].forEach(function (name, i) {
    const sh = ss.getSheetByName(name);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  ss.setActiveSheet(ss.getSheetByName('Dashboard'));
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
