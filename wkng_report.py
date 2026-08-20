#!/usr/bin/env python3
"""wkng_report.py -- audit what projectsummary.js is actually summing.

Pulls a project through the same endpoint projectsummary.js uses
(/api/load-group), replays its WKNG DAYS arithmetic line for line, and writes
two self-contained HTML reports:

    wkng_explorer.html   summary + top-level list + per-leaf breakdown
    wkng_totals.html     top-level contributions only

The point is to see every individual number that goes into the total, so a
WKNG DAYS edit can be traced from the UI through to the header figure.

Usage
    python wkng_report.py                              # localhost:5000
    python wkng_report.py --base-url https://prod.host
    python wkng_report.py --file GROUP/Some.json       # skip HTTP entirely
    python wkng_report.py --no-snapshot                # don't diff vs last run

Snapshots: each run stores every leaf's value in wkng_snapshot.json and
compares against the previous run, so the workflow is

    1. run it        2. edit WKNG DAYS in the app        3. run it again

and the report marks exactly which leaves moved and by how much.
"""

import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_PROJECT = 'INTL_to_ITServices_Execution'
DEFAULT_BASE = 'http://localhost:5000'
SNAPSHOT_NAME = 'wkng_snapshot.json'


# ------------------------------------------------------------------ loading

def fetch_project(base_url, project, timeout=30):
    """GET /api/load-group?project=... -- cache-busted, unlike the browser."""
    qs = urllib.parse.urlencode({'project': project, '_ts': int(time.time() * 1000)})
    url = base_url.rstrip('/') + '/api/load-group?' + qs
    req = urllib.request.Request(url, headers={
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    })
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read().decode('utf-8')
        headers = dict(res.headers.items())
    resp = json.loads(raw)
    if not resp.get('ok'):
        raise RuntimeError('endpoint returned ok=false: %s' % resp.get('error'))
    if not resp.get('data'):
        raise RuntimeError('no data for project %r -- check the name' % project)
    return resp, url, headers


def load_file(path):
    with open(path, encoding='utf-8') as fh:
        return {'ok': True, 'data': json.load(fh)}


# ------------------------------------ arithmetic, mirroring projectsummary.js

def parse_iso(value):
    if not value:
        return None
    try:
        return datetime.date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def to_num(value):
    """Number(x) semantics: unparseable -> 0, so `> 0` is false."""
    if value is None or value is True or value is False:
        return 0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def working_days_between(start, end):
    """Mon-Fri inclusive of both endpoints -- calcDuration in design.js."""
    if not start or not end or end < start:
        return 0
    count, cur = 0, start
    while cur <= end:
        if cur.weekday() < 5:
            count += 1
        cur += datetime.timedelta(days=1)
    return count


def derive_dates(task):
    """Leaf: own dates. Parent: min/max over descendant leaves."""
    subs = task.get('subtasks') or []
    if not subs:
        return parse_iso(task.get('startDate')), parse_iso(task.get('endDate'))
    start = end = None
    for sub in subs:
        s, e = derive_dates(sub)
        if s and (not start or s < start):
            start = s
        if e and (not end or e > end):
            end = e
    return start, end


def fmt_num(value):
    value = float(value)
    return int(value) if value.is_integer() else round(value, 2)


def fmt_date(d):
    return '%02d/%02d/%d' % (d.month, d.day, d.year) if d else '--'


def collect(task, trail, leaves, ignored):
    """Walk one task, appending leaf rows. Returns the subtree's WKNG DAYS.

    Parents contribute only the sum of their descendants -- their own
    _workingDays is never added (it spans the predecessor chain too), so any
    non-zero value found on a parent is recorded in `ignored` instead.
    """
    name = (task.get('name') or '').strip() or '(unnamed)'
    path = trail + [name]
    subs = task.get('subtasks') or []
    start, end = derive_dates(task)

    if subs:
        own = to_num(task.get('_workingDays'))
        if own > 0:
            ignored.append({
                'name': name,
                'path': ' > '.join(path),
                'value': fmt_num(own),
                'children': len(subs),
            })
        return sum(collect(sub, path, leaves, ignored) for sub in subs)

    raw = task.get('_workingDays')
    stored = to_num(raw)
    if stored > 0:
        days, source = stored, 'stored'
    else:
        days, source = working_days_between(start, end), 'derived'

    leaves.append({
        'id': task.get('id'),
        'name': name,
        'path': ' > '.join(path[1:]) or name,
        'depth': len(path) - 1,
        'days': fmt_num(days),
        'source': source,
        'raw': '' if raw is None else str(raw),
        'start': fmt_date(start),
        'end': fmt_date(end),
        'span': working_days_between(start, end),
    })
    return days


