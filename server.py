import os
import json
import re
import tempfile
import threading
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__, static_folder='.', static_url_path='')
socketio = SocketIO(app, cors_allowed_origins="*")

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
FILES_DIR = os.path.join(DATA_DIR, 'FILES')

# Lock for serializing writes to group project files
_file_locks = {}
_file_locks_lock = threading.Lock()


def get_file_lock(fpath):
    """Get or create a threading lock for a specific file path."""
    with _file_locks_lock:
        if fpath not in _file_locks:
            _file_locks[fpath] = threading.Lock()
        return _file_locks[fpath]


def atomic_write_json(fpath, data):
    """Write JSON to a file atomically using temp file + rename."""
    dir_name = os.path.dirname(fpath)
    fd, tmp_path = tempfile.mkstemp(suffix='.tmp', dir=dir_name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # On Windows, os.rename fails if target exists; use os.replace instead
        os.replace(tmp_path, fpath)
    except Exception:
        # Clean up temp file on failure
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def read_json_file(fpath):
    """Read and parse a JSON file, returning None if it doesn't exist."""
    if not os.path.exists(fpath):
        return None
    with open(fpath, 'r', encoding='utf-8') as f:
        return json.load(f)


def safe_filename(user_id, project_name, date_str):
    """Build a safe filename from user, project, and date."""
    parts = '{}_{}'.format(user_id, project_name)
    # Remove anything that isn't alphanumeric, underscore, or hyphen
    parts = re.sub(r'[^A-Za-z0-9_\-]', '', parts)
    # date_str should be YYYY-MM-DD
    date_clean = re.sub(r'[^0-9\-]', '', date_str)
    return '{}_{}.json'.format(parts, date_clean)


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory('.', filename)


PERSONAL_DIR = os.path.join(DATA_DIR, 'PERSONAL')
GROUP_DIR = os.path.join(DATA_DIR, 'GROUP')


@app.route('/api/group-projects', methods=['GET'])
def group_projects():
    try:
        result = []
        if not os.path.isdir(GROUP_DIR):
            return jsonify({'ok': True, 'projects': []})

        for fname in os.listdir(GROUP_DIR):
            if not fname.endswith('.json'):
                continue
            proj_name = fname[:-5]  # strip .json
            fpath = os.path.join(GROUP_DIR, fname)
            entries = 0
            last_saved = ''
            try:
                with open(fpath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    cell_data = data.get('cellData', {})
                    for key, val in cell_data.items():
                        if key.endswith('-0') and isinstance(val, dict) and val.get('text', '').strip():
                            entries += 1
            except Exception:
                pass
            try:
                mtime = os.path.getmtime(fpath)
                last_saved = datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %I:%M %p')
            except Exception:
                pass
            result.append({
                'name': proj_name,
                'lastSaved': last_saved,
                'entries': entries
            })

        result.sort(key=lambda x: x['lastSaved'], reverse=True)
        return jsonify({'ok': True, 'projects': result})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/load-group', methods=['GET'])
def load_group():
    try:
        project = request.args.get('project', '')
        if not project:
            return jsonify({'ok': False, 'error': 'No project name'}), 400
        safe_name = re.sub(r'[^A-Za-z0-9_\-]', '', project)
        fname = safe_name + '.json'
        fpath = os.path.join(GROUP_DIR, fname)
        if not os.path.exists(fpath):
            return jsonify({'ok': True, 'data': None, 'version': 0})
        data = read_json_file(fpath)
        version = data.get('_version', 0) if isinstance(data, dict) else 0
        return jsonify({'ok': True, 'data': data, 'filename': fname, 'version': version})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/project-version', methods=['GET'])
def project_version():
    """Lightweight endpoint that returns only the current version number."""
    try:
        project = request.args.get('project', '')
        if not project:
            return jsonify({'ok': False, 'error': 'No project name'}), 400
        safe_name = re.sub(r'[^A-Za-z0-9_\-]', '', project)
        fname = safe_name + '.json'
        fpath = os.path.join(GROUP_DIR, fname)
        if not os.path.exists(fpath):
            return jsonify({'ok': True, 'version': 0})
        data = read_json_file(fpath)
        version = data.get('_version', 0) if isinstance(data, dict) else 0
        return jsonify({'ok': True, 'version': version})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/save-tasks', methods=['POST'])
def save_tasks():
    try:
        payload = request.get_json()
        if payload is None:
            return jsonify({'ok': False, 'error': 'No JSON body'}), 400

        data = payload.get('data', {})
        project = payload.get('project', 'TASKS')
        client_version = payload.get('version', None)
        safe_name = re.sub(r'[^A-Za-z0-9_\-]', '', project)
        fname = safe_name + '.json'

        os.makedirs(GROUP_DIR, exist_ok=True)
        fpath = os.path.join(GROUP_DIR, fname)

        lock = get_file_lock(fpath)
        with lock:
            # Read current version from file
            current_version = 0
            if os.path.exists(fpath):
                try:
                    existing = read_json_file(fpath)
                    if existing and isinstance(existing, dict):
                        current_version = existing.get('_version', 0)
                except Exception:
                    current_version = 0

            # If client sent a version, check for conflicts
            if client_version is not None:
                if client_version != current_version:
                    return jsonify({
                        'ok': False,
                        'conflict': True,
                        'error': 'Version conflict: another user has saved changes since you last loaded.',
                        'serverVersion': current_version,
                        'clientVersion': client_version
                    }), 409

            # Increment version and save
            new_version = current_version + 1
            data['_version'] = new_version

            atomic_write_json(fpath, data)

        return jsonify({'ok': True, 'filename': fname, 'version': new_version})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/save', methods=['POST'])
def save():
    try:
        payload = request.get_json()
        if payload is None:
            return jsonify({'ok': False, 'error': 'No JSON body'}), 400

        user_id = payload.get('userId', 'default')
        project_name = payload.get('projectName', 'project')
        date_str = payload.get('date', 'unknown')
        data = payload.get('data', {})

        fname = safe_filename(user_id, project_name, date_str)
        os.makedirs(PERSONAL_DIR, exist_ok=True)
        fpath = os.path.join(PERSONAL_DIR, fname)

        atomic_write_json(fpath, data)

        return jsonify({'ok': True, 'filename': fname})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/delete', methods=['POST'])
def delete_project():
    try:
        payload = request.get_json()
        if payload is None:
            return jsonify({'ok': False, 'error': 'No JSON body'}), 400

        user_id = payload.get('userId', 'default')
        project_name = payload.get('projectName', '')
        if not project_name:
            return jsonify({'ok': False, 'error': 'No project name'}), 400

        prefix = re.sub(r'[^A-Za-z0-9_\-]', '', user_id) + '_'
        safe_proj = re.sub(r'[^A-Za-z0-9_\-]', '', project_name)
        deleted = 0

        for fname in os.listdir(PERSONAL_DIR):
            if not fname.startswith(prefix) or not fname.endswith('.json'):
                continue
            remainder = fname[len(prefix):]
            remainder_no_ext = remainder[:-5]
            last_underscore = remainder_no_ext.rfind('_')
            if last_underscore == -1:
                continue
            proj_name = remainder_no_ext[:last_underscore]
            if proj_name == safe_proj:
                fpath = os.path.join(PERSONAL_DIR, fname)
                os.remove(fpath)
                deleted += 1

        return jsonify({'ok': True, 'deleted': deleted})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/delete-group', methods=['POST'])
def delete_group_project():
    try:
        payload = request.get_json()
        if payload is None:
            return jsonify({'ok': False, 'error': 'No JSON body'}), 400

        project_name = payload.get('projectName', '')
        if not project_name:
            return jsonify({'ok': False, 'error': 'No project name'}), 400

        safe_name = re.sub(r'[^A-Za-z0-9_\\-]', '', project_name)
        fpath = os.path.join(GROUP_DIR, safe_name + '.json')
        if os.path.exists(fpath):
            os.remove(fpath)
            return jsonify({'ok': True, 'deleted': 1})
        else:
            return jsonify({'ok': False, 'error': 'Project file not found'}), 404
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/projects', methods=['GET'])
def list_projects():
    try:
        user_id = request.args.get('user', 'default')
        prefix = re.sub(r'[^A-Za-z0-9_\-]', '', user_id) + '_'
        projects = {}  # project_name => {lastSaved, createdBy}

        for fname in os.listdir(PERSONAL_DIR):
            if not fname.startswith(prefix) or not fname.endswith('.json'):
                continue
            # filename format: userId_projectName_YYYY-MM-DD.json
            remainder = fname[len(prefix):]  # projectName_YYYY-MM-DD.json
            remainder = remainder[:-5]  # strip .json
            # Split on last underscore to separate project name from date
            last_underscore = remainder.rfind('_')
            if last_underscore == -1:
                continue
            proj_name = remainder[:last_underscore]
            date_str = remainder[last_underscore + 1:]
            # Validate date format
            if not re.match(r'^\d{4}-\d{2}-\d{2}$', date_str):
                continue

            entries = 0
            fpath = os.path.join(PERSONAL_DIR, fname)
            try:
                with open(fpath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    cell_data = data.get('cellData', {})
                    for key, val in cell_data.items():
                        if key.endswith('-0') and isinstance(val, dict) and val.get('text', '').strip():
                            entries += 1
            except Exception:
                pass

            # Get file modification time for the timestamp
            try:
                mtime = os.path.getmtime(fpath)
                last_saved_dt = datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %I:%M %p')
            except Exception:
                last_saved_dt = date_str

            if proj_name not in projects or date_str > projects[proj_name]['_date']:
                projects[proj_name] = {
                    '_date': date_str,
                    'lastSaved': last_saved_dt,
                    'entries': entries
                }

        result = []
        for name, info in projects.items():
            result.append({
                'name': name,
                'lastSaved': info['lastSaved'],
                'entries': info['entries'],
                '_date': info['_date']
            })
        result.sort(key=lambda x: x['_date'], reverse=True)
        for item in result:
            del item['_date']

        return jsonify({'ok': True, 'projects': result})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/load', methods=['GET'])
def load():
    try:
        user_id = request.args.get('user', 'default')
        project_name = request.args.get('project', 'project')
        date_str = request.args.get('date', '')

        if date_str:
            # Load specific date file
            fname = safe_filename(user_id, project_name, date_str)
            fpath = os.path.join(PERSONAL_DIR, fname)
        else:
            # Find the most recent file for this user/project
            prefix = re.sub(r'[^A-Za-z0-9_\-]', '', '{}_{}'.format(user_id, project_name))
            matching = []
            for f in os.listdir(PERSONAL_DIR):
                if f.startswith(prefix + '_') and f.endswith('.json'):
                    matching.append(f)
            if not matching:
                return jsonify({'ok': True, 'data': None})
            matching.sort(reverse=True)
            fpath = os.path.join(PERSONAL_DIR, matching[0])
            fname = matching[0]

        if not os.path.exists(fpath):
            return jsonify({'ok': True, 'data': None})

        with open(fpath, 'r', encoding='utf-8') as f:
            data = json.load(f)

        return jsonify({'ok': True, 'data': data, 'filename': fname})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/upload', methods=['POST'])
def upload_file():
    try:
        project = request.form.get('project', '')
        if not project:
            return jsonify({'ok': False, 'error': 'No project name'}), 400

        uploaded = request.files.get('file')
        if not uploaded:
            return jsonify({'ok': False, 'error': 'No file'}), 400

        safe_proj = re.sub(r'[^A-Za-z0-9_\-]', '', project)
        proj_dir = os.path.join(FILES_DIR, safe_proj)
        os.makedirs(proj_dir, exist_ok=True)

        timestamp = int(datetime.now().timestamp() * 1000)
        original_name = uploaded.filename
        safe_original = re.sub(r'[^A-Za-z0-9_\-\.]', '_', original_name)
        stored_name = '{}_{}'.format(timestamp, safe_original)

        dest = os.path.join(proj_dir, stored_name)
        uploaded.save(dest)

        return jsonify({
            'ok': True,
            'storedName': stored_name,
            'originalName': original_name,
            'size': os.path.getsize(dest)
        })
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/files/<project>/<filename>')
def serve_file(project, filename):
    safe_proj = re.sub(r'[^A-Za-z0-9_\-]', '', project)
    safe_file = re.sub(r'[^A-Za-z0-9_\-\.]', '', filename)
    proj_dir = os.path.join(FILES_DIR, safe_proj)
    fpath = os.path.join(proj_dir, safe_file)
    if not os.path.exists(fpath):
        return jsonify({'ok': False, 'error': 'File not found'}), 404
    return send_from_directory(proj_dir, safe_file, as_attachment=True,
                               download_name=safe_file.split('_', 1)[1] if '_' in safe_file else safe_file)


@app.route('/api/delete-file', methods=['POST'])
def delete_file():
    try:
        payload = request.get_json()
        if payload is None:
            return jsonify({'ok': False, 'error': 'No JSON body'}), 400

        project = payload.get('project', '')
        stored_name = payload.get('storedName', '')
        if not project or not stored_name:
            return jsonify({'ok': False, 'error': 'Missing project or storedName'}), 400

        safe_proj = re.sub(r'[^A-Za-z0-9_\-]', '', project)
        safe_file = re.sub(r'[^A-Za-z0-9_\-\.]', '', stored_name)
        fpath = os.path.join(FILES_DIR, safe_proj, safe_file)

        if os.path.exists(fpath):
            os.remove(fpath)
            return jsonify({'ok': True})
        return jsonify({'ok': False, 'error': 'File not found'}), 404
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# ========== Patch System ==========

LOGS_DIR = os.path.join(DATA_DIR, 'LOGS')


def find_task_by_id(task_id, tasks_list):
    """Recursively find a task/subtask by ID."""
    for t in tasks_list:
        if t.get('id') == task_id:
            return t
        found = find_task_by_id(task_id, t.get('subtasks', []))
        if found:
            return found
    return None


def remove_task_by_id(task_id, tasks_list):
    """Recursively remove a task/subtask by ID. Returns True if removed."""
    for i, t in enumerate(tasks_list):
        if t.get('id') == task_id:
            tasks_list.pop(i)
            return True
        if remove_task_by_id(task_id, t.get('subtasks', [])):
            return True
    return False


def clear_predecessor_refs_server(deleted_id, tasks_list):
    """Clear any predecessor references pointing to a deleted task."""
    for t in tasks_list:
        if str(t.get('predecessor', '')) == str(deleted_id):
            t['predecessor'] = ''
        clear_predecessor_refs_server(deleted_id, t.get('subtasks', []))


def log_change(project, user, patch_data):
    """Append a change entry to the project's log file."""
    try:
        os.makedirs(LOGS_DIR, exist_ok=True)
        safe_proj = re.sub(r'[^A-Za-z0-9_\-]', '', project)
        log_file = os.path.join(LOGS_DIR, safe_proj + '.log')
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        entry = {
            'timestamp': timestamp,
            'user': user,
            'op': patch_data.get('op', ''),
            'details': {k: v for k, v in patch_data.items()
                        if k not in ('project', 'user', 'op')}
        }
        with open(log_file, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except Exception:
        pass


def apply_patch_to_file(project, payload):
    """Core patch logic shared by HTTP and WebSocket handlers.
    Returns (True, version) on success or (False, error_string) on failure.
    """
    op = payload.get('op', '')
    if not op:
        return False, 'Missing op'

    safe_name = re.sub(r'[^A-Za-z0-9_\-]', '', project)
    fname = safe_name + '.json'
    os.makedirs(GROUP_DIR, exist_ok=True)
    fpath = os.path.join(GROUP_DIR, fname)

    lock = get_file_lock(fpath)
    with lock:
        data = {}
        if os.path.exists(fpath):
            data = read_json_file(fpath) or {}

        task_data = data.get('_taskData', {'tasks': [], 'taskIdCounter': 0})
        tasks_list = task_data.get('tasks', [])
        counter = task_data.get('taskIdCounter', 0)

        if op == 'updateCell':
            cell_key = payload.get('key')
            cell_value = payload.get('cell')
            if not cell_key:
                return False, 'Missing cell key'
            if 'cellData' not in data:
                data['cellData'] = {}
            data['cellData'][cell_key] = cell_value if cell_value else {}
            # Skip _taskData update for cell patches
            task_data['tasks'] = tasks_list
            task_data['taskIdCounter'] = counter
            data['_taskData'] = task_data
            version = data.get('_version', 0) + 1
            data['_version'] = version
            atomic_write_json(fpath, data)
            return True, version

        elif op == 'update':
            task_id = payload.get('taskId')
            field = payload.get('field')
            value = payload.get('value')
            task = find_task_by_id(task_id, tasks_list)
            if task is None:
                return False, 'Task not found'
            task[field] = value

        elif op == 'addTask':
            new_task = payload.get('task')
            if not new_task:
                return False, 'No task data'
            tasks_list.append(new_task)
            new_id = new_task.get('id', 0)
            if new_id > counter:
                counter = new_id

        elif op == 'addSubtask':
            parent_id = payload.get('parentTaskId')
            subtask = payload.get('subtask')
            if not subtask:
                return False, 'No subtask data'
            parent = find_task_by_id(parent_id, tasks_list)
            if parent is None:
                return False, 'Parent task not found'
            if 'subtasks' not in parent:
                parent['subtasks'] = []
            parent['subtasks'].append(subtask)
            new_id = subtask.get('id', 0)
            if new_id > counter:
                counter = new_id

        elif op == 'deleteTask':
            task_id = payload.get('taskId')
            tasks_list[:] = [t for t in tasks_list
                             if t.get('id') != task_id]
            clear_predecessor_refs_server(task_id, tasks_list)

        elif op == 'deleteSubtask':
            task_id = payload.get('taskId')
            if not remove_task_by_id(task_id, tasks_list):
                return False, 'Subtask not found'
            clear_predecessor_refs_server(task_id, tasks_list)

        else:
            return False, 'Unknown operation: ' + op

        task_data['tasks'] = tasks_list
        task_data['taskIdCounter'] = counter
        data['_taskData'] = task_data

        version = data.get('_version', 0) + 1
        data['_version'] = version

        atomic_write_json(fpath, data)

    return True, version


@app.route('/api/patch-task', methods=['POST'])
def patch_task():
    """HTTP fallback for applying a patch (used when WebSocket is unavailable)."""
    try:
        payload = request.get_json()
        if not payload:
            return jsonify({'ok': False, 'error': 'No JSON body'}), 400

        project = payload.get('project', '')
        user = payload.get('user', 'unknown')

        if not project:
            return jsonify({'ok': False, 'error': 'Missing project'}), 400

        ok, result = apply_patch_to_file(project, payload)
        if ok:
            # Broadcast to all WebSocket clients in the project room
            # (the sender filters out their own patch via clientId)
            socketio.emit('patch', payload, room=project)
            log_change(project, user, payload)
            return jsonify({'ok': True, 'version': result})
        else:
            return jsonify({'ok': False, 'error': result}), 400
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# ========== WebSocket Handlers ==========

@socketio.on('join_project')
def handle_join_project(data):
    room = data.get('project', '')
    if room:
        join_room(room)
        return {'ok': True}
    return {'ok': False, 'error': 'No project name'}


@socketio.on('leave_project')
def handle_leave_project(data):
    room = data.get('project', '')
    if room:
        leave_room(room)


@socketio.on('send_patch')
def handle_send_patch(data):
    """Receive a patch via WebSocket, apply it, broadcast to other clients."""
    project = data.get('project', '')
    user = data.get('user', 'unknown')

    if not project:
        return {'ok': False, 'error': 'Missing project'}

    try:
        ok, result = apply_patch_to_file(project, data)
        if ok:
            # Broadcast to all OTHER clients in the room (skip sender)
            emit('patch', data, room=project, include_self=False)
            log_change(project, user, data)
            return {'ok': True, 'version': result}
        else:
            return {'ok': False, 'error': result}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


if __name__ == '__main__':
    socketio.run(app, debug=True, port=5000, allow_unsafe_werkzeug=True)
