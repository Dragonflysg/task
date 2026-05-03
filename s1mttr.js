// ============================================================
// CHART CONFIG — display thresholds, not data
// ============================================================
const SLA_HOURS = 72;
const TICKET_HOURS = 12;

// ============================================================
// DATA SOURCE — REPLACE THIS BLOCK IN PRODUCTION
// ============================================================
//
// In production, replace the single line:
//     const INCIDENTS_DATA = generateDummyData();
// with an API fetch. Example:
//
//     async function loadIncidents() {
//       const res = await fetch('/api/noncompliance', {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({ days: 180 })
//       });
//       if (!res.ok) throw new Error('Failed to load incidents: ' + res.status);
//       return await res.json();
//     }
//     // wrap the page bootstrap in async since fetch is async:
//     (async () => {
//       const INCIDENTS_DATA = await loadIncidents();
//       window.INCIDENTS = normalizeIncidents(INCIDENTS_DATA);
//       buildServerLookup();
//       renderAll();
//     })();
//
// EXPECTED ROW SHAPE — each object in INCIDENTS_DATA must have these fields.
// Datetime fields can be ISO strings ("2026-04-15T08:00:00Z") OR MySQL DATETIME
// strings ("2026-04-15 08:00:00") — both parse via new Date(...).
//
//   id                              number    unique row id (your MySQL PK)
//   server_name                     string    hostname
//   first_seen_noncompliant         string    datetime
//   last_seen_noncompliant          string    datetime, OR null while ongoing
//   consecutive_hours_noncompliant  number    hours from first_seen to last_seen
//                                             (for ongoing rows: hours so far)
//   ticket_created                  string    helpdesk ticket number
//   status                          string    'on-going' or 'resolved'
//   created_at                      string    datetime
//   updated_at                      string    datetime
//
//   team                            string    NOT in your noncompliance table.
//                                             Add via JOIN to your server registry / CMDB:
//                                               SELECT n.*, s.team, s.os
//                                               FROM noncompliance n
//                                               JOIN servers s ON s.hostname = n.server_name;
//   os                              string    'Windows' or 'Linux' — same source as team
//
// If team/os are unavailable, the "MTTR by team & OS" chart will render empty.
// You can comment out renderMTTRTeam() in renderAll() and remove that card.

const INCIDENTS_DATA = generateDummyData();
console.log(INCIDENTS_DATA)

// ============================================================
// MATH & FORMAT HELPERS
// ============================================================
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function lognormal(mu, sigma) { return Math.exp(mu + sigma * randn()); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pad(n, w) { return String(n).padStart(w, '0'); }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(p / 100 * s.length));
  return s[idx];
}
function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ============================================================
// NORMALIZE — convert API/JSON row format (ISO strings) into the
// shape the charts work with (Date objects). Single conversion point.
// ============================================================
function normalizeIncidents(rows) {
  return rows.map(r => ({
    ...r,
    first_seen_noncompliant: new Date(r.first_seen_noncompliant),
    last_seen_noncompliant:  r.last_seen_noncompliant ? new Date(r.last_seen_noncompliant) : null,
    created_at:              new Date(r.created_at),
    updated_at:              new Date(r.updated_at)
  }));
}

const INCIDENTS = normalizeIncidents(INCIDENTS_DATA);

// derived server metadata lookup (for tooltip enrichment in renderRepeat)
const SERVER_LOOKUP = {};
function buildServerLookup() {
  for (const i of INCIDENTS) {
    if (!SERVER_LOOKUP[i.server_name]) {
      SERVER_LOOKUP[i.server_name] = { team: i.team, os: i.os };
    }
  }
}
buildServerLookup();

// "now" anchor for window calculations
const NOW = new Date();
NOW.setMinutes(0, 0, 0);

// derived from data — list of distinct teams (used by MTTR-by-team chart)
// and the earliest incident date (used to bound the Prev-30d button).
const TEAMS = [...new Set(INCIDENTS.map(i => i.team).filter(Boolean))].sort();
const EARLIEST_DATE = INCIDENTS.length
  ? (() => {
      const d = new Date(Math.min(...INCIDENTS.map(i => i.first_seen_noncompliant.getTime())));
      d.setHours(0, 0, 0, 0);
      return d;
    })()
  : new Date(NOW);

console.log(`Loaded ${INCIDENTS.length} incidents · teams: ${TEAMS.join(', ')}`);