def build_model(payload, origin):
    data = payload['data']
    tasks = (data.get('_taskData') or {}).get('tasks') or []

    groups, ignored = [], []
    total = 0
    p_start = p_end = None

    for task in tasks:
        leaves = []
        subtotal = collect(task, [], leaves, ignored)
        s, e = derive_dates(task)
        if s and (not p_start or s < p_start):
            p_start = s
        if e and (not p_end or e > p_end):
            p_end = e
        total += subtotal
        groups.append({
            'name': (task.get('name') or '').strip() or '(unnamed)',
            'id': task.get('id'),
            'subtotal': fmt_num(subtotal),
            'leafCount': len(leaves),
            'childCount': len(task.get('subtasks') or []),
            'start': fmt_date(s),
            'end': fmt_date(e),
            'leaves': leaves,
        })

    return {
        'project': payload.get('_project'),
        'origin': origin,
        'filename': payload.get('filename', ''),
        'version': data.get('_version', 0),
        'generated': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'start': fmt_date(p_start),
        'end': fmt_date(p_end),
        'total': fmt_num(total),
        'leafTotal': sum(g['leafCount'] for g in groups),
        'topCount': len(groups),
        'groups': groups,
        'ignored': ignored,
    }


# ---------------------------------------------------------------- snapshots

def leaf_map(model):
    out = {}
    for group in model['groups']:
        for leaf in group['leaves']:
            key = str(leaf['id']) if leaf['id'] else group['name'] + '|' + leaf['path']
            out[key] = {'days': leaf['days'], 'path': group['name'] + ' > ' + leaf['path']}
    return out


def apply_snapshot(model, path):
    """Mark leaves whose value moved since the previous run."""
    model['diff'] = None
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding='utf-8') as fh:
            prev = json.load(fh)
    except (ValueError, OSError):
        return

    old = prev.get('leaves', {})
    changed, added, removed = [], [], []
    for group in model['groups']:
        for leaf in group['leaves']:
            key = str(leaf['id']) if leaf['id'] else group['name'] + '|' + leaf['path']
            if key not in old:
                leaf['delta'] = 'new'
                added.append(group['name'] + ' > ' + leaf['path'])
            elif old[key]['days'] != leaf['days']:
                leaf['delta'] = fmt_num(leaf['days'] - old[key]['days'])
                leaf['was'] = old[key]['days']
                changed.append({
                    'path': group['name'] + ' > ' + leaf['path'],
                    'was': old[key]['days'],
                    'now': leaf['days'],
                })
    current = leaf_map(model)
    for key, rec in old.items():
        if key not in current:
            removed.append(rec['path'])

    model['diff'] = {
        'at': prev.get('generated', '?'),
        'total': prev.get('total', model['total']),
        'version': prev.get('version'),
        'totalDelta': fmt_num(model['total'] - prev.get('total', model['total'])),
        'changed': changed,
        'added': added,
        'removed': removed,
    }


def write_snapshot(model, path):
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump({
            'generated': model['generated'],
            'project': model['project'],
            'total': model['total'],
            'version': model['version'],
            'leaves': leaf_map(model),
        }, fh, indent=1)


# --------------------------------------------------------------------- html

def embed(model):
    return json.dumps(model, ensure_ascii=False).replace('</', '<\\/')


