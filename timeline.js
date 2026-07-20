/* timeline.js — Hierarchy Gantt for timeline.html
 *
 * Scope resolution (in priority order):
 *   1. Query string:      timeline.html?project=NAME&taskId=123
 *   2. sessionStorage:    key 'timeline' = JSON {"project": NAME, "taskId": 123|null}
 *   3. Default:           whole DEFAULT_PROJECT
 *
 * Data rules (agreed after the memory-vs-JSON comparison):
 *   - Trust ONLY leaf startDate / endDate from the server JSON.
 *   - Parent (rollup) dates are DERIVED here: min(start) / max(end) of
 *     descendant leaves. The stored parent dates are often stale because
 *     design.js only re-syncs a parent when it is open in the detail pane.
 *   - _workingDays is never read. Working days are counted here from the
 *     dates (Mon-Fri inclusive), same convention as design.js calcDuration.
 */
$(document).ready(function () {

    var DEFAULT_PROJECT = 'INTL_to_ITServices_Execution';
    var NAME_COL_PX = 340;      // width of the task-name column
    var RIGHT_GUTTER_PX = 118;  // room for day-count labels past the last bar
    var MONTH_PX = 56;          // min horizontal pixels per month

    // ---------- scope resolution ----------
    function resolveScope() {
        var params = new URLSearchParams(window.location.search);
        var project = params.get('project');
        var taskId = params.get('taskId');
        if (project || taskId) {
            return { project: project || DEFAULT_PROJECT, taskId: taskId || null, source: 'query' };
        }
        try {
            var raw = sessionStorage.getItem('timeline');
            if (raw) {
                var obj = JSON.parse(raw);
                if (obj && (obj.project || obj.taskId)) {
                    return {
                        project: obj.project || DEFAULT_PROJECT,
                        taskId: (obj.taskId === undefined || obj.taskId === null) ? null : obj.taskId,
                        source: 'session'
                    };
                }
            }
        } catch (e) { /* malformed sessionStorage value — fall through */ }
        return { project: DEFAULT_PROJECT, taskId: null, source: 'default' };
    }

    // Display copy of a project name: underscores read as spaces. The raw
    // name (with underscores) is still used for API calls and links.
    function displayName(name) {
        return String(name).replace(/_/g, ' ');
    }

    // ---------- date helpers ----------
    function parseIso(iso) {
        if (!iso) return null;
        var d = new Date(iso + 'T00:00:00');
        return isNaN(d.getTime()) ? null : d;
    }
    function fmt(d) {
        return String(d.getMonth() + 1).padStart(2, '0') + '/' +
               String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
    }
    function fmtShort(d) {
        return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
    }
    // Mon-Fri inclusive — mirrors calcDuration in design.js
    function workingDays(s, e) {
        if (!s || !e || e < s) return 0;
        var count = 0, cur = new Date(s);
        while (cur <= e) {
            var day = cur.getDay();
            if (day !== 0 && day !== 6) count++;
            cur.setDate(cur.getDate() + 1);
        }
        return count;
    }
    function nextDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
    function prevDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
    }

    // ---------- tree helpers ----------
    // id -> task and id -> parent task, over the WHOLE project (predecessors
    // can live outside the scoped subtree). Rebuilt on every load.
    var taskIndex = {};
    var parentIndex = {};
    function indexTasks(tasks, parent) {
        for (var i = 0; i < tasks.length; i++) {
            taskIndex[String(tasks[i].id)] = tasks[i];
            parentIndex[String(tasks[i].id)] = parent || null;
            indexTasks(tasks[i].subtasks || [], tasks[i]);
        }
    }

    // Compact path for tooltips: "TopParent > … > leaf". Middle ancestors
    // are elided and long names clamped so a deep chain of verbose task
    // names can't turn the tooltip into a wall of wrapped text — the full
    // path is always visible in the expanded row tree itself.
    var PATH_NAME_MAX = 44;
    function clampName(name) {
        name = String(name);
        return name.length > PATH_NAME_MAX ? name.slice(0, PATH_NAME_MAX - 1) + '…' : name;
    }
    function taskPath(t) {
        var names = [t.name], p = parentIndex[String(t.id)];
        while (p) { names.unshift(p.name); p = parentIndex[String(p.id)]; }
        var leaf = clampName(names[names.length - 1]);
        if (names.length === 1) return leaf;
        var top = clampName(names[0]);
        return names.length === 2 ? top + ' > ' + leaf : top + ' > … > ' + leaf;
    }

    // Resolve a leaf's predecessor ids to display name + (derived) end date
    function resolvePreds(t) {
        var out = [];
        var ids = t.predecessor || [];
        for (var i = 0; i < ids.length; i++) {
            var p = taskIndex[String(ids[i])];
            if (!p) { out.push({ name: 'deleted task (id ' + ids[i] + ')', end: null }); continue; }
            var pe = (p.subtasks && p.subtasks.length)
                ? (p._derived ? p._derived.e : deriveDates(p).e)
                : parseIso(p.endDate);
            out.push({ name: taskPath(p), end: pe });
        }
        return out;
    }

    function findTask(tasks, id) {
        for (var i = 0; i < tasks.length; i++) {
            if (String(tasks[i].id) === String(id)) return tasks[i];
            var hit = findTask(tasks[i].subtasks || [], id);
            if (hit) return hit;
        }
        return null;
    }

    // Derive rollup dates: leaves use their own stored dates; parents get
    // min/max of their descendant leaves (stored parent dates are ignored).
    function deriveDates(task) {
        var subs = task.subtasks || [];
        if (subs.length === 0) {
            return { s: parseIso(task.startDate), e: parseIso(task.endDate) };
        }
        var s = null, e = null;
        for (var i = 0; i < subs.length; i++) {
            var d = deriveDates(subs[i]);
            if (d.s && (!s || d.s < s)) s = d.s;
            if (d.e && (!e || d.e > e)) e = d.e;
        }
        task._derived = { s: s, e: e };
        return task._derived;
    }

    // Earliest leaf start across the whole project = "day 1", the day every
    // task owner could in principle have started. Set on load.
    var projectStart = null;
    function earliestLeafStart(tasks) {
        var min = null;
        (function walk(list) {
            for (var i = 0; i < list.length; i++) {
                var subs = list[i].subtasks || [];
                if (subs.length) { walk(subs); continue; }
                var s = parseIso(list[i].startDate);
                if (s && (!min || s < min)) min = s;
            }
        })(tasks);
        return min;
    }

    // Pre-bar gaps for a leaf with predecessors. Two kinds:
    //   waiting — project day 1 up to the latest predecessor's end (derived
    //             end if the predecessor is a parent): blocked, predecessor
    //             chain still running.
    //   idle    — predecessor finished but the task hasn't started: dead
    //             time / slack. Only reported when it contains >= 1 working
    //             day, so a plain weekend in between doesn't get marked.
    function computeWait(preds, start) {
        if (!start) return null;
        // No predecessor: the whole span from project day 1 to the start is
        // unexplained slack. Reported separately (slack, rendered fainter)
        // so it reads as "starts late by plan", not "unblocked and idle".
        if (!preds || !preds.length) {
            if (!projectStart || projectStart >= start) return null;
            var sTo = prevDay(start);
            var sWd = workingDays(projectStart, sTo);
            return sWd > 0 ? { slack: { from: projectStart, to: sTo, days: sWd } } : null;
        }
        var latest = null;
        for (var i = 0; i < preds.length; i++) {
            if (preds[i].end && (!latest || preds[i].end > latest)) latest = preds[i].end;
        }
        if (!latest || !projectStart || projectStart >= start) return null;

        var waiting = null, idle = null;
        var wEnd = latest < start ? latest : prevDay(start);
        if (projectStart <= wEnd) {
            var wd1 = workingDays(projectStart, wEnd);
            if (wd1 > 0) waiting = { from: projectStart, to: wEnd, days: wd1 };
        }
        if (latest < start) {
            var iFrom = nextDay(latest), iTo = prevDay(start);
            var wd2 = workingDays(iFrom, iTo);
            if (wd2 > 0) idle = { from: iFrom, to: iTo, days: wd2 };
        }
        return (waiting || idle) ? { waiting: waiting, idle: idle } : null;
    }

    // Flatten the tree into render rows (depth-first, source order)
    function buildRows(tasks, depth, ancestors, out) {
        for (var i = 0; i < tasks.length; i++) {
            var t = tasks[i];
            var subs = t.subtasks || [];
            var isParent = subs.length > 0;
            var d = isParent ? (t._derived || deriveDates(t)) : { s: parseIso(t.startDate), e: parseIso(t.endDate) };
            var preds = (!isParent && t.predecessor && t.predecessor.length) ? resolvePreds(t) : null;
            out.push({
                task: t,
                depth: depth,
                isParent: isParent,
                childCount: subs.length,
                s: d.s,
                e: d.e,
                preds: preds,
                wait: isParent ? null : computeWait(preds, d.s),
                ancestors: ancestors
            });
            if (isParent) {
                buildRows(subs, depth + 1, ancestors.concat([String(t.id)]), out);
            }
        }
        return out;
    }

    // ---------- rendering ----------
    var $chart = $('#tl-chart');

    function render(rows, scopeName, projectName) {
        document.title = scopeName + ' · Timeline';
        $('#tl-project-name').text(displayName(projectName));
        $('#tl-scope-name').text(scopeName);

        // Time domain from the rows themselves
        var min = null, max = null;
        rows.forEach(function (r) {
            if (r.s && (!min || r.s < min)) min = r.s;
            if (r.e && (!max || r.e > max)) max = r.e;
            // wait tails can reach back before the first bar in a scoped
            // view — widen the axis so they stay visible
            if (r.wait && r.wait.waiting && (!min || r.wait.waiting.from < min)) min = r.wait.waiting.from;
        });
        if (!min || !max) {
            $chart.html('<p style="padding:30px 0;color:var(--muted)">No dated tasks to plot.</p>').prop('hidden', false);
            return;
        }

        // Domain: first of min's month -> first of the month AFTER max
        var x0 = new Date(min.getFullYear(), min.getMonth(), 1);
        var x1 = new Date(max.getFullYear(), max.getMonth() + 1, 1);
        var span = x1 - x0;
        var pct = function (d) { return (d - x0) / span * 100; };
        var endPct = function (d) { return pct(nextDay(d)); };  // bars include the end day

        var months = (x1.getFullYear() - x0.getFullYear()) * 12 + (x1.getMonth() - x0.getMonth());
        var multiYear = x0.getFullYear() !== new Date(x1 - 1).getFullYear();
        var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        $chart.css('min-width', (NAME_COL_PX + months * MONTH_PX + RIGHT_GUTTER_PX) + 'px');

        // Month grid
        var h = '<div class="tl-grid-layer" style="left:' + NAME_COL_PX + 'px;right:' + RIGHT_GUTTER_PX + 'px">';
        for (var m = 0; m <= months; m++) {
            var mDate = new Date(x0.getFullYear(), x0.getMonth() + m, 1);
            var x = pct(mDate);
            var glineCls = (multiYear && mDate.getMonth() === 0) ? 'tl-gline tl-gline-year' : 'tl-gline';
            h += '<div class="' + glineCls + '" style="left:' + x + '%"></div>';
            if (m < months) {
                var mNext = new Date(x0.getFullYear(), x0.getMonth() + m + 1, 1);
                var mid = (pct(mDate) + pct(mNext)) / 2;
                var label = MONTH_NAMES[mDate.getMonth()];
                var glabelCls = 'tl-glabel';
                if (multiYear && (m === 0 || mDate.getMonth() === 0)) {
                    label += ' ’' + String(mDate.getFullYear()).slice(-2);
                    glabelCls += ' tl-glabel-year';
                }
                h += '<div class="' + glabelCls + '" style="left:' + mid + '%">' + label + '</div>';
            }
        }
        h += '</div>';

        // Today marker
        var today = new Date(); today.setHours(0, 0, 0, 0);
        if (today >= x0 && today <= x1) {
            var tx = pct(today);
            h += '<div class="tl-today-layer" style="left:' + NAME_COL_PX + 'px;right:' + RIGHT_GUTTER_PX + 'px">' +
                 '<div class="tl-todayline" style="left:' + tx + '%"></div>' +
                 '<div class="tl-todaytag" style="left:' + tx + '%">today ' + fmtShort(today) + '</div>' +
                 '</div>';
        }

        // Rows
        h += '<div class="tl-rows">';
        rows.forEach(function (r, idx) {
            var t = r.task;
            var indent = r.depth * 18;
            var days = workingDays(r.s, r.e);

            // one value per line (.t / .m are display:block in timeline.css)
            var tip = '<span class=\'t\'>' + esc(t.name) + '</span>';
            if (r.s && r.e) {
                tip += '<span class=\'m\'>' + fmt(r.s) + ' → ' + fmt(r.e) + '</span>' +
                       '<span class=\'m\'>' + days + ' wkng days</span>';
            } else {
                tip += '<span class=\'m\'>no dates set</span>';
            }
            if (r.isParent) {
                tip += '<span class=\'m\'>carries ' + r.childCount + ' subtask(s)</span>';
            } else {
                var sb = [];
                if (t.status) sb.push(esc(t.status));
                if (t.percentComplete !== undefined && t.percentComplete !== null && t.percentComplete !== '') {
                    sb.push(t.percentComplete + '% complete');
                }
                if (sb.length) tip += '<span class=\'m\'>' + sb.join(' · ') + '</span>';
                // predecessor / waiting / idle details are deliberately NOT
                // in the bar tooltip — the hatched tail bars carry their own
                // tooltips with that information
                if (t.assignedTo && t.assignedTo.length) {
                    tip += '<span class=\'m\'>assigned: ' + esc(t.assignedTo.join(', ')) + '</span>';
                }
            }

            // hide-row eye: top-level rows and 1st/2nd-level subtasks,
            // revealed on row hover
            var eye = r.depth <= 2
                ? '<span class="tl-hide" data-hide="' + escAttr(String(t.id)) + '" title="hide this row">' +
                  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></span>'
                : '';

            // focus magnifier: top-level rows only, and only in the
            // whole-project view — opens the task scoped in a new tab
            var focus = (currentScope.isWholeProject && r.depth === 0)
                ? '<a class="tl-focus" target="_blank" rel="noopener" href="' +
                  escAttr('timeline.html?project=' + encodeURIComponent(projectName) +
                          '&taskId=' + encodeURIComponent(String(t.id))) +
                  '" title="focus: open this task in a new tab">' +
                  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/></svg></a>'
                : '';

            h += '<div class="tl-row" data-id="' + esc(String(t.id)) + '" data-ancestors="' + r.ancestors.join(',') + '">';
            h += '<div class="tl-name" style="width:' + NAME_COL_PX + 'px;padding-left:' + indent + 'px">';
            // FONT TWEAK (revertible): tl-top = heavier top-level parents,
            // tl-leafnm = italic leaves. See matching block in timeline.css.
            if (r.isParent) {
                h += '<span class="tl-caret" data-toggle="' + esc(String(t.id)) + '">▾</span>' +
                     '<span class="tl-nm tl-parent' + (r.depth === 0 ? ' tl-top' : '') + '" data-toggle="' + esc(String(t.id)) + '" title="' + escAttr(t.name) + '">' + esc(t.name) + '</span>' +
                     '<span class="tl-kids">(' + r.childCount + ')</span>' + eye + focus;
            } else {
                // top-level tasks keep the heavy top-parent style even when
                // they have no children; italics is for nested leaves only
                h += '<span class="tl-caret"></span><span class="tl-nm ' +
                     (r.depth === 0 ? 'tl-top' : 'tl-leafnm') +
                     '" title="' + escAttr(t.name) + '">' + esc(t.name) + '</span>' + eye + focus;
            }
            h += '</div>';

            h += '<div class="tl-track">';
            if (r.s && r.e && r.e >= r.s) {
                var left = pct(r.s), width = endPct(r.e) - left;
                if (r.isParent) {
                    h += '<div class="tl-rollbar" style="left:' + left + '%;width:' + width + '%" tabindex="0" data-tip="' + escAttr(tip) + '"></div>';
                } else {
                    // tails get their own tooltip naming the predecessor(s),
                    // latest-ending first so the top line is the one the
                    // waiting period is actually gated on
                    var predLines = '';
                    if (r.preds) {
                        r.preds.slice().sort(function (a, b) {
                            if (!a.end) return b.end ? 1 : 0;
                            if (!b.end) return -1;
                            return b.end - a.end;
                        }).forEach(function (p) {
                            predLines += '<span class=\'m\'>· ' + esc(p.name) +
                                         (p.end ? ' — ends ' + fmt(p.end) : '') + '</span>';
                        });
                    }
                    if (r.wait && r.wait.waiting) {
                        var wl = Math.max(pct(r.wait.waiting.from), 0);
                        var wr = endPct(r.wait.waiting.to);
                        var wTip = '<span class=\'t\'>' + esc(t.name) + '</span>' +
                                   '<span class=\'m\'>— waiting on PREDECESSOR:</span>' +
                                   '<span class=\'m\'>' + fmt(r.wait.waiting.from) + ' → ' + fmt(r.wait.waiting.to) +
                                   ' · ' + r.wait.waiting.days + ' wkng days</span>' + predLines;
                        h += '<div class="tl-wait" style="left:' + wl + '%;width:' + (wr - wl) +
                             '%" tabindex="0" data-tip="' + escAttr(wTip) + '"></div>';
                    }
                    if (r.wait && r.wait.slack) {
                        var sl = Math.max(pct(r.wait.slack.from), 0);
                        var sr = endPct(r.wait.slack.to);
                        var sTip = '<span class=\'t\'>' + esc(t.name) + '</span>' +
                                   '<span class=\'m\'>— IDLE GAP (no predecessor, no activity before task):</span>' +
                                   '<span class=\'m\'>' + fmt(r.wait.slack.from) + ' → ' + fmt(r.wait.slack.to) +
                                   ' · ' + r.wait.slack.days + ' wkng days</span>';
                        h += '<div class="tl-slack" style="left:' + sl + '%;width:' + (sr - sl) +
                             '%" tabindex="0" data-tip="' + escAttr(sTip) + '"></div>';
                    }
                    if (r.wait && r.wait.idle) {
                        var il = Math.max(pct(r.wait.idle.from), 0);
                        var ir = endPct(r.wait.idle.to);
                        var iTip = '<span class=\'t\'>' + esc(t.name) + '</span>' +
                                   '<span class=\'m\'>— IDLE GAP (no activity before task):</span>' +
                                   '<span class=\'m\'>' + fmt(r.wait.idle.from) + ' → ' + fmt(r.wait.idle.to) +
                                   ' · ' + r.wait.idle.days + ' wkng days</span>' + predLines;
                        h += '<div class="tl-idle" style="left:' + il + '%;width:' + (ir - il) +
                             '%" tabindex="0" data-tip="' + escAttr(iTip) + '"></div>';
                    }
                    var pc = Number(t.percentComplete) || 0;
                    h += '<div class="tl-bar" style="left:' + left + '%;width:' + width + '%" tabindex="0" data-tip="' + escAttr(tip) + '">' +
                         (pc > 0 ? '<div class="tl-pct" style="width:' + Math.min(pc, 100) + '%"></div>' : '') +
                         '</div>';
                    h += '<div class="tl-days" style="left:' + endPct(r.e) + '%">' + days + 'd</div>';
                }
            } else {
                h += '<div class="tl-nodates" style="left:2px">no dates set</div>';
            }
            h += '</div></div>';
        });
        h += '</div>';

        $chart.html(h).prop('hidden', false);
        syncTopScroll();
    }

    // ---------- top scrollbar (mirror of the panel's bottom one) ----------
    var $panel = $('.tl-panel');
    var $topScroll = $('#tl-topscroll');

    function syncTopScroll() {
        var panel = $panel[0];
        $('#tl-topscroll-inner').css('width', panel.scrollWidth + 'px');
        var overflows = panel.scrollWidth > panel.clientWidth + 1;
        $topScroll.prop('hidden', !overflows);
        if (overflows) $topScroll[0].scrollLeft = panel.scrollLeft;
    }
    // mutual sync is loop-safe: assigning an unchanged scrollLeft is a no-op
    $topScroll.on('scroll', function () { $panel[0].scrollLeft = this.scrollLeft; });
    $panel.on('scroll', function () { $topScroll[0].scrollLeft = this.scrollLeft; });
    $(window).on('resize', syncTopScroll);

    // ---------- collapse / expand ----------
    var collapsed = {};      // taskId -> true
    var manualHidden = {};   // taskId -> true (eye-hidden rows; resets on reload)

    function collapseParents(list) {
        for (var i = 0; i < list.length; i++) {
            var subs = list[i].subtasks || [];
            if (subs.length) {
                collapsed[String(list[i].id)] = true;
                collapseParents(subs);
            }
        }
    }

    // Current scope, remembered so Expand All / Collapse All can rebuild
    // the collapsed map without reloading.
    var currentScope = { tasks: [], isWholeProject: true };

    function collapseAllForScope() {
        collapsed = {};
        if (currentScope.isWholeProject) {
            collapseParents(currentScope.tasks);
        } else {
            // scope root itself always stays open
            collapseParents((currentScope.tasks[0] && currentScope.tasks[0].subtasks) || []);
        }
    }

    // Initial state: whole-project view always starts fully collapsed (too
    // many rows to take in at once); a scoped view starts collapsed only
    // when the scope root has >= 10 first-level subtasks, otherwise it is
    // shown fully expanded.
    function setInitialCollapse(rootTasks, isWholeProject) {
        currentScope = { tasks: rootTasks, isWholeProject: isWholeProject };
        collapsed = {};
        manualHidden = {};
        var firstLevel = isWholeProject
            ? rootTasks
            : ((rootTasks[0] && rootTasks[0].subtasks) || []);
        if (isWholeProject || firstLevel.length >= 10) collapseAllForScope();
    }

    function applyCollapse() {
        $('.tl-row').each(function () {
            var id = String($(this).data('id'));
            var anc = ($(this).data('ancestors') + '').split(',').filter(Boolean);
            var hide = manualHidden[id] ||
                       anc.some(function (a) { return collapsed[a] || manualHidden[a]; });
            $(this).toggleClass('tl-hidden', hide);
        });
        $('.tl-caret[data-toggle]').each(function () {
            $(this).text(collapsed[$(this).data('toggle')] ? '▸' : '▾');
        });
        updateToggleAll();
        updateShowHidden();
    }

    // "Show N hidden" pill — visible only while eye-hidden rows exist
    function updateShowHidden() {
        var n = Object.keys(manualHidden).length;
        $('#tl-show-hidden')
            .text('Show ' + n + ' hidden')
            .prop('hidden', n === 0);
    }

    $('#tl-show-hidden').on('click', function () {
        manualHidden = {};
        applyCollapse();
    });

    $chart.on('click', '.tl-hide', function (e) {
        e.stopPropagation();
        manualHidden[String($(this).data('hide'))] = true;
        applyCollapse();
    });

    // focus magnifier: let the anchor open its new tab, but keep the click
    // from also toggling / selecting the row
    $chart.on('click', '.tl-focus', function (e) {
        e.stopPropagation();
    });

    // Label always reflects the chart's actual state: if anything is still
    // collapsed the button offers "Expand All", otherwise "Collapse All".
    function updateToggleAll() {
        var $btn = $('#tl-toggle-all');
        var $carets = $('.tl-caret[data-toggle]');
        if (!$carets.length) { $btn.prop('hidden', true); return; }
        var anyCollapsed = false;
        $carets.each(function () {
            if (collapsed[String($(this).data('toggle'))]) { anyCollapsed = true; return false; }
        });
        $btn.text(anyCollapsed ? 'Expand All' : 'Collapse All').prop('hidden', false);
    }

    $('#tl-toggle-all').on('click', function () {
        if ($(this).text() === 'Expand All') collapsed = {};
        else collapseAllForScope();
        applyCollapse();
    });

    $chart.on('click', '[data-toggle]', function () {
        var id = String($(this).data('toggle'));
        collapsed[id] = !collapsed[id];
        applyCollapse();
    });

    // ---------- tooltip ----------
    var $tip = $('#tl-tip');
    function showTip(el, x, y) {
        // tail bars (waiting / idle) get the grey variant so their tooltip
        // reads differently from the blue-bar one
        $tip.toggleClass('tl-tip-alt', $(el).is('.tl-wait, .tl-idle, .tl-slack'));
        $tip.html($(el).attr('data-tip')).prop('hidden', false);
        var w = $tip.outerWidth();
        $tip.css({
            left: Math.min(x + 14, $(window).width() - w - 12) + 'px',
            top: (y + 16) + 'px'
        });
    }
    $(document).on('mousemove', function (e) {
        var el = $(e.target).closest('[data-tip]')[0];
        if (el) showTip(el, e.clientX, e.clientY);
        else $tip.prop('hidden', true);
    });
    $(document).on('focusin', '[data-tip]', function () {
        var r = this.getBoundingClientRect();
        showTip(this, r.left, r.bottom);
    });
    $(document).on('focusout', '[data-tip]', function () {
        $tip.prop('hidden', true);
    });

    // ---------- escaping ----------
    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escAttr(s) {
        return esc(s).replace(/"/g, '&quot;');
    }

    // ---------- notices ----------
    function notice(msg) {
        $('#tl-notice').text(msg).prop('hidden', false);
    }

    // ---------- load & boot ----------
    function load() {
        var scope = resolveScope();
        $('#tl-loading').show();
        $('#tl-error').prop('hidden', true);
        $chart.prop('hidden', true);

        $.ajax({
            url: '/api/load-group',
            method: 'GET',
            data: { project: scope.project },
            dataType: 'json',
            timeout: 10000,
            success: function (resp) {
                $('#tl-loading').hide();
                if (!(resp && resp.ok && resp.data && resp.data._taskData)) {
                    showError('The project "' + scope.project + '" could not be loaded from the server.');
                    return;
                }
                var allTasks = resp.data._taskData.tasks || [];
                allTasks.forEach(function (t) { deriveDates(t); });
                taskIndex = {};
                indexTasks(allTasks);
                projectStart = earliestLeafStart(allTasks);

                var rootTasks = allTasks;
                var isWholeProject = true;
                var scopeName = displayName(scope.project);
                if (scope.taskId !== null && scope.taskId !== '') {
                    var hit = findTask(allTasks, scope.taskId);
                    if (hit) {
                        rootTasks = [hit];
                        isWholeProject = false;
                        scopeName = hit.name;
                        $('#tl-full-link')
                            .attr('href', 'timeline.html?project=' + encodeURIComponent(scope.project))
                            .prop('hidden', false);
                    } else {
                        notice('Task id "' + scope.taskId + '" was not found in "' + scope.project +
                               '" (it may have been deleted). Showing the full project instead.');
                    }
                }

                // Whole-project view: list top-level tasks alphabetically
                // (display copy only — subtask order inside each branch
                // stays as stored)
                if (isWholeProject) {
                    rootTasks = allTasks.slice().sort(function (a, b) {
                        return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
                    });
                }

                setInitialCollapse(rootTasks, isWholeProject);
                var rows = buildRows(rootTasks, 0, [], []);
                render(rows, scopeName, scope.project);
                applyCollapse();
            },
            error: function () {
                $('#tl-loading').hide();
                showError('The project "' + scope.project + '" could not be loaded. Check that the server is running.');
            }
        });
    }

    function showError(msg) {
        $('#tl-error-msg').text(msg);
        $('#tl-error').prop('hidden', false);
    }

    $('#tl-retry').on('click', load);

    load();
});
