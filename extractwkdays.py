#!/usr/bin/env python3
"""extractwkdays.py -- reduce a project JSON to its three header numbers.

A stripped-down wkng_report.py: same arithmetic as projectsummary.js, no HTTP
and no HTML. Reads a project out of GROUP/ and returns

    {'start': '2027-01-04', 'end': '2029-11-16', 'totalwkdays': 2545}

Data rules, identical to projectsummary.js / design.js:
  - Only LEAF startDate / endDate are trusted; a parent's span is re-derived
    as min/max over its descendant leaves, because stored parent dates go
    stale.
  - Only LEAF rows contribute WKNG DAYS. A parent's own WORKING DAYS is never
    added -- it spans the predecessor chain too and would double count. A top
    level task with no subtasks is itself a leaf and does contribute.
  - A leaf uses _workingDays when it is set and positive, otherwise the day
    count is recomputed from its dates (Mon-Fri, inclusive of both ends).

Usage
    python extractwkdays.py                                # default project
    python extractwkdays.py INTL_to_ITServices_Execution   # by project name
    python extractwkdays.py GROUP/Some.json                # by path
    python extractwkdays.py --json                         # JSON, for piping

As a module
    from extractwkdays import extract_wkdays
    summary = extract_wkdays('GROUP/Some.json')
"""

import argparse
import datetime
import json
import os
import sys

DEFAULT_PROJECT = 'INTL_to_ITServices_Execution'
GROUP_DIR = 'GROUP'


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


def leaf_working_days(task):
    """WKNG DAYS for one subtree: the sum of its leaves, parents excluded."""
    subs = task.get('subtasks') or []
    if subs:
        return sum(leaf_working_days(sub) for sub in subs)
    stored = to_num(task.get('_workingDays'))
    if stored > 0:
        return stored
    return working_days_between(parse_iso(task.get('startDate')),
                                parse_iso(task.get('endDate')))


# --------------------------------------------------------------------- entry

def resolve_path(target):
    """Accept a project name, a bare filename, or a path to the JSON."""
    if not target:
        target = DEFAULT_PROJECT
    if not target.lower().endswith('.json'):
        target += '.json'
    if os.path.exists(target):
        return target
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (os.path.join(GROUP_DIR, target),
                      os.path.join(here, target),
                      os.path.join(here, GROUP_DIR, os.path.basename(target))):
        if os.path.exists(candidate):
            return candidate
    return target


def extract_wkdays(target=None):
    """Reduce a project JSON to {'start', 'end', 'totalwkdays'}.

    Dates come back as ISO strings, or None when the project has no dated
    leaf. totalwkdays is an int unless a stored _workingDays was fractional.
    """
    path = resolve_path(target)
    with open(path, encoding='utf-8') as fh:
        data = json.load(fh)

    tasks = (data.get('_taskData') or {}).get('tasks') or []
    start = end = None
    total = 0

    for task in tasks:
        s, e = derive_dates(task)
        if s and (not start or s < start):
            start = s
        if e and (not end or e > end):
            end = e
        total += leaf_working_days(task)

    total = float(total)
    return {
        'start': start.isoformat() if start else None,
        'end': end.isoformat() if end else None,
        'totalwkdays': int(total) if total.is_integer() else round(total, 2),
    }


def main():
    ap = argparse.ArgumentParser(
        description='Extract start date, end date and total working days from a project JSON.')
    ap.add_argument('project', nargs='?', default=DEFAULT_PROJECT,
                    help='project name, or a path to the JSON (default %s)' % DEFAULT_PROJECT)
    ap.add_argument('--file', dest='file',
                    help='explicit path to the JSON, e.g. GROUP/Some.json')
    ap.add_argument('--json', action='store_true',
                    help='emit JSON instead of a Python dict')
    args = ap.parse_args()

    try:
        summary = extract_wkdays(args.file or args.project)
    except FileNotFoundError:
        sys.exit('no such project JSON: %s' % resolve_path(args.file or args.project))
    except ValueError as exc:
        sys.exit('could not parse JSON: %s' % exc)

    print(json.dumps(summary) if args.json else summary)


if __name__ == '__main__':
    main()