// ============================================================
// DUMMY DATA GENERATOR — delete this whole function in production
// ============================================================
function generateDummyData() {
  const TEAMS = ['Platform', 'Security', 'DataOps', 'AppDev', 'Infrastructure'];
  // lognormal params: hours = exp(mu + sigma * randn()), clamped to [1, 315]
  const TEAM_PROFILES = {
    Platform:       { mu: 2.0, sigma: 1.0 },  // fastest
    Security:       { mu: 2.4, sigma: 1.1 },
    Infrastructure: { mu: 2.6, sigma: 1.2 },
    DataOps:        { mu: 2.9, sigma: 1.3 },
    AppDev:         { mu: 3.4, sigma: 1.4 }   // slowest
  };
  const HISTORY_DAYS = 180;
  const TOTAL_SERVERS = 1000;
  const AVG_INCIDENTS_PER_DAY = 7;

  const servers = [];
  for (let i = 1; i <= TOTAL_SERVERS; i++) {
    const team = pick(TEAMS);
    const os = Math.random() < 0.6 ? 'Windows' : 'Linux';
    const prefix = os === 'Windows' ? 'WIN' : 'LNX';
    servers.push({
      name: `${prefix}-${team.substring(0, 3).toUpperCase()}-${pad(i, 4)}`,
      team,
      os,
      // 10% of servers are "problem children" — appear 5x as often
      problemFactor: Math.random() < 0.10 ? 5 : 1
    });
  }

  const now = new Date();
  now.setMinutes(0, 0, 0);

  const weighted = [];
  servers.forEach(s => {
    for (let i = 0; i < s.problemFactor; i++) weighted.push(s);
  });

  const rows = [];
  let nextId = 1;

  for (let d = HISTORY_DAYS; d >= 0; d--) {
    const dayStart = new Date(now);
    dayStart.setDate(dayStart.getDate() - d);
    dayStart.setHours(0, 0, 0, 0);
    const numIncidents = Math.max(0, Math.round(AVG_INCIDENTS_PER_DAY + randn() * 3));
    for (let k = 0; k < numIncidents; k++) {
      const server = pick(weighted);
      const profile = TEAM_PROFILES[server.team];
      const firstSeen = new Date(dayStart);
      firstSeen.setHours(Math.floor(Math.random() * 24));
      let hoursToResolve = Math.round(lognormal(profile.mu, profile.sigma));
      hoursToResolve = Math.max(1, Math.min(315, hoursToResolve));
      const lastSeen = new Date(firstSeen);
      lastSeen.setHours(lastSeen.getHours() + hoursToResolve);

      let status, lastSeenIso, updatedAtIso, consecutiveHours;
      if (lastSeen >= now) {
        status = 'on-going';
        lastSeenIso = null;
        updatedAtIso = now.toISOString();
        consecutiveHours = Math.max(1, Math.round((now - firstSeen) / 3600000));
      } else {
        status = 'resolved';
        lastSeenIso = lastSeen.toISOString();
        updatedAtIso = lastSeen.toISOString();
        consecutiveHours = hoursToResolve;
      }

      // shape mirrors what the API/MySQL would return: ISO strings, flat fields
      rows.push({
        id: nextId++,
        server_name: server.name,
        first_seen_noncompliant: firstSeen.toISOString(),
        last_seen_noncompliant: lastSeenIso,
        consecutive_hours_noncompliant: consecutiveHours,
        ticket_created: `INC${pad(100000 + nextId, 6)}`,
        status,
        created_at: firstSeen.toISOString(),
        updated_at: updatedAtIso,
        team: server.team,   // from CMDB JOIN in production
        os: server.os        // from CMDB JOIN in production
      });
    }
  }
  return rows;
}

// ============================================================
// 30-DAY WINDOW STATE
// ============================================================
let windowEnd = new Date(NOW);
windowEnd.setHours(23, 59, 59, 999);