CSS = """
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;
     color:#1a2233;background:#eef2f8}
.wrap{max-width:1500px;margin:0 auto;padding:22px}
.num{font-variant-numeric:tabular-nums;font-feature-settings:'tnum'}

header.hero{background:linear-gradient(120deg,#0b2f6b,#123f8f 55%,#1b4fae);
  color:#fff;border-radius:12px;padding:22px 26px;box-shadow:0 6px 22px rgba(11,47,107,.22)}
.hero .eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:#9fc0f0;margin-bottom:14px}
.hero h1{margin:0 0 18px;font-size:21px;font-weight:600;letter-spacing:.01em}
.stats{display:flex;flex-wrap:wrap;gap:34px}
.stat .k{font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#9fc0f0}
.stat .v{font-size:29px;font-weight:600;letter-spacing:.02em;line-height:1.25}
.meta{margin-top:18px;padding-top:13px;border-top:1px solid rgba(255,255,255,.16);
  font-size:11.5px;color:#b6cef2;display:flex;flex-wrap:wrap;gap:8px 20px}
.meta code{background:rgba(255,255,255,.1);padding:1px 6px;border-radius:4px;
  font-size:11px;color:#e3edfd}

.note{margin-top:16px;border-radius:10px;padding:13px 16px;font-size:13px;
  border:1px solid;background:#fff}
.note h3{margin:0 0 7px;font-size:12px;letter-spacing:.09em;text-transform:uppercase}
.note.warn{border-color:#f0c36a;background:#fffaef;color:#6b4a08}
.note.info{border-color:#a9c8ef;background:#f2f7fe;color:#1b3f76}
.note ul{margin:7px 0 0;padding-left:19px}
.note li{margin:3px 0}

.panes{display:grid;grid-template-columns:330px 1fr;gap:16px;margin-top:16px;
  align-items:start}
.card{background:#fff;border:1px solid #d7e0ee;border-radius:10px;
  box-shadow:0 1px 3px rgba(16,38,76,.05);overflow:hidden}
.card>h2{margin:0;padding:12px 16px;font-size:11px;letter-spacing:.13em;
  text-transform:uppercase;color:#5a6b86;border-bottom:1px solid #e6ecf5;
  background:#f7f9fd;display:flex;justify-content:space-between;align-items:center;gap:12px}
.card>h2 .sub{letter-spacing:0;text-transform:none;font-size:11.5px;color:#8494ad}

.tasklist{list-style:none;margin:0;padding:0;max-height:74vh;overflow:auto}
.tasklist li{border-bottom:1px solid #eef2f8}
.tasklist button{width:100%;border:0;background:none;text-align:left;cursor:pointer;
  padding:10px 16px;display:flex;justify-content:space-between;gap:10px;
  align-items:baseline;font:inherit;color:inherit;border-left:3px solid transparent}
.tasklist button:hover{background:#f4f8ff}
.tasklist button.on{background:#e8f1ff;border-left-color:#1b4fae;font-weight:600}
.tasklist .nm{overflow:hidden}
.tasklist .nm>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tasklist .ct{font-size:10.5px;color:#8494ad;font-weight:400}
.tasklist .dv{font-weight:600;color:#123f8f;white-space:nowrap}

table{width:100%;border-collapse:collapse}
th{font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:#5a6b86;
  text-align:left;padding:9px 14px;border-bottom:1px solid #e6ecf5;background:#f7f9fd;
  position:sticky;top:0;z-index:1}
td{padding:9px 14px;border-bottom:1px solid #f0f4fa;vertical-align:top}
th.r,td.r{text-align:right}
tbody tr:hover{background:#fafcff}
.leafname{font-weight:600}
.leafpath{font-size:11px;color:#8494ad;margin-top:2px}
.dates{font-size:11.5px;color:#5a6b86;white-space:nowrap}
.val{font-weight:700;font-size:15px;color:#123f8f}

.tag{display:inline-block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;
  padding:2px 7px;border-radius:20px;font-weight:600;white-space:nowrap}
.tag.stored{background:#e4f2e6;color:#256b33}
.tag.derived{background:#fdf0dd;color:#8a5a10}
.tag.up{background:#e4f2e6;color:#256b33}
.tag.down{background:#fde4e4;color:#96262d}
.tag.new{background:#e6ecfb;color:#2b3f9c}
tr.moved{background:#fffbe9}
tr.moved:hover{background:#fff7dc}
tfoot td{border-top:2px solid #123f8f;border-bottom:0;padding:13px 14px;
  font-weight:700;background:#f7f9fd}
tfoot .total{font-size:19px;color:#123f8f}
.empty{padding:34px;text-align:center;color:#8494ad}
.scroll{max-height:74vh;overflow:auto}
footer{margin:18px 0 6px;font-size:11.5px;color:#8494ad;text-align:center}
@media(max-width:900px){.panes{grid-template-columns:1fr}}
"""


