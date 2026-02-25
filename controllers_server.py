import os
import json
import re
import copy
import time
import atexit
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
    """Write JSON to a file atomically using temp file + rename.
    Retries the replace step to handle transient Windows locks
    (antivirus scanners, search indexers, etc.).
    Used by the background flush thread — not on the hot path."""
    dir_name = os.path.dirname(fpath)
    fd, tmp_path = tempfile.mkstemp(suffix='.tmp', dir=dir_name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # Extended retry budget (background thread, not blocking users)
        last_err = None
        for attempt in range(15):
            try:
                os.replace(tmp_path, fpath)
                return  # success
            except PermissionError as e:
                last_err = e
                time.sleep(0.2 * (attempt + 1))
        raise last_err
    except Exception:
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


# ========== In-Memory Write-Behind Cache ==========

class ProjectCache:
    """In-memory cache for group project JSON files.

    All reads and writes go through this cache. A background thread
    periodically flushes dirty entries to disk via atomic_write_json.
    """

    FLUSH_INTERVAL = 2  # seconds between background flush cycles

    def __init__(self):
        self._cache = {}       # project_name -> dict (the JSON data)
        self._dirty = set()    # project names that need flushing
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._flush_thread = threading.Thread(
            target=self._flush_loop, daemon=True, name='cache-flush'
        )
        self._flush_thread.start()
        atexit.register(self.flush_all)

    # -- public API --

    def get(self, project_name):
        """Return the cached data dict for a project (loading from disk if needed).
        Returns a *reference* to the live dict — callers may mutate it directly
        under their own lock, then call mark_dirty().
        """
        with self._lock:
            if project_name not in self._cache:
                fpath = self._fpath(project_name)
                if os.path.exists(fpath):
                    self._cache[project_name] = read_json_file(fpath) or {}
                else:
                    self._cache[project_name] = {}
            return self._cache[project_name]

    def get_snapshot(self, project_name):
        """Return a deep copy — safe for returning to HTTP clients."""
        with self._lock:
            if project_name not in self._cache:
                fpath = self._fpath(project_name)
                if os.path.exists(fpath):
                    self._cache[project_name] = read_json_file(fpath) or {}
                else:
                    self._cache[project_name] = {}
            return copy.deepcopy(self._cache[project_name])

    def put(self, project_name, data):
        """Replace the entire cached dict for a project and mark dirty."""
        with self._lock:
            self._cache[project_name] = data
            self._dirty.add(project_name)

    def mark_dirty(self, project_name):
        """Mark a project as needing a disk flush."""
        with self._lock:
            self._dirty.add(project_name)

    def is_loaded(self, project_name):
        """Check if a project is already in the cache."""
        with self._lock:
            return project_name in self._cache

    def flush_all(self):
        """Flush every dirty project to disk. Called on shutdown."""
        with self._lock:
            dirty = list(self._dirty)
            snapshots = {}
            for name in dirty:
                if name in self._cache:
                    snapshots[name] = copy.deepcopy(self._cache[name])
            self._dirty.clear()

        for name, data in snapshots.items():
            self._write_to_disk(name, data)

    def shutdown(self):
        """Stop the background thread and do a final flush."""
        self._stop_event.set()
        self._flush_thread.join(timeout=5)
        self.flush_all()

    # -- internal --

    @staticmethod
    def _fpath(project_name):
        safe = re.sub(r'[^A-Za-z0-9_\-]', '', project_name)
        return os.path.join(GROUP_DIR, safe + '.json')

    def _flush_loop(self):
        while not self._stop_event.is_set():
            self._stop_event.wait(self.FLUSH_INTERVAL)
            self._flush_dirty()

    def _flush_dirty(self):
        with self._lock:
            dirty = list(self._dirty)
            snapshots = {}
            for name in dirty:
                if name in self._cache:
                    snapshots[name] = copy.deepcopy(self._cache[name])
            self._dirty -= set(snapshots.keys())

        for name, data in snapshots.items():
            self._write_to_disk(name, data)

    def _write_to_disk(self, project_name, data):
        """Flush a snapshot to disk. Runs only from the single flush thread,
        so no file-level lock is needed (no other code writes GROUP files)."""
        fpath = self._fpath(project_name)
        os.makedirs(GROUP_DIR, exist_ok=True)
        try:
            atomic_write_json(fpath, data)
        except Exception as e:
            # Re-mark dirty so next cycle retries
            with self._lock:
                self._dirty.add(project_name)
            print(f'[cache-flush] Failed to write {project_name}: {e}')


GROUP_DIR = os.path.join(DATA_DIR, 'GROUP')
CHANGE_DIR = os.path.join(DATA_DIR, 'CHANGE')
LOGS_DIR = os.path.join(DATA_DIR, 'LOGS')
BACKUPS_DIR = os.path.join(DATA_DIR, 'BACKUPS')

# Global cache instance (must be after GROUP_DIR definition)
_project_cache = ProjectCache()


# ========== Version-Milestone Backups ==========

def _maybe_backup_project(project_name, data, version):
    """Save a full snapshot every 50 edits, keep last 50."""
    if version % 50 != 0:
        return
    try:
        project_backup_dir = os.path.join(BACKUPS_DIR, project_name)
        os.makedirs(project_backup_dir, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        backup_fname = f'v{version}_{timestamp}.json'
        backup_path = os.path.join(project_backup_dir, backup_fname)
        snapshot = copy.deepcopy(data)
        atomic_write_json(backup_path, snapshot)
        _enforce_backup_retention(project_name, max_backups=50)
        # Log the backup event so restores have a clear boundary marker
        try:
            proj_log_dir = os.path.join(LOGS_DIR, project_name)
            os.makedirs(proj_log_dir, exist_ok=True)
            today = datetime.now().strftime('%Y-%m-%d')
            log_file = os.path.join(proj_log_dir, today + '.log')
            entry = {
                'timestamp': timestamp,
                'user': 'SYSTEM',
                'op': 'backup',
                'details': {
                    'filename': backup_fname,
                    'version': version
                }
            }
            with open(log_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')
        except Exception:
            pass
    except Exception as e:
        print(f'[backup] Failed to backup {project_name} at v{version}: {e}')


def _enforce_backup_retention(project_name, max_backups=50):
    """Delete oldest backups when count exceeds max_backups."""
    project_backup_dir = os.path.join(BACKUPS_DIR, project_name)
    if not os.path.isdir(project_backup_dir):
        return
    files = sorted(f for f in os.listdir(project_backup_dir) if f.endswith('.json'))
    while len(files) > max_backups:
        oldest = files.pop(0)
        try:
            os.remove(os.path.join(project_backup_dir, oldest))
        except OSError:
            pass


# ========== Static Files ==========

def index():
    return send_from_directory('.', 'index.html')


def static_files(filename):
    return send_from_directory('.', filename)


# ========== Group Projects ==========

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
                data = _project_cache.get_snapshot(proj_name)
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


def load_group():
    try:
        project = request.args.get('project', '')
        if not project:
            return jsonify({'ok': False, 'error': 'No project name'}), 400
        safe_name = re.sub(r'[^A-Za-z0-9_\-]', '', project)
        fname = safe_name + '.json'
        fpath = os.path.join(GROUP_DIR, fname)
        if not os.path.exists(fpath) and not _project_cache.is_loaded(safe_name):
            return jsonify({'ok': True, 'data': None, 'version': 0})
        data = _project_cache.get_snapshot(safe_name)
        version = data.get('_version', 0) if isinstance(data, dict) else 0
        return jsonify({'ok': True, 'data': data, 'filename': fname, 'version': version})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


def project_version():
    """Lightweight endpoint that returns only the current version number."""
    try:
        project = request.args.get('project', '')
        if not project:
            return jsonify({'ok': False, 'error': 'No project name'}), 400
        safe_name = re.sub(r'[^A-Za-z0-9_\-]', '', project)
        fpath = os.path.join(GROUP_DIR, safe_name + '.json')
        if not os.path.exists(fpath) and not _project_cache.is_loaded(safe_name):
            return jsonify({'ok': True, 'version': 0})
        data = _project_cache.get(safe_name)
        version = data.get('_version', 0) if isinstance(data, dict) else 0
        return jsonify({'ok': True, 'version': version})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# ========== File Upload / Serve / Delete ==========

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


def serve_file(project, filename):
    safe_proj = re.sub(r'[^A-Za-z0-9_\-]', '', project)
    # Support subdirectory paths (e.g. screenshots/file.png)
    parts = filename.replace('\\', '/').split('/')
    safe_parts = [re.sub(r'[^A-Za-z0-9_\-\.]', '', p) for p in parts]
    proj_dir = os.path.join(FILES_DIR, safe_proj)
    rel_path = os.path.join(*safe_parts)
    fpath = os.path.join(proj_dir, rel_path)
    if not os.path.exists(fpath):
        return jsonify({'ok': False, 'error': 'File not found'}), 404
    serve_dir = os.path.dirname(fpath)
    serve_name = os.path.basename(fpath)
    return send_from_directory(serve_dir, serve_name)


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


# ========== Change Requests ==========

def _change_file_path(project):
    safe_name = re.sub(r'[^A-Za-z0-9_\-]', '', project)
    return os.path.join(CHANGE_DIR, safe_name + '.json')


def _load_change_data(project):
    fpath = _change_file_path(project)
    data = read_json_file(fpath)
    if data is None:
        return {'requests': []}
    return data


def _save_change_data(project, data):
    os.makedirs(CHANGE_DIR, exist_ok=True)
    fpath = _change_file_path(project)
    lock = get_file_lock(fpath)
    with lock:
        atomic_write_json(fpath, data)


def get_change_requests():
    try:
        project = request.args.get('project', '')
        if not project:
            return jsonify({'ok': False, 'error': 'No project name'}), 400
        data = _load_change_data(project)
        return jsonify({'ok': True, 'requests': data.get('requests', [])})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


def create_change_request():
    try:
        # Support both JSON and multipart/form-data (for screenshot uploads)
        if request.content_type and 'multipart/form-data' in request.content_type:
            project = request.form.get('project', '')
            user = request.form.get('user', '')
            text = request.form.get('text', '')
        else:
            payload = request.get_json()
            if not payload:
                return jsonify({'ok': False, 'error': 'No JSON body'}), 400
            project = payload.get('project', '')
            user = payload.get('user', '')
            text = payload.get('text', '')

        if not project or not text:
            return jsonify({'ok': False, 'error': 'Missing project or text'}), 400

        req_id = int(datetime.now().timestamp() * 1000)
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        # Handle screenshot uploads (max 3)
        screenshots = []
        uploaded_files = request.files.getlist('screenshots')
        if uploaded_files:
            safe_proj = re.sub(r'[^A-Za-z0-9_\-]', '', project)
            screenshot_dir = os.path.join(FILES_DIR, safe_proj, 'screenshots')
            os.makedirs(screenshot_dir, exist_ok=True)
            for i, f in enumerate(uploaded_files[:3]):
                if f and f.filename:
                    ext = os.path.splitext(f.filename)[1] or '.png'
                    safe_ext = re.sub(r'[^A-Za-z0-9\.]', '', ext)
                    saved_name = str(req_id) + '_' + str(i) + safe_ext
                    f.save(os.path.join(screenshot_dir, saved_name))
                    screenshots.append('/api/files/' + safe_proj + '/screenshots/' + saved_name)

        new_request = {
            'id': req_id,
            'user': user,
            'timestamp': timestamp,
            'text': text,
            'status': 'Open',
            'replies': [],
            'screenshots': screenshots
        }

        data = _load_change_data(project)
        data['requests'].append(new_request)
        _save_change_data(project, data)

        return jsonify({'ok': True, 'request': new_request})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


def reply_change_request():
    try:
        payload = request.get_json()
        if not payload:
            return jsonify({'ok': False, 'error': 'No JSON body'}), 400

        project = payload.get('project', '')
        request_id = payload.get('requestId')
        user = payload.get('user', '')
        text = payload.get('text', '')

        if not project or not request_id or not text:
            return jsonify({'ok': False, 'error': 'Missing required fields'}), 400

        data = _load_change_data(project)
        found = False
        for req in data['requests']:
            if req['id'] == request_id:
                req['replies'].append({
                    'user': user,
                    'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    'text': text
                })
                found = True
                break

        if not found:
            return jsonify({'ok': False, 'error': 'Request not found'}), 404

        _save_change_data(project, data)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


def update_change_request_status():
    try:
        payload = request.get_json()
        if not payload:
            return jsonify({'ok': False, 'error': 'No JSON body'}), 400

        project = payload.get('project', '')
        request_id = payload.get('requestId')
        status = payload.get('status', '')

        if not project or not request_id or not status:
            return jsonify({'ok': False, 'error': 'Missing required fields'}), 400

        valid_statuses = ['Open', 'In Progress', 'Closed', 'Non-Viable', 'In Review', 'Approved', 'Not Viable', 'Done']
        if status not in valid_statuses:
            return jsonify({'ok': False, 'error': 'Invalid status'}), 400

        data = _load_change_data(project)
        found = False
        for req in data['requests']:
            if req['id'] == request_id:
                req['status'] = status
                found = True
                break

        if not found:
            return jsonify({'ok': False, 'error': 'Request not found'}), 404

        _save_change_data(project, data)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# ========== Patch System ==========

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


def find_parent_of(task_id, tasks_list):
    """Find a task's parent list and index. Returns (list, index) or None."""
    for i, t in enumerate(tasks_list):
        if t.get('id') == task_id:
            return tasks_list, i
        result = find_parent_of(task_id, t.get('subtasks', []))
        if result:
            return result
    return None


def clear_predecessor_refs_server(deleted_id, tasks_list):
    """Clear any predecessor references pointing to a deleted task."""
    for t in tasks_list:
        if str(t.get('predecessor', '')) == str(deleted_id):
            t['predecessor'] = ''
        clear_predecessor_refs_server(deleted_id, t.get('subtasks', []))


def log_change(project, user, patch_data):
    """Append a change entry to the project's daily log file."""
    try:
        safe_proj = re.sub(r'[^A-Za-z0-9_\-]', '', project)
        proj_log_dir = os.path.join(LOGS_DIR, safe_proj)
        os.makedirs(proj_log_dir, exist_ok=True)
        today = datetime.now().strftime('%Y-%m-%d')
        log_file = os.path.join(proj_log_dir, today + '.log')
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

    Uses the in-memory ProjectCache — mutations happen in-memory and are
    flushed to disk asynchronously by the background thread.
    """
    op = payload.get('op', '')
    if not op:
        return False, 'Missing op'

    safe_name = re.sub(r'[^A-Za-z0-9_\-]', '', project)
    fpath = os.path.join(GROUP_DIR, safe_name + '.json')

    # Use a per-file lock to serialize concurrent patches to the same project
    lock = get_file_lock(fpath)
    with lock:
        data = _project_cache.get(safe_name)

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
            task_data['tasks'] = tasks_list
            task_data['taskIdCounter'] = counter
            data['_taskData'] = task_data
            version = data.get('_version', 0) + 1
            data['_version'] = version
            _project_cache.mark_dirty(safe_name)
            _maybe_backup_project(safe_name, data, version)
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

        elif op == 'reorderSubtask':
            task_id = payload.get('taskId')
            direction = payload.get('direction')
            result = find_parent_of(task_id, tasks_list)
            if not result:
                return False, 'Subtask not found'
            parent_list, idx = result
            if direction == 'up' and idx > 0:
                parent_list[idx], parent_list[idx - 1] = parent_list[idx - 1], parent_list[idx]
            elif direction == 'down' and idx < len(parent_list) - 1:
                parent_list[idx], parent_list[idx + 1] = parent_list[idx + 1], parent_list[idx]
            else:
                return False, 'Cannot move further'

        elif op == 'updateComment':
            row_key = str(payload.get('rowKey'))
            comment = payload.get('comment')
            if not comment:
                return False, 'No comment data'
            if 'rowComments' not in data:
                data['rowComments'] = {}
            if row_key not in data['rowComments']:
                data['rowComments'][row_key] = []
            data['rowComments'][row_key].append(comment)
            version = data.get('_version', 0) + 1
            data['_version'] = version
            _project_cache.mark_dirty(safe_name)
            _maybe_backup_project(safe_name, data, version)
            return True, version

        else:
            return False, 'Unknown operation: ' + op

        task_data['tasks'] = tasks_list
        task_data['taskIdCounter'] = counter
        data['_taskData'] = task_data

        version = data.get('_version', 0) + 1
        data['_version'] = version

        _project_cache.mark_dirty(safe_name)
        _maybe_backup_project(safe_name, data, version)

    return True, version


def get_task_logs():
    """Return log entries filtered by taskId for a given project."""
    project = request.args.get('project', '')
    task_id = request.args.get('taskId', '')
    if not project or not task_id:
        return jsonify({'ok': False, 'error': 'Missing project or taskId'}), 400

    safe_proj = re.sub(r'[^A-Za-z0-9_\\-]', '', project)
    proj_log_dir = os.path.join(LOGS_DIR, safe_proj)

    # Support both old single-file format and new daily-file format
    old_log_file = os.path.join(LOGS_DIR, safe_proj + '.log')
    log_files = []
    if os.path.exists(old_log_file):
        log_files.append(old_log_file)
    if os.path.isdir(proj_log_dir):
        log_files.extend(
            os.path.join(proj_log_dir, f)
            for f in sorted(os.listdir(proj_log_dir))
            if f.endswith('.log')
        )

    if not log_files:
        return jsonify({'ok': True, 'logs': []})

    tid = str(task_id)
    results = []
    try:
        for log_file in log_files:
            with open(log_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    details = entry.get('details', {})
                    # Match: taskId in details, or parentTaskId, or subtask.id
                    matched = False
                    if str(details.get('taskId', '')) == tid:
                        matched = True
                    elif str(details.get('parentTaskId', '')) == tid:
                        matched = True
                    elif isinstance(details.get('subtask'), dict) and str(details['subtask'].get('id', '')) == tid:
                        matched = True
                    if matched:
                        results.append(entry)
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

    # Sort by timestamp descending (latest first)
    results.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
    return jsonify({'ok': True, 'logs': results})


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
            if not data.get('noBroadcast'):
                emit('patch', data, room=project, include_self=False)
            log_change(project, user, data)
            return {'ok': True, 'version': result}
        else:
            return {'ok': False, 'error': result}
    except Exception as e:
        return {'ok': False, 'error': str(e)}