function getWindow() {
  const end = new Date(windowEnd);
  const start = new Date(windowEnd);
  start.setDate(start.getDate() - 29);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

// ============================================================
// CHART REGISTRY
// ============================================================
const charts = {};
function mountOrUpdate(key, selector, options) {
  if (charts[key]) {
    charts[key].updateOptions(options, false, false);
  } else {
    charts[key] = new ApexCharts(document.querySelector(selector), options);
    charts[key].render();
  }
}

// ============================================================
// KPI CARDS
// ============================================================
function renderKPIs() {
  const { start, end } = getWindow();
  const inWindow = INCIDENTS.filter(i =>
    i.first_seen_noncompliant >= start && i.first_seen_noncompliant <= end
  );
  const resolvedInWindow = inWindow.filter(i => i.status === 'resolved');
  const hours = resolvedInWindow.map(i => i.consecutive_hours_noncompliant);
  const med = median(hours);
  const avg = mean(hours);
  const p90 = percentile(hours, 90);
  const slaPass = resolvedInWindow.filter(i => i.consecutive_hours_noncompliant <= SLA_HOURS).length;
  const slaPct = resolvedInWindow.length ? (slaPass / resolvedInWindow.length * 100) : 0;
  const ongoingNow = INCIDENTS.filter(i => i.status === 'on-going').length;

  const slaClass = slaPct >= 80 ? 'good' : slaPct >= 60 ? 'warn' : 'bad';
  const medClass = med <= SLA_HOURS ? 'good' : med <= SLA_HOURS * 1.5 ? 'warn' : 'bad';
  const ongoingClass = ongoingNow > 0 ? 'bad' : 'good';

  const cards = [
    { label: 'Median MTTR (window)', value: med.toFixed(1) + 'h', sub: `${resolvedInWindow.length} resolved incidents`, cls: medClass, help: 'median' },
    { label: 'Mean MTTR (window)',   value: avg.toFixed(1) + 'h', sub: 'inflated by long tail', help: 'mean' },
    { label: '90% resolved within',  value: p90.toFixed(0) + 'h', sub: '10% took longer than this', help: 'p90' },
    { label: 'SLA compliance',       value: slaPct.toFixed(1) + '%', sub: `target: ≤${SLA_HOURS}h to resolve`, cls: slaClass, help: 'sla' },
    { label: 'Incidents in window',  value: inWindow.length, sub: `${resolvedInWindow.length} resolved · ${inWindow.length - resolvedInWindow.length} still open`, help: 'volume' },
    { label: 'Ongoing right now',    value: ongoingNow, sub: 'across all dates', cls: ongoingClass, help: 'ongoing' }
  ];
  $('#kpiGrid').html(cards.map(c => `
    <div class="kpi">
      ${c.help ? `<button class="kpi-help" data-help="${c.help}" title="What is this?" aria-label="What is this?">?</button>` : ''}
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value ${c.cls || ''}">${c.value}</div>
      <div class="kpi-sub">${c.sub}</div>
    </div>
  `).join(''));
}

// ============================================================
// KPI HELP MODAL
// ============================================================
const HELP_CONTENT = {
  median: {
    title: 'Median MTTR (window)',
    body: `
      <p><b>What it shows.</b> The middle resolution time for non-compliant servers in the 30-day window. Half were brought back into SentinelOne compliance faster than this; half took longer. If this card reads <i>12.0h</i>, a typical server sat without SentinelOne protection for about 12 hours before the team fixed it.</p>

      <p><b>Why median and not average.</b> A few servers that drag on for days or weeks would pull the average up and misrepresent how teams are actually doing. The median ignores those slow cases and tells you what most servers really look like.</p>

      <p><b>Compare it against the Mean MTTR card.</b></p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">Both numbers similar</div>
          Resolution times are consistent. Teams are in steady state — no servers are slipping through the cracks.
        </div>
        <div class="compare-cell">
          <div class="label">Mean is much higher</div>
          A few stuck servers are dragging the average up. Most are fine; a few are sitting non-compliant longer than they should. Check the aging chart.
        </div>
      </div>
    `
  },

  mean: {
    title: 'Mean MTTR (window)',
    body: `
      <p><b>What it shows.</b> The average time it takes to bring a non-compliant server back into SentinelOne compliance, across all servers resolved in the 30-day window. Add up the hours, divide by the count.</p>

      <p><b>Why it can mislead.</b> A single server that stays non-compliant for 200h pulls the average up sharply. The number stops describing what most servers actually look like — that's why the subtitle reads "inflated by long tail." For a fair read of how teams are doing on a typical server, use the Median card instead.</p>

      <p><b>When Mean is the right number.</b> When you're estimating total team workload. Total time spent on SentinelOne remediation ≈ Mean × number of servers. Useful for forecasting how much of a team's time will go to compliance work next quarter.</p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">Both numbers similar</div>
          Resolution times are tightly clustered. Workload is predictable — easy to plan.
        </div>
        <div class="compare-cell">
          <div class="label">Mean is much higher than Median</div>
          A few stuck servers are eating disproportionate hours. Most work is fine, but those long-runners are absorbing time that doesn't show up in the typical-day picture.
        </div>
      </div>
    `
  },

  p90: {
    title: '90% resolved within',
    body: `
      <p><b>What it shows.</b> 90% of non-compliant servers in the window were brought back into SentinelOne compliance within this many hours. Only the worst 10% took longer. If this card reads <i>85h</i>, then 9 out of every 10 affected servers were fixed in under 85 hours.</p>

      <p><b>Why it matters.</b> Median tells you the typical server. This number tells you the bad-but-not-worst case — the kind of stuck server you can't ignore, even though it isn't the absolute worst. It's the most honest number for how long a problematic case usually drags on.</p>

      <p><b>Read against the 72h SLA.</b></p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">90% within ≤ 72h</div>
          Even your slow cases are inside the SLA window. Healthy.
        </div>
        <div class="compare-cell">
          <div class="label">90% within &gt; 72h</div>
          More than 10% of servers stayed non-compliant longer than allowed. Worth investigating, even if the Median card looks fine.
        </div>
      </div>
    `
  },

  sla: {
    title: 'SLA compliance',
    body: `
      <p><b>What it shows.</b> The percentage of resolved non-compliance events in the window where the server was returned to SentinelOne compliance within the 72-hour SLA. If this reads <i>84%</i>, then 84 out of every 100 affected servers were fixed within the allowed window.</p>

      <p><b>Why it matters.</b> This is the number that shows up in security commitments and management reporting — every server above 72h is a documented coverage gap. Remember the 12h grace window before a ticket is even created: teams effectively have 60h of active ticketed work to bring a server back.</p>

      <p><b>Compare against the Median MTTR card.</b></p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">High SLA% + low Median</div>
          Healthy. Teams restore most servers quickly.
        </div>
        <div class="compare-cell">
          <div class="label">High SLA% + Median near 72h</div>
          Fragile. Most servers just barely make it. One bad week and the number falls below target.
        </div>
      </div>
    `
  },

  volume: {
    title: 'Incidents in window',
    body: `
      <p><b>What it shows.</b> Total non-compliance events across the server fleet during the 30-day window — both servers already restored and ones still affected. The subtitle splits the count between the two.</p>

      <p><b>Why it matters.</b> Volume context. A team handling 50 events in a month at a 12h median is doing very different work than a team with 500 events at the same median. MTTR alone can't tell you whether teams are seeing routine fleet noise or active firefighting.</p>

      <p><b>Compare against MTTR.</b></p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">High volume + low MTTR</div>
          Teams are responsive, but the fleet keeps generating events. Worth checking the Recurring Offenders chart — same servers repeating? That points to a deeper issue (broken patching, configuration drift) that faster remediation won't fix.
        </div>
        <div class="compare-cell">
          <div class="label">Low volume + high MTTR</div>
          Few events, but the ones that happen are stuck. Check the Aging chart.
        </div>
      </div>
    `
  },

  ongoing: {
    title: 'Ongoing right now',
    body: `
      <p><b>What it shows.</b> Number of servers currently in a non-compliant state — right now, this moment. This counts every server, not just ones from the 30-day window. A server that went out of SentinelOne compliance 90 days ago and is still out today is included.</p>

      <p><b>Why all dates.</b> A server without working SentinelOne protection today is exposed today, regardless of when it stopped reporting. The 30-day window controls how we look at history — it doesn't change today's risk.</p>

      <p><b>Why this card is red whenever the number is greater than zero.</b> Every currently non-compliant server is an active gap in protection on a real machine in your fleet. There's no "healthy non-zero" count for security exposure. Use the Aging chart to see how bad each one is.</p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">Many ongoing, none past 72h</div>
          Teams are keeping up. Watch the oldest one — it's next on the breach list.
        </div>
        <div class="compare-cell">
          <div class="label">Any ongoing past 72h</div>
          Active SLA breach in progress. That server is the immediate priority.
        </div>
      </div>
    `
  },

  mttrTeam: {
    title: 'MTTR by team & OS',
    body: `
      <p><b>What it shows.</b> The middle resolution time for each of the 5 teams that own server fleets, split by Windows and Linux. Bars above the dashed 72h line mean the team is missing SLA on a typical server.</p>

      <p><b>Why median per team.</b> Like the Median MTTR card up top, this uses the middle case — not the average — so a single stuck server doesn't make a team look worse than it actually is. You're seeing each team's typical experience.</p>

      <p><b>Why split by OS.</b> Windows and Linux servers usually have very different remediation paths — different agent issues, different patching cadences, often different engineers responsible. Combining them into one bar would hide which OS is actually slow inside each team.</p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">One team consistently lower</div>
          That team has a process worth replicating across the others.
        </div>
        <div class="compare-cell">
          <div class="label">One OS bar much higher</div>
          Likely an agent or platform-specific issue — not a team-wide problem.
        </div>
      </div>
    `
  },

  hist: {
    title: 'Resolution time distribution',
    body: `
      <p><b>What it shows.</b> How many non-compliance events fell into each duration bucket during the 30-day window. The colors track the ticketing process: green = inside the 12h grace window (no ticket needed), amber = ticket cut but still inside the 72h SLA, red = SLA breach.</p>

      <p><b>Why it matters.</b> This separates two very different problem types. A tall green stack means lots of short events that resolved themselves before tickets were even cut — usually routine fleet noise. A tall red stack means real exposure: servers sitting non-compliant for days.</p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">Tall green + short red</div>
          Healthy. Most events self-resolve before requiring a ticket.
        </div>
        <div class="compare-cell">
          <div class="label">Any noticeable red bars</div>
          Servers running past SLA. Each one shows up in the SLA Compliance number.
        </div>
      </div>
    `
  },

  trend: {
    title: 'Weekly MTTR trend',
    body: `
      <p><b>What it shows.</b> Two lines plotted weekly for the last 12 weeks: the median resolution time, and the "90% resolved within" number. This chart is independent of the 30-day window above — it's always the most recent 12 weeks. Useful for spotting drift that the window-based cards can hide.</p>

      <p><b>Why two lines.</b> The median line tracks the typical week's experience. The 90% line tracks how bad the slow cases are. Watching them together shows whether changes are affecting everyone or just the long-runners.</p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">Median rising</div>
          Every server is taking longer to resolve — fleet-wide slowdown, not just unlucky weeks.
        </div>
        <div class="compare-cell">
          <div class="label">Only the 90% line rising</div>
          A few stuck cases are getting worse. Most work is fine; specific servers need attention.
        </div>
      </div>
    `
  },

  slaTrend: {
    title: 'SLA compliance trend',
    body: `
      <p><b>What it shows.</b> One bar per week — the percentage of resolved incidents in that week that beat the 72h SLA.</p>

      <p><b>Why weekly.</b> SLA conversations usually happen weekly, or summed monthly. This is the chart you would hand to security leadership when they ask "are we on target?"</p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">Bars consistently high and flat</div>
          Meeting commitments. Steady state.
        </div>
        <div class="compare-cell">
          <div class="label">Trend declining across weeks</div>
          Getting worse, not just a one-week blip. Worth surfacing before security leadership notices first.
        </div>
      </div>
    `
  },

  aging: {
    title: 'Currently ongoing — aging',
    body: `
      <p><b>What it shows.</b> The 15 oldest currently non-compliant servers in your fleet, right now. Bars to the right of the dashed 72h line are already in SLA breach. This view is independent of the 30-day window — it shows live state.</p>

      <p><b>Why this view.</b> The KPI cards summarize. This chart gives you specific server names and how long each has been exposed. Useful for incident standups and daily prioritization.</p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">All bars short, none past 72h</div>
          Teams are keeping up. No active breaches.
        </div>
        <div class="compare-cell">
          <div class="label">Many bars past 72h</div>
          SLA crisis — likely a fleet-wide failure pattern or a team that's stuck.
        </div>
      </div>
    `
  },

  repeat: {
    title: 'Top recurring offenders',
    body: `
      <p><b>What it shows.</b> Servers that have gone non-compliant the most times across all available history. Each bar is one server; the height is the number of distinct non-compliance episodes that server has had.</p>

      <p><b>Why it matters.</b> When the same server keeps lapsing, the answer isn't faster remediation — it's root cause. These are candidates for deeper investigation: a software conflict, a broken patching pipeline, unstable hardware, or a misconfigured update process. Faster ticket handling won't help if the underlying issue keeps regenerating events.</p>

      <div class="compare-grid">
        <div class="compare-cell">
          <div class="label">A few servers dominate the list</div>
          Concentrated problem. Investigate those specific hosts; one root-cause fix could remove many future incidents.
        </div>
        <div class="compare-cell">
          <div class="label">Counts spread evenly</div>
          No single bad host. The volume is fleet-wide noise — look at process or agent rollout instead.
        </div>
      </div>
    `
  }
};

function openHelpModal(key) {
  const c = HELP_CONTENT[key];
  if (!c) return;
  $('#modalTitle').text(c.title);
  $('#modalBody').html(c.body);
  $('#modalOverlay').addClass('open');
}
function closeHelpModal() {
  $('#modalOverlay').removeClass('open');
}
$(document).on('click', '[data-help]', function () {
  openHelpModal($(this).data('help'));
});
$(document).on('click', '#modalOverlay', function (e) {
  if (e.target === this) closeHelpModal();
});
$(document).on('click', '.modal-close', closeHelpModal);
$(document).on('keydown', function (e) {
  if (e.key === 'Escape') closeHelpModal();
});

// ============================================================
// SCATTER: daily incident distribution
// ============================================================
// Y-axis zoom state for the scatter chart. null = auto-fit to current
// window's data; otherwise this is the explicit yaxis.max in hours.
let scatterYMaxOverride = null;
const SCATTER_ZOOM_FACTOR = 1.5;
const SCATTER_ZOOM_MIN_HOURS = 10;

function getScatterAutoMax() {
  const { start, end } = getWindow();
  const inWindow = INCIDENTS.filter(i =>
    i.first_seen_noncompliant >= start && i.first_seen_noncompliant <= end
  );
  if (!inWindow.length) return 100;
  const dataMax = Math.max(...inWindow.map(i => i.consecutive_hours_noncompliant));
  // a touch of headroom above the highest point so the dot isn't on the edge
  return Math.max(80, Math.ceil(dataMax * 1.1));
}

function renderScatter() {
  const { start, end } = getWindow();
  const inWindow = INCIDENTS.filter(i =>
    i.first_seen_noncompliant >= start && i.first_seen_noncompliant <= end
  );
  const resolved = inWindow.filter(i => i.status === 'resolved').map(i => ({
    x: i.first_seen_noncompliant.getTime(),
    y: i.consecutive_hours_noncompliant,
    meta: i
  }));
  const ongoing = inWindow.filter(i => i.status === 'on-going').map(i => ({
    x: i.first_seen_noncompliant.getTime(),
    y: i.consecutive_hours_noncompliant,
    meta: i
  }));

  const yMax = scatterYMaxOverride ?? getScatterAutoMax();

  mountOrUpdate('scatter', '#scatterChart', {
    // built-in zoom disabled — Zoom In / Zoom Out buttons drive yaxis range instead.
    // This also stops the chart from capturing the page scroll wheel.
    chart: { type: 'scatter', height: 400, zoom: { enabled: false }, toolbar: { show: false }, animations: { enabled: false } },
    series: [
      { name: 'Resolved', data: resolved },
      { name: 'Ongoing',  data: ongoing }
    ],
    colors: ['#2563eb', '#ef4444'],
    xaxis: {
      type: 'datetime',
      min: start.getTime(),
      max: end.getTime(),
      labels: { datetimeFormatter: { day: 'MMM dd' } }
    },
    yaxis: {
      title: { text: 'Hours to resolve' },
      min: 0,
      max: yMax,
      labels: { formatter: v => Math.round(v) + 'h' }
    },
    annotations: {
      yaxis: [
        {
          y: TICKET_HOURS,
          borderColor: '#5a6878',
          strokeDashArray: 4,
          label: { text: `TICKET ${TICKET_HOURS}h`, style: { background: '#5a6878', color: '#fff' } }
        },
        {
          y: SLA_HOURS,
          borderColor: '#f59e0b',
          strokeDashArray: 6,
          label: { text: `SLA ${SLA_HOURS}h`, style: { background: '#f59e0b', color: '#fff' } }
        }
      ]
    },
    markers: { size: 5, strokeWidth: 0, hover: { size: 8 } },
    grid: { borderColor: '#e5e9f0' },
    legend: { position: 'top', horizontalAlign: 'right' },
    tooltip: {
      custom: ({ seriesIndex, dataPointIndex, w }) => {
        const pt = w.config.series[seriesIndex].data[dataPointIndex];
        const m = pt.meta;
        return `<div style="padding:8px 10px;font-size:12px;line-height:1.5">
          <div style="font-weight:600;margin-bottom:2px">${m.server_name}</div>
          <div>Team: <b>${m.team}</b> (${m.os})</div>
          <div>First seen: ${m.first_seen_noncompliant.toLocaleString()}</div>
          <div>Hours: <b>${m.consecutive_hours_noncompliant}h</b>${m.status === 'on-going' ? ' <span style="color:#ef4444">(ongoing)</span>' : ''}</div>
          <div>Ticket: ${m.ticket_created}</div>
        </div>`;
      }
    }
  });

  updateScatterZoomButtons();
}

function zoomScatter(factor) {
  const auto = getScatterAutoMax();
  const current = scatterYMaxOverride ?? auto;
  let next = Math.round(current * factor);
  next = Math.max(SCATTER_ZOOM_MIN_HOURS, Math.min(auto, next));
  // back to null (auto) when at the natural max — keeps state tidy
  scatterYMaxOverride = next >= auto ? null : next;
  renderScatter();
}

function updateScatterZoomButtons() {
  const auto = getScatterAutoMax();
  const current = scatterYMaxOverride ?? auto;
  $('#scatterZoomIn').prop('disabled', current <= SCATTER_ZOOM_MIN_HOURS);
  $('#scatterZoomOut').prop('disabled', current >= auto);
}

// ============================================================
// MTTR by team & OS
// ============================================================
function renderMTTRTeam() {
  const { start, end } = getWindow();
  const resolved = INCIDENTS.filter(i =>
    i.status === 'resolved' &&
    i.first_seen_noncompliant >= start &&
    i.first_seen_noncompliant <= end
  );
  const winSeries = TEAMS.map(t => {
    const h = resolved.filter(i => i.team === t && i.os === 'Windows').map(i => i.consecutive_hours_noncompliant);
    return Number(median(h).toFixed(1));
  });
  const lnxSeries = TEAMS.map(t => {
    const h = resolved.filter(i => i.team === t && i.os === 'Linux').map(i => i.consecutive_hours_noncompliant);
    return Number(median(h).toFixed(1));
  });

  mountOrUpdate('mttrTeam', '#mttrTeamChart', {
    chart: { type: 'bar', height: 320, toolbar: { show: false }, animations: { enabled: false } },
    series: [
      { name: 'Windows', data: winSeries },
      { name: 'Linux',   data: lnxSeries }
    ],
    colors: ['#0078d4', '#f7931e'],
    plotOptions: { bar: { columnWidth: '60%', borderRadius: 4 } },
    dataLabels: { enabled: true, formatter: v => v + 'h', style: { fontSize: '11px', colors: ['#1a2332'] }, offsetY: -18 },
    xaxis: { categories: TEAMS },
    yaxis: { title: { text: 'Median hours to resolve' } },
    annotations: {
      yaxis: [{
        y: SLA_HOURS,
        borderColor: '#f59e0b',
        strokeDashArray: 6,
        label: { text: `SLA ${SLA_HOURS}h`, style: { background: '#f59e0b', color: '#fff' } }
      }]
    },
    grid: { borderColor: '#e5e9f0' },
    legend: { position: 'top', horizontalAlign: 'right' }
  });
}

// ============================================================
// HISTOGRAM: resolution time distribution
// ============================================================
function renderHistogram() {
  const { start, end } = getWindow();
  const resolved = INCIDENTS.filter(i =>
    i.status === 'resolved' &&
    i.first_seen_noncompliant >= start &&
    i.first_seen_noncompliant <= end
  );
  const buckets = [
    { label: '0–4h',     min: -1,  max: 4   },
    { label: '4–12h',    min: 4,   max: 12  },
    { label: '12–24h',   min: 12,  max: 24  },
    { label: '1–3 days', min: 24,  max: 72  },
    { label: '3–7 days', min: 72,  max: 168 },
    { label: '7–14 days',min: 168, max: 336 },
    { label: '14+ days', min: 336, max: 99999 }
  ];
  const counts = buckets.map(() => 0);
  resolved.forEach(i => {
    const h = i.consecutive_hours_noncompliant;
    const idx = buckets.findIndex(b => h > b.min && h <= b.max);
    if (idx >= 0) counts[idx]++;
  });

  mountOrUpdate('hist', '#histChart', {
    chart: { type: 'bar', height: 320, toolbar: { show: false }, animations: { enabled: false } },
    series: [{ name: 'Incidents', data: counts }],
    // 0–12h grace = green, 12h–3d (in SLA but ticketed) = amber, >3d (breach) = red
    colors: ['#10b981', '#10b981', '#f59e0b', '#f59e0b', '#ef4444', '#ef4444', '#ef4444'],
    plotOptions: { bar: { columnWidth: '55%', borderRadius: 4, distributed: true } },
    xaxis: { categories: buckets.map(b => b.label) },
    yaxis: { title: { text: 'Number of incidents' } },
    dataLabels: { enabled: true, style: { colors: ['#fff'], fontWeight: 700 } },
    legend: { show: false },
    grid: { borderColor: '#e5e9f0' },
    tooltip: {
      y: { formatter: (v, { dataPointIndex }) => `${v} incidents (${buckets[dataPointIndex].label})` }
    }
  });
}

// ============================================================
// WEEKLY MTTR TREND (last 12 weeks, independent of window)
// ============================================================
function renderTrend() {
  const weeks = 12;
  const med = [], p90 = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const wStart = new Date(NOW);
    wStart.setDate(wStart.getDate() - w * 7 - 6);
    wStart.setHours(0, 0, 0, 0);
    const wEnd = new Date(wStart);
    wEnd.setDate(wEnd.getDate() + 7);
    const inWeek = INCIDENTS.filter(i =>
      i.status === 'resolved' &&
      i.first_seen_noncompliant >= wStart &&
      i.first_seen_noncompliant < wEnd
    ).map(i => i.consecutive_hours_noncompliant);
    med.push({ x: wStart.getTime(), y: Number(median(inWeek).toFixed(1)) });
    p90.push({ x: wStart.getTime(), y: Number(percentile(inWeek, 90).toFixed(1)) });
  }

  mountOrUpdate('trend', '#trendChart', {
    chart: { type: 'line', height: 320, toolbar: { show: false }, animations: { enabled: false }, zoom: { enabled: false } },
    series: [
      { name: 'Median', data: med },
      { name: 'P90',    data: p90 }
    ],
    colors: ['#2563eb', '#ef4444'],
    stroke: { width: 3, curve: 'smooth' },
    markers: { size: 4 },
    xaxis: { type: 'datetime', labels: { datetimeFormatter: { day: 'MMM dd' } } },
    yaxis: { title: { text: 'Hours' } },
    annotations: {
      yaxis: [{ y: SLA_HOURS, borderColor: '#f59e0b', strokeDashArray: 6,
        label: { text: 'SLA 72h', style: { background: '#f59e0b', color: '#fff' } } }]
    },
    grid: { borderColor: '#e5e9f0' },
    legend: { position: 'top', horizontalAlign: 'right' }
  });
}