def head(title):
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>' + title + '</title><style>' + CSS +
            '</style></head><body><div class="wrap">')


HERO = """
<header class="hero">
  <div class="eyebrow">WKNG DAYS audit &mdash; projectsummary.js</div>
  <h1 id="proj"></h1>
  <div class="stats">
    <div class="stat"><div class="k">Starts</div><div class="v num" id="s-start"></div></div>
    <div class="stat"><div class="k">Completion</div><div class="v num" id="s-end"></div></div>
    <div class="stat"><div class="k">Workdays</div><div class="v num" id="s-total"></div></div>
  </div>
  <div class="meta" id="meta"></div>
</header>
<div id="notes"></div>
"""

SHARED_JS = r"""
var D = window.__WKNG__;
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function signed(n) { return (n > 0 ? '+' : '') + comma(n); }

function paintHero() {
  document.getElementById('proj').textContent = D.project;
  document.getElementById('s-start').textContent = D.start;
  document.getElementById('s-end').textContent = D.end;
  document.getElementById('s-total').textContent = comma(D.total) + 'd';

  document.getElementById('meta').innerHTML = [
    '<span>Pulled <code>' + esc(D.origin) + '</code></span>',
    '<span>_version <code>' + esc(D.version) + '</code></span>',
    '<span>' + D.topCount + ' top-level &middot; ' + D.leafTotal + ' leaf rows counted</span>',
    '<span>Generated ' + esc(D.generated) + '</span>'
  ].join('');

  var notes = [];
  if (D.diff && (D.diff.changed.length || D.diff.added.length || D.diff.removed.length)) {
    var rows = D.diff.changed.map(function (c) {
      return '<li><strong>' + esc(c.path) + '</strong>: ' + comma(c.was) + ' &rarr; ' +
        comma(c.now) + ' <span class="tag ' + (c.now > c.was ? 'up' : 'down') + '">' +
        signed(c.now - c.was) + '</span></li>';
    });
    D.diff.added.forEach(function (p) {
      rows.push('<li><strong>' + esc(p) + '</strong> &mdash; new leaf</li>');
    });
    D.diff.removed.forEach(function (p) {
      rows.push('<li><strong>' + esc(p) + '</strong> &mdash; no longer a counted leaf</li>');
    });
    notes.push('<div class="note info"><h3>Changed since the previous run (' + esc(D.diff.at) +
      ')</h3><div>Total ' + comma(D.diff.total) + 'd &rarr; <strong>' + comma(D.total) +
      'd</strong> (' + signed(D.diff.totalDelta) + ')</div><ul>' + rows.join('') + '</ul></div>');
  } else if (D.diff) {
    notes.push('<div class="note info"><h3>No change since the previous run (' + esc(D.diff.at) +
      ')</h3><div>Every leaf holds the same value and the total is still ' +
      comma(D.total) + 'd. If you just edited a WKNG DAYS cell, the server never received it.</div></div>');
  }
  if (D.ignored.length) {
    notes.push('<div class="note warn"><h3>' + D.ignored.length + ' parent row' +
      (D.ignored.length > 1 ? 's carry' : ' carries') +
      ' a WKNG DAYS value that is NOT counted</h3><div>A row with children never contributes ' +
      'its own WORKING DAYS &mdash; only its leaves are summed. Editing WKNG DAYS on one of ' +
      'these will not move the total.</div><ul>' +
      D.ignored.map(function (p) {
        return '<li><strong>' + esc(p.path) + '</strong> = ' + comma(p.value) + ' (ignored; ' +
          p.children + ' child row' + (p.children > 1 ? 's' : '') + ')</li>';
      }).join('') + '</ul></div>');
  }
  document.getElementById('notes').innerHTML = notes.join('');
}
"""


