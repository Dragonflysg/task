/* projectsummary.js — project header numbers for index.html
 *
 * Self-contained (no jQuery, no build step). Loads one project through the
 * same endpoint timeline.js uses and reduces it to three values:
 *
 *     { start: Date, end: Date, workdays: Number }
 *
 * Everything is exposed on window.ProjectSummary so the pieces can be lifted
 * into another page one function at a time.
 *
 * Data rules — deliberately identical to timeline.js / design.js:
 *   - Only LEAF startDate / endDate are trusted. Parent dates in the JSON go
 *     stale because design.js only re-syncs a parent while it is open in the
 *     detail pane, so parent spans are re-derived here as min/max of their
 *     descendant leaves.
 *   - Workdays is the sum of the WKNG DAYS column, which only leaf rows carry
 *     (design.js renders that cell empty for any row with children). A top
 *     level task with no subtasks is itself a leaf, so it contributes its own
 *     WORKING DAYS — no special case needed. A parent's own WORKING DAYS is
 *     never added: it spans the predecessor chain too and would double count.
 *   - A leaf uses _workingDays when it is set and positive, otherwise the
 *     day count is recomputed from its dates (Mon-Fri inclusive), matching
 *     calcDuration in design.js.
 */
(function (window, document) {
    'use strict';

    var DEFAULT_PROJECT = 'INTL_to_ITServices_Execution';
    var LOAD_URL = '/api/load-group';

    // ---------------------------------------------------------------- dates

    function parseIso(iso) {
        if (!iso) return null;
        var d = new Date(iso + 'T00:00:00');
        return isNaN(d.getTime()) ? null : d;
    }

    function pad2(n) {
        return String(n).length < 2 ? '0' + n : String(n);
    }

    // MM/DD/YYYY — the format the timeline header uses
    function formatDate(d) {
        if (!d) return '';
        return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + '/' + d.getFullYear();
    }

    // Mon-Fri inclusive of both endpoints — mirrors calcDuration in design.js
    function workingDaysBetween(s, e) {
        if (!s || !e || e < s) return 0;
        var count = 0, cur = new Date(s.getTime());
        while (cur <= e) {
            var day = cur.getDay();          // 0 = Sun, 6 = Sat
            if (day !== 0 && day !== 6) count++;
            cur.setDate(cur.getDate() + 1);
        }
        return count;
    }

    // -------------------------------------------------------------- rollups

    // Span of one task: a leaf is its own dates, a parent is min/max over its
    // descendant leaves. Stored parent dates are ignored.
    function deriveDates(task) {
        var subs = task.subtasks || [];
        if (!subs.length) {
            return { s: parseIso(task.startDate), e: parseIso(task.endDate) };
        }
        var s = null, e = null;
        for (var i = 0; i < subs.length; i++) {
            var d = deriveDates(subs[i]);
            if (d.s && (!s || d.s < s)) s = d.s;
            if (d.e && (!e || d.e > e)) e = d.e;
        }
        return { s: s, e: e };
    }

    // WKNG DAYS for one task: leaves report their own, parents report the sum
    // of their descendants (never their own WORKING DAYS — see header note).
    function leafWorkingDays(task) {
        var subs = task.subtasks || [];
        if (subs.length) {
            var sum = 0;
            for (var i = 0; i < subs.length; i++) sum += leafWorkingDays(subs[i]);
            return sum;
        }
        var stored = Number(task._workingDays);
        if (stored > 0) return stored;
        return workingDaysBetween(parseIso(task.startDate), parseIso(task.endDate));
    }

    // Reduce a whole project's task array to the three header numbers.
    function computeProjectSummary(tasks) {
        tasks = tasks || [];
        var start = null, end = null, workdays = 0;
        for (var i = 0; i < tasks.length; i++) {
            var d = deriveDates(tasks[i]);
            if (d.s && (!start || d.s < start)) start = d.s;
            if (d.e && (!end || d.e > end)) end = d.e;
            workdays += leafWorkingDays(tasks[i]);
        }
        return { start: start, end: end, workdays: workdays };
    }

    // ----------------------------------------------------------------- load

    // fetchProjectSummary('Name', function (summary) {...}, function (err) {...})
    function fetchProjectSummary(projectName, onDone, onError) {
        var name = projectName || DEFAULT_PROJECT;
        var url = LOAD_URL + '?project=' + encodeURIComponent(name);

        function fail(err) {
            if (onError) onError(err instanceof Error ? err : new Error(String(err)));
        }

        window.fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status + ' loading "' + name + '"');
                return res.json();
            })
            .then(function (resp) {
                if (!(resp && resp.ok && resp.data && resp.data._taskData)) {
                    throw new Error('No task data returned for "' + name + '"');
                }
                onDone(computeProjectSummary(resp.data._taskData.tasks || []), name);
            })
            .catch(fail);
    }

    // ------------------------------------------------------------ animation

    function prefersReducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function easeOut(p) {
        return 1 - Math.pow(1 - p, 3);
    }

    // Run fn once the page is actually on screen. requestAnimationFrame is
    // throttled to a crawl in a background tab, so a roll started there would
    // sit frozen on a half-spun value until the user came back to it.
    function whenVisible(fn) {
        if (document.visibilityState !== 'hidden') { fn(); return; }
        document.addEventListener('visibilitychange', function once() {
            if (document.visibilityState === 'hidden') return;
            document.removeEventListener('visibilitychange', once);
            fn();
        });
    }

    /* One slot-machine reel.
     *
     * The reel walks `ticks` steps through `values` and is started at whatever
     * index makes step `ticks` land exactly on `finalValue`, so the landing is
     * never faked or corrected at the end. Steps are spread with an ease-out
     * curve, which is what produces the mechanical slow-down into the stop.
     *
     * opts: { duration, ticks, delay, done }
     */
    function spinReel(el, values, finalValue, opts) {
        opts = opts || {};
        var done = opts.done || function () {};
        var len = values.length;
        var finalIdx = values.indexOf(finalValue);

        if (!el) { done(); return; }
        if (finalIdx < 0 || prefersReducedMotion()) {   // nothing to spin to
            el.textContent = finalValue;
            done();
            return;
        }

        var ticks = opts.ticks || len * 3;
        var duration = opts.duration || 1600;
        var delay = opts.delay || 0;
        var startIdx = ((finalIdx - ticks) % len + len) % len;
        var t0 = null;
        var finished = false;

        el.classList.add('is-spinning');

        function finish() {
            if (finished) return;
            finished = true;
            el.textContent = finalValue;
            el.classList.remove('is-spinning');
            el.classList.add('is-settled');
            done();
        }

        function frame(now) {
            if (finished) return;
            if (t0 === null) t0 = now;
            var t = now - t0 - delay;
            if (t < 0) { window.requestAnimationFrame(frame); return; }

            var p = Math.min(t / duration, 1);
            if (p >= 1) { finish(); return; }

            var step = Math.floor(easeOut(p) * ticks);
            el.textContent = values[(startIdx + step) % len];
            window.requestAnimationFrame(frame);
        }
        window.requestAnimationFrame(frame);

        // Safety net: if the rAF loop is starved (tab hidden mid-roll, heavy
        // page), settle on the real value anyway. A stalled reel must never be
        // left showing a number that isn't the answer.
        window.setTimeout(finish, delay + duration + 400);
    }

    /* Drop a date onto three reels with no animation — used for STARTS, which
     * shows its value the moment the data lands. Same cells as rollDate so the
     * two dates stay aligned. */
    function setDate(els, date) {
        if (!date) return;
        if (els.month) els.month.textContent = pad2(date.getMonth() + 1);
        if (els.day) els.day.textContent = pad2(date.getDate());
        if (els.year) els.year.textContent = String(date.getFullYear());
    }

    /* Roll a date onto three reels.
     *
     * els: { month, day, year } — three elements rendered as MM / DD / YYYY.
     * All three start together; the day reel ticks fastest and stops first,
     * the month follows, and the year is the slowest and lands last.
     */
    function rollDate(els, date, opts) {
        opts = opts || {};
        if (!date) return;

        var months = [], days = [], years = [];
        var i;
        for (i = 1; i <= 12; i++) months.push(pad2(i));
        for (i = 1; i <= 31; i++) days.push(pad2(i));
        // the year climbs like an odometer instead of jumping at random
        for (i = 9; i >= 0; i--) years.push(String(date.getFullYear() - i));

        var speed = opts.speed || 1;

        // tick counts are deliberately not exact multiples of the reel length,
        // so the very first painted frame never happens to be the answer
        spinReel(els.day, days, pad2(date.getDate()),
                 { duration: 1500 * speed, ticks: 97 });
        spinReel(els.month, months, pad2(date.getMonth() + 1),
                 { duration: 2100 * speed, ticks: 40 });
        spinReel(els.year, years, String(date.getFullYear()),
                 { duration: 2900 * speed, ticks: 22, done: opts.done });
    }

    // Plain integer count-up, used for the workdays total.
    function countUp(el, finalValue, opts) {
        opts = opts || {};
        var done = opts.done || function () {};
        var duration = opts.duration || 2400;
        var suffix = opts.suffix || '';

        function show(n) {
            el.textContent = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + suffix;
        }
        if (!el) { done(); return; }
        if (prefersReducedMotion()) { show(finalValue); done(); return; }

        var t0 = null;
        var finished = false;
        el.classList.add('is-spinning');

        function finish() {
            if (finished) return;
            finished = true;
            show(finalValue);
            el.classList.remove('is-spinning');
            el.classList.add('is-settled');
            done();
        }

        function frame(now) {
            if (finished) return;
            if (t0 === null) t0 = now;
            var p = Math.min((now - t0) / duration, 1);
            if (p >= 1) { finish(); return; }
            show(Math.round(easeOut(p) * finalValue));
            window.requestAnimationFrame(frame);
        }
        window.requestAnimationFrame(frame);
        window.setTimeout(finish, duration + 400);   // see spinReel
    }

    // ---------------------------------------------------------------- mount

    /* Wire the whole thing to the markup in index.html.
     *
     * ids: {
     *   startMonth / startDay / startYear : STARTS, filled immediately
     *   endMonth   / endDay   / endYear   : COMPLETION, the three reels
     *   workdays                          : the workdays total
     *   root                              : optional wrapper, gets .is-failed
     * }
     */
    function mountProjectSummary(projectName, ids) {
        var el = {};
        Object.keys(ids).forEach(function (k) { el[k] = document.getElementById(ids[k]); });

        fetchProjectSummary(projectName, function (summary) {
            if (el.root) el.root.classList.add('is-loaded');

            // STARTS — no theatrics, straight to the value
            setDate({ month: el.startMonth, day: el.startDay, year: el.startYear }, summary.start);

            whenVisible(function () {
                // COMPLETION — day, then month, then year
                rollDate({ month: el.endMonth, day: el.endDay, year: el.endYear }, summary.end);

                // WORKDAYS — counts up alongside the reels
                countUp(el.workdays, summary.workdays, { duration: 2600, suffix: 'd' });
            });
        }, function (err) {
            if (el.root) el.root.classList.add('is-failed');
            if (el.root) el.root.setAttribute('title', err.message);
            if (window.console) console.warn('[project summary]', err.message);
        });
    }

    window.ProjectSummary = {
        DEFAULT_PROJECT: DEFAULT_PROJECT,
        // data
        fetch: fetchProjectSummary,
        compute: computeProjectSummary,
        deriveDates: deriveDates,
        leafWorkingDays: leafWorkingDays,
        workingDaysBetween: workingDaysBetween,
        parseIso: parseIso,
        formatDate: formatDate,
        // presentation
        spinReel: spinReel,
        setDate: setDate,
        rollDate: rollDate,
        countUp: countUp,
        mount: mountProjectSummary
    };

})(window, document);