// ============================================================
// SLA TREND (within window, weekly)
// ============================================================
function renderSLA() {
  const { start, end } = getWindow();
  const points = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const wEnd = new Date(cursor);
    wEnd.setDate(wEnd.getDate() + 7);
    const slice = INCIDENTS.filter(i =>
      i.status === 'resolved' &&
      i.first_seen_noncompliant >= cursor &&
      i.first_seen_noncompliant < wEnd
    );
    const pass = slice.filter(i => i.consecutive_hours_noncompliant <= SLA_HOURS).length;
    const pct = slice.length ? pass / slice.length * 100 : null;
    points.push({ x: cursor.getTime(), y: pct === null ? null : Number(pct.toFixed(1)) });
    cursor = wEnd;
  }

  mountOrUpdate('sla', '#slaChart', {
    chart: { type: 'area', height: 320, toolbar: { show: false }, animations: { enabled: false }, zoom: { enabled: false } },
    series: [{ name: 'SLA compliance %', data: points }],
    colors: ['#10b981'],
    stroke: { width: 3, curve: 'smooth' },
    fill: { type: 'gradient', gradient: { opacityFrom: 0.4, opacityTo: 0.05 } },
    markers: { size: 5 },
    xaxis: { type: 'datetime', min: start.getTime(), max: end.getTime() },
    yaxis: { min: 0, max: 100, title: { text: '% within 72h' }, labels: { formatter: v => v.toFixed(0) + '%' } },
    grid: { borderColor: '#e5e9f0' }
  });
}