def explorer_html(model):
    return (head('WKNG DAYS explorer') + HERO + """
<div class="panes">
  <section class="card">
    <h2>Top-level tasks <span class="sub" id="cnt"></span></h2>
    <ul class="tasklist" id="list"></ul>
  </section>
  <section class="card">
    <h2 id="dt">Select a task</h2>
    <div class="scroll" id="detail"></div>
  </section>
</div>
<footer>Replays projectsummary.js exactly: leaf rows only, <code>_workingDays</code> when &gt; 0, otherwise Mon&ndash;Fri recomputed from the row's dates.</footer>
</div>
<script>window.__WKNG__ = """ + embed(model) + r""";</script>
<script>
""" + SHARED_JS + r"""
paintHero();
document.getElementById('cnt').textContent = D.groups.length + ' tasks';

var list = document.getElementById('list');
D.groups.forEach(function (g, i) {
  var li = document.createElement('li');
  var b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = '<span class="nm"><span>' + esc(g.name) + '</span>' +
    '<span class="ct">' + g.leafCount + ' leaf row' + (g.leafCount === 1 ? '' : 's') +
    (g.childCount ? '' : ' &middot; no subtasks') + '</span></span>' +
    '<span class="dv num">' + comma(g.subtotal) + '</span>';
  b.onclick = function () { select(i); };
  li.appendChild(b);
  list.appendChild(li);
});

function select(i) {
  var g = D.groups[i];
  Array.prototype.forEach.call(list.querySelectorAll('button'), function (b, n) {
    b.className = n === i ? 'on' : '';
  });
  document.getElementById('dt').innerHTML =
    esc(g.name) + ' <span class="sub">' + esc(g.start) + ' &rarr; ' + esc(g.end) + '</span>';

  var box = document.getElementById('detail');
  if (!g.leaves.length) {
    box.innerHTML = '<div class="empty">No counted leaf rows.</div>';
    return;
  }

  var body = g.leaves.map(function (l) {
    var delta = '';
    if (l.delta === 'new') {
      delta = ' <span class="tag new">new</span>';
    } else if (l.delta !== undefined) {
      delta = ' <span class="tag ' + (l.delta > 0 ? 'up' : 'down') + '">' + signed(l.delta) +
        '</span> <span class="leafpath" style="display:inline">was ' + comma(l.was) + '</span>';
    }
    var nested = l.path !== l.name;
    return '<tr class="' + (l.delta !== undefined ? 'moved' : '') + '">' +
      '<td><div class="leafname">' + esc(l.name) + delta + '</div>' +
      (nested ? '<div class="leafpath">' + esc(l.path) + '</div>' : '') + '</td>' +
      '<td class="dates">' + esc(l.start) + '<br>' + esc(l.end) + '</td>' +
      '<td><span class="tag ' + l.source + '">' + l.source + '</span>' +
      (l.source === 'derived'
        ? '<div class="leafpath">_workingDays ' + (l.raw === '' ? 'unset' : esc(l.raw)) + '</div>'
        : '') + '</td>' +
      '<td class="r val num">' + comma(l.days) + '</td></tr>';
  }).join('');

  box.innerHTML = '<table><thead><tr><th>Leaf task</th><th>Start / end</th>' +
    '<th>Value from</th><th class="r">WKNG days</th></tr></thead><tbody>' + body +
    '</tbody><tfoot><tr><td colspan="3">Net total for ' + esc(g.name) + '</td>' +
    '<td class="r total num">' + comma(g.subtotal) + '</td></tr></tfoot></table>';
}

select(0);
</script></body></html>""")


def totals_html(model):
    return (head('Top-level contributions') + HERO + """
<section class="card" style="margin-top:16px">
  <h2>Top-level contributions <span class="sub" id="cnt"></span></h2>
  <table id="t"><thead><tr><th>Top-level task</th><th>Span</th>
    <th class="r">Leaf rows</th><th class="r">WKNG days</th><th class="r">Share</th>
  </tr></thead><tbody></tbody><tfoot></tfoot></table>
</section>
<footer>Each figure is the sum of that task's leaf rows. Parent rows never contribute their own WORKING DAYS.</footer>
</div>
<script>window.__WKNG__ = """ + embed(model) + r""";</script>
<script>
""" + SHARED_JS + r"""
paintHero();
document.getElementById('cnt').textContent = D.groups.length + ' tasks';

var sorted = D.groups.slice().sort(function (a, b) { return b.subtotal - a.subtotal; });
document.querySelector('#t tbody').innerHTML = sorted.map(function (g) {
  var pct = D.total ? (g.subtotal / D.total * 100) : 0;
  return '<tr><td><div class="leafname">' + esc(g.name) + '</div>' +
    (g.childCount ? '' : '<div class="leafpath">no subtasks &mdash; counts as its own leaf</div>') +
    '</td><td class="dates">' + esc(g.start) + ' &rarr; ' + esc(g.end) + '</td>' +
    '<td class="r num">' + g.leafCount + '</td>' +
    '<td class="r val num">' + comma(g.subtotal) + '</td>' +
    '<td class="r num" style="color:#8494ad">' + pct.toFixed(1) + '%</td></tr>';
}).join('');

document.querySelector('#t tfoot').innerHTML =
  '<tr><td>Total</td><td></td><td class="r num">' + D.leafTotal + '</td>' +
  '<td class="r total num">' + comma(D.total) + '</td><td class="r num">100.0%</td></tr>';
</script></body></html>""")


