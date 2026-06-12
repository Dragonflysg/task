"""Local dev server for the Scroll of Knowledge page.

Run:    python app.py
Browse: http://localhost:5000
"""
import json
import os
import re

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

BASE = os.path.dirname(os.path.abspath(__file__))
UPDATES_DIR = os.path.join(BASE, 'Updates')
ALLOWED_EXT = {'docx', 'xlsx', 'pdf', 'jpg', 'jpeg', 'bmp', 'png'}

app = Flask(__name__, static_folder=None)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024   # 50 MB per request


@app.route('/')
def index():
    return send_from_directory(BASE, 'index.html')


# API-style endpoint backed by project.json — swap its body for the real
# API call later without touching the front end.
@app.route('/api/articles')
def articles():
    with open(os.path.join(BASE, 'project.json'), encoding='utf-8') as f:
        return jsonify(json.load(f))


# Receives the user's update files and stores them under Updates/<ticket>/.
# Duplicate names are auto-renamed ("changes (1).docx") so no submission
# is ever overwritten.
@app.route('/api/upload', methods=['POST'])
def upload():
    ticket = re.sub(r'[^A-Za-z0-9_-]', '', request.form.get('ticket', '')).strip()
    if not ticket:
        return jsonify(error='Missing or invalid ticket number.'), 400

    files = [f for f in request.files.getlist('files') if f and f.filename]
    if not files:
        return jsonify(error='No files received.'), 400

    # validate everything before saving anything, so a bad file
    # rejects the whole batch instead of leaving a partial upload
    for f in files:
        ext = f.filename.rsplit('.', 1)[-1].lower() if '.' in f.filename else ''
        if ext not in ALLOWED_EXT:
            return jsonify(error=f'File type not allowed: {f.filename}'), 400

    folder = os.path.join(UPDATES_DIR, ticket)
    os.makedirs(folder, exist_ok=True)

    saved = []
    for f in files:
        name = secure_filename(f.filename)
        stem, _, ext = name.rpartition('.')
        candidate, n = name, 1
        while os.path.exists(os.path.join(folder, candidate)):
            candidate = f'{stem} ({n}).{ext}'
            n += 1
        f.save(os.path.join(folder, candidate))
        saved.append(candidate)

    # record the submission: due diligence is done for this article
    try:
        entry_id = int(request.form.get('id', ''))
    except ValueError:
        entry_id = None
    path = os.path.join(BASE, 'project.json')
    with open(path, encoding='utf-8') as f:
        entries = json.load(f)
    entry = next((e for e in entries if e.get('id') == entry_id), None)
    if entry is not None:
        entry['Update'] = {'ticket': entry.get('ticket', ''), 'submitted': True}
        entry['due'] = 'N'
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(entries, f, indent=1)
        print('Update submitted:', entry_id, entry['Update'])

    return jsonify(saved=saved)


# Records a "no update needed" decision. The payload carries id, article
# and ticket — persistence/forwarding is handled later; for now we just
# acknowledge so the front end can seal the scroll.
@app.route('/api/noupdate', methods=['POST'])
def noupdate():
    data = request.get_json(silent=True) or {}
    print('No-update decision received:', data)
    return jsonify(ok=True)


# Records a "this article is not needed" request, or recalls one when
# the payload's "delete" key is false. The decision is written into the
# entry's "Deletion" attribute in project.json, matched by id.
@app.route('/api/delete', methods=['POST'])
def delete():
    data = request.get_json(silent=True) or {}
    entry_id = data.get('id')
    delete_flag = bool(data.get('delete', True))

    path = os.path.join(BASE, 'project.json')
    with open(path, encoding='utf-8') as f:
        entries = json.load(f)
    entry = next((e for e in entries if e.get('id') == entry_id), None)
    if entry is None:
        return jsonify(error=f'No article with id {entry_id}.'), 404

    entry['Deletion'] = {'ticket': entry.get('ticket', ''), 'delete': delete_flag}
    # a pending deletion counts as due diligence done; recalling restores it
    entry['due'] = 'N' if delete_flag else 'Y'
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(entries, f, indent=1)
    print('Deletion request received:', data, '->', entry['Deletion'])
    return jsonify(ok=True, deletion=entry['Deletion'], due=entry['due'])


# Looks a person up by uid in members.json (stand-in for the real
# directory). Unknown uids are refused — members only.
@app.route('/api/uidsearch', methods=['POST'])
def uidsearch():
    data = request.get_json(silent=True) or {}
    uid = str(data.get('uid', '')).strip().lower()
    if not re.fullmatch(r'[a-z]{2}\d{4}', uid):
        return jsonify(error='Invalid uid — expected a form like "ab1234".'), 400
    with open(os.path.join(BASE, 'members.json'), encoding='utf-8') as f:
        members = json.load(f)
    member = next((m for m in members if m.get('uid', '').lower() == uid), None)
    print('uid search:', uid, '->', member['name'] if member else 'not found')
    if member is None:
        return jsonify(error='UID not found, members only'), 404
    return jsonify(uid=uid, name=member['name'])


# Records a transfer-of-ownership request (or withdraws one when
# transferTo is empty) by writing the entry's "ownership" attribute
# into project.json, matched by id. The email to the recipient is
# handled later.
@app.route('/api/transfer', methods=['POST'])
def transfer():
    data = request.get_json(silent=True) or {}
    entry_id = data.get('id')
    transfer_to = str(data.get('transferTo', '')).strip().lower()
    name = str(data.get('name', '')).strip()
    if transfer_to and not re.fullmatch(r'[a-z]{2}\d{4}', transfer_to):
        return jsonify(error='Invalid uid — expected a form like "ab1234".'), 400

    path = os.path.join(BASE, 'project.json')
    with open(path, encoding='utf-8') as f:
        entries = json.load(f)
    entry = next((e for e in entries if e.get('id') == entry_id), None)
    if entry is None:
        return jsonify(error=f'No article with id {entry_id}.'), 404

    entry['ownership'] = {'transferTo': transfer_to, 'name': name if transfer_to else ''}
    # a pending transfer counts as due diligence done; withdrawing restores it
    entry['due'] = 'N' if transfer_to else 'Y'
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(entries, f, indent=1)
    print('Ownership updated:', entry_id, entry['ownership'])
    return jsonify(ok=True, ownership=entry['ownership'], due=entry['due'])


@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory(BASE, filename)


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000)