// ============================================================
// AGING: currently ongoing (live, global)
// ============================================================
function renderAging() {
  const ongoing = INCIDENTS
    .filter(i => i.status === 'on-going')
    .sort((a, b) => b.consecutive_hours_noncompliant - a.consecutive_hours_noncompliant)
    .slice(0, 15);

  mountOrUpdate('aging', '#agingChart', {
    chart: { type: 'bar', height: 380, toolbar: { show: false }, animations: { enabled: false } },
    series: [{ name: 'Hours non-compliant', data: ongoing.map(i => i.consecutive_hours_noncompliant) }],
    plotOptions: { bar: { horizontal: true, borderRadius: 4, distributed: true } },
    colors: ongoing.map(i => i.consecutive_hours_noncompliant > SLA_HOURS ? '#ef4444' : '#f59e0b'),
    xaxis: {
      categories: ongoing.map(i => i.server_name),
      title: { text: 'Hours since first_seen' }
    },
    legend: { show: false },
    dataLabels: { enabled: true, formatter: v => v + 'h', textAnchor: 'start', offsetX: 4, style: { colors: ['#fff'], fontWeight: 600 } },
    annotations: {
      xaxis: [{ x: SLA_HOURS, borderColor: '#5a6878', strokeDashArray: 4,
        label: { text: 'SLA 72h', style: { background: '#5a6878', color: '#fff' }, orientation: 'horizontal' } }]
    },
    tooltip: {
      custom: ({ dataPointIndex }) => {
        const i = ongoing[dataPointIndex];
        return `<div style="padding:8px 10px;font-size:12px;line-height:1.5">
          <div style="font-weight:600">${i.server_name}</div>
          <div>Team: <b>${i.team}</b> (${i.os})</div>
          <div>First seen: ${i.first_seen_noncompliant.toLocaleString()}</div>
          <div>Hours non-compliant: <b>${i.consecutive_hours_noncompliant}h</b></div>
          <div>Ticket: ${i.ticket_created}</div>
        </div>`;
      }
    },
    grid: { borderColor: '#e5e9f0' }
  });
}