# --------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(
        description='Audit the WKNG DAYS total that projectsummary.js renders.')
    ap.add_argument('--base-url', default=DEFAULT_BASE,
                    help='server root (default %s)' % DEFAULT_BASE)
    ap.add_argument('--project', default=DEFAULT_PROJECT,
                    help='project name (default %s)' % DEFAULT_PROJECT)
    ap.add_argument('--file', help='read a GROUP/*.json directly instead of calling the endpoint')
    ap.add_argument('--out-dir', default='.', help='where to write the HTML (default .)')
    ap.add_argument('--no-snapshot', action='store_true',
                    help='skip the compare-with-last-run diff')
    args = ap.parse_args()

    headers = {}
    try:
        if args.file:
            payload = load_file(args.file)
            origin = os.path.abspath(args.file)
        else:
            payload, origin, headers = fetch_project(args.base_url, args.project)
    except urllib.error.HTTPError as exc:
        sys.exit('HTTP %s from %s -- is the server up and the project name right?'
                 % (exc.code, args.base_url))
    except urllib.error.URLError as exc:
        sys.exit('could not reach %s: %s' % (args.base_url, exc.reason))
    except (OSError, ValueError, RuntimeError) as exc:
        sys.exit('failed to load project: %s' % exc)

    payload['_project'] = args.project
    model = build_model(payload, origin)

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    snap_path = os.path.join(out_dir, SNAPSHOT_NAME)

    if args.no_snapshot:
        model['diff'] = None
    else:
        apply_snapshot(model, snap_path)

    explorer = os.path.join(out_dir, 'wkng_explorer.html')
    totals = os.path.join(out_dir, 'wkng_totals.html')
    with open(explorer, 'w', encoding='utf-8') as fh:
        fh.write(explorer_html(model))
    with open(totals, 'w', encoding='utf-8') as fh:
        fh.write(totals_html(model))
    if not args.no_snapshot:
        write_snapshot(model, snap_path)

    print('project    : %s' % model['project'])
    print('source     : %s' % model['origin'])
    print('_version   : %s' % model['version'])
    if headers.get('Cache-Control') or headers.get('ETag'):
        print('cache hdrs : Cache-Control=%s  ETag=%s'
              % (headers.get('Cache-Control', '(none)'), headers.get('ETag', '(none)')))
    print('start      : %s' % model['start'])
    print('completion : %s' % model['end'])
    print('workdays   : %sd  (%d leaf rows across %d top-level tasks)'
          % (format(int(model['total']), ','), model['leafTotal'], model['topCount']))
    if model['ignored']:
        print('warning    : %d parent row(s) carry an ignored WKNG DAYS value'
              % len(model['ignored']))
        for p in model['ignored']:
            print('             %s = %s' % (p['path'], p['value']))
    diff = model.get('diff')
    if diff and (diff['changed'] or diff['added'] or diff['removed']):
        print('changed    : total %s -> %s (%+g)'
              % (format(int(diff['total']), ','), format(int(model['total']), ','),
                 diff['totalDelta']))
        for c in diff['changed']:
            print('             %s: %g -> %g' % (c['path'], c['was'], c['now']))
        for p in diff['added']:
            print('             + %s (new leaf)' % p)
        for p in diff['removed']:
            print('             - %s (no longer counted)' % p)
    elif diff:
        print('changed    : nothing since %s (_version was %s)' % (diff['at'], diff['version']))
    print()
    print('wrote %s' % explorer)
    print('wrote %s' % totals)


if __name__ == '__main__':
    main()