// ============================================================
// REPEAT OFFENDERS (all time, global)
// ============================================================
function renderRepeat() {
  const counts = {};
  INCIDENTS.forEach(i => {
    counts[i.server_name] = (counts[i.server_name] || 0) + 1;
  });
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const meta = top.map(([name]) => SERVER_LOOKUP[name] || { team: '?', os: '?' });

  mountOrUpdate('repeat', '#repeatChart', {
    chart: { type: 'bar', height: 380, toolbar: { show: false }, animations: { enabled: false } },
    series: [{ name: 'Episodes', data: top.map(t => t[1]) }],
    plotOptions: { bar: { horizontal: true, borderRadius: 4, distributed: true } },
    colors: ['#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe'],
    xaxis: { categories: top.map(t => t[0]), title: { text: 'Number of non-compliance episodes' } },
    legend: { show: false },
    dataLabels: { enabled: true, textAnchor: 'start', offsetX: 4, style: { colors: ['#fff'], fontWeight: 600 } },
    tooltip: {
      custom: ({ dataPointIndex }) => {
        const m = meta[dataPointIndex];
        return `<div style="padding:8px 10px;font-size:12px;line-height:1.5">
          <div style="font-weight:600">${top[dataPointIndex][0]}</div>
          <div>Team: <b>${m.team}</b> (${m.os})</div>
          <div>Episodes: <b>${top[dataPointIndex][1]}</b></div>
        </div>`;
      }
    },
    grid: { borderColor: '#e5e9f0' }
  });
}

// ============================================================
// RENDER ALL
// ============================================================
function renderAll() {
  const { start, end } = getWindow();
  $('#dateLabel').text(`${fmtDate(start)} → ${fmtDate(end)}`);

  const todayEnd = new Date(NOW);
  todayEnd.setHours(23, 59, 59, 999);

  $('#nextWindow').prop('disabled', windowEnd >= todayEnd);
  $('#prevWindow').prop('disabled', start <= EARLIEST_DATE);

  renderKPIs();
  renderScatter();
  renderMTTRTeam();
  renderHistogram();
  renderTrend();
  renderSLA();
  renderAging();
  renderRepeat();
}

// ============================================================
// EVENTS
// ============================================================
$('#prevWindow').on('click', () => {
  const candidate = new Date(windowEnd);
  candidate.setDate(candidate.getDate() - 30);
  // don't let the window's start go before the earliest data point
  const candidateStart = new Date(candidate);
  candidateStart.setDate(candidateStart.getDate() - 29);
  if (candidateStart < EARLIEST_DATE) {
    candidate.setTime(EARLIEST_DATE.getTime() + 29 * 86400000);
  }
  windowEnd = candidate;
  scatterYMaxOverride = null;  // reset zoom on window change
  renderAll();
});
$('#nextWindow').on('click', () => {
  const todayEnd = new Date(NOW);
  todayEnd.setHours(23, 59, 59, 999);
  const candidate = new Date(windowEnd);
  candidate.setDate(candidate.getDate() + 30);
  if (candidate > todayEnd) candidate.setTime(todayEnd.getTime());
  windowEnd = candidate;
  scatterYMaxOverride = null;
  renderAll();
});
$('#resetWindow').on('click', () => {
  windowEnd = new Date(NOW);
  windowEnd.setHours(23, 59, 59, 999);
  scatterYMaxOverride = null;
  renderAll();
});

$('#scatterZoomIn').on('click',  () => zoomScatter(1 / SCATTER_ZOOM_FACTOR));
$('#scatterZoomOut').on('click', () => zoomScatter(SCATTER_ZOOM_FACTOR));

// initial render
$(renderAll);
