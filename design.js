$(document).ready(function () {

    // ========== State ==========
    var CURRENT_USER_ID = 'gs6368';
    var SUPER_USERS = ['gs6368', 'ps1234'];
    var DEFAULT_GROUP_PROJECT = 'INTL_to_ITServices_Migration';
    var STORAGE_KEY = 'task_manager_data';
    var CONTACTS_STORAGE_KEY = 'task_manager_contacts';
    var PROJ_NAME = '';
    var tasks = [];
    var taskIdCounter = 0;
    var selectedTaskId = null;
    var contacts = [];

    // Avatar color palette
    var avatarColors = [
        '#607D8B', '#E8A838', '#5C6BC0', '#26A69A', '#EF5350',
        '#AB47BC', '#42A5F5', '#66BB6A', '#FFA726', '#8D6E63',
        '#78909C', '#7E57C2', '#29B6F6', '#9CCC65', '#EC407A'
    ];

    // Predecessor color palette (no green — green is reserved for "self")
    var predColors = [
        { bg: '#e8edf4', text: '#3a5a8c', border: '#c8d4e8' },  // blue
        { bg: '#fce8db', text: '#9a4e2a', border: '#f0cdb8' },  // orange
        { bg: '#ede0f5', text: '#6b3fa0', border: '#d8c2ea' },  // purple
        { bg: '#fde8e8', text: '#a83232', border: '#f4c4c4' },  // red
        { bg: '#e0f0f5', text: '#2a6e7a', border: '#b8dce5' },  // teal
        { bg: '#f5eacc', text: '#7a6020', border: '#e6d49a' },  // gold
        { bg: '#e0e8f8', text: '#3050a0', border: '#b8c8e8' },  // indigo
        { bg: '#f5e0ea', text: '#8a2a5a', border: '#e4b8cc' },  // pink
    ];

    function getPredColor(index) {
        return predColors[index % predColors.length];
    }

    // Currently open contact picker reference
    var activePickerTarget = null; // {type: 'header'} or {type: 'subtask', id: number}
    var activePickerEl = null;     // the .contact-picker DOM element

    // ========== Persistence ==========
    function getStorageKey() {
        return STORAGE_KEY + '_' + PROJ_NAME;
    }

    function saveData() {
        var data = { tasks: tasks, taskIdCounter: taskIdCounter };
        localStorage.setItem(getStorageKey(), JSON.stringify(data));
    }

    function loadData() {
        var raw = localStorage.getItem(getStorageKey());
        if (raw) {
            try {
                var data = JSON.parse(raw);
                tasks = data.tasks || [];
                taskIdCounter = data.taskIdCounter || 0;
            } catch (e) {
                tasks = [];
                taskIdCounter = 0;
            }
        }
    }

    function saveContacts() {
        localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(contacts));
    }

    // ========== Patch System ==========
    var CLIENT_ID = 'c_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    function sendPatch(patch) {
        if (!PROJ_NAME) return;
        patch.project = PROJ_NAME;
        patch.user = CURRENT_USER_ID;
        patch.clientId = CLIENT_ID;

        if (socket && socketConnected) {
            // Primary: send via WebSocket
            socket.emit('send_patch', patch, function (resp) {
                if (!(resp && resp.ok)) {
                    showToast('Save failed: ' + ((resp && resp.error) || 'Unknown'));
                }
            });
        } else {
            // Fallback: send via AJAX
            $.ajax({
                url: '/api/patch-task',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify(patch),
                success: function (resp) {
                    if (!(resp && resp.ok)) {
                        showToast('Save failed: ' + ((resp && resp.error) || 'Unknown'));
                    }
                },
                error: function () {
                    showToast('Failed to save change to server');
                }
            });
        }
    }

    var _patchTimers = {};
    function sendPatchDebounced(key, patchFn, delay) {
        if (_patchTimers[key]) clearTimeout(_patchTimers[key]);
        _patchTimers[key] = setTimeout(function () {
            delete _patchTimers[key];
            var patch = patchFn();
            if (patch) sendPatch(patch);
        }, delay || 600);
    }

    // ========== WebSocket ==========
    var socket = io();
    var socketConnected = false;
    var socketRoom = '';

    socket.on('connect', function () {
        socketConnected = true;
        if (socketRoom) {
            socket.emit('join_project', {project: socketRoom});
        }
    });

    socket.on('disconnect', function () {
        socketConnected = false;
    });

    socket.on('patch', function (data) {
        handleIncomingPatch(data);
    });

    function joinProjectRoom(project) {
        if (socketRoom && socketConnected) {
            socket.emit('leave_project', {project: socketRoom});
        }
        socketRoom = project;
        if (socketConnected) {
            socket.emit('join_project', {project: project});
        }
    }

    function isTaskInSelectedTree(taskId) {
        if (!selectedTaskId) return false;
        if (selectedTaskId === taskId) return true;
        var selectedTask = findTaskById(selectedTaskId, tasks);
        if (!selectedTask) return false;
        return !!findTaskById(taskId, selectedTask.subtasks || []);
    }

    function applyPatchLocally(data) {
        var op = data.op;
        if (op === 'update') {
            var task = findTaskById(data.taskId, tasks);
            if (task) {
                task[data.field] = data.value;
                // Mirror server-side derivation: a status update on a leaf
                // implies a matching percentComplete value. Keeps other
                // design.html tabs in sync without an extra broadcast.
                if (data.field === 'status' &&
                    (data.value === 'Completed' || data.value === 'Not Started') &&
                    (!task.subtasks || task.subtasks.length === 0)) {
                    task.percentComplete = (data.value === 'Completed') ? 100 : 0;
                }
                // Symmetric derivation: a % CMPLT update on a leaf implies
                // a matching status (100 ⇒ Completed, <100 ⇒ In Progress).
                if (data.field === 'percentComplete' &&
                    (!task.subtasks || task.subtasks.length === 0)) {
                    var _pi = parseInt(data.value, 10);
                    if (isNaN(_pi)) _pi = 0;
                    task.status = (_pi >= 100) ? 'Completed' : (_pi === 0) ? 'Not Started' : 'In Progress';
                }
                // Mirror server-side ancestor cascade: whenever a leaf %
                // changes (directly or via status derivation), walk the
                // ancestor chain and recompute parent roll-ups in place.
                if (data.field === 'percentComplete' ||
                    (data.field === 'status' &&
                     (data.value === 'Completed' || data.value === 'Not Started'))) {
                    recomputeAncestorPercents(data.taskId);
                }
            }
        } else if (op === 'addTask') {
            if (data.task) tasks.push(JSON.parse(JSON.stringify(data.task)));
        } else if (op === 'addSubtask') {
            var parent = findTaskById(data.parentTaskId, tasks);
            if (parent) {
                if (!parent.subtasks) parent.subtasks = [];
                parent.subtasks.push(JSON.parse(JSON.stringify(data.subtask)));
            }
        } else if (op === 'deleteTask') {
            for (var i = 0; i < tasks.length; i++) {
                if (tasks[i].id === data.taskId) {
                    tasks.splice(i, 1);
                    break;
                }
            }
            clearPredecessorRefs(data.taskId, tasks);
        } else if (op === 'deleteSubtask') {
            var info = findParentOf(data.taskId, tasks, null);
            if (info) {
                info.list[info.index].subtasks = [];
                info.list.splice(info.index, 1);
            }
            clearPredecessorRefs(data.taskId, tasks);
        }
        saveData();
    }

    // Map grid column indices to task field names
    var COL_TO_TASK_FIELD = {
        0: 'name', 1: 'startDate', 2: 'endDate',
        4: 'predecessor', 5: 'percentComplete', 6: 'status',
        7: 'assignedTo', 8: 'cost'
    };

    function findTaskByRowIndex(rowIdx) {
        // Walk task hierarchy to find which task corresponds to a grid row
        var idx = 0;
        for (var ti = 0; ti < tasks.length; ti++) {
            var task = tasks[ti];
            if (!task.name || !task.name.trim()) continue;
            if (idx === rowIdx) return task;
            idx++;
            var subs = task.subtasks || [];
            for (var si = 0; si < subs.length; si++) {
                if (idx === rowIdx) return subs[si];
                idx++;
                var subsubs = subs[si].subtasks || [];
                for (var ssi = 0; ssi < subsubs.length; ssi++) {
                    if (idx === rowIdx) return subsubs[ssi];
                    idx++;
                }
            }
        }
        return null;
    }

    function reversePredecessorLookup(label) {
        // Given a predecessor label like "CFO > OS", find the task ID
        // Try matching against buildPredecessorLabel for each task/subtask
        for (var ti = 0; ti < tasks.length; ti++) {
            var t = tasks[ti];
            if ((t.name || '') === label) return t.id;
            var subs = t.subtasks || [];
            for (var si = 0; si < subs.length; si++) {
                var s = subs[si];
                var subLabel = (t.name || '') + ' > ' + (s.name || '');
                if (subLabel === label) return s.id;
                var subsubs = s.subtasks || [];
                for (var ssi = 0; ssi < subsubs.length; ssi++) {
                    var ss = subsubs[ssi];
                    var subsubLabel = (t.name || '') + ' > ' + (s.name || '') + ' > ' + (ss.name || '');
                    if (subsubLabel === label) return ss.id;
                }
            }
        }
        return null;
    }

    function applyCellPatchToTasks(data) {
        var key = data.key;
        if (!key) return null;
        var parts = key.split('-');
        var row = parseInt(parts[0]);
        var col = parseInt(parts[1]);
        var field = COL_TO_TASK_FIELD[col];
        if (!field) return null; // col 3 (duration) or unknown column

        var task = findTaskByRowIndex(row);
        if (!task) return null;

        var cellText = (data.cell && data.cell.text) || '';

        if (field === 'assignedTo') {
            task.assignedTo = cellText ? cellText.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
        } else if (field === 'percentComplete') {
            task.percentComplete = parseInt(cellText) || 0;
        } else if (field === 'cost') {
            task.cost = cellText;
        } else if (field === 'predecessor') {
            // Grid stores comma-separated labels (e.g. "CFO > OS, Task2"), task stores array of IDs
            if (!cellText) {
                task.predecessor = [];
            } else {
                var labels = cellText.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
                var ids = [];
                for (var li = 0; li < labels.length; li++) {
                    var foundId = reversePredecessorLookup(labels[li]);
                    if (foundId !== null) ids.push(foundId);
                }
                task.predecessor = ids;
            }
        } else {
            task[field] = cellText;
        }

        saveData();
        return task.id;
    }

    // Map task field names to their detail-panel element selectors
    var FIELD_TO_SELECTOR = {
        name:            '#detail-task-name',
        startDate:       '#detail-start-date',
        endDate:         '#detail-end-date',
        status:          '#detail-status',
        percentComplete: '#detail-percent',
        cost:            '#detail-cost',
        description:     '#detail-description'
    };

    function flashRemoteChange($el) {
        if (!$el || !$el.length) return;
        $el.removeClass('remote-flash');
        // Force reflow so re-adding the class restarts the animation
        void $el[0].offsetWidth;
        $el.addClass('remote-flash');
    }

    function flashFieldForPatch(data) {
        if (!data || !data.taskId) return;

        // If the changed task is the selected (parent) task, flash the header field
        if (data.taskId === selectedTaskId) {
            var sel = FIELD_TO_SELECTOR[data.field];
            if (sel) flashRemoteChange($(sel));
            if (data.field === 'assignedTo') flashRemoteChange($('#detail-assigned-picker'));
            if (data.field === 'predecessor') flashRemoteChange($('#detail-predecessor-picker'));
            return;
        }

        // Otherwise it's a subtask — flash the matching cell in the subtask table
        var $row = $('#subtask-body tr[data-subtask-id="' + data.taskId + '"]');
        if ($row.length) {
            var $target = $row.find('[data-field="' + data.field + '"]');
            if ($target.length) {
                flashRemoteChange($target);
            } else if (data.field === 'assignedTo') {
                flashRemoteChange($row.find('.contact-picker'));
            } else if (data.field === 'predecessor') {
                flashRemoteChange($row.find('.predecessor-picker'));
            }
        }
    }

    function handleIncomingPatch(data) {
        // Skip own patches (needed for AJAX fallback where broadcast includes sender)
        if (data.clientId === CLIENT_ID) return;

        // Handle grid cell patches from view.html
        if (data.op === 'updateCell') {
            var affectedId = applyCellPatchToTasks(data);
            if (affectedId && isTaskInSelectedTree(affectedId)) {
                var $focused = $('#task-detail :focus');
                if ($focused.length === 0) {
                    renderDetail();
                    // Flash the affected field from the grid column mapping
                    var fieldName = COL_TO_TASK_FIELD[data.col];
                    if (fieldName && affectedId) {
                        flashFieldForPatch({taskId: affectedId, field: fieldName});
                    }
                }
                renderTaskList();
            }
            return;
        }

        applyPatchLocally(data);

        // If the deleted task is the one we're viewing, switch away
        if (data.op === 'deleteTask' && selectedTaskId === data.taskId) {
            selectedTaskId = tasks.length > 0 ? tasks[0].id : null;
            renderTaskList();
            renderDetail();
            return;
        }

        // Check if this affects the currently viewed task tree
        var affectsSelected = false;
        if (data.op === 'update' || data.op === 'deleteSubtask') {
            affectsSelected = isTaskInSelectedTree(data.taskId);
        } else if (data.op === 'addSubtask') {
            affectsSelected = isTaskInSelectedTree(data.parentTaskId);
        }

        // Re-render detail only if affected and no field currently has focus
        if (affectsSelected) {
            var $focused = $('#task-detail :focus');
            if ($focused.length === 0) {
                renderDetail();
            }
            // Flash the changed field so the user notices the remote edit
            if (data.op === 'update') {
                flashFieldForPatch(data);
            }
        }
    }

    // Default contacts bundled in code (mirrors contacts.json)
    var DEFAULT_CONTACTS = [
        {"id": "ab1234", "name": "Andy Bundy"},
        {"id": "jv8888", "name": "Jules Verne"},
        {"id": "ae3323", "name": "Albert Einstein"},
        {"id": "hl3333", "name": "Heidi Lamar"}
    ];

    function mergeContacts(source) {
        if (!source || !source.length) return;
        var existingIds = {};
        for (var i = 0; i < contacts.length; i++) {
            existingIds[contacts[i].id] = true;
        }
        for (var j = 0; j < source.length; j++) {
            if (!existingIds[source[j].id]) {
                contacts.push(source[j]);
            }
        }
    }

    function loadContacts() {
        // Load saved contacts from localStorage
        var stored = localStorage.getItem(CONTACTS_STORAGE_KEY);
        if (stored) {
            try {
                contacts = JSON.parse(stored);
            } catch (e) {
                contacts = [];
            }
        }

        // Always merge defaults so they are always present
        mergeContacts(DEFAULT_CONTACTS);

        // Also try to load contacts.json for any additional entries
        $.ajax({
            url: 'contacts.json',
            dataType: 'json',
            async: false,
            success: function (data) {
                mergeContacts(data);
            },
            error: function () { /* ignore */ }
        });

        saveContacts();
    }

    // ========== Helpers ==========
    function generateId() {
        var id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
        taskIdCounter = Math.max(taskIdCounter, id);
        return id;
    }

    function createTaskObj(name) {
        return {
            id: generateId(),
            name: name || '',
            startDate: '',
            endDate: '',
            percentComplete: 0,
            status: 'Not Started',
            assignedTo: [],   // array of contact IDs
            cost: '',
            flagged: false,
            predecessor: [],   // array of predecessor task IDs
            description: '',
            attachments: [],   // array of {name, size, type}
            comments: '',
            subtasks: []
        };
    }

    function findTaskById(id, list) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return list[i];
            var found = findTaskById(id, list[i].subtasks || []);
            if (found) return found;
        }
        return null;
    }

    // Recompute parent task % complete as the average of its direct subtasks (recursive)
    function recomputePercentComplete() {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        if (!task.subtasks || task.subtasks.length === 0) {
            task.percentComplete = 0;
        } else {
            computePercentFromChildren(task);
        }
        $('#detail-percent').val(task.percentComplete);
        // Update intermediate subtask % values in the table
        updateSubtaskPercentCells(task.subtasks || []);
        saveData();
        sendPatch({op: 'update', taskId: task.id, field: 'percentComplete', value: task.percentComplete});
    }

    var _allCompleteNoticeVisible = false;
    function showAllCompleteNotice(taskName) {
        if (_allCompleteNoticeVisible) return;
        _allCompleteNoticeVisible = true;
        var $overlay = $('<div class="dialog-overlay">');
        var $box = $('<div class="dialog-box" style="max-width:440px;">');
        $box.append(
            $('<div class="dialog-title" style="display:flex;align-items:center;gap:8px;">').html(
                '<i class="fa fa-circle-check" style="color:#2e7d3e;font-size:20px;"></i> All Subtasks Completed'
            )
        );
        $box.append(
            $('<p style="font-size:13px;color:#555;line-height:1.6;margin:0 0 20px;">').text(
                'Congratulations! All the subtasks of "' + taskName + '" have been completed. Thank You.'
            )
        );
        var $actions = $('<div class="dialog-actions">');
        var $okBtn = $('<button class="dialog-btn-primary">OK</button>');
        $okBtn.on('click', function () {
            $overlay.remove();
            _allCompleteNoticeVisible = false;
        });
        $actions.append($okBtn);
        $box.append($actions);
        $overlay.append($box);
        $('body').append($overlay);
    }

    function updateSubtaskPercentCells(subtasks) {
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            if (st.subtasks && st.subtasks.length > 0) {
                // Show blank for parent subtask rows — computed value rolls up to header only
                $('#subtask-body input[data-field="percentComplete"][data-id="' + st.id + '"]').val('');
                updateSubtaskPercentCells(st.subtasks);
            }
        }
    }

    function computePercentFromChildren(node) {
        if (!node.subtasks || node.subtasks.length === 0) return;
        for (var i = 0; i < node.subtasks.length; i++) {
            computePercentFromChildren(node.subtasks[i]);
        }
        var sum = 0;
        for (var i = 0; i < node.subtasks.length; i++) {
            sum += (node.subtasks[i].percentComplete || 0);
        }
        node.percentComplete = Math.round(sum / node.subtasks.length);
    }

    // Recursively derive status for nodes with children
    function computeStatusFromChildren(node) {
        if (!node.subtasks || node.subtasks.length === 0) return;
        for (var i = 0; i < node.subtasks.length; i++) {
            computeStatusFromChildren(node.subtasks[i]);
        }
        var allNotStarted = true;
        var allCompleted = true;
        for (var i = 0; i < node.subtasks.length; i++) {
            var s = node.subtasks[i].status;
            if (s !== 'Not Started') allNotStarted = false;
            if (s !== 'Completed') allCompleted = false;
        }
        if (allCompleted) {
            node.status = 'Completed';
        } else if (allNotStarted) {
            node.status = 'Not Started';
        } else {
            node.status = 'In Progress';
        }
    }

    function updateSubtaskStatusCells(subtasks) {
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            if (st.subtasks && st.subtasks.length > 0) {
                // Show blank for parent subtask rows — computed value rolls up to header only
                $('#subtask-body [data-field="status"][data-id="' + st.id + '"]').val('');
                updateSubtaskStatusCells(st.subtasks);
            }
        }
    }

    // Recompute parent task status derived from subtask statuses (recursive)
    function recomputeStatus() {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task || !task.subtasks || task.subtasks.length === 0) return;
        var oldStatus = task.status;
        computeStatusFromChildren(task);
        $('#detail-status').val(task.status);
        updateSubtaskStatusCells(task.subtasks || []);
        saveData();
        if (task.status !== oldStatus) {
            sendPatch({op: 'update', taskId: task.id, field: 'status', value: task.status});
            renderTaskList();
        }
        // Notify when parent transitions to Completed
        if (task.status === 'Completed' && oldStatus !== 'Completed') {
            var taskName = (task.name && task.name.trim()) ? task.name.trim() : '(unnamed)';
            showAllCompleteNotice(taskName);
        }
    }

    // No-op: working days for parent subtask rows are shown as blank.
    // Header duration is handled by syncParentEndDate (calcDuration from dates).
    function recomputeWorkingDays() {
        // intentionally empty — kept so existing call sites don't error
    }

    // Recompute parent task cost as the sum of its direct subtasks (recursive)
    function recomputeCost() {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        if (!task.subtasks || task.subtasks.length === 0) {
            task.cost = 0;
        } else {
            computeCostFromChildren(task);
        }
        $('#detail-cost').val(task.cost);
        updateSubtaskCostCells(task.subtasks || []);
        saveData();
        sendPatch({op: 'update', taskId: task.id, field: 'cost', value: task.cost});
    }

    function updateSubtaskCostCells(subtasks) {
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            if (st.subtasks && st.subtasks.length > 0) {
                // Show blank for parent subtask rows — computed value rolls up to header only
                $('#subtask-body input[data-field="cost"][data-id="' + st.id + '"]').val('');
                updateSubtaskCostCells(st.subtasks);
            }
        }
    }

    function computeCostFromChildren(node) {
        if (!node.subtasks || node.subtasks.length === 0) return;
        for (var i = 0; i < node.subtasks.length; i++) {
            computeCostFromChildren(node.subtasks[i]);
        }
        var sum = 0;
        for (var i = 0; i < node.subtasks.length; i++) {
            sum += (parseFloat(node.subtasks[i].cost) || 0);
        }
        node.cost = sum;
    }

    function clearPredecessorRefs(deletedId, list) {
        for (var i = 0; i < list.length; i++) {
            ensurePredecessorArray(list[i]);
            var idx = -1;
            for (var j = 0; j < list[i].predecessor.length; j++) {
                if (String(list[i].predecessor[j]) === String(deletedId)) { idx = j; break; }
            }
            if (idx !== -1) list[i].predecessor.splice(idx, 1);
            if (list[i].subtasks && list[i].subtasks.length) {
                clearPredecessorRefs(deletedId, list[i].subtasks);
            }
        }
    }

    function findParentOf(id, list, parent) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return { parent: parent, list: list, index: i };
            var found = findParentOf(id, list[i].subtasks || [], list[i]);
            if (found) return found;
        }
        return null;
    }

    // Walk the ancestor chain of taskId and recompute each ancestor's
    // percentComplete as the rounded average of its direct children.
    // Mirrors recompute_ancestor_percents in controllers_server.py so
    // local state stays consistent with the persisted JSON without
    // requiring an extra broadcast.
    function recomputeAncestorPercents(taskId) {
        var chain = [];
        function find(lst, target, current) {
            for (var i = 0; i < lst.length; i++) {
                var t = lst[i];
                if (t.id === target) {
                    for (var j = 0; j < current.length; j++) chain.push(current[j]);
                    return true;
                }
                var subs = t.subtasks || [];
                if (subs.length) {
                    current.push(t);
                    if (find(subs, target, current)) return true;
                    current.pop();
                }
            }
            return false;
        }
        find(tasks, taskId, []);
        for (var k = chain.length - 1; k >= 0; k--) {
            var anc = chain[k];
            var subs = anc.subtasks || [];
            if (subs.length) {
                var total = 0;
                for (var m = 0; m < subs.length; m++) {
                    var v = parseInt(subs[m].percentComplete, 10);
                    if (!isNaN(v)) total += v;
                }
                anc.percentComplete = Math.round(total / subs.length);
                // Also derive ancestor status from children
                var allNS = true, allC = true;
                for (var n = 0; n < subs.length; n++) {
                    var ss = subs[n].status;
                    if (ss !== 'Not Started') allNS = false;
                    if (ss !== 'Completed') allC = false;
                }
                if (allC) anc.status = 'Completed';
                else if (allNS) anc.status = 'Not Started';
                else anc.status = 'In Progress';
            }
        }
    }

    function getContactById(contactId) {
        for (var i = 0; i < contacts.length; i++) {
            if (contacts[i].id === contactId) return contacts[i];
        }
        return null;
    }

    function getInitials(name) {
        if (!name) return '?';
        var parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return parts[0][0].toUpperCase();
    }

    function getAvatarColor(contactId) {
        // Deterministic color from contact ID
        var hash = 0;
        for (var i = 0; i < contactId.length; i++) {
            hash = contactId.charCodeAt(i) + ((hash << 5) - hash);
        }
        return avatarColors[Math.abs(hash) % avatarColors.length];
    }

    // Ensure assignedTo is always an array (migration for old string data)
    function ensureAssignedArray(task) {
        if (!task.assignedTo) {
            task.assignedTo = [];
        } else if (typeof task.assignedTo === 'string') {
            task.assignedTo = task.assignedTo ? [task.assignedTo] : [];
        }
    }

    // Ensure predecessor is always an array (migration for old single-value data)
    function ensurePredecessorArray(task) {
        if (!task.predecessor) {
            task.predecessor = [];
        } else if (!Array.isArray(task.predecessor)) {
            task.predecessor = [task.predecessor];
        }
    }

    function statusClass(status) {
        return 'status-' + status.toLowerCase().replace(/\s+/g, '-');
    }

    // Display project name with underscores replaced by spaces
    function displayProjectName(name) {
        return (name || '').replace(/_/g, ' ');
    }

    // Project color-coding for visual distinction
    function getProjectColor(name) {
        var n = (name || '').toLowerCase();
        if (n.indexOf('assessment') !== -1 || n.indexOf('assesment') !== -1) {
            return { color: '#0E8A6D', label: 'ASM', tint: '#E6F5F0' };
        }
        if (n.indexOf('execution') !== -1) {
            return { color: '#D4513D', label: 'EXC', tint: '#FBEAE8' };
        }
        return null;
    }

    function isExecutionProject() {
        return (PROJ_NAME || '').toLowerCase().indexOf('execution') !== -1;
    }

    function isAssessmentProject() {
        var n = (PROJ_NAME || '').toLowerCase();
        return n.indexOf('assessment') !== -1 || n.indexOf('assesment') !== -1;
    }

    function isAssessmentOrExecutionProject() {
        return isAssessmentProject() || isExecutionProject();
    }

    function applyTitleBarColor(name) {
        var $label = $('#project-name-label');
        $label.empty();
        var pc = getProjectColor(name);
        if (pc) {
            var $badge = $('<span class="title-color-badge">').text(pc.label).css('background', pc.color);
            $label.append($badge);
        }
        $label.append($('<span class="title-name-text">').text(displayProjectName(name)));
        if (pc) {
            $label.append($('<span class="title-color-underline">').css('background', pc.color));
        }
    }

    function showToast(msg) {
        var $toast = $('<div class="toast">').text(msg).appendTo('body');
        setTimeout(function () {
            $toast.fadeOut(400, function () { $toast.remove(); });
        }, 2500);
    }


    // ========== Contact Picker Widget ==========
    function buildPickerChips($picker, assignedArr) {
        var $area = $picker.find('.cp-chips-area');
        $area.find('.cp-chip').remove();
        var $input = $area.find('.cp-filter-input');

        $.each(assignedArr, function (i, contactId) {
            var contact = getContactById(contactId);
            if (!contact) return;
            var initials = getInitials(contact.name);
            var color = getAvatarColor(contact.id);

            var $chip = $('<span class="cp-chip">')
                .attr('data-contact-id', contact.id);
            $chip.append(
                $('<span class="cp-avatar-sm">').css('background', color).text(initials)
            );
            $chip.append($('<span class="cp-chip-name">').text(contact.name));
            $chip.append($('<span class="cp-chip-remove">').html('&times;'));
            $input.before($chip);
        });

        // Update placeholder
        if (assignedArr.length > 0) {
            $input.attr('placeholder', '');
        } else {
            $input.attr('placeholder', 'Select...');
        }
    }

    function buildSubtaskPicker(subtaskId, assignedArr) {
        var $picker = $('<div class="contact-picker">')
            .attr('data-target', 'subtask')
            .attr('data-subtask-id', subtaskId);
        var $area = $('<div class="cp-chips-area">');
        var $input = $('<input type="text" class="cp-filter-input">').attr('placeholder', assignedArr.length > 0 ? '' : 'Select...');
        $area.append($input);
        $picker.append($area);
        $picker.append($('<button type="button" class="cp-dropdown-btn" tabindex="-1">').html('<i class="fa fa-caret-down"></i>'));

        // Build chips
        $.each(assignedArr, function (i, contactId) {
            var contact = getContactById(contactId);
            if (!contact) return;
            var initials = getInitials(contact.name);
            var color = getAvatarColor(contact.id);

            var $chip = $('<span class="cp-chip">')
                .attr('data-contact-id', contact.id);
            $chip.append($('<span class="cp-avatar-sm">').css('background', color).text(initials));
            $chip.append($('<span class="cp-chip-name">').text(contact.name));
            $chip.append($('<span class="cp-chip-remove">').html('&times;'));
            $input.before($chip);
        });

        return $picker;
    }

    // ========== Dropdown Rendering ==========
    function openContactDropdown($picker) {
        var $dropdown = $('#contact-dropdown');
        activePickerEl = $picker[0];

        // Determine which task/subtask this picker is for
        var targetType = $picker.attr('data-target');
        if (targetType === 'header') {
            activePickerTarget = { type: 'header' };
        } else {
            activePickerTarget = { type: 'subtask', id: parseInt($picker.attr('data-subtask-id')) };
        }

        $picker.addClass('cp-open');
        renderDropdownList('');
        positionDropdown($picker);
        $dropdown.show();
        $picker.find('.cp-filter-input').focus();
    }

    function closeContactDropdown() {
        $('#contact-dropdown').hide();
        if (activePickerEl) {
            $(activePickerEl).removeClass('cp-open');
            $(activePickerEl).find('.cp-filter-input').val('');
        }
        activePickerEl = null;
        activePickerTarget = null;
    }

    function positionDropdown($picker) {
        var $dropdown = $('#contact-dropdown');
        var rect = $picker[0].getBoundingClientRect();
        var top = rect.bottom + 2;
        var left = rect.left;

        // Keep within viewport
        if (left + 300 > window.innerWidth) {
            left = window.innerWidth - 310;
        }
        if (top + 340 > window.innerHeight) {
            top = rect.top - 342;
        }

        $dropdown.css({ top: top + 'px', left: left + 'px' });
    }

    function getAssignedArray() {
        if (!activePickerTarget) return [];
        if (activePickerTarget.type === 'header') {
            var task = findTaskById(selectedTaskId, tasks);
            if (!task) return [];
            ensureAssignedArray(task);
            return task.assignedTo;
        } else {
            var sub = findTaskById(activePickerTarget.id, tasks);
            if (!sub) return [];
            ensureAssignedArray(sub);
            return sub.assignedTo;
        }
    }

    function setAssignedArray(arr) {
        if (!activePickerTarget) return;
        var targetId;
        if (activePickerTarget.type === 'header') {
            var task = findTaskById(selectedTaskId, tasks);
            if (task) { task.assignedTo = arr; targetId = selectedTaskId; }
        } else {
            var sub = findTaskById(activePickerTarget.id, tasks);
            if (sub) { sub.assignedTo = arr; targetId = activePickerTarget.id; }
        }
        saveData();
        if (targetId) sendPatch({op: 'update', taskId: targetId, field: 'assignedTo', value: arr.slice()});
    }

    function renderDropdownList(filterText) {
        var $list = $('#contact-dropdown-list');
        $list.empty();

        var assigned = getAssignedArray();
        var filter = (filterText || '').toLowerCase();

        var matched = 0;
        $.each(contacts, function (i, contact) {
            if (filter && contact.name.toLowerCase().indexOf(filter) === -1 && contact.id.toLowerCase().indexOf(filter) === -1) {
                return; // skip
            }
            matched++;
            var isSelected = assigned.indexOf(contact.id) !== -1;
            var initials = getInitials(contact.name);
            var color = getAvatarColor(contact.id);

            var $item = $('<div class="contact-dropdown-item">')
                .attr('data-contact-id', contact.id)
                .toggleClass('selected', isSelected);

            $item.append($('<div class="cp-checkbox">'));
            $item.append($('<div class="cp-avatar">').css('background', color).text(initials));
            $item.append(
                $('<div class="contact-info">').append(
                    $('<div class="contact-info-name">').text(contact.name)
                ).append(
                    $('<div class="contact-info-id">').text(contact.id)
                )
            );

            $list.append($item);
        });

        if (matched === 0) {
            $list.append('<div class="contact-dropdown-empty">No contacts found</div>');
        }
    }

    // ========== Contact Picker Events ==========

    // Toggle dropdown on button click
    $(document).on('click', '.cp-dropdown-btn', function (e) {
        e.stopPropagation();
        var $picker = $(this).closest('.contact-picker');
        if ($picker.hasClass('cp-disabled')) return;
        if (activePickerEl === $picker[0]) {
            closeContactDropdown();
        } else {
            closeContactDropdown();
            openContactDropdown($picker);
        }
    });

    // Open dropdown when clicking the chips area
    $(document).on('click', '.cp-chips-area', function (e) {
        if ($(e.target).hasClass('cp-chip-remove') || $(e.target).closest('.cp-chip-remove').length) return;
        var $picker = $(this).closest('.contact-picker');
        if ($picker.hasClass('cp-disabled')) return;
        if (activePickerEl !== $picker[0]) {
            closeContactDropdown();
            openContactDropdown($picker);
        } else {
            $picker.find('.cp-filter-input').focus();
        }
    });

    // Filter on typing
    $(document).on('input', '.cp-filter-input', function () {
        if (!activePickerEl) return;
        renderDropdownList($(this).val());
    });

    // Toggle contact selection
    $(document).on('click', '.contact-dropdown-item', function (e) {
        e.stopPropagation();
        var contactId = $(this).attr('data-contact-id');
        var assigned = getAssignedArray();
        var idx = assigned.indexOf(contactId);
        if (idx !== -1) {
            assigned.splice(idx, 1);
        } else {
            assigned.push(contactId);
        }
        setAssignedArray(assigned);

        // Re-render dropdown
        var filterVal = $(activePickerEl).find('.cp-filter-input').val();
        renderDropdownList(filterVal);

        // Re-render chips in the picker
        var $picker = $(activePickerEl);
        buildPickerChips($picker, assigned);
    });

    // Remove chip
    $(document).on('click', '.cp-chip-remove', function (e) {
        e.stopPropagation();
        var $chip = $(this).closest('.cp-chip');
        var contactId = $chip.attr('data-contact-id');
        var $picker = $chip.closest('.contact-picker');
        if ($picker.hasClass('cp-disabled')) return;

        // Determine the task/subtask
        var targetType = $picker.attr('data-target');
        var taskObj;
        if (targetType === 'header') {
            taskObj = findTaskById(selectedTaskId, tasks);
        } else {
            var subId = parseInt($picker.attr('data-subtask-id'));
            taskObj = findTaskById(subId, tasks);
        }
        if (!taskObj) return;
        ensureAssignedArray(taskObj);

        var idx = taskObj.assignedTo.indexOf(contactId);
        if (idx !== -1) {
            taskObj.assignedTo.splice(idx, 1);
        }
        saveData();
        sendPatch({op: 'update', taskId: taskObj.id, field: 'assignedTo', value: taskObj.assignedTo.slice()});
        buildPickerChips($picker, taskObj.assignedTo);

        // If dropdown is open for this picker, re-render
        if (activePickerEl === $picker[0]) {
            var filterVal = $picker.find('.cp-filter-input').val();
            renderDropdownList(filterVal);
        }
    });

    // Close dropdown when clicking outside
    $(document).on('mousedown', function (e) {
        if (!activePickerEl) return;
        var $target = $(e.target);
        if ($target.closest('#contact-dropdown').length || $target.closest('.contact-picker').length) return;
        closeContactDropdown();
    });

    // Backspace on empty filter removes last chip
    $(document).on('keydown', '.cp-filter-input', function (e) {
        if (e.key === 'Backspace' && $(this).val() === '') {
            var $picker = $(this).closest('.contact-picker');
            var $lastChip = $picker.find('.cp-chip').last();
            if ($lastChip.length) {
                $lastChip.find('.cp-chip-remove').click();
            }
        }
        if (e.key === 'Escape') {
            closeContactDropdown();
        }
    });

    // Add New Contact
    $(document).on('click', '#btn-add-new-contact', function (e) {
        e.preventDefault();
        e.stopPropagation();
        $('#add-contact-dialog').show();
        $('#new-contact-name').val('').focus();
        $('#new-contact-id').val('');
    });

    $('#add-contact-cancel').on('click', function () {
        $('#add-contact-dialog').hide();
    });

    $('#add-contact-ok').on('click', function () {
        var name = $('#new-contact-name').val().trim();
        var id = $('#new-contact-id').val().trim();
        if (!name) { alert('Please enter a name.'); return; }
        if (!id) { alert('Please enter an ID.'); return; }
        // Check for duplicate id
        if (getContactById(id)) { alert('A contact with ID "' + id + '" already exists.'); return; }

        contacts.push({ id: id, name: name });
        saveContacts();
        $('#add-contact-dialog').hide();
        showToast('Contact "' + name + '" added');

        // Refresh dropdown if open
        if (activePickerEl) {
            var filterVal = $(activePickerEl).find('.cp-filter-input').val();
            renderDropdownList(filterVal);
        }
    });

    $('#new-contact-id').on('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('#add-contact-ok').click(); }
    });

    // ========== Predecessor Picker Widget ==========
    var activePredPickerTarget = null; // {type: 'header'} or {type: 'subtask', id: number}
    var activePredPickerEl = null;     // the .predecessor-picker DOM element

    function buildPredecessorLabel(predId) {
        if (!predId) return '';
        for (var ti = 0; ti < tasks.length; ti++) {
            if (String(tasks[ti].id) === String(predId)) {
                return tasks[ti].name || '';
            }
        }
        var globalRows = [];
        $.each(tasks, function (ti, t) {
            flattenSubtasks(t.subtasks, 0, globalRows, t.id);
        });
        for (var i = 0; i < globalRows.length; i++) {
            var pRow = globalRows[i];
            if (String(pRow.subtask.id) === String(predId)) {
                var parentObj = findTaskById(pRow.parentId, tasks);
                var parentName = parentObj ? (parentObj.name || '(unnamed)') : '(unnamed)';
                if (pRow.depth === 2) {
                    var gpInfo = findParentOf(pRow.parentId, tasks, null);
                    var gpName = (gpInfo && gpInfo.parent) ? (gpInfo.parent.name || '(unnamed)') : '(unnamed)';
                    var ggpInfo = gpInfo && gpInfo.parent ? findParentOf(gpInfo.parent.id, tasks, null) : null;
                    var ggpName = (ggpInfo && ggpInfo.parent) ? (ggpInfo.parent.name || '(unnamed)') : '(unnamed)';
                    return ggpName + ' > ' + gpName + ' > ' + parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
                }
                if (pRow.depth === 1) {
                    var gpInfo = findParentOf(pRow.parentId, tasks, null);
                    var gpName = (gpInfo && gpInfo.parent) ? (gpInfo.parent.name || '(unnamed)') : '(unnamed)';
                    return gpName + ' > ' + parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
                }
                return parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
            }
        }
        return '';
    }

    // Build breakdown badges showing each predecessor's working days contribution
    function buildEndDateBadges(taskObj) {
        var $wrap = $('<div class="end-date-badges">');
        if (!taskObj || !taskObj.predecessor || taskObj.predecessor.length === 0) return $wrap;
        if (!taskObj.endDate) return $wrap;

        var ownDays = getStoredDuration(taskObj);
        if (ownDays <= 0) return $wrap;

        // Row 1: TIMELINE action badge (own row, no other badges share space)
        var $row1 = $('<div class="edb-row edb-row-timeline">');
        var $infoBadge = $('<span class="edb-badge edb-timeline" tabindex="0">')
            .attr('data-timeline-info', taskObj.id)
            .attr('title', 'Show timeline: why this end date?')
            .html('<i class="fa fa-diagram-project"></i> TIMELINE');
        $row1.append($infoBadge);
        $wrap.append($row1);

        // Row 2: per-predecessor duration badges + self badge
        var $row2 = $('<div class="edb-row edb-row-contribs">');
        for (var i = 0; i < taskObj.predecessor.length; i++) {
            var pred = findTaskById(taskObj.predecessor[i], tasks);
            if (!pred) continue;
            var predDays = getStoredDuration(pred);
            var label = buildPredecessorLabel(taskObj.predecessor[i]);
            var pc = getPredColor(i);
            var $badge = $('<span class="edb-badge">')
                .css({ background: pc.bg, color: pc.text })
                .attr('title', label + ': ' + predDays + ' working days')
                .text('+' + predDays + 'd');
            $row2.append($badge);
        }
        var $selfBadge = $('<span class="edb-badge edb-self">')
            .attr('title', (taskObj.name || 'This task') + ': ' + ownDays + ' working days')
            .text('self +' + ownDays + 'd');
        $row2.append($selfBadge);
        $wrap.append($row2);

        return $wrap;
    }

    // Populate the header-level end date badges container. Badges are shown
    // only for Execution leaf tasks (no subtasks) that have predecessors —
    // mirrors the badges rendered under the END DATE in the subtask table.
    function updateHeaderEndDateBadges(task) {
        var $wrap = $('#detail-end-date-badges');
        if (!$wrap.length) return;
        $wrap.empty();
        if (!task) return;
        if (!isExecutionProject()) return;
        if (task.subtasks && task.subtasks.length > 0) return;
        if (!task.predecessor || task.predecessor.length === 0) return;
        var $badges = buildEndDateBadges(task);
        $wrap.append($badges.children());
    }

    // Gather everything the timeline dialog needs to render the schedule math
    function buildTimelineData(taskObj) {
        var data = {
            predecessors: [],
            latestPredEnd: '',
            effectiveStart: '',
            taskEndDate: taskObj ? (taskObj.endDate || '') : '',
            ownDays: getStoredDuration(taskObj),
            taskName: taskObj ? (taskObj.name || '(unnamed)') : ''
        };
        if (!taskObj || !taskObj.predecessor) return data;

        for (var i = 0; i < taskObj.predecessor.length; i++) {
            var predId = taskObj.predecessor[i];
            var pred = findTaskById(predId, tasks);
            if (!pred) continue;
            var predStart = pred.startDate || '';
            var predEnd = pred.endDate || '';
            if (!predEnd) {
                var pd = getStoredDuration(pred);
                if (pd > 0) {
                    var es = getEffectiveStartDate(pred);
                    if (es) { predEnd = addWorkingDays(es, pd); if (!predStart) predStart = es; }
                }
            }
            var upstreamLabels = [];
            var upstreamEffStart = '';
            if (pred.predecessor && pred.predecessor.length) {
                var upLatest = '';
                for (var ui = 0; ui < pred.predecessor.length; ui++) {
                    var upId = pred.predecessor[ui];
                    var upTask = findTaskById(upId, tasks);
                    if (!upTask) continue;
                    var upLabel = buildPredecessorLabel(upId);
                    if (upLabel) upstreamLabels.push(upLabel);
                    var upEnd = upTask.endDate || '';
                    if (!upEnd) {
                        var upDur = getStoredDuration(upTask);
                        var upEs = getEffectiveStartDate(upTask);
                        if (upDur > 0 && upEs) upEnd = addWorkingDays(upEs, upDur);
                    }
                    if (upEnd && upEnd > upLatest) upLatest = upEnd;
                }
                if (upLatest) upstreamEffStart = nextWorkingDay(upLatest);
            }
            data.predecessors.push({
                id: predId,
                label: buildPredecessorLabel(predId),
                startDate: predStart,
                endDate: predEnd,
                workingDays: getStoredDuration(pred),
                color: getPredColor(i),
                upstreamLabels: upstreamLabels,
                upstreamEffStart: upstreamEffStart
            });
            if (predEnd && predEnd > data.latestPredEnd) data.latestPredEnd = predEnd;
        }

        if (data.latestPredEnd) {
            data.effectiveStart = nextWorkingDay(data.latestPredEnd);
        } else {
            data.effectiveStart = taskObj.startDate || '';
        }
        if (!data.taskEndDate && data.effectiveStart && data.ownDays > 0) {
            data.taskEndDate = addWorkingDays(data.effectiveStart, data.ownDays);
        }
        return data;
    }

    // Click/keyboard handler for the TIMELINE badge
    $(document).on('mousedown click', '[data-timeline-info]', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.type !== 'click') return;
        var id = parseInt($(this).attr('data-timeline-info'), 10);
        var task = findTaskById(id, tasks);
        if (!task) return;
        openTimelineInfoDialog(task);
    });
    $(document).on('keydown', '[data-timeline-info]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });

    // Render the timeline popup
    function openTimelineInfoDialog(taskObj) {
        $('#timeline-info-dialog').remove();
        var data = buildTimelineData(taskObj);

        var $overlay = $('<div class="dialog-overlay" id="timeline-info-dialog">');
        var $box = $('<div class="dialog-box timeline-dialog">');
        $box.append($('<div class="dialog-title">').html(
            '<i class="fa fa-diagram-project" style="color:#2a5db0;margin-right:6px;"></i> Schedule Timeline &mdash; ' +
            $('<div>').text(data.taskName).html()
        ));

        var $body = $('<div class="timeline-body">');

        // Single centered lane — uniformly sized blocks stacked in predecessor
        // end-date order. Bars don't scale with duration; all stay legible.
        if (data.predecessors.length === 0 && !data.taskEndDate) {
            $body.append($('<div class="timeline-empty">').text('Not enough schedule data to render a timeline.'));
        } else {
            var ordered = data.predecessors.slice().sort(function (a, b) {
                return (a.endDate || '').localeCompare(b.endDate || '');
            });

            var $stack = $('<div class="timeline-stack">');
            $stack.append($('<div class="timeline-rail"><span class="timeline-rail-arrow"><i class="fa fa-arrow-down"></i></span></div>'));

            for (var pi = 0; pi < ordered.length; pi++) {
                var pr = ordered[pi];
                var $bar = $('<div class="timeline-bar timeline-bar-pred">')
                    .css({
                        background: pr.color.bg,
                        borderColor: pr.color.border,
                        color: pr.color.text
                    });
                $bar.append($('<div class="timeline-bar-label">').text(pr.label || ('Pred ' + (pi + 1))));
                var dateLine = (pr.startDate ? toDisplayDate(pr.startDate) : '—') + '  \u2192  ' + (pr.endDate ? toDisplayDate(pr.endDate) : '—');
                $bar.append($('<div class="timeline-bar-dates">').text(dateLine));
                var hasUpstream = pr.upstreamLabels && pr.upstreamLabels.length > 0;
                var metaText = pr.workingDays + ' working day' + (pr.workingDays === 1 ? '' : 's');
                if (hasUpstream) metaText += ' (own work only)';
                $bar.append($('<div class="timeline-bar-meta">').text(metaText));
                if (hasUpstream) {
                    var waitText = '\u21B3 waits on ' + pr.upstreamLabels.join(', ');
                    if (pr.upstreamEffStart) waitText += ' (starts ' + toDisplayDate(pr.upstreamEffStart) + ')';
                    $bar.append($('<div class="timeline-bar-upstream">').text(waitText));
                }
                $stack.append($bar);
            }

            // Handoff marker between latest predecessor end and effective start
            if (data.latestPredEnd && data.effectiveStart && data.latestPredEnd !== data.effectiveStart) {
                var $handoff = $('<div class="timeline-handoff-row">');
                $handoff.append($('<span class="timeline-handoff-arrow">').html('<i class="fa fa-arrow-down"></i>'));
                $handoff.append($('<span class="timeline-handoff-text">').text('next working day \u2192 ' + toDisplayDate(data.effectiveStart)));
                $stack.append($handoff);
            }

            // Task bar at the bottom
            if (data.effectiveStart && data.taskEndDate) {
                var $taskBar = $('<div class="timeline-bar timeline-bar-task">');
                $taskBar.append($('<div class="timeline-bar-label">').text(data.taskName));
                var tDateLine = toDisplayDate(data.effectiveStart) + '  \u2192  ' + toDisplayDate(data.taskEndDate);
                $taskBar.append($('<div class="timeline-bar-dates">').text(tDateLine));
                $taskBar.append($('<div class="timeline-bar-meta">').text('+' + data.ownDays + ' working day' + (data.ownDays === 1 ? '' : 's')));
                $stack.append($taskBar);
            }

            $body.append($stack);
        }

        // Legend / summary explaining the three computed values
        var $legend = $('<div class="timeline-legend">');
        $legend.append($('<div class="timeline-legend-title">').text('How this end date was computed'));

        var $row1 = $('<div class="timeline-legend-row">');
        $row1.append($('<span class="timeline-legend-key">').text('Latest predecessor end'));
        $row1.append($('<span class="timeline-legend-val">').text(data.latestPredEnd ? toDisplayDate(data.latestPredEnd) : '—'));
        $row1.append($('<span class="timeline-legend-desc">').text('The maximum end date among all predecessors — this task cannot start until every predecessor is completed.'));
        $legend.append($row1);

        var $row2 = $('<div class="timeline-legend-row">');
        $row2.append($('<span class="timeline-legend-key">').text('Effective start'));
        $row2.append($('<span class="timeline-legend-val">').text(data.effectiveStart ? toDisplayDate(data.effectiveStart) : '—'));
        $row2.append($('<span class="timeline-legend-desc">').text('The next working day after the latest predecessor end — weekends are skipped.'));
        $legend.append($row2);

        var $row3 = $('<div class="timeline-legend-row">');
        $row3.append($('<span class="timeline-legend-key">').text('End date'));
        $row3.append($('<span class="timeline-legend-val">').text(data.taskEndDate ? toDisplayDate(data.taskEndDate) : '—'));
        $row3.append($('<span class="timeline-legend-desc">').text('Effective start plus this task\u2019s own ' + data.ownDays + ' working day' + (data.ownDays === 1 ? '' : 's') + ' (Mon\u2013Fri only).'));
        $legend.append($row3);

        $body.append($legend);
        $box.append($body);

        var $actions = $('<div class="dialog-actions">');
        var $close = $('<button class="dialog-btn-primary">Close</button>');
        $close.on('click', function () { $overlay.remove(); });
        $actions.append($close);
        $box.append($actions);
        $overlay.append($box);
        $('body').append($overlay);
    }

    function buildPredecessorChips($picker, predArray, taskId) {
        var $area = $picker.find('.pp-chips-area');
        $area.find('.pp-chip').remove();
        var $input = $area.find('.pp-filter-input');

        $.each(predArray, function (i, predId) {
            var label = buildPredecessorLabel(predId);
            if (!label) return;
            var pc = getPredColor(i);
            var $chip = $('<span class="pp-chip">').attr('data-pred-id', predId)
                .css({ background: pc.bg, borderColor: pc.border, color: pc.text });
            $chip.append($('<span class="pp-chip-label">').text(label));
            $chip.append($('<span class="pp-chip-remove">').css('color', pc.text).html('&times;'));
            $input.before($chip);
        });

        if (predArray.length > 0) {
            $input.attr('placeholder', '');
        } else {
            $input.attr('placeholder', 'Select...');
        }
    }

    function buildSubtaskPredPicker(subtaskId, predArray) {
        var $picker = $('<div class="predecessor-picker">')
            .attr('data-target', 'subtask')
            .attr('data-subtask-id', subtaskId);
        var $area = $('<div class="pp-chips-area">');
        var $input = $('<input type="text" class="pp-filter-input">').attr('placeholder', predArray.length > 0 ? '' : 'Select...');
        $area.append($input);
        $picker.append($area);
        $picker.append($('<button type="button" class="pp-dropdown-btn" tabindex="-1">').html('<i class="fa fa-caret-down"></i>'));

        $.each(predArray, function (i, predId) {
            var label = buildPredecessorLabel(predId);
            if (!label) return;
            var pc = getPredColor(i);
            var $chip = $('<span class="pp-chip">').attr('data-pred-id', predId)
                .css({ background: pc.bg, borderColor: pc.border, color: pc.text });
            $chip.append($('<span class="pp-chip-label">').text(label));
            $chip.append($('<span class="pp-chip-remove">').css('color', pc.text).html('&times;'));
            $input.before($chip);
        });

        return $picker;
    }

    function getPredArray() {
        if (!activePredPickerTarget) return [];
        var task;
        if (activePredPickerTarget.type === 'header') {
            task = findTaskById(selectedTaskId, tasks);
        } else {
            task = findTaskById(activePredPickerTarget.id, tasks);
        }
        if (!task) return [];
        ensurePredecessorArray(task);
        return task.predecessor;
    }

    function setPredArray(arr) {
        if (!activePredPickerTarget) return;
        var targetId;
        if (activePredPickerTarget.type === 'header') {
            var task = findTaskById(selectedTaskId, tasks);
            if (task) { task.predecessor = arr; targetId = selectedTaskId; }
        } else {
            var sub = findTaskById(activePredPickerTarget.id, tasks);
            if (sub) { sub.predecessor = arr; targetId = activePredPickerTarget.id; }
        }
        saveData();
        if (targetId) sendPatch({op: 'update', taskId: targetId, field: 'predecessor', value: arr.slice()});
    }

    function openPredecessorDropdown($picker) {
        var $dropdown = $('#predecessor-dropdown');
        activePredPickerEl = $picker[0];

        var targetType = $picker.attr('data-target');
        if (targetType === 'header') {
            activePredPickerTarget = { type: 'header' };
        } else {
            activePredPickerTarget = { type: 'subtask', id: parseInt($picker.attr('data-subtask-id')) };
        }

        $picker.addClass('pp-open');
        $('#pred-search-filter').val('');
        renderPredDropdownList('');
        positionPredDropdown($picker);
        $dropdown.show();
        $('#pred-search-filter').focus();
    }

    function closePredecessorDropdown() {
        $('#predecessor-dropdown').hide();
        $('#pred-search-filter').val('');
        if (activePredPickerEl) {
            $(activePredPickerEl).removeClass('pp-open');
            $(activePredPickerEl).find('.pp-filter-input').val('');
        }
        activePredPickerEl = null;
        activePredPickerTarget = null;
    }

    function positionPredDropdown($picker) {
        var $dropdown = $('#predecessor-dropdown');
        var rect = $picker[0].getBoundingClientRect();
        var top = rect.bottom + 2;
        var left = rect.left;

        if (left + 340 > window.innerWidth) {
            left = window.innerWidth - 350;
        }
        if (top + 320 > window.innerHeight) {
            top = rect.top - 322;
        }

        $dropdown.css({ top: top + 'px', left: left + 'px' });
    }

    function renderPredDropdownList(filterText) {
        var $list = $('#pred-dropdown-list');
        $list.empty();

        var selectedPreds = getPredArray();
        var filter = (filterText || '').toLowerCase();

        // Determine the current task ID to exclude self
        var selfId = null;
        if (activePredPickerTarget) {
            selfId = activePredPickerTarget.type === 'header' ? selectedTaskId : activePredPickerTarget.id;
        }

        // Build global list of all tasks + subtasks with labels
        var allGlobalRows = [];
        $.each(tasks, function (ti, t) {
            if (t.name && t.name.trim()) {
                allGlobalRows.push({ subtask: t, depth: -1, parentId: null });
            }
            flattenSubtasks(t.subtasks, 0, allGlobalRows, t.id);
        });

        // Build label for each row and collect into sortable array
        var labeledRows = [];
        $.each(allGlobalRows, function (pi, pRow) {
            if (pRow.subtask.id === selfId) return; // skip self

            var label;
            if (pRow.depth === -1) {
                label = pRow.subtask.name;
            } else if (pRow.depth === 2) {
                var gpInfo = findParentOf(pRow.parentId, tasks, null);
                var gpName = (gpInfo && gpInfo.parent) ? (gpInfo.parent.name || '(unnamed)') : '(unnamed)';
                var ggpInfo = gpInfo && gpInfo.parent ? findParentOf(gpInfo.parent.id, tasks, null) : null;
                var ggpName = (ggpInfo && ggpInfo.parent) ? (ggpInfo.parent.name || '(unnamed)') : '(unnamed)';
                var parentObj = findTaskById(pRow.parentId, tasks);
                var parentName = parentObj ? (parentObj.name || '(unnamed)') : '(unnamed)';
                label = ggpName + ' > ' + gpName + ' > ' + parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
            } else if (pRow.depth === 1) {
                var gpInfo = findParentOf(pRow.parentId, tasks, null);
                var gpName = (gpInfo && gpInfo.parent) ? (gpInfo.parent.name || '(unnamed)') : '(unnamed)';
                var parentObj = findTaskById(pRow.parentId, tasks);
                var parentName = parentObj ? (parentObj.name || '(unnamed)') : '(unnamed)';
                label = gpName + ' > ' + parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
            } else {
                var parentObj = findTaskById(pRow.parentId, tasks);
                var parentName = parentObj ? (parentObj.name || '(unnamed)') : '(unnamed)';
                label = parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
            }

            if (filter && label.toLowerCase().indexOf(filter) === -1) return;
            labeledRows.push({ pRow: pRow, label: label });
        });

        // Sort alphabetically by label
        labeledRows.sort(function (a, b) {
            return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
        });

        $.each(labeledRows, function (i, item) {
            var isSelected = false;
            for (var s = 0; s < selectedPreds.length; s++) {
                if (String(selectedPreds[s]) === String(item.pRow.subtask.id)) { isSelected = true; break; }
            }

            var $item = $('<div class="pred-dropdown-item">')
                .attr('data-pred-id', item.pRow.subtask.id)
                .toggleClass('selected', isSelected);

            $item.append($('<div class="pp-checkbox">'));
            $item.append($('<span class="pred-label">').text(item.label));
            $list.append($item);
        });

        if (labeledRows.length === 0) {
            $list.append('<div class="pred-dropdown-empty">No tasks found</div>');
        }
    }

    // Predecessor picker events
    $(document).on('click', '.pp-dropdown-btn', function (e) {
        e.stopPropagation();
        var $picker = $(this).closest('.predecessor-picker');
        if ($picker.hasClass('pp-disabled')) return;
        if (activePredPickerEl === $picker[0]) {
            closePredecessorDropdown();
        } else {
            closePredecessorDropdown();
            closeContactDropdown();
            openPredecessorDropdown($picker);
        }
    });

    $(document).on('click', '.pp-chips-area', function (e) {
        if ($(e.target).hasClass('pp-chip-remove') || $(e.target).closest('.pp-chip-remove').length) return;
        var $picker = $(this).closest('.predecessor-picker');
        if ($picker.hasClass('pp-disabled')) return;
        if (activePredPickerEl !== $picker[0]) {
            closePredecessorDropdown();
            closeContactDropdown();
            openPredecessorDropdown($picker);
        } else {
            $picker.find('.pp-filter-input').focus();
        }
    });

    $(document).on('input', '.pp-filter-input', function () {
        if (!activePredPickerEl) return;
        var val = $(this).val();
        $('#pred-search-filter').val(val);
        renderPredDropdownList(val);
    });

    $(document).on('input', '#pred-search-filter', function () {
        if (!activePredPickerEl) return;
        renderPredDropdownList($(this).val());
    });

    $(document).on('click', '#pred-search-filter', function (e) {
        e.stopPropagation();
    });

    $(document).on('click', '.pred-dropdown-item', function (e) {
        e.stopPropagation();
        var predId = parseInt($(this).attr('data-pred-id'));
        var preds = getPredArray();
        var idx = -1;
        for (var i = 0; i < preds.length; i++) {
            if (String(preds[i]) === String(predId)) { idx = i; break; }
        }
        if (idx !== -1) {
            preds.splice(idx, 1);
        } else {
            preds.push(predId);
        }
        setPredArray(preds);

        // Recalculate end date for the task whose predecessors changed
        var changedTask = null;
        if (activePredPickerTarget.type === 'header') {
            changedTask = findTaskById(selectedTaskId, tasks);
        } else {
            changedTask = findTaskById(activePredPickerTarget.id, tasks);
        }
        if (changedTask) {
            var dur = getStoredDuration(changedTask);
            if (dur > 0) {
                var newEnd = computeEndDateFromDuration(changedTask, dur);
                if (newEnd) {
                    changedTask.endDate = newEnd;
                    saveData();
                    sendPatch({ op: 'update', taskId: changedTask.id, field: 'endDate', value: newEnd });
                    recalcDependents(changedTask.id);
                    // If this was the currently-displayed header task (leaf),
                    // refresh the END DATE input so the UI reflects the new value.
                    if (changedTask.id === selectedTaskId &&
                        !(changedTask.subtasks && changedTask.subtasks.length > 0)) {
                        $('#detail-end-date').val(toDisplayDate(newEnd));
                    }
                }
            }
        }

        var filterVal = $('#pred-search-filter').val() || $(activePredPickerEl).find('.pp-filter-input').val();
        renderPredDropdownList(filterVal);

        var $picker = $(activePredPickerEl);
        buildPredecessorChips($picker, preds);

        // Refresh subtask table to show updated end dates
        var parentTask = findTaskById(selectedTaskId, tasks);
        if (parentTask) {
            syncParentEndDate(parentTask);
            renderSubtaskTable(parentTask);
        }

        // Refresh header badges whenever the selected task's predecessors change
        if (activePredPickerTarget.type === 'header') {
            updateHeaderEndDateBadges(findTaskById(selectedTaskId, tasks));
        }
    });

    $(document).on('click', '.pp-chip-remove', function (e) {
        e.stopPropagation();
        var $chip = $(this).closest('.pp-chip');
        var predId = parseInt($chip.attr('data-pred-id'));
        var $picker = $chip.closest('.predecessor-picker');
        if ($picker.hasClass('pp-disabled')) return;

        var targetType = $picker.attr('data-target');
        var taskObj;
        if (targetType === 'header') {
            taskObj = findTaskById(selectedTaskId, tasks);
        } else {
            var subId = parseInt($picker.attr('data-subtask-id'));
            taskObj = findTaskById(subId, tasks);
        }
        if (!taskObj) return;
        ensurePredecessorArray(taskObj);

        var idx = -1;
        for (var i = 0; i < taskObj.predecessor.length; i++) {
            if (String(taskObj.predecessor[i]) === String(predId)) { idx = i; break; }
        }
        if (idx !== -1) taskObj.predecessor.splice(idx, 1);

        saveData();
        sendPatch({op: 'update', taskId: taskObj.id, field: 'predecessor', value: taskObj.predecessor.slice()});

        // Recalculate end date after predecessor removal
        var dur = getStoredDuration(taskObj);
        if (dur > 0) {
            var newEnd = computeEndDateFromDuration(taskObj, dur);
            if (newEnd) {
                taskObj.endDate = newEnd;
                saveData();
                sendPatch({ op: 'update', taskId: taskObj.id, field: 'endDate', value: newEnd });
                recalcDependents(taskObj.id);
                if (taskObj.id === selectedTaskId &&
                    !(taskObj.subtasks && taskObj.subtasks.length > 0)) {
                    $('#detail-end-date').val(toDisplayDate(newEnd));
                }
            }
        }

        buildPredecessorChips($picker, taskObj.predecessor);

        if (activePredPickerEl === $picker[0]) {
            var filterVal = $picker.find('.pp-filter-input').val();
            renderPredDropdownList(filterVal);
        }

        // Refresh subtask table to show updated end dates
        var parentTask = findTaskById(selectedTaskId, tasks);
        if (parentTask) {
            syncParentEndDate(parentTask);
            renderSubtaskTable(parentTask);
        }

        // Refresh header badges if the chip belonged to the header picker
        if (targetType === 'header') {
            updateHeaderEndDateBadges(findTaskById(selectedTaskId, tasks));
        }
    });

    // Close predecessor dropdown on outside click
    $(document).on('mousedown', function (e) {
        if (!activePredPickerEl) return;
        var $target = $(e.target);
        if ($target.closest('#predecessor-dropdown').length || $target.closest('.predecessor-picker').length) return;
        closePredecessorDropdown();
    });

    $(document).on('keydown', '.pp-filter-input', function (e) {
        if (e.key === 'Backspace' && $(this).val() === '') {
            var $picker = $(this).closest('.predecessor-picker');
            var $lastChip = $picker.find('.pp-chip').last();
            if ($lastChip.length) {
                $lastChip.find('.pp-chip-remove').click();
            }
        }
        if (e.key === 'Escape') {
            closePredecessorDropdown();
        }
    });

    // Also close predecessor dropdown when opening contact dropdown
    var _origOpenContactDropdown = openContactDropdown;
    openContactDropdown = function ($picker) {
        closePredecessorDropdown();
        _origOpenContactDropdown($picker);
    };

    // ========== Render Sidebar ==========
    // Check if CURRENT_USER_ID is assigned in a task or any of its subtasks (recursive)
    function isUserAssignedInTree(taskObj) {
        ensureAssignedArray(taskObj);
        if (taskObj.assignedTo.indexOf(CURRENT_USER_ID) !== -1) return true;
        if (taskObj.subtasks && taskObj.subtasks.length > 0) {
            for (var i = 0; i < taskObj.subtasks.length; i++) {
                if (isUserAssignedInTree(taskObj.subtasks[i])) return true;
            }
        }
        return false;
    }

    // Check if a task matches the text filter based on the selected filter mode
    function matchesTextFilter(task, filterText, filterBy) {
        if (!filterText || filterText.length < 3) return true; // not enough chars, show all
        var needle = filterText.toLowerCase();

        if (filterBy === 'all') {
            return (task.name || '').toLowerCase().indexOf(needle) !== -1 ||
                   subtaskNameMatches(task.subtasks || [], needle) ||
                   assigneeMatches(task, needle);
        }

        if (filterBy === 'task') {
            return (task.name || '').toLowerCase().indexOf(needle) !== -1;
        }

        if (filterBy === 'subtask') {
            return subtaskNameMatches(task.subtasks || [], needle);
        }

        if (filterBy === 'assignee') {
            return assigneeMatches(task, needle);
        }

        return true;
    }

    function subtaskNameMatches(subtasks, needle) {
        for (var i = 0; i < subtasks.length; i++) {
            if ((subtasks[i].name || '').toLowerCase().indexOf(needle) !== -1) return true;
            if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
                if (subtaskNameMatches(subtasks[i].subtasks, needle)) return true;
            }
        }
        return false;
    }

    function assigneeMatches(task, needle) {
        // Check parent task assignees
        ensureAssignedArray(task);
        if (assigneeListMatches(task.assignedTo, needle)) return true;
        // Check subtask assignees recursively
        return assigneeMatchesInSubtasks(task.subtasks || [], needle);
    }

    function assigneeMatchesInSubtasks(subtasks, needle) {
        for (var i = 0; i < subtasks.length; i++) {
            ensureAssignedArray(subtasks[i]);
            if (assigneeListMatches(subtasks[i].assignedTo, needle)) return true;
            if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
                if (assigneeMatchesInSubtasks(subtasks[i].subtasks, needle)) return true;
            }
        }
        return false;
    }

    function assigneeListMatches(assignedTo, needle) {
        for (var j = 0; j < assignedTo.length; j++) {
            var contactId = assignedTo[j];
            if (contactId.toLowerCase().indexOf(needle) !== -1) return true;
            var contact = getContactById(contactId);
            if (contact && contact.name.toLowerCase().indexOf(needle) !== -1) return true;
        }
        return false;
    }

    function renderTaskList() {
        var $list = $('#task-list');
        $list.empty();

        var filterMine = $('#filter-my-tasks').is(':checked');
        var filterText = ($('#filter-text').val() || '').trim();
        var filterBy = 'all';

        if (tasks.length === 0) {
            $list.append('<div style="padding:20px 16px;color:#999;font-size:13px;text-align:center;">No tasks yet.<br>Click "New Task" to get started.</div>');
            return;
        }

        // Sort alphabetically by name (case-insensitive), unnamed tasks go to end
        var sorted = tasks.slice().sort(function (a, b) {
            var nameA = (a.name || '').toLowerCase();
            var nameB = (b.name || '').toLowerCase();
            if (!nameA && !nameB) return 0;
            if (!nameA) return 1;
            if (!nameB) return -1;
            return nameA.localeCompare(nameB);
        });

        var visibleCount = 0;
        $.each(sorted, function (i, task) {
            if (filterMine && !isUserAssignedInTree(task)) return;
            if (!matchesTextFilter(task, filterText, filterBy)) return;
            visibleCount++;

            var $item = $('<div class="task-item">')
                .attr('data-task-id', task.id)
                .toggleClass('active', task.id === selectedTaskId);

            var nameText = task.name || '';
            var $name = $('<div class="task-item-name">');
            if (nameText) {
                $name.text(nameText);
            } else {
                $name.append($('<span class="unnamed">').text('Untitled Task'));
            }
            $item.append($name);

            var $meta = $('<div class="task-item-meta">');
            if (task.flagged) {
                $meta.append('<span class="flag-icon"><i class="fa fa-flag"></i></span>');
            }
            if (task.startDate) {
                $meta.append('<span class="date-text"><i class="fa fa-calendar"></i> ' + formatDate(task.startDate) + '</span>');
            }
            if (task.status) {
                $meta.append('<span class="task-item-status ' + statusClass(task.status) + '">' + task.status + '</span>');
            }
            $item.append($meta);
            $list.append($item);
        });

        if (visibleCount === 0) {
            var msg = filterMine ? 'No tasks assigned to you.' : 'No tasks match the filter.';
            $list.append('<div style="padding:20px 16px;color:#999;font-size:13px;text-align:center;">' + msg + '</div>');
        }
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        var d = new Date(dateStr + 'T00:00:00');
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return months[d.getMonth()] + ' ' + d.getDate();
    }

    // Convert yyyy-mm-dd to mm/dd/yyyy for display
    function toDisplayDate(iso) {
        if (!iso) return '';
        var parts = iso.split('-');
        if (parts.length !== 3) return iso;
        return parts[1] + '/' + parts[2] + '/' + parts[0];
    }

    // Convert mm/dd/yyyy to yyyy-mm-dd for storage
    function toIsoDate(display) {
        if (!display) return '';
        var parts = display.split('/');
        if (parts.length !== 3) return '';
        var mm = parts[0].padStart(2, '0');
        var dd = parts[1].padStart(2, '0');
        var yyyy = parts[2];
        if (yyyy.length === 2) yyyy = '20' + yyyy;
        return yyyy + '-' + mm + '-' + dd;
    }

    // Auto-format date input: insert slashes as user types
    function setupDateAutoFormat($input) {
        $input.on('keydown', function (e) {
            if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Tab' ||
                e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.ctrlKey || e.metaKey) return;
            var val = $(this).val();
            if (!/^\d$/.test(e.key)) { e.preventDefault(); return; }
            if (val.length === 2 || val.length === 5) {
                $(this).val(val + '/');
            }
            if (val.length >= 10) { e.preventDefault(); }
        });
    }

    // Count working days (Mon-Fri) between two ISO date strings, inclusive
    function calcDuration(startIso, endIso) {
        if (!startIso || !endIso) return '';
        var s = new Date(startIso + 'T00:00:00');
        var e = new Date(endIso + 'T00:00:00');
        if (isNaN(s.getTime()) || isNaN(e.getTime())) return '';
        if (e < s) return '0d';
        var count = 0;
        var cur = new Date(s);
        while (cur <= e) {
            var day = cur.getDay(); // 0=Sun, 6=Sat
            if (day !== 0 && day !== 6) count++;
            cur.setDate(cur.getDate() + 1);
        }
        return count + 'd';
    }

    // Add working days to a start date and return the end ISO date string
    function addWorkingDays(startIso, numDays) {
        var cur = new Date(startIso + 'T00:00:00');
        if (numDays <= 0) return startIso;
        var count = 0;
        while (true) {
            var day = cur.getDay();
            if (day !== 0 && day !== 6) {
                count++;
                if (count === numDays) break;
            }
            cur.setDate(cur.getDate() + 1);
        }
        return cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
    }

    // Return the next working day (Mon-Fri) after a given ISO date
    function nextWorkingDay(isoDate) {
        var cur = new Date(isoDate + 'T00:00:00');
        cur.setDate(cur.getDate() + 1);
        while (cur.getDay() === 0 || cur.getDay() === 6) {
            cur.setDate(cur.getDate() + 1);
        }
        return cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
    }

    // Get the effective start date for a task considering its predecessor chain.
    // If predecessors exist, effective start = next working day after the latest predecessor end date.
    // Uses a visited set to prevent circular references.
    function getEffectiveStartDate(taskObj, visited) {
        if (!visited) visited = {};
        if (!taskObj) return '';
        if (visited[taskObj.id]) return taskObj.startDate || ''; // circular ref guard
        visited[taskObj.id] = true;

        ensurePredecessorArray(taskObj);
        if (!taskObj.predecessor || taskObj.predecessor.length === 0) {
            return taskObj.startDate || '';
        }

        var maxEndDate = '';
        for (var i = 0; i < taskObj.predecessor.length; i++) {
            var pred = findTaskById(taskObj.predecessor[i], tasks);
            if (!pred) continue;

            var predEnd = pred.endDate || '';
            // If predecessor has no end date but has working days set,
            // try to compute it from its own chain
            if (!predEnd) {
                var predDays = getStoredDuration(pred);
                if (predDays > 0) {
                    var effStart = getEffectiveStartDate(pred, visited);
                    if (effStart) predEnd = addWorkingDays(effStart, predDays);
                }
            }

            if (predEnd && predEnd > maxEndDate) {
                maxEndDate = predEnd;
            }
        }

        if (maxEndDate) {
            return nextWorkingDay(maxEndDate);
        }
        return taskObj.startDate || '';
    }

    // Compute end date from duration, accounting for predecessors (Execution only)
    function computeEndDateFromDuration(taskObj, numDays) {
        var startDate;
        if (isExecutionProject()) {
            startDate = getEffectiveStartDate(taskObj);
        } else {
            startDate = taskObj.startDate || '';
        }
        if (!startDate) return '';
        return addWorkingDays(startDate, numDays);
    }

    // Get the stored working days for a task.
    // Uses _workingDays if available (user-entered), otherwise falls back to calcDuration.
    function getStoredDuration(taskObj) {
        if (!taskObj) return 0;
        if (taskObj._workingDays && taskObj._workingDays > 0) return taskObj._workingDays;
        if (!taskObj.startDate || !taskObj.endDate) return 0;
        var dur = calcDuration(taskObj.startDate, taskObj.endDate);
        if (!dur) return 0;
        var num = parseInt(dur.replace(/[^0-9]/g, ''));
        return isNaN(num) ? 0 : num;
    }

    // Recalculate end dates for all tasks that depend on changedTaskId, cascading
    function recalcDependents(changedTaskId, visited) {
        if (!visited) visited = {};
        if (visited[changedTaskId]) return;
        visited[changedTaskId] = true;

        // Flatten ALL tasks and subtasks in the project
        var allItems = [];
        function collectAll(list) {
            for (var i = 0; i < list.length; i++) {
                allItems.push(list[i]);
                if (list[i].subtasks && list[i].subtasks.length > 0) {
                    collectAll(list[i].subtasks);
                }
            }
        }
        collectAll(tasks);

        for (var i = 0; i < allItems.length; i++) {
            var item = allItems[i];
            ensurePredecessorArray(item);
            var dependsOnChanged = false;
            for (var j = 0; j < item.predecessor.length; j++) {
                if (String(item.predecessor[j]) === String(changedTaskId)) {
                    dependsOnChanged = true;
                    break;
                }
            }
            if (!dependsOnChanged) continue;

            // This item depends on the changed task — recalculate its end date
            var dur = getStoredDuration(item);
            if (dur > 0) {
                var newEnd = computeEndDateFromDuration(item, dur);
                if (newEnd && newEnd !== item.endDate) {
                    item.endDate = newEnd;
                    saveData();
                    sendPatch({ op: 'update', taskId: item.id, field: 'endDate', value: newEnd });
                    // Cascade to anything depending on this item
                    recalcDependents(item.id, visited);
                }
            }
        }
    }

    // Snapshot current endDate of every intermediate (has-children) subtask
    // so we can detect which ones change after a sync pass.
    function snapshotIntermediateEndDates(subtasks, out) {
        out = out || {};
        if (!subtasks) return out;
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            if (st.subtasks && st.subtasks.length > 0) {
                out[st.id] = st.endDate || '';
                snapshotIntermediateEndDates(st.subtasks, out);
            }
        }
        return out;
    }

    // Broadcast patches for intermediate subtasks whose endDate changed vs. snapshot.
    function patchChangedIntermediateEndDates(subtasks, before) {
        if (!subtasks) return;
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            if (st.subtasks && st.subtasks.length > 0) {
                var oldVal = before[st.id] || '';
                var newVal = st.endDate || '';
                if (oldVal !== newVal) {
                    sendPatch({op: 'update', taskId: st.id, field: 'endDate', value: newVal});
                }
                patchChangedIntermediateEndDates(st.subtasks, before);
            }
        }
    }

    // Snapshot current startDate of every intermediate (has-children) subtask
    // so we can detect which ones change after a sync pass.
    function snapshotIntermediateStartDates(subtasks, out) {
        out = out || {};
        if (!subtasks) return out;
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            if (st.subtasks && st.subtasks.length > 0) {
                out[st.id] = st.startDate || '';
                snapshotIntermediateStartDates(st.subtasks, out);
            }
        }
        return out;
    }

    // Broadcast patches for intermediate subtasks whose startDate changed vs. snapshot.
    function patchChangedIntermediateStartDates(subtasks, before) {
        if (!subtasks) return;
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            if (st.subtasks && st.subtasks.length > 0) {
                var oldVal = before[st.id] || '';
                var newVal = st.startDate || '';
                if (oldVal !== newVal) {
                    sendPatch({op: 'update', taskId: st.id, field: 'startDate', value: newVal});
                }
                patchChangedIntermediateStartDates(st.subtasks, before);
            }
        }
    }

    // Collect the minimum start date from leaf subtasks (recursive).
    // Intermediate subtasks (with children) get their startDate synced from children.
    function getMinSubtaskStartDate(subtasks) {
        var minIso = '';
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            var candidate;
            if (st.subtasks && st.subtasks.length > 0) {
                candidate = getMinSubtaskStartDate(st.subtasks);
                if (candidate) st.startDate = candidate;
            } else {
                candidate = st.startDate || '';
            }
            if (candidate && (!minIso || candidate < minIso)) {
                minIso = candidate;
            }
        }
        return minIso;
    }

    // Collect the maximum end date from leaf subtasks (recursive).
    // Intermediate subtasks (with children) get their endDate synced from children.
    function getMaxSubtaskEndDate(subtasks) {
        var maxIso = '';
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            if (st.subtasks && st.subtasks.length > 0) {
                // Intermediate node: derive endDate from children, not its own stale value
                var childMax = getMaxSubtaskEndDate(st.subtasks);
                if (childMax) st.endDate = childMax;
                if (childMax && childMax > maxIso) {
                    maxIso = childMax;
                }
            } else {
                // Leaf node: use its own endDate
                if (st.endDate && st.endDate > maxIso) {
                    maxIso = st.endDate;
                }
            }
        }
        return maxIso;
    }

    // Sync parent task END DATE field: disable + auto-populate when subtasks exist
    function syncParentEndDate(task) {
        if (!task) return;
        var hasSubtasks = task.subtasks && task.subtasks.length > 0;
        var $endDate = $('#detail-end-date');
        var $endBtn = $endDate.siblings('.date-picker-btn');
        var $endHidden = $endDate.siblings('.date-hidden-picker');

        var oldEndDate = task.endDate || '';
        var newEndDate;

        var $duration = $('#detail-duration');
        if (hasSubtasks) {
            newEndDate = getMaxSubtaskEndDate(task.subtasks); // may be '' if no subtask has a date yet
            task.endDate = newEndDate;
            $endDate.val(toDisplayDate(newEndDate));
            $endDate.prop('disabled', true);
            $endBtn.prop('disabled', true).css('pointer-events', 'none');
            $endHidden.prop('disabled', true);
            $duration.val('');
            $duration.prop('readonly', true).css({background: '#f7f9fc', color: '#666', cursor: 'default'});
        } else {
            newEndDate = task.endDate || '';
            $endDate.val(toDisplayDate(newEndDate));
            if (isExecutionProject()) {
                $endDate.prop('disabled', true);
                $endBtn.prop('disabled', true).css('pointer-events', 'none');
                $endHidden.prop('disabled', true);
            } else {
                $endDate.prop('disabled', false);
                $endBtn.prop('disabled', false).css('pointer-events', '');
                $endHidden.prop('disabled', false);
            }
            $duration.prop('readonly', false).css({background: '#fff', color: '#333', cursor: ''});
        }
        $duration.val(calcDuration(task.startDate, task.endDate));

        // Only save if the end date actually changed
        if (newEndDate !== oldEndDate) {
            saveData();
            sendPatch({op: 'update', taskId: task.id, field: 'endDate', value: newEndDate});
        }
    }

    // Sync parent task START DATE field: for ASSESSMENT and EXECUTION projects,
    // when the task has children subtasks, auto-derive startDate from MIN of
    // descendants and disable editing. Mirrors syncParentEndDate (which uses MAX).
    function syncParentStartDate(task) {
        if (!task) return;
        if (!isAssessmentOrExecutionProject()) return;
        var hasSubtasks = task.subtasks && task.subtasks.length > 0;
        if (!hasSubtasks) return;

        var $startDate = $('#detail-start-date');
        var $startBtn = $startDate.siblings('.date-picker-btn');
        var $startHidden = $startDate.siblings('.date-hidden-picker');

        var oldStartDate = task.startDate || '';
        var newStartDate = getMinSubtaskStartDate(task.subtasks);
        task.startDate = newStartDate;
        $startDate.val(toDisplayDate(newStartDate));
        $startDate.prop('disabled', true);
        $startBtn.prop('disabled', true).css('pointer-events', 'none');
        $startHidden.prop('disabled', true);

        $('#detail-duration').val(calcDuration(task.startDate, task.endDate));

        if (newStartDate !== oldStartDate) {
            saveData();
            sendPatch({op: 'update', taskId: task.id, field: 'startDate', value: newStartDate});
        }
    }

    // Calendar icon click: open hidden date picker
    $(document).on('click', '.date-picker-btn', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var $hidden = $(this).siblings('.date-hidden-picker');
        // Sync current text value into hidden picker
        var $text = $(this).siblings('input[type="text"]');
        var iso = toIsoDate($text.val());
        if (iso) $hidden.val(iso);
        $hidden.css({ opacity: 0, pointerEvents: 'auto', width: 'auto', height: 'auto' });
        $hidden[0].showPicker();
    });

    // When a date is picked from hidden input, format into text field
    $(document).on('change', '.date-hidden-picker', function () {
        var iso = $(this).val();
        var targetSel = $(this).attr('data-target');
        if (targetSel) {
            // Header date fields
            $(targetSel).val(toDisplayDate(iso)).trigger('change');
        } else {
            // Subtask date fields — find sibling text input
            $(this).siblings('input[type="text"]').val(toDisplayDate(iso)).trigger('change');
        }
    });

    // Re-hide the date picker on blur
    $(document).on('blur', '.date-hidden-picker', function () {
        $(this).css({ opacity: 0, pointerEvents: 'none', width: 0, height: 0 });
    });

    // ========== Render Detail ==========
    function renderDetail() {
        closeContactDropdown();
        closePredecessorDropdown();

        if (selectedTaskId === null) {
            $('#empty-state').show();
            $('#task-detail').hide();
            return;
        }

        var task = findTaskById(selectedTaskId, tasks);
        if (!task) {
            selectedTaskId = null;
            $('#empty-state').show();
            $('#task-detail').hide();
            return;
        }

        ensureAssignedArray(task);

        $('#empty-state').hide();
        $('#task-detail').show();

        // Expand Notes and Attachments card by default
        $('#btn-toggle-desc-docs').removeClass('collapsed');
        $('#desc-docs-body').removeClass('collapsed');
        $('#btn-toggle-desc-docs').closest('.desc-docs-header').removeClass('no-border');

        // Fill header fields
        $('#detail-task-name').val(task.name);
        $('#detail-start-date').val(toDisplayDate(task.startDate));
        $('#detail-end-date').val(toDisplayDate(task.endDate));
        if (task.subtasks && task.subtasks.length > 0) {
            // Header duration is set by syncParentEndDate (calcDuration from dates)
            $('#detail-duration').val('').prop('readonly', true).addClass('pct-auto');
        } else {
            $('#detail-duration').val((task._workingDays && task._workingDays > 0) ? task._workingDays + 'd' : calcDuration(task.startDate, task.endDate)).prop('readonly', false).removeClass('pct-auto');
        }
        if (task.subtasks && task.subtasks.length > 0) {
            $('#detail-status').val(task.status).prop('disabled', true);
        } else {
            $('#detail-status').val(task.status).prop('disabled', false);
        }
        $('#detail-percent').val(task.percentComplete);
        var _pctHasChildren = task.subtasks && task.subtasks.length > 0;
        var _pctLockedByExec = isExecutionProject() && !isStartDateEnabled(task);
        if (_pctHasChildren || _pctLockedByExec) {
            $('#detail-percent').prop('readonly', true).addClass('pct-auto');
        } else {
            $('#detail-percent').prop('readonly', false).removeClass('pct-auto');
        }
        if (task.subtasks && task.subtasks.length > 0) {
            // Rolled-up cost from descendants — display but lock from direct edit.
            $('#detail-cost').val(task.cost).prop('disabled', true).addClass('pct-auto');
        } else {
            $('#detail-cost').val(task.cost).prop('disabled', false).removeClass('pct-auto');
        }
        $('#btn-flag-task').toggleClass('flagged', task.flagged);

        // Build header predecessor chips
        ensurePredecessorArray(task);
        var $predPicker = $('#detail-predecessor-picker');
        $predPicker.attr('data-target', 'header');
        if (task.subtasks && task.subtasks.length > 0) {
            buildPredecessorChips($predPicker, [], task.id);
            $predPicker.addClass('pp-disabled');
            $predPicker.find('.pp-filter-input').prop('readonly', true).attr('placeholder', '');
        } else {
            buildPredecessorChips($predPicker, task.predecessor, task.id);
            $predPicker.removeClass('pp-disabled');
            $predPicker.find('.pp-filter-input').prop('readonly', false).attr('placeholder', 'Select...');
        }

        // Build header assigned picker chips
        var $headerPicker = $('#detail-assigned-picker');
        if (task.subtasks && task.subtasks.length > 0) {
            buildPickerChips($headerPicker, []);
            $headerPicker.addClass('cp-disabled');
            $headerPicker.find('.cp-filter-input').prop('readonly', true).attr('placeholder', '');
        } else {
            buildPickerChips($headerPicker, task.assignedTo);
            $headerPicker.removeClass('cp-disabled');
            $headerPicker.find('.cp-filter-input').prop('readonly', false).attr('placeholder', 'Select...');
        }

        // Populate description and attachments
        $('#detail-description').val(task.description || '');
        renderTaskAttachments(task);

        if (task.name && task.name.trim() !== '') {
            $('#btn-add-subtask').show();
        } else {
            $('#btn-add-subtask').hide();
        }

        // Check button: visible to gs6368 on Assessment or Execution projects
        if (CURRENT_USER_ID === 'gs6368' && (isAssessmentProject() || isExecutionProject())) {
            $('#btn-check-data').show();
        } else {
            $('#btn-check-data').hide();
        }

        // Sync dates first: intermediate subtask start/endDates are derived from
        // their children before the table renders, so rows show correct dates.
        syncParentStartDate(task);
        syncParentEndDate(task);

        renderSubtaskTable(task);

        // Header predecessor badges (Execution leaf tasks with predecessors)
        updateHeaderEndDateBadges(task);

        // For Execution projects, disable date controls based on enable state
        if (isExecutionProject()) {
            var startEnabled = isStartDateEnabled(task);
            var hasSubtasksForStart = task.subtasks && task.subtasks.length > 0;

            // Start Date: disabled unless explicitly enabled; always disabled when
            // it has subtasks (auto-derived by syncParentStartDate in asm/exec).
            var $startDate = $('#detail-start-date');
            var $startBtn = $startDate.siblings('.date-picker-btn');
            var $startHidden = $startDate.siblings('.date-hidden-picker');
            if (!startEnabled || hasSubtasksForStart) {
                $startDate.prop('disabled', true);
                $startBtn.prop('disabled', true).css('pointer-events', 'none');
                $startHidden.prop('disabled', true);
            } else {
                $startDate.prop('disabled', false);
                $startBtn.prop('disabled', false).css('pointer-events', '');
                $startHidden.prop('disabled', false);
            }

            // End Date: always disabled for Execution projects
            var $endDate = $('#detail-end-date');
            var $endBtn = $endDate.siblings('.date-picker-btn');
            var $endHidden = $endDate.siblings('.date-hidden-picker');
            $endDate.prop('disabled', true);
            $endBtn.prop('disabled', true).css('pointer-events', 'none');
            $endHidden.prop('disabled', true);

            // Status: disabled if has subtasks, or if start dates not enabled
            var $status = $('#detail-status');
            if ((task.subtasks && task.subtasks.length > 0) || !startEnabled) {
                $status.prop('disabled', true);
            } else {
                $status.prop('disabled', false);
            }
        }

        updateEnableStartDateBtn();
    }

    // ========== Render Subtask Table ==========
    function renderSubtaskTable(parentTask) {
        var $body = $('#subtask-body');
        $body.empty();

        var allRows = [];
        flattenSubtasks(parentTask.subtasks, 0, allRows, parentTask.id);

        if (allRows.length === 0) {
            $('#subtask-empty').show();
            $('.subtask-table-wrapper').hide();
        } else {
            $('#subtask-empty').hide();
            $('.subtask-table-wrapper').show();
        }

        // Build connector info for continuous tree lines (matching view.html behaviour)
        function hasMoreAtLevel(rowIdx, level) {
            for (var i = rowIdx + 1; i < allRows.length; i++) {
                var d = allRows[i].depth;
                if (d < level) return false;
                if (d === level) return true;
            }
            return false;
        }
        var rowConnectors = [];
        for (var ri = 0; ri < allRows.length; ri++) {
            var rd = allRows[ri].depth;
            var rConnectors = [];
            for (var L = 0; L <= rd; L++) {
                var hasMore = hasMoreAtLevel(ri, L);
                rConnectors.push(L === rd ? (hasMore ? 'branch' : 'last') : (hasMore ? 'vline' : 'spacer'));
            }
            rowConnectors.push(rConnectors);
        }

        $.each(allRows, function (idx, row) {
            var st = row.subtask;
            var depth = row.depth;
            var isLast = row.isLast;

            ensureAssignedArray(st);

            var _hasChildrenForRow = st.subtasks && st.subtasks.length > 0;
            var $tr = $('<tr>').attr('data-subtask-id', st.id);
            if (_hasChildrenForRow) $tr.addClass('subtask-row-parent');

            // Task Name cell with tree connector
            var $nameCell = $('<td>');
            var depthClass = 'tree-cell depth-' + depth;
            var $treeCell = $('<div>').addClass(depthClass);

            // Connector spans first — must come before reorder arrows so all
            // rows share the same horizontal line positions regardless of whether
            // arrows are present.
            var connList = rowConnectors[idx];
            for (var ci = 0; ci < connList.length; ci++) {
                var ctype = connList[ci];
                var lvl = ' level-' + ci;
                if (ctype === 'branch') {
                    $treeCell.append($('<span class="tree-connector has-more' + lvl + '">'));
                } else if (ctype === 'last') {
                    $treeCell.append($('<span class="tree-connector' + lvl + '">'));
                } else if (ctype === 'vline') {
                    $treeCell.append($('<span class="tree-vline' + lvl + '">'));
                } else {
                    $treeCell.append($('<span class="tree-spacer' + lvl + '">'));
                }
            }

            // Reorder arrows (visible on hover) — placed after connectors
            if (row.siblingCount > 1) {
                var $arrows = $('<span class="subtask-reorder-arrows">');
                if (!row.isFirst) {
                    $arrows.append(
                        $('<button class="subtask-reorder-btn" title="Move up" tabindex="-1">')
                            .attr('data-reorder-id', st.id)
                            .attr('data-reorder-dir', 'up')
                            .html('<i class="fa fa-caret-up"></i>')
                    );
                } else {
                    $arrows.append($('<span class="subtask-reorder-spacer">'));
                }
                if (!row.isLast) {
                    $arrows.append(
                        $('<button class="subtask-reorder-btn" title="Move down" tabindex="-1">')
                            .attr('data-reorder-id', st.id)
                            .attr('data-reorder-dir', 'down')
                            .html('<i class="fa fa-caret-down"></i>')
                    );
                } else {
                    $arrows.append($('<span class="subtask-reorder-spacer">'));
                }
                $treeCell.append($arrows);
            }

            var $nameWrap = $('<span class="tree-cell-name">');
            var $nameInput = $('<input type="text">')
                .attr('placeholder', depth === 0 ? 'Subtask name...' : depth === 1 ? 'Sub-subtask name...' : 'Sub-sub-subtask name...')
                .val(st.name)
                .attr('data-field', 'name')
                .attr('data-id', st.id);
            $nameWrap.append($nameInput);
            if (depth < 2 && st.name && st.name.trim() !== '') {
                $nameWrap.append(
                    $('<button class="row-action-btn btn-add-child-inline" title="Add sub-subtask" tabindex="-1">')
                        .attr('data-add-child', st.id)
                        .html('<i class="fa fa-plus"></i>')
                );
            }
            $treeCell.append($nameWrap);
            $nameCell.append($treeCell);
            $tr.append($nameCell);

            // Subtasks with children get their Start/End Date auto-computed from
            // the min/max date of their descendant leaves (set by
            // syncParentStartDate/syncParentEndDate prior to render).
            var hasChildren = st.subtasks && st.subtasks.length > 0;

            // Start Date — disabled for Execution projects without start-date
            // enable, OR for intermediate rows (has children) in Assessment/
            // Execution projects (value is auto-computed in that case).
            var $startWrap = $('<div class="subtask-date-wrap">');
            var $startInput = $('<input type="text" placeholder="mm/dd/yyyy">').val(toDisplayDate(st.startDate)).attr('data-field', 'startDate').attr('data-id', st.id);
            setupDateAutoFormat($startInput);
            var $startHidden = $('<input type="date" class="date-hidden-picker" tabindex="-1">').val(st.startDate);
            var $startBtn = $('<button type="button" class="date-picker-btn" tabindex="-1">').html('<i class="fa fa-calendar-days"></i>');
            if ((isExecutionProject() && !isStartDateEnabled(parentTask)) || (isAssessmentOrExecutionProject() && hasChildren)) {
                $startInput.prop('disabled', true);
                $startBtn.prop('disabled', true).css('pointer-events', 'none');
                $startHidden.prop('disabled', true);
            }
            $startWrap.append($startInput).append($startHidden).append($startBtn);
            $tr.append($('<td>').append($startWrap));

            // End Date — disabled for Execution projects or when this subtask
            // has its own children (value is auto-computed in that case).
            var $endWrap = $('<div class="subtask-date-wrap">');
            var $endInput = $('<input type="text" placeholder="mm/dd/yyyy">').val(toDisplayDate(st.endDate)).attr('data-field', 'endDate').attr('data-id', st.id);
            setupDateAutoFormat($endInput);
            var $endHidden = $('<input type="date" class="date-hidden-picker" tabindex="-1">').val(st.endDate);
            var $endBtn = $('<button type="button" class="date-picker-btn" tabindex="-1">').html('<i class="fa fa-calendar-days"></i>');
            if (isExecutionProject() || hasChildren) {
                $endInput.prop('disabled', true);
                $endBtn.prop('disabled', true).css('pointer-events', 'none');
                $endHidden.prop('disabled', true);
            }
            $endWrap.append($endInput).append($endHidden).append($endBtn);
            var $endTd = $('<td>').append($endWrap);
            // Add predecessor breakdown badges under end date (Execution projects only)
            if (isExecutionProject() && st.predecessor && st.predecessor.length > 0 && st.endDate) {
                $endTd.append(buildEndDateBadges(st));
            }
            $tr.append($endTd);

            // Duration — editable if no children, blank+readonly if has children
            var durText = hasChildren ? '' : ((st._workingDays && st._workingDays > 0) ? st._workingDays + 'd' : calcDuration(st.startDate, st.endDate));
            var $durInput = $('<input type="text">').val(durText)
                .attr('data-field', 'duration')
                .attr('data-id', st.id)
                .css({ textAlign: 'right' });
            if (hasChildren) {
                // Match the disabled style of the other parent-row columns
                // (predecessor, % cmplt, status, assigned to, cost) — #f0f0f0 / #999.
                $durInput.prop('readonly', true).css({ background: '#f0f0f0', color: '#999', cursor: 'not-allowed' });
            } else {
                $durInput.attr('placeholder', 'e.g. 30');
            }
            $tr.append($('<td>').append($durInput));

            // Predecessor — chip picker (disabled for parents with children)
            ensurePredecessorArray(st);
            var $predTd = $('<td>');
            var $subtaskPredPicker = buildSubtaskPredPicker(st.id, st.predecessor);
            if (hasChildren) {
                $subtaskPredPicker.addClass('pp-disabled');
                $subtaskPredPicker.find('.pp-filter-input').prop('readonly', true).attr('placeholder', '');
            }
            $predTd.append($subtaskPredPicker);
            $tr.append($predTd);

            // % Complete — blank for parents with children, value for leaves
            var $pctInput = $('<input type="text">').val(hasChildren ? '' : st.percentComplete).attr('data-field', 'percentComplete').attr('data-id', st.id).css('text-align', 'center');
            if (hasChildren) {
                $pctInput.prop('readonly', true).addClass('pct-auto');
            } else if (isExecutionProject() && !isStartDateEnabled(parentTask)) {
                $pctInput.prop('readonly', true).addClass('pct-auto');
            }
            $tr.append($('<td>').append($pctInput));

            // Status — blank readonly input for parents with children, select for leaves
            var $statusTd = $('<td>');
            if (hasChildren) {
                var $statusBlank = $('<input type="text">').val('').attr('data-field', 'status').attr('data-id', st.id)
                    .prop('readonly', true).addClass('pct-auto');
                $statusTd.append($statusBlank);
            } else {
                var $select = $('<select>').attr('data-field', 'status').attr('data-id', st.id);
                ['Not Started', 'In Progress', 'Completed', 'On Hold', 'Cancelled'].forEach(function (s) {
                    $select.append($('<option>').val(s).text(s).prop('selected', s === st.status));
                });
                if (isExecutionProject() && !isStartDateEnabled(parentTask)) {
                    $select.prop('disabled', true);
                }
                $statusTd.append($select);
            }
            $tr.append($statusTd);

            // Assigned To — contact picker (disabled for parents with children)
            var $assignedTd = $('<td>');
            var $subtaskPicker = buildSubtaskPicker(st.id, st.assignedTo);
            if (hasChildren) {
                $subtaskPicker.addClass('cp-disabled');
                $subtaskPicker.find('.cp-filter-input').prop('readonly', true).attr('placeholder', '');
            }
            $assignedTd.append($subtaskPicker);
            $tr.append($assignedTd);

            // Cost
            var $costTd = $('<td>');
            var $costWrap = $('<div class="subtask-cost-wrap">');
            $costWrap.append($('<i class="fa fa-dollar-sign cost-icon-sub">'));
            var $costInput = $('<input type="text">').val(hasChildren ? '' : st.cost).attr('data-field', 'cost').attr('data-id', st.id);
            if (hasChildren) {
                $costInput.prop('readonly', true).addClass('pct-auto');
            } else {
                $costInput.attr('placeholder', '0');
            }
            $costWrap.append($costInput);
            $costTd.append($costWrap);
            $tr.append($costTd);

            // Actions
            var $actions = $('<td>');
            var $actWrap = $('<div class="row-actions">');

            $actWrap.append(
                $('<button class="row-action-btn btn-delete" title="Delete" tabindex="-1">')
                    .attr('data-delete-subtask', st.id)
                    .html('<i class="fa fa-trash"></i>')
            );

            $actions.append($actWrap);
            $tr.append($actions);

            $body.append($tr);
        });

        // After DOM is built, sync tree-cell heights to actual row heights
        // (rows may be taller than 36px due to contact/predecessor chips)
        setTimeout(syncTreeCellHeights, 0);
        observeSubtaskDOMChanges();
    }

    // Reset tree-cell heights to natural, measure the resulting row heights
    // (now driven purely by other columns' content), then set tree-cells to
    // match.  Done in one synchronous pass to avoid visible flicker.
    function syncTreeCellHeights() {
        var treeCells = document.querySelectorAll('#subtask-table tbody .tree-cell');
        var i;
        // Step 1: clear explicit heights so tree-cells don't inflate the row
        for (i = 0; i < treeCells.length; i++) treeCells[i].style.height = '';
        // Step 2: force a synchronous layout recalc
        void document.body.offsetHeight;
        // Step 3: read the natural row height and apply to each tree-cell
        var rows = document.querySelectorAll('#subtask-table tbody tr');
        for (i = 0; i < rows.length; i++) {
            var h = rows[i].offsetHeight + 'px';
            var cell = rows[i].querySelector('.tree-cell');
            if (cell) cell.style.height = h;
        }
    }

    // MutationObserver on the subtask table body.  Watches for child-list
    // changes only (chip elements being added/removed) — NOT attribute
    // changes, so our own style.height writes never re-trigger the observer.
    var _subtaskMutObs, _syncTimer;
    function observeSubtaskDOMChanges() {
        if (_subtaskMutObs) _subtaskMutObs.disconnect();
        var body = document.getElementById('subtask-body');
        if (!body) return;
        _subtaskMutObs = new MutationObserver(function () {
            clearTimeout(_syncTimer);
            _syncTimer = setTimeout(syncTreeCellHeights, 30);
        });
        _subtaskMutObs.observe(body, { childList: true, subtree: true });
    }

    // ========== Column Resize for Subtask Table ==========
    (function initColumnResize() {
        var $table = $('#subtask-table');
        var dragging = null; // { $th, startX, startW }

        function addResizeHandles() {
            $table.find('.col-resize-handle').remove();
            $table.find('thead th').each(function () {
                var $th = $(this);
                if ($th.hasClass('col-actions')) return; // skip last actions col
                var $handle = $('<div class="col-resize-handle"></div>');
                $th.append($handle);
            });
        }

        // Insert handles on first load and whenever thead might re-render
        addResizeHandles();

        // Mousedown on handle starts drag
        $table.on('mousedown', '.col-resize-handle', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var $th = $(this).closest('th');
            dragging = {
                $th: $th,
                startX: e.pageX,
                startW: $th.outerWidth()
            };
            $(this).addClass('resizing');
            $('body').css({ cursor: 'col-resize', userSelect: 'none' });
        });

        $(document).on('mousemove', function (e) {
            if (!dragging) return;
            var diff = e.pageX - dragging.startX;
            var newW = Math.max(50, dragging.startW + diff);
            dragging.$th.css('width', newW + 'px');
            // Also set matching td widths via col index
            var idx = dragging.$th.index();
            $table.find('tbody tr').each(function () {
                $(this).children('td').eq(idx).css('width', newW + 'px');
            });
        });

        $(document).on('mouseup', function () {
            if (!dragging) return;
            $('.col-resize-handle').removeClass('resizing');
            $('body').css({ cursor: '', userSelect: '' });
            dragging = null;
        });

        // Re-add handles after subtask table re-renders
        var origRender = window._colResizePatched;
        if (!origRender) {
            var observer = new MutationObserver(function () {
                addResizeHandles();
            });
            var tbody = document.getElementById('subtask-body');
            if (tbody) {
                observer.observe(tbody, { childList: true });
            }
            // Also observe for when wrapper becomes visible
            window._colResizePatched = true;
        }
    })();

    function flattenSubtasks(subtasks, depth, result, parentId) {
        $.each(subtasks, function (i, st) {
            var isLast = (i === subtasks.length - 1);
            var isFirst = (i === 0);
            result.push({ subtask: st, depth: depth, isLast: isLast, isFirst: isFirst, parentId: parentId, siblingIndex: i, siblingCount: subtasks.length });
            if (st.subtasks && st.subtasks.length > 0 && depth < 2) {
                flattenSubtasks(st.subtasks, depth + 1, result, st.id);
            }
        });
    }

    // ========== Event Handlers ==========

    // Create new task (local only until named)
    $('#btn-new-task').on('click', function () {
        var task = createTaskObj('');
        task._pendingAdd = true; // not yet broadcast
        tasks.push(task);
        selectedTaskId = task.id;
        renderTaskList();
        renderDetail();
        setTimeout(function () { $('#detail-task-name').focus(); }, 50);
    });

    // Select task from sidebar
    // Remove any unnamed pending tasks before switching
    function cleanupUnnamedTasks() {
        for (var i = tasks.length - 1; i >= 0; i--) {
            if (tasks[i]._pendingAdd && (!tasks[i].name || !tasks[i].name.trim())) {
                tasks.splice(i, 1);
            }
        }
    }

    $(document).on('click', '.task-item', function () {
        cleanupUnnamedTasks();
        var id = parseInt($(this).attr('data-task-id'));
        selectedTaskId = id;
        renderTaskList();
        renderDetail();
    });

    // Filter: show only my assigned tasks
    $('#filter-my-tasks').on('change', function () {
        var filterMine = $(this).is(':checked');
        if (filterMine) {
            // Select the first visible task in the filtered list
            var firstMatch = null;
            for (var i = 0; i < tasks.length; i++) {
                if (isUserAssignedInTree(tasks[i])) { firstMatch = tasks[i]; break; }
            }
            selectedTaskId = firstMatch ? firstMatch.id : null;
        }
        renderTaskList();
        renderDetail();
    });

    // Text filter: on-the-fly filtering with debounce
    var filterDebounceTimer = null;
    $('#filter-text').on('input', function () {
        if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
        filterDebounceTimer = setTimeout(function () {
            filterDebounceTimer = null;
            renderTaskList();
            // If selected task is no longer visible, select the first visible one
            if (selectedTaskId !== null && !$('#task-list .task-item[data-task-id="' + selectedTaskId + '"]').length) {
                var $first = $('#task-list .task-item').first();
                selectedTaskId = $first.length ? parseInt($first.attr('data-task-id')) : null;
                renderTaskList();
                renderDetail();
            }
        }, 250);
    });

    // Update parent task header fields — local update on input
    $('#detail-task-name').on('input', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        task.name = $(this).val();
        if (task.name && task.name.trim() !== '') {
            $('#btn-add-subtask').show();
        } else {
            $('#btn-add-subtask').hide();
        }
        // For already-saved tasks, debounce the name update to server
        if (!task._pendingAdd) {
            saveData();
            var tid = task.id;
            sendPatchDebounced('name-' + tid, function () {
                var t = findTaskById(tid, tasks);
                return t ? {op: 'update', taskId: tid, field: 'name', value: t.name} : null;
            });
        }
        renderTaskList();
    });

    // Broadcast on blur — handles pending addTask and name-cleared deleteTask
    $('#detail-task-name').on('blur', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        var tid = task.id;
        if (task._pendingAdd && task.name && task.name.trim()) {
            // Task now has a name — broadcast addTask
            delete task._pendingAdd;
            saveData();
            sendPatch({op: 'addTask', task: JSON.parse(JSON.stringify(task))});
        } else if (!task._pendingAdd && (!task.name || !task.name.trim())) {
            // Name cleared on a previously saved task — delete from server
            task._pendingAdd = true;
            saveData();
            sendPatch({op: 'deleteTask', taskId: tid});
        }
    });

    $('#detail-start-date').on('change blur', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        var iso = toIsoDate($(this).val());
        if (iso === task.startDate) return;
        task.startDate = iso;
        // Recalculate end date if duration exists
        var dur = getStoredDuration(task);
        if (dur > 0 && !(task.subtasks && task.subtasks.length > 0)) {
            var newEnd = computeEndDateFromDuration(task, dur);
            if (newEnd) {
                task.endDate = newEnd;
                $('#detail-end-date').val(toDisplayDate(newEnd));
                sendPatch({op: 'update', taskId: task.id, field: 'endDate', value: newEnd});
                recalcDependents(task.id);
            }
        }
        $('#detail-duration').val(calcDuration(task.startDate, task.endDate));
        saveData();
        sendPatch({op: 'update', taskId: task.id, field: 'startDate', value: iso});
        renderTaskList();
    });

    $('#detail-end-date').on('change blur', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        // If subtasks exist, end date is managed automatically — ignore manual edits
        if (task.subtasks && task.subtasks.length > 0) return;
        var iso = toIsoDate($(this).val());
        if (iso === task.endDate) return;
        task.endDate = iso;
        $('#detail-duration').val(calcDuration(task.startDate, task.endDate));
        saveData();
        sendPatch({op: 'update', taskId: task.id, field: 'endDate', value: iso});
    });

    // Duration input: compute end date from start date + duration
    $('#detail-duration').on('change blur', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        if (task.subtasks && task.subtasks.length > 0) return;
        var raw = $(this).val().replace(/[^0-9]/g, '');
        if (!raw) return;
        var days = parseInt(raw);
        if (isNaN(days) || days < 0) return;
        var isExec = isExecutionProject();
        var effStart = isExec ? getEffectiveStartDate(task) : (task.startDate || '');
        if (!effStart && !isExec) {
            alert('Indicate the Start Date first.');
            $(this).val(calcDuration(task.startDate, task.endDate));
            return;
        }
        task._workingDays = days;
        if (effStart) {
            var iso = addWorkingDays(effStart, days);
            task.endDate = iso;
            $('#detail-end-date').val(toDisplayDate(iso));
            sendPatch({op: 'update', taskId: task.id, field: 'endDate', value: iso});
        }
        $(this).val(days + 'd');
        saveData();
        sendPatch({op: 'update', taskId: task.id, field: '_workingDays', value: days});
        recalcDependents(task.id);
        updateHeaderEndDateBadges(task);
    });

    // Setup auto-format for header date inputs
    setupDateAutoFormat($('#detail-start-date'));
    setupDateAutoFormat($('#detail-end-date'));

    $('#detail-status').on('change', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        task.status = $(this).val();
        if (!task.subtasks || task.subtasks.length === 0) {
            if (task.status === 'Completed') {
                task.percentComplete = 100;
                $('#detail-percent').val(100);
            } else if (task.status === 'Not Started') {
                task.percentComplete = 0;
                $('#detail-percent').val(0);
            }
        }
        saveData();
        sendPatch({op: 'update', taskId: task.id, field: 'status', value: task.status});
        if (!task.subtasks || task.subtasks.length === 0) {
            sendPatch({op: 'update', taskId: task.id, field: 'percentComplete', value: task.percentComplete});
        }
        renderTaskList();
    });

    $('#detail-percent').on('input', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        if (task.subtasks && task.subtasks.length > 0) return;
        var pctVal = parseInt($(this).val()) || 0;
        if (pctVal > 100) {
            alert('The maximum percent completion should only be 100%');
            $(this).val(task.percentComplete);
            return;
        }
        if (pctVal < 0) pctVal = 0;
        task.percentComplete = pctVal;
        // Derive status: 100 ⇒ Completed, <100 ⇒ In Progress.
        // Only the % CMPLT patch is broadcast — receivers mirror this
        // derivation (server, other design tabs, view.html).
        var derivedStatus = (pctVal >= 100) ? 'Completed' : (pctVal === 0) ? 'Not Started' : 'In Progress';
        if (task.status !== derivedStatus) {
            task.status = derivedStatus;
            $('#detail-status').val(derivedStatus);
        }
        saveData();
        var tid = task.id;
        sendPatchDebounced('pct-' + tid, function () {
            var t = findTaskById(tid, tasks);
            return t ? {op: 'update', taskId: tid, field: 'percentComplete', value: t.percentComplete} : null;
        });
    });

    $('#detail-cost').on('input', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        if (task.subtasks && task.subtasks.length > 0) return;
        task.cost = $(this).val();
        saveData();
        var tid = task.id;
        sendPatchDebounced('cost-' + tid, function () {
            var t = findTaskById(tid, tasks);
            return t ? {op: 'update', taskId: tid, field: 'cost', value: t.cost} : null;
        });
    });

    // ========== Description and Documents ==========
    // Collapse/Expand toggle
    $('#btn-toggle-desc-docs').on('click', function () {
        var $btn = $(this);
        var $body = $('#desc-docs-body');
        var $header = $btn.closest('.desc-docs-header');
        $btn.toggleClass('collapsed');
        $body.toggleClass('collapsed');
        if ($body.hasClass('collapsed')) {
            $header.addClass('no-border');
        } else {
            $header.removeClass('no-border');
        }
    });

    // Description save
    $('#detail-description').on('input', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        task.description = $(this).val();
        saveData();
        var tid = task.id;
        sendPatchDebounced('desc-' + tid, function () {
            var t = findTaskById(tid, tasks);
            return t ? {op: 'update', taskId: tid, field: 'description', value: t.description} : null;
        });
    });

    // Attachment helpers
    function getTaskFileIcon(mimeType) {
        if (!mimeType) return 'fa-file';
        if (mimeType.indexOf('image') !== -1) return 'fa-file-image';
        if (mimeType.indexOf('pdf') !== -1) return 'fa-file-pdf';
        if (mimeType.indexOf('word') !== -1 || mimeType.indexOf('document') !== -1) return 'fa-file-word';
        if (mimeType.indexOf('sheet') !== -1 || mimeType.indexOf('excel') !== -1) return 'fa-file-excel';
        if (mimeType.indexOf('text') !== -1 || mimeType.indexOf('csv') !== -1) return 'fa-file-lines';
        return 'fa-file';
    }

    function formatTaskFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function renderTaskAttachments(task) {
        var attachments = task.attachments || [];
        var $list = $('#task-attachment-list');
        $list.empty();

        if (attachments.length === 0) {
            $('#task-attachments-placeholder').show();
        } else {
            $('#task-attachments-placeholder').hide();
            $.each(attachments, function (i, att) {
                var icon = getTaskFileIcon(att.type);
                var sizeStr = formatTaskFileSize(att.size);
                var isUploaded = !!att.storedName;
                var $item = $('<div class="task-att-item">').attr('data-task-att-index', i);
                $item.append('<i class="fa ' + icon + '"></i>');
                if (isUploaded) {
                    var safeProjName = PROJ_NAME.replace(/[^A-Za-z0-9_\-]/g, '');
                    var $link = $('<a class="att-name" target="_blank">')
                        .attr('href', '/api/files/' + safeProjName + '/' + att.storedName)
                        .text(att.name);
                    $item.append($link);
                } else {
                    $item.append($('<span class="att-name">').text(att.name));
                }
                $item.append($('<span class="att-size">').text(sizeStr));
                $item.append($('<span class="att-remove" title="Remove"><i class="fa fa-xmark"></i></span>'));
                $list.append($item);
            });
        }
    }

    function uploadTaskFile(file, task) {
        if (!task.attachments) task.attachments = [];

        // Add placeholder entry with uploading state
        var attIndex = task.attachments.length;
        task.attachments.push({
            name: file.name,
            size: file.size,
            type: file.type,
            storedName: '',
            uploading: true
        });

        // Hide placeholder, show list
        $('#task-attachments-placeholder').hide();

        // Build progress row
        var icon = getTaskFileIcon(file.type);
        var $item = $('<div class="task-att-item uploading">').attr('data-task-att-index', attIndex);
        $item.append('<i class="fa ' + icon + '"></i>');
        $item.append($('<span class="att-name">').text(file.name));
        $item.append($('<span class="att-size">').text(formatTaskFileSize(file.size)));
        var $progress = $('<div class="att-progress"><div class="att-progress-bar"></div></div>');
        $item.append($progress);
        $('#task-attachment-list').append($item);

        // Upload via XHR for progress tracking
        var formData = new FormData();
        formData.append('file', file);
        formData.append('project', PROJ_NAME);

        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload', true);

        xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) {
                var pct = Math.round((e.loaded / e.total) * 100);
                $item.find('.att-progress-bar').css('width', pct + '%');
            }
        };

        xhr.onload = function () {
            if (xhr.status === 200) {
                try {
                    var resp = JSON.parse(xhr.responseText);
                    if (resp.ok) {
                        task.attachments[attIndex].storedName = resp.storedName;
                        task.attachments[attIndex].uploading = false;
                        saveData();
                        sendPatch({op: 'update', taskId: task.id, field: 'attachments', value: task.attachments.slice()});
                        renderTaskAttachments(task);
                        return;
                    }
                } catch (e) { /* fall through */ }
            }
            // Upload failed — remove from list
            task.attachments.splice(attIndex, 1);
            renderTaskAttachments(task);
            showToast('Upload failed for "' + file.name + '"');
        };

        xhr.onerror = function () {
            task.attachments.splice(attIndex, 1);
            renderTaskAttachments(task);
            showToast('Upload failed for "' + file.name + '"');
        };

        xhr.send(formData);
    }

    function processTaskFiles(files) {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        if (!files || files.length === 0) return;

        var allowed = /^(image\/|application\/pdf|application\/msword|application\/vnd\.openxmlformats|application\/vnd\.ms-excel|text\/)/;
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (!allowed.test(file.type) && !file.name.match(/\.(csv|txt|doc|docx|xls|xlsx|pdf)$/i)) {
                showToast('File "' + file.name + '" is not an allowed type.');
                continue;
            }
            uploadTaskFile(file, task);
        }
    }

    // File input handler
    $('#task-attach-input').on('change', function () {
        processTaskFiles(this.files);
        $(this).val('');
    });

    // Remove attachment (also deletes from server)
    $(document).on('click', '.task-att-item .att-remove', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        var $item = $(this).closest('.task-att-item');
        var idx = parseInt($item.attr('data-task-att-index'));
        if (!task.attachments || idx >= task.attachments.length) return;

        var att = task.attachments[idx];
        // Delete from server if it was uploaded
        if (att.storedName) {
            $.ajax({
                url: '/api/delete-file',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ project: PROJ_NAME, storedName: att.storedName })
            });
        }
        task.attachments.splice(idx, 1);
        renderTaskAttachments(task);
        saveData();
        sendPatch({op: 'update', taskId: task.id, field: 'attachments', value: task.attachments.slice()});
    });

    // Drag and drop on task attachments area
    $('#task-attachments-area').on('dragover', function (e) {
        e.preventDefault();
        $(this).addClass('drag-over');
    }).on('dragleave', function () {
        $(this).removeClass('drag-over');
    }).on('drop', function (e) {
        e.preventDefault();
        $(this).removeClass('drag-over');
        processTaskFiles(e.originalEvent.dataTransfer.files);
    });

    // Flag toggle
    $('#btn-flag-task').on('click', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        task.flagged = !task.flagged;
        $(this).toggleClass('flagged', task.flagged);
        saveData();
        sendPatch({op: 'update', taskId: task.id, field: 'flagged', value: task.flagged});
        renderTaskList();
    });

    // Delete task — show custom confirmation dialog
    $('#btn-delete-task').on('click', function () {
        if (!selectedTaskId) return;
        var task = findTaskById(selectedTaskId, tasks);
        var name = (task && task.name) ? task.name : 'Untitled Task';
        $('#delete-task-name').text(name);
        $('#delete-task-dialog').show();
    });

    $('#delete-task-cancel').on('click', function () {
        $('#delete-task-dialog').hide();
    });

    $('#delete-task-confirm').on('click', function () {
        $('#delete-task-dialog').hide();
        var deletedId = selectedTaskId;
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].id === deletedId) {
                tasks.splice(i, 1);
                break;
            }
        }
        selectedTaskId = tasks.length > 0 ? tasks[0].id : null;
        saveData();
        sendPatch({op: 'deleteTask', taskId: deletedId});
        renderTaskList();
        renderDetail();
        showToast('Task deleted');
    });

    // Add subtask
    $('#btn-add-subtask').on('click', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        var hadSubtasks = task.subtasks && task.subtasks.length > 0;
        var sub = createTaskObj('');
        sub._pendingAdd = true;
        sub._parentId = task.id;
        task.subtasks.push(sub);
        // When the first subtask is added, clear parent predecessor, assignedTo, cost, status
        if (!hadSubtasks) {
            task.predecessor = [];
            task.assignedTo = [];
            task.cost = '';
            task.status = 'Not Started';
            sendPatch({op: 'update', taskId: task.id, field: 'predecessor', value: []});
            sendPatch({op: 'update', taskId: task.id, field: 'assignedTo', value: []});
            sendPatch({op: 'update', taskId: task.id, field: 'cost', value: ''});
            sendPatch({op: 'update', taskId: task.id, field: 'status', value: 'Not Started'});
        }
        recomputePercentComplete();
        recomputeStatus();
        recomputeWorkingDays();
        recomputeCost();
        renderDetail();
        setTimeout(function () {
            var $inputs = $('#subtask-body input[data-field="name"]');
            $inputs.last().focus();
        }, 50);
    });

    // Add sub-subtask
    $(document).on('click', '[data-add-child]', function () {
        var parentSubId = parseInt($(this).attr('data-add-child'));
        var parentSub = findTaskById(parentSubId, tasks);
        if (!parentSub) return;
        var hadChildren = parentSub.subtasks && parentSub.subtasks.length > 0;
        var child = createTaskObj('');
        child._pendingAdd = true;
        child._parentId = parentSubId;
        parentSub.subtasks.push(child);
        // When the first child is added, clear this subtask's predecessor, assignedTo, cost, status
        if (!hadChildren) {
            parentSub.predecessor = [];
            parentSub.assignedTo = [];
            parentSub.cost = '';
            parentSub.status = 'Not Started';
            sendPatch({op: 'update', taskId: parentSub.id, field: 'predecessor', value: []});
            sendPatch({op: 'update', taskId: parentSub.id, field: 'assignedTo', value: []});
            sendPatch({op: 'update', taskId: parentSub.id, field: 'cost', value: ''});
            sendPatch({op: 'update', taskId: parentSub.id, field: 'status', value: 'Not Started'});
        }
        recomputePercentComplete();
        recomputeStatus();
        recomputeWorkingDays();
        recomputeCost();
        renderDetail();
        setTimeout(function () {
            var $newInput = $('#subtask-body input[data-field="name"][data-id="' + child.id + '"]');
            if ($newInput.length) $newInput.focus();
            else $('#subtask-body input[data-field="name"]').last().focus();
        }, 50);
    });

    // Delete subtask — show confirmation dialog
    var pendingDeleteSubtaskId = null;
    $(document).on('click', '[data-delete-subtask]', function () {
        var subId = parseInt($(this).attr('data-delete-subtask'));
        var sub = findTaskById(subId, tasks);
        if (!sub) return;
        pendingDeleteSubtaskId = subId;
        var displayName = (sub.name && sub.name.trim()) ? sub.name.trim() : '(unnamed)';
        $('#delete-subtask-name').text('"' + displayName + '"?');
        var hasChildren = sub.subtasks && sub.subtasks.length > 0;
        $('#delete-subtask-warning').toggle(hasChildren);
        $('#delete-subtask-dialog').show();
    });

    $('#delete-subtask-cancel').on('click', function () {
        pendingDeleteSubtaskId = null;
        $('#delete-subtask-dialog').hide();
    });

    $('#delete-subtask-confirm').on('click', function () {
        if (pendingDeleteSubtaskId === null) return;
        var subId = pendingDeleteSubtaskId;
        pendingDeleteSubtaskId = null;
        $('#delete-subtask-dialog').hide();
        var info = findParentOf(subId, tasks, null);
        if (!info) return;
        clearPredecessorRefs(subId, tasks);
        info.list[info.index].subtasks = [];
        info.list.splice(info.index, 1);
        saveData();
        sendPatch({op: 'deleteSubtask', taskId: subId});
        recomputePercentComplete();
        recomputeStatus();
        recomputeWorkingDays();
        recomputeCost();
        renderDetail();
        showToast('Subtask deleted');
    });

    // Reorder subtask (move up/down within siblings)
    $(document).on('click', '.subtask-reorder-btn', function (e) {
        e.stopPropagation();
        var subId = parseInt($(this).attr('data-reorder-id'));
        var dir = $(this).attr('data-reorder-dir');
        var info = findParentOf(subId, tasks, null);
        if (!info) return;
        var idx = info.index;
        var list = info.list;
        if (dir === 'up' && idx > 0) {
            var temp = list[idx];
            list[idx] = list[idx - 1];
            list[idx - 1] = temp;
        } else if (dir === 'down' && idx < list.length - 1) {
            var temp = list[idx];
            list[idx] = list[idx + 1];
            list[idx + 1] = temp;
        } else {
            return;
        }
        saveData();
        sendPatch({op: 'reorderSubtask', taskId: subId, direction: dir, noBroadcast: true});
        renderDetail();
    });

    // Handle pending subtask on blur: broadcast if named, remove if empty
    $(document).on('blur', '#subtask-body input[data-field="name"]', function () {
        var id = parseInt($(this).attr('data-id'));
        var sub = findTaskById(id, tasks);
        if (!sub || !sub._pendingAdd) return;
        if (sub.name && sub.name.trim()) {
            // Subtask now has a name — broadcast addSubtask
            var parentId = sub._parentId;
            delete sub._pendingAdd;
            delete sub._parentId;
            saveData();
            sendPatch({op: 'addSubtask', parentTaskId: parentId, subtask: JSON.parse(JSON.stringify(sub))});
        } else {
            // Still unnamed — remove it
            removePendingSubtask(id, tasks);
            recomputePercentComplete();
            recomputeStatus();
            recomputeWorkingDays();
            recomputeCost();
            renderDetail();
        }
    });

    function removePendingSubtask(id, tasksList) {
        for (var i = 0; i < tasksList.length; i++) {
            var subs = tasksList[i].subtasks || [];
            for (var j = subs.length - 1; j >= 0; j--) {
                if (subs[j].id === id && subs[j]._pendingAdd) {
                    subs.splice(j, 1);
                    return true;
                }
                if (removePendingSubtask(id, [subs[j]])) return true;
            }
        }
        return false;
    }

    // Inline edit subtask fields (excluding assignedTo which uses the picker)
    $(document).on('input change blur', '#subtask-body input[data-field], #subtask-body select[data-field]', function (e) {
        // For select elements, only act on 'change' to avoid duplicate patches
        if ($(this).is('select') && e.type !== 'change') return;
        // For debounced fields (name, cost, %), 'input' is sufficient — skip change/blur
        var field = $(this).attr('data-field');
        if ((field === 'name' || field === 'cost') && e.type !== 'input') return;
        if (field === 'percentComplete' && e.type === 'change') return;

        var id = parseInt($(this).attr('data-id'));
        var val = $(this).val();
        var sub = findTaskById(id, tasks);
        if (!sub) return;

        if (field === 'predecessor') return; // handled by predecessor picker
        if (field === 'duration') {
            if (e.type !== 'change' && e.type !== 'blur') return;
            var rawDur = val.replace(/[^0-9]/g, '');
            if (!rawDur) return;
            var days = parseInt(rawDur);
            if (isNaN(days) || days < 0) return;
            var isExec = isExecutionProject();
            var effStart = isExec ? getEffectiveStartDate(sub) : (sub.startDate || '');
            if (!effStart && !isExec) {
                alert('Indicate the Start Date first.');
                $(this).val(calcDuration(sub.startDate, sub.endDate));
                return;
            }
            sub._workingDays = days;
            if (effStart) {
                var iso = addWorkingDays(effStart, days);
                sub.endDate = iso;
                $(this).closest('tr').find('input[data-field="endDate"]').val(toDisplayDate(iso));
                sendPatch({op: 'update', taskId: sub.id, field: 'endDate', value: iso});
            }
            $(this).val(days + 'd');
            saveData();
            sendPatch({op: 'update', taskId: sub.id, field: '_workingDays', value: days});
            recalcDependents(sub.id);
            recomputeWorkingDays();
            var parentTask = findTaskById(selectedTaskId, tasks);
            syncParentEndDate(parentTask);
            renderSubtaskTable(parentTask);
            return;
        }
        if (field === 'percentComplete') {
            if (sub.subtasks && sub.subtasks.length > 0) {
                $(this).val(sub[field] || 0);
                return;
            }
            var trimmed = val.trim();
            if (trimmed !== '' && !/^\d+$/.test(trimmed)) {
                alert('Please indicate numbers only');
                $(this).val(sub[field] || 0);
                return;
            }
            var num = parseInt(trimmed) || 0;
            if (num < 0) num = 0;
            if (num > 100) {
                alert('The maximum percent completion should only be 100%');
                $(this).val(sub[field] || 0);
                return;
            }
            sub[field] = num;
            if (e.type === 'blur') $(this).val(num);
            // Derive status from % CMPLT: 100 ⇒ Completed, <100 ⇒ In Progress.
            // Only the % patch is broadcast; receivers mirror this derivation.
            var _derivedStatus = (num >= 100) ? 'Completed' : (num === 0) ? 'Not Started' : 'In Progress';
            if (sub.status !== _derivedStatus) {
                sub.status = _derivedStatus;
                $(this).closest('tr').find('select[data-field="status"]').val(_derivedStatus);
            }
        } else if (field === 'startDate' || field === 'endDate') {
            // Only commit on change/blur — `input` events fire mid-typing and
            // would repeatedly wipe sub[field] with '' while the user types
            // partial dates like "0" or "02/", leaving the final 'change'
            // event to return early via the equality guard below and skipping
            // the parent-row re-render.
            if (e.type !== 'change' && e.type !== 'blur') return;
            var iso = toIsoDate(val);
            if (iso === sub[field]) return;
            sub[field] = iso;
            // If start date changed, recalculate end date from duration
            if (field === 'startDate') {
                var dur = getStoredDuration(sub);
                if (dur > 0 && !(sub.subtasks && sub.subtasks.length > 0)) {
                    var newEnd = computeEndDateFromDuration(sub, dur);
                    if (newEnd) {
                        sub.endDate = newEnd;
                        $(this).closest('tr').find('input[data-field="endDate"]').val(toDisplayDate(newEnd));
                        sendPatch({op: 'update', taskId: sub.id, field: 'endDate', value: newEnd});
                        recalcDependents(sub.id);
                    }
                }
            }
            // If user manually edited end date (non-Execution only — Execution
            // derives end date from predecessors + duration), recompute
            // _workingDays from the new span so the Duration cell reflects
            // the new range and renderSubtaskTable doesn't overwrite it with
            // the stale stored value.
            if (field === 'endDate' && !isExecutionProject() &&
                !(sub.subtasks && sub.subtasks.length > 0) &&
                sub.startDate && sub.endDate) {
                var _durStr = calcDuration(sub.startDate, sub.endDate);
                var _durNum = parseInt(_durStr, 10);
                if (!isNaN(_durNum) && _durNum >= 0 && sub._workingDays !== _durNum) {
                    sub._workingDays = _durNum;
                    sendPatch({op: 'update', taskId: sub.id, field: '_workingDays', value: _durNum});
                }
            }
            // Update duration cell in the same row
            var $row = $(this).closest('tr');
            $row.find('input[data-field="duration"]').val(calcDuration(sub.startDate, sub.endDate));
            // If end date changed (directly or via startDate→duration), sync
            // the top-level task header, recompute intermediate subtask
            // endDates from children, broadcast those changes, and re-render
            // the subtask table so parent rows reflect the new computed value.
            // Also sync start date for Assessment/Execution projects (MIN of children).
            var parentTask = findTaskById(selectedTaskId, tasks);
            if (parentTask) {
                var _snapStart = snapshotIntermediateStartDates(parentTask.subtasks || []);
                var _snap = snapshotIntermediateEndDates(parentTask.subtasks || []);
                syncParentStartDate(parentTask);
                syncParentEndDate(parentTask);
                patchChangedIntermediateStartDates(parentTask.subtasks || [], _snapStart);
                patchChangedIntermediateEndDates(parentTask.subtasks || [], _snap);
                renderSubtaskTable(parentTask);
            }
        } else if (field === 'cost') {
            if (sub.subtasks && sub.subtasks.length > 0) {
                $(this).val(sub[field] || 0);
                return;
            }
            sub[field] = val;
        } else {
            sub[field] = val;
            if (field === 'status') {
                if (val === 'Completed') {
                    sub.percentComplete = 100;
                    $(this).closest('tr').find('input[data-field="percentComplete"]').val(100);
                } else if (val === 'Not Started') {
                    sub.percentComplete = 0;
                    $(this).closest('tr').find('input[data-field="percentComplete"]').val(0);
                }
            }
        }

        saveData();

        // Send patch to server
        if (field === 'name' && sub._pendingAdd) {
            // Still pending — addSubtask will be sent on blur
        } else if (field === 'name' || field === 'cost' || field === 'percentComplete') {
            var _fld = field, _id = id;
            sendPatchDebounced('sub-' + _fld + '-' + _id, function () {
                var s = findTaskById(_id, tasks);
                return s ? {op: 'update', taskId: _id, field: _fld, value: s[_fld]} : null;
            });
        } else {
            var patchValue = sub[field];
            sendPatch({op: 'update', taskId: id, field: field, value: patchValue});
        }

        if (field === 'percentComplete') {
            recomputePercentComplete();
            recomputeStatus();
        }

        if (field === 'cost') {
            recomputeCost();
        }

        if (field === 'status') {
            recomputePercentComplete();
            recomputeStatus();
        }

        if (field === 'startDate' || field === 'endDate') {
            recomputeWorkingDays();
        }

        if (field === 'name' && e.type === 'input') {
            renderTaskList();
        }
    });

    // Show add-child "+" button when subtask naming is confirmed (Enter or blur)
    function showAddChildIfNeeded($input) {
        var id = parseInt($input.attr('data-id'));
        var val = $input.val();
        var $nameWrap = $input.closest('.tree-cell-name');
        var hasAddBtn = $nameWrap.find('.btn-add-child-inline').length > 0;
        var nameNotEmpty = val && val.trim() !== '';
        var depthClass = $input.closest('.tree-cell').attr('class') || '';
        var canAddChild = depthClass.indexOf('depth-0') !== -1 || depthClass.indexOf('depth-1') !== -1;
        if (nameNotEmpty && canAddChild && !hasAddBtn) {
            $nameWrap.append(
                $('<button class="row-action-btn btn-add-child-inline" title="Add sub-subtask" tabindex="-1">')
                    .attr('data-add-child', id)
                    .html('<i class="fa fa-plus"></i>')
            );
        }
    }

    $(document).on('keydown', '#subtask-body input[data-field="name"]', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        showAddChildIfNeeded($(this));
        $(this).blur();
    });

    $(document).on('blur', '#subtask-body input[data-field="name"]', function () {
        showAddChildIfNeeded($(this));
    });

    // Force commit on Enter for the WKNG DAYS cell. Chromium-based Edge can
    // defer the native `change` event while its autofill/suggestion pipeline
    // is still evaluating the field (~1–3s), so pressing Enter alone may not
    // trigger the handler at design.js:3540. Blurring forces `change` to fire.
    $(document).on('keydown', '#subtask-body input[data-field="duration"]', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        $(this).blur();
    });

    // ========== Save All ==========
    function addSaveRow(cellData, rowIdx, indent, taskObj) {
        // Col 0: Task Name
        var cell0 = { text: taskObj.name || '' };
        if (indent > 0) cell0.indent = indent;
        cellData[rowIdx + '-0'] = cell0;

        // Col 1: Start Date
        if (taskObj.startDate) cellData[rowIdx + '-1'] = { text: taskObj.startDate };

        // Col 2: End Date
        if (taskObj.endDate) cellData[rowIdx + '-2'] = { text: taskObj.endDate };

        // Col 3: Duration (auto-calculated, also stored as text fallback)
        var dur = calcDuration(taskObj.startDate, taskObj.endDate);
        if (dur) cellData[rowIdx + '-3'] = { text: dur };

        // Col 4: Predecessor (readable labels, comma-separated)
        ensurePredecessorArray(taskObj);
        if (taskObj.predecessor.length > 0) {
            var predLabels = [];
            for (var pi = 0; pi < taskObj.predecessor.length; pi++) {
                var pl = buildPredecessorLabel(taskObj.predecessor[pi]);
                if (pl) predLabels.push(pl);
            }
            if (predLabels.length > 0) cellData[rowIdx + '-4'] = { text: predLabels.join(', ') };
        }

        // Col 5: % Complete
        if (taskObj.percentComplete) cellData[rowIdx + '-5'] = { text: String(taskObj.percentComplete), align: 'right' };

        // Col 6: Status
        if (taskObj.status) cellData[rowIdx + '-6'] = { text: taskObj.status };

        // Col 7: Assigned To (IDs comma-separated)
        ensureAssignedArray(taskObj);
        if (taskObj.assignedTo.length > 0) cellData[rowIdx + '-7'] = { text: taskObj.assignedTo.join(', ') };

        // Col 8: Cost
        if (taskObj.cost) cellData[rowIdx + '-8'] = { text: String(taskObj.cost) };
    }

    function buildSaveData() {
        var columns = [
            { id: 0, name: 'Task Name', type: 'text', width: 250, description: '', filterValue: '', frozen: false, hidden: false, locked: false },
            { id: 1, name: 'Start Date', type: 'date', width: 140, description: '', filterValue: '', frozen: false, hidden: false, locked: false },
            { id: 2, name: 'End Date', type: 'date', width: 140, description: '', filterValue: '', frozen: false, hidden: false, locked: false },
            { id: 3, name: 'Wkng Days', type: 'duration', width: 100, description: '', filterValue: '', frozen: false, hidden: false, locked: false, durationStartCol: 1, durationEndCol: 2 },
            { id: 4, name: 'Predecessor', type: 'predecessor', width: 180, description: '', filterValue: '', frozen: false, hidden: false, locked: false },
            { id: 5, name: '% Complete', type: 'percent', width: 100, description: '', filterValue: '', frozen: false, hidden: false, locked: false },
            { id: 6, name: 'Status', type: 'dropdown', width: 140, description: '', filterValue: '', frozen: false, hidden: false, locked: false,
                dropdownOptions: [
                    { value: 'Not Started', color: '#f0f0f0' },
                    { value: 'In Progress', color: '#e3f0fc' },
                    { value: 'Completed', color: '#e6f5ea' },
                    { value: 'On Hold', color: '#fff3e0' },
                    { value: 'Cancelled', color: '#fde8e8' }
                ]
            },
            { id: 7, name: 'Assigned To', type: 'contacts', width: 180, description: '', filterValue: '', frozen: false, hidden: false, locked: false },
            { id: 8, name: 'Cost', type: 'cost', width: 120, description: '', filterValue: '', frozen: false, hidden: false, locked: false }
        ];

        var cellData = {};
        var rowAttachments = {};
        var rowNotes = {};
        var rowIdx = 0;

        $.each(tasks, function (ti, task) {
            // Skip tasks with no name
            if (!task.name || !task.name.trim()) return;
            // Parent task row (indent 0)
            addSaveRow(cellData, rowIdx, 0, task);
            // Map attachments and notes to parent row
            if (task.attachments && task.attachments.length) {
                rowAttachments[rowIdx] = task.attachments.slice();
            }
            if (task.description) {
                rowNotes[rowIdx] = task.description;
            }
            rowIdx++;

            // Subtasks (indent 1)
            $.each(task.subtasks || [], function (si, sub) {
                addSaveRow(cellData, rowIdx, 1, sub);
                rowIdx++;

                // Sub-subtasks (indent 2)
                $.each(sub.subtasks || [], function (ssi, subsub) {
                    addSaveRow(cellData, rowIdx, 2, subsub);
                    rowIdx++;

                    // Sub-sub-subtasks (indent 3)
                    $.each(subsub.subtasks || [], function (sssi, subsubsub) {
                        addSaveRow(cellData, rowIdx, 3, subsubsub);
                        rowIdx++;
                    });
                });
            });
        });

        return {
            columns: columns,
            cellData: cellData,
            totalRows: rowIdx,
            frozenUpTo: -1,
            collapsedRows: {},
            rowAttachments: rowAttachments,
            rowComments: {},
            rowNotes: rowNotes,
            colIdCounter: 9,
            createdBy: CURRENT_USER_ID,
            _taskData: {
                tasks: tasks,
                taskIdCounter: taskIdCounter
            }
        };
    }

    // ========== Sidebar Resize ==========
    var sidebarResizing = false;
    var sidebarStartX = 0;
    var sidebarStartW = 0;

    $('#sidebar-resize-handle').on('mousedown', function (e) {
        e.preventDefault();
        sidebarResizing = true;
        sidebarStartX = e.clientX;
        sidebarStartW = $('#sidebar').outerWidth();
        $(this).addClass('dragging');
        $('body').css('cursor', 'col-resize');
        // Disable transition during manual resize for smooth dragging
        $('#sidebar').css('transition', 'none');
        $('#sidebar-toggle-tab').css('transition', 'none');
    });

    $(document).on('mousemove', function (e) {
        if (!sidebarResizing) return;
        var diff = e.clientX - sidebarStartX;
        var newW = Math.max(200, Math.min(500, sidebarStartW + diff));
        $('#sidebar').css('width', newW + 'px');
        $('#sidebar-toggle-tab').css('left', newW + 'px');
    });

    $(document).on('mouseup', function () {
        if (sidebarResizing) {
            sidebarResizing = false;
            $('#sidebar-resize-handle').removeClass('dragging');
            $('body').css('cursor', '');
            // Re-enable transitions after resize
            $('#sidebar').css('transition', '');
            $('#sidebar-toggle-tab').css('transition', '');
        }
    });

    // ========== Sidebar Toggle ==========
    $('#sidebar-toggle-tab').on('click', function () {
        var $layout = $('#app-layout');
        var $tab = $(this);
        if ($layout.hasClass('sidebar-collapsed')) {
            // Expand: restore sidebar
            $layout.removeClass('sidebar-collapsed');
            var w = $('#sidebar').data('prev-width') || 280;
            // Let the CSS transition handle the width via the class removal,
            // but we need to restore the inline width if it was resized
            $('#sidebar').css('width', w + 'px');
            $tab.css('left', w + 'px');
        } else {
            // Collapse: save current width and hide
            var currentW = $('#sidebar').outerWidth();
            $('#sidebar').data('prev-width', currentW);
            $layout.addClass('sidebar-collapsed');
            // left position is handled by CSS for collapsed state
            $tab.css('left', '');
        }
    });

    // ========== Project Picker ==========
    function showTaskProjectPicker() {
        var $picker = $('#task-project-picker');
        var $tbody = $('#task-picker-body');
        var $wrap = $('#task-picker-table-wrap');
        var $empty = $('#task-picker-empty');
        var $loading = $('#task-picker-loading');
        $tbody.empty();
        $empty.hide();
        $wrap.hide();
        $loading.show();
        $picker.show();

        $.ajax({
            url: '/api/group-projects',
            method: 'GET',
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                $loading.hide();
                if (resp && resp.ok && resp.projects && resp.projects.length > 0) {
                    resp.projects.sort(function (a, b) {
                        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                    });
                    $wrap.show();
                    $.each(resp.projects, function (i, proj) {
                        var $tr = $('<tr>');
                        var pc = getProjectColor(proj.name);
                        if (pc) {
                            $tr.css('border-left', '4px solid ' + pc.color);
                        }
                        var $nameCell = $('<td>');
                        if (pc) {
                            var $badge = $('<span class="project-color-badge">').text(pc.label).css('background', pc.color);
                            $nameCell.append($badge);
                        }
                        var $link = $('<span class="task-picker-link">').text(displayProjectName(proj.name));
                        $link.on('click', function () {
                            openGroupProject(proj.name);
                        });
                        $nameCell.append($link);
                        $tr.append($nameCell);
                        $tr.append($('<td>').text(proj.lastSaved));
                        $tr.append($('<td>').text(proj.entries));
                        $tbody.append($tr);
                    });
                } else {
                    $wrap.hide();
                    $empty.show();
                }
            },
            error: function () {
                $loading.hide();
                $wrap.hide();
                $empty.text('Could not load projects. Check server.').show();
            }
        });
    }

    function openGroupProject(name) {
        PROJ_NAME = name;
        $('#task-project-picker').hide();
        applyTitleBarColor(name);
        joinProjectRoom(name);

        // Try loading from server first
        $.ajax({
            url: '/api/load-group',
            method: 'GET',
            data: { project: name },
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok && resp.data && resp.data._taskData) {
                    tasks = resp.data._taskData.tasks || [];
                    taskIdCounter = resp.data._taskData.taskIdCounter || 0;
                    // Cache in localStorage
                    localStorage.setItem(getStorageKey(), JSON.stringify({
                        tasks: tasks,
                        taskIdCounter: taskIdCounter
                    }));
                } else {
                    // Fall back to localStorage
                    loadData();
                }
                initAfterLoad();
            },
            error: function () {
                loadData();
                initAfterLoad();
            }
        });
    }

    function createGroupProject(name) {
        PROJ_NAME = name;
        $('#task-project-picker').hide();
        applyTitleBarColor(name);
        joinProjectRoom(name);
        tasks = [];
        taskIdCounter = 0;
        selectedTaskId = null;
        initAfterLoad();
    }

    function initAfterLoad() {
        selectedTaskId = null;
        if (tasks.length > 0) {
            selectedTaskId = tasks[0].id;
        }
        renderTaskList();
        renderDetail();
    }

    // ========== Enable Start Date (Execution projects) ==========
    function isStartDateEnabled(task) {
        return task && task._startDateEnabled === true;
    }

    function setStartDateOnAllSubtasks(subtasks, isoDate) {
        if (!subtasks) return;
        for (var i = 0; i < subtasks.length; i++) {
            subtasks[i].startDate = isoDate;
            if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
                setStartDateOnAllSubtasks(subtasks[i].subtasks, isoDate);
            }
        }
    }

    function setEndDateOnAllSubtasks(subtasks, isoDate) {
        if (!subtasks) return;
        for (var i = 0; i < subtasks.length; i++) {
            subtasks[i].endDate = isoDate;
            if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
                setEndDateOnAllSubtasks(subtasks[i].subtasks, isoDate);
            }
        }
    }

    function setStatusOnAllSubtasks(subtasks, status) {
        if (!subtasks) return;
        for (var i = 0; i < subtasks.length; i++) {
            subtasks[i].status = status;
            if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
                setStatusOnAllSubtasks(subtasks[i].subtasks, status);
            }
        }
    }

    function clearWorkingDaysOnAllSubtasks(subtasks) {
        if (!subtasks) return;
        for (var i = 0; i < subtasks.length; i++) {
            subtasks[i]._workingDays = 0;
            if (subtasks[i].subtasks && subtasks[i].subtasks.length > 0) {
                clearWorkingDaysOnAllSubtasks(subtasks[i].subtasks);
            }
        }
    }

    // ========== Data Integrity Check (Assessment projects, gs6368 only) ==========
    // Audits auto-computed values and reports discrepancies without mutating data.

    function _chkComputeMinStart(subs) {
        var min = '';
        for (var i = 0; i < subs.length; i++) {
            var s = subs[i];
            var cand;
            if (s.subtasks && s.subtasks.length > 0) cand = _chkComputeMinStart(s.subtasks);
            else cand = s.startDate || '';
            if (cand && (!min || cand < min)) min = cand;
        }
        return min;
    }

    function _chkComputeMaxEnd(subs) {
        var max = '';
        for (var i = 0; i < subs.length; i++) {
            var s = subs[i];
            var cand;
            if (s.subtasks && s.subtasks.length > 0) cand = _chkComputeMaxEnd(s.subtasks);
            else cand = s.endDate || '';
            if (cand && cand > max) max = cand;
        }
        return max;
    }

    // Recursive bottom-up roll-ups so leaves are the source of truth — stale
    // stored values on intermediate parents never contaminate comparisons.
    function _chkComputeAvgPct(subs) {
        if (!subs || subs.length === 0) return 0;
        var sum = 0;
        for (var i = 0; i < subs.length; i++) {
            var s = subs[i];
            var v = (s.subtasks && s.subtasks.length > 0)
                ? _chkComputeAvgPct(s.subtasks)
                : (parseInt(s.percentComplete, 10) || 0);
            sum += v;
        }
        return Math.round(sum / subs.length);
    }

    function _chkComputeSumCost(subs) {
        var sum = 0;
        for (var i = 0; i < subs.length; i++) {
            var s = subs[i];
            if (s.subtasks && s.subtasks.length > 0) sum += _chkComputeSumCost(s.subtasks);
            else sum += parseFloat(s.cost) || 0;
        }
        return sum;
    }

    function _chkComputeDerivedStatus(subs) {
        var allNotStarted = true, allCompleted = true;
        for (var i = 0; i < subs.length; i++) {
            var s = subs[i];
            var st = (s.subtasks && s.subtasks.length > 0)
                ? _chkComputeDerivedStatus(s.subtasks)
                : (s.status || '');
            if (st !== 'Not Started') allNotStarted = false;
            if (st !== 'Completed') allCompleted = false;
        }
        if (allCompleted) return 'Completed';
        if (allNotStarted) return 'Not Started';
        return 'In Progress';
    }

    function _chkFmtDate(iso) {
        return iso ? toDisplayDate(iso) : '(empty)';
    }

    function _chkFmtCost(n) {
        return '$' + (parseFloat(n) || 0).toFixed(2);
    }

    function runDataChecks(task) {
        var report = {
            header: [],
            datesDur: [],
            execEndDate: [],
            execPredStale: [],
            pctStatus: [],
            pctRollup: [],
            costRollup: [],
            parentDates: [],
            parentStatusRollup: [],
            parentEmpty: []
        };
        if (!task) return report;

        function push(key, item, current, expected, reason) {
            report[key].push({ item: item, current: current, expected: expected, reason: reason });
        }

        var hasChildren = task.subtasks && task.subtasks.length > 0;

        // ===== HEADER (top-level task) =====
        if (hasChildren) {
            var topLabel = (task.name || '(unnamed task)') + ' [top-level]';
            var expStart = _chkComputeMinStart(task.subtasks);
            if ((task.startDate || '') !== expStart) {
                push('header', topLabel + ' — Start Date', _chkFmtDate(task.startDate), _chkFmtDate(expStart), 'MIN of descendants');
            }
            var expEnd = _chkComputeMaxEnd(task.subtasks);
            if ((task.endDate || '') !== expEnd) {
                push('header', topLabel + ' — End Date', _chkFmtDate(task.endDate), _chkFmtDate(expEnd), 'MAX of descendants');
            }
            var expPct = _chkComputeAvgPct(task.subtasks);
            var stPct = parseInt(task.percentComplete, 10) || 0;
            if (stPct !== expPct) {
                push('header', topLabel + ' — % Complete', String(stPct), String(expPct), 'rounded avg from leaves');
            }
            var expCost = _chkComputeSumCost(task.subtasks);
            var stCost = parseFloat(task.cost) || 0;
            if (Math.abs(stCost - expCost) > 0.009) {
                push('header', topLabel + ' — Cost', _chkFmtCost(stCost), _chkFmtCost(expCost), 'sum of leaves');
            }
            var expStatus = _chkComputeDerivedStatus(task.subtasks);
            if ((task.status || '') !== expStatus) {
                push('header', topLabel + ' — Status', task.status || '(empty)', expStatus, 'derived from leaves');
            }
        }

        // ===== WALK SUBTASKS =====
        function walk(list, path) {
            for (var i = 0; i < list.length; i++) {
                var st = list[i];
                var p = path ? (path + ' > ' + (st.name || '(unnamed)')) : (st.name || '(unnamed)');
                checkRow(st, p);
                if (st.subtasks && st.subtasks.length > 0) walk(st.subtasks, p);
            }
        }

        function checkRow(st, path) {
            var hasKids = st.subtasks && st.subtasks.length > 0;

            if (!hasKids) {
                // ---- LEAF ----
                if (isExecutionProject()) {
                    // In Execution, END DATE is derived: start (or next working day
                    // after latest predecessor end) + WKNG DAYS.
                    var ownDays = st._workingDays || 0;
                    var hasPred = st.predecessor && st.predecessor.length > 0;

                    if (!hasPred) {
                        // No predecessors — expected end = addWorkingDays(startDate, ownDays)
                        if (st.startDate && ownDays > 0) {
                            var expE = addWorkingDays(st.startDate, ownDays);
                            if (expE !== (st.endDate || '')) {
                                push('execEndDate', path + ' — END DATE', _chkFmtDate(st.endDate), _chkFmtDate(expE), 'start ' + _chkFmtDate(st.startDate) + ' + ' + ownDays + 'd');
                            }
                        }
                    } else {
                        // (a) Stale per-predecessor duration badges: each predecessor's
                        //     _workingDays should match calcDuration(pred.startDate, pred.endDate).
                        for (var pi = 0; pi < st.predecessor.length; pi++) {
                            var pr = findTaskById(st.predecessor[pi], tasks);
                            if (!pr || !pr.startDate || !pr.endDate) continue;
                            var spanDurStr = calcDuration(pr.startDate, pr.endDate);
                            var spanDur = parseInt(spanDurStr, 10) || 0;
                            var storedPrDur = pr._workingDays || 0;
                            if (storedPrDur !== spanDur) {
                                var prLabel = buildPredecessorLabel(pr.id) || (pr.name || '(pred)');
                                push('execPredStale', path + ' — badge for [' + prLabel + ']', storedPrDur + 'd', spanDur + 'd', 'predecessor span ' + _chkFmtDate(pr.startDate) + ' → ' + _chkFmtDate(pr.endDate));
                            }
                        }

                        // (b) This task's endDate should reflect the predecessors' CURRENT end dates:
                        //     expected = addWorkingDays(nextWorkingDay(MAX(pred.endDate)), ownDays)
                        if (ownDays > 0) {
                            var maxPredEnd = '';
                            var havePredDate = false;
                            for (var pj = 0; pj < st.predecessor.length; pj++) {
                                var pr2 = findTaskById(st.predecessor[pj], tasks);
                                if (!pr2 || !pr2.endDate) continue;
                                havePredDate = true;
                                if (pr2.endDate > maxPredEnd) maxPredEnd = pr2.endDate;
                            }
                            if (havePredDate) {
                                var effStart = nextWorkingDay(maxPredEnd);
                                var expE2 = addWorkingDays(effStart, ownDays);
                                if (expE2 !== (st.endDate || '')) {
                                    push('execEndDate', path + ' — END DATE', _chkFmtDate(st.endDate), _chkFmtDate(expE2), 'after pred MAX ' + _chkFmtDate(maxPredEnd) + ' + ' + ownDays + 'd');
                                }
                            }
                        }
                    }
                } else {
                    // Assessment: stored WKNG DAYS must equal calcDuration(start, end).
                    // Any end date whose span yields the same working-day count is
                    // consistent (e.g. Fri and the adjacent Sat/Sun give the same count).
                    // Canonical end-date hint only surfaces if the span already disagrees.
                    var _spanOk = true;
                    if (st.startDate && st.endDate) {
                        var expDurStr = calcDuration(st.startDate, st.endDate);
                        var expDur = parseInt(expDurStr, 10) || 0;
                        var stDur = st._workingDays || 0;
                        if (stDur !== expDur) {
                            _spanOk = false;
                            push('datesDur', path + ' — WKNG DAYS', stDur + 'd', expDur + 'd', 'span ' + _chkFmtDate(st.startDate) + ' → ' + _chkFmtDate(st.endDate));
                        }
                    }
                    if (!_spanOk && st.startDate && st._workingDays && st._workingDays > 0) {
                        var expEndD = addWorkingDays(st.startDate, st._workingDays);
                        if (expEndD !== (st.endDate || '')) {
                            push('datesDur', path + ' — END DATE (canonical)', _chkFmtDate(st.endDate), _chkFmtDate(expEndD), 'start ' + _chkFmtDate(st.startDate) + ' + ' + st._workingDays + 'd');
                        }
                    }
                }

                // % vs Status (skip On Hold / Cancelled — user-set)
                var pct = parseInt(st.percentComplete, 10) || 0;
                var status = st.status || '';
                if (status !== 'On Hold' && status !== 'Cancelled') {
                    var expSt;
                    if (pct === 0) expSt = 'Not Started';
                    else if (pct === 100) expSt = 'Completed';
                    else expSt = 'In Progress';
                    if (status !== expSt) {
                        push('pctStatus', path + ' — STATUS', status || '(empty)', expSt, '% CMPLT = ' + pct);
                    }
                }
            } else {
                // ---- INTERMEDIATE PARENT ----
                var pExpStart = _chkComputeMinStart(st.subtasks);
                if ((st.startDate || '') !== pExpStart) {
                    push('parentDates', path + ' — START DATE', _chkFmtDate(st.startDate), _chkFmtDate(pExpStart), 'MIN of descendants');
                }
                var pExpEnd = _chkComputeMaxEnd(st.subtasks);
                if ((st.endDate || '') !== pExpEnd) {
                    push('parentDates', path + ' — END DATE', _chkFmtDate(st.endDate), _chkFmtDate(pExpEnd), 'MAX of descendants');
                }

                var pExpPct = _chkComputeAvgPct(st.subtasks);
                var pStPct = parseInt(st.percentComplete, 10) || 0;
                if (pStPct !== pExpPct) {
                    push('pctRollup', path + ' — % CMPLT', String(pStPct), String(pExpPct), 'rounded avg from leaves');
                }

                var pExpCost = _chkComputeSumCost(st.subtasks);
                var pStCost = parseFloat(st.cost) || 0;
                if (Math.abs(pStCost - pExpCost) > 0.009) {
                    push('costRollup', path + ' — COST', _chkFmtCost(pStCost), _chkFmtCost(pExpCost), 'sum of leaves');
                }

                var pExpStatus = _chkComputeDerivedStatus(st.subtasks);
                if ((st.status || '') !== pExpStatus) {
                    push('parentStatusRollup', path + ' — STATUS', st.status || '(empty)', pExpStatus, 'derived from leaves');
                }

                // Strict-empty checks (user-entered columns that should never be on a parent row)
                if (st._workingDays && st._workingDays > 0) {
                    push('parentEmpty', path + ' — WKNG DAYS', st._workingDays + 'd', '(empty)', 'parent rows have no duration');
                }
                if (st.predecessor && st.predecessor.length > 0) {
                    push('parentEmpty', path + ' — PREDECESSOR', st.predecessor.length + ' entr' + (st.predecessor.length === 1 ? 'y' : 'ies'), '(empty)', 'parent rows have no predecessor');
                }
                if (st.assignedTo && st.assignedTo.length > 0) {
                    push('parentEmpty', path + ' — ASSIGNED TO', st.assignedTo.length + ' entr' + (st.assignedTo.length === 1 ? 'y' : 'ies'), '(empty)', 'parent rows have no assignees');
                }
            }
        }

        walk(task.subtasks || [], '');
        return report;
    }

    function showCheckReportDialog(report) {
        var sections = [
            { key: 'header',              title: 'Top-Level Task Roll-Ups' },
            { key: 'datesDur',            title: 'Start Date / End Date / WKNG DAYS' },
            { key: 'execEndDate',         title: 'END DATE (Execution leaf rows)' },
            { key: 'execPredStale',       title: 'Stale Predecessor Badges' },
            { key: 'pctStatus',           title: '% CMPLT vs STATUS (leaf rows)' },
            { key: 'pctRollup',           title: '% CMPLT Roll-Ups (parent rows)' },
            { key: 'costRollup',          title: 'COST Roll-Ups (parent rows)' },
            { key: 'parentDates',         title: 'Parent Row Start/End vs Children' },
            { key: 'parentStatusRollup',  title: 'Parent Row STATUS (derived)' },
            { key: 'parentEmpty',         title: 'Parent Rows That Should Be Empty' }
        ];

        var totalIssues = 0;
        for (var i = 0; i < sections.length; i++) totalIssues += (report[sections[i].key] || []).length;

        var $overlay = $('<div class="dialog-overlay" id="check-report-dialog">');
        var $box = $('<div class="dialog-box">');
        $box.append($('<div class="dialog-title">').html('<i class="fa fa-clipboard-check" style="color:#0E8A6D;margin-right:6px;"></i> Data Integrity Check'));

        var $body = $('<div class="check-report-body">');

        if (totalIssues === 0) {
            $body.append($('<div class="check-report-allgood">').html('<i class="fa fa-circle-check" style="margin-right:6px;"></i> All checks passed — no discrepancies found.'));
        } else {
            $body.append($('<div class="check-report-summary">').text(totalIssues + ' discrepanc' + (totalIssues === 1 ? 'y' : 'ies') + ' found across ' + sections.filter(function(s){ return (report[s.key]||[]).length > 0; }).length + ' section(s).'));
            for (var si = 0; si < sections.length; si++) {
                var sec = sections[si];
                var items = report[sec.key] || [];
                if (items.length === 0) continue;
                var $sec = $('<div class="check-report-section">');
                $sec.append($('<div class="check-report-section-title">').text(sec.title + ' (' + items.length + ')'));
                var $tbl = $('<table class="check-report-table">');
                var $thead = $('<thead>').append(
                    $('<tr>')
                        .append($('<th>').text('ITEM'))
                        .append($('<th>').text('CURR VALUE'))
                        .append($('<th>').text('EXPECTED VALUE'))
                        .append($('<th>').text('REASON'))
                );
                $tbl.append($thead);
                var $tbody = $('<tbody>');
                for (var ii = 0; ii < items.length; ii++) {
                    var it = items[ii];
                    if (typeof it === 'string') {
                        $tbody.append($('<tr>').append($('<td colspan="4">').text(it)));
                    } else {
                        $tbody.append(
                            $('<tr>')
                                .append($('<td class="crt-item">').text(it.item != null ? String(it.item) : ''))
                                .append($('<td class="crt-curr">').text(it.current != null ? String(it.current) : ''))
                                .append($('<td class="crt-exp">').text(it.expected != null ? String(it.expected) : ''))
                                .append($('<td class="crt-reason">').text(it.reason != null ? String(it.reason) : ''))
                        );
                    }
                }
                $tbl.append($tbody);
                $sec.append($tbl);
                $body.append($sec);
            }
        }

        $box.append($body);
        var $actions = $('<div class="dialog-actions">');
        var $close = $('<button class="dialog-btn-primary">Close</button>');
        $close.on('click', function () { $overlay.remove(); });
        $actions.append($close);
        $box.append($actions);
        $overlay.append($box);
        $('body').append($overlay);
    }

    $(document).on('click', '#btn-check-data', function () {
        if (!isAssessmentProject() && !isExecutionProject()) return;
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        var report = runDataChecks(task);
        showCheckReportDialog(report);
    });

    // Show the button globally for Execution projects (gs1234 only)
    function updateEnableStartDateBtn() {
        var $btn = $('#btn-enable-start-date');
        if (isExecutionProject() && CURRENT_USER_ID === 'gs6368') {
            $btn.show();
        } else {
            $btn.hide();
        }
    }

    // Open the dialog (global — applies to ALL tasks)
    $('#btn-enable-start-date').on('click', function () {
        var $dlg = $('#enable-startdate-dialog');

        // Check if ANY task has start dates enabled
        var anyEnabled = false;
        for (var i = 0; i < tasks.length; i++) {
            if (isStartDateEnabled(tasks[i])) { anyEnabled = true; break; }
        }

        // Reset state
        $dlg.find('input[name="esd-choice"]').prop('checked', false);
        $dlg.find('.esd-option').removeClass('selected');

        // Toggle explanation text and title
        if (anyEnabled) {
            $('#esd-dialog-title-text').text('Enable Start Date');
            $('#esd-explanation-disabled').hide();
            $('#esd-explanation-enabled').show();
            $dlg.find('.esd-option-reset').show();
            $('#esd-reset-task-name').text('ALL tasks');
        } else {
            $('#esd-dialog-title-text').text('Enable Start Date');
            $('#esd-explanation-disabled').show();
            $('#esd-explanation-enabled').hide();
            $dlg.find('.esd-option-reset').hide();
        }

        // Default date to today
        var today = new Date();
        var mm = String(today.getMonth() + 1).padStart(2, '0');
        var dd = String(today.getDate()).padStart(2, '0');
        var yyyy = today.getFullYear();
        $('#esd-bulk-date').val(mm + '/' + dd + '/' + yyyy);
        $('#esd-bulk-date-hidden').val(yyyy + '-' + mm + '-' + dd);
        $dlg.show();
    });

    // Radio selection highlight
    $(document).on('change', 'input[name="esd-choice"]', function () {
        $('.esd-option').removeClass('selected');
        $(this).closest('.esd-option').addClass('selected');
    });

    // Calendar picker inside the dialog
    $('#esd-bulk-date-btn').on('click', function (e) {
        e.preventDefault();
        var $hidden = $('#esd-bulk-date-hidden');
        var currentVal = toIsoDate($('#esd-bulk-date').val());
        if (currentVal) $hidden.val(currentVal);
        $hidden[0].showPicker ? $hidden[0].showPicker() : $hidden.trigger('click');
    });

    $('#esd-bulk-date-hidden').on('change', function () {
        var iso = $(this).val();
        if (iso) {
            $('#esd-bulk-date').val(toDisplayDate(iso));
        }
    });

    // Auto-format the date text input in the dialog
    setupDateAutoFormat($('#esd-bulk-date'));

    // Cancel
    $('#esd-cancel').on('click', function () {
        $('#enable-startdate-dialog').hide();
    });

    // Apply (global — applies to ALL tasks and their subtasks)
    $('#esd-apply').on('click', function () {
        var choice = $('input[name="esd-choice"]:checked').val();
        if (!choice) {
            showToast('Please select an option before applying.');
            return;
        }

        if (choice === 'C') {
            // Reset: clear all start/end dates, reset status to Not Started, and disable on every task
            for (var t = 0; t < tasks.length; t++) {
                var task = tasks[t];
                task.startDate = '';
                task.endDate = '';
                task.status = 'Not Started';
                task._workingDays = 0;
                task._startDateEnabled = false;
                setStartDateOnAllSubtasks(task.subtasks, '');
                setEndDateOnAllSubtasks(task.subtasks, '');
                setStatusOnAllSubtasks(task.subtasks, 'Not Started');
                clearWorkingDaysOnAllSubtasks(task.subtasks);
                sendPatch({ op: 'update', taskId: task.id, field: '_startDateEnabled', value: false });
                sendPatch({ op: 'update', taskId: task.id, field: 'startDate', value: '' });
                sendPatch({ op: 'update', taskId: task.id, field: 'endDate', value: '' });
                sendPatch({ op: 'update', taskId: task.id, field: 'status', value: 'Not Started' });
                sendPatch({ op: 'update', taskId: task.id, field: '_workingDays', value: 0 });
                var allRows = [];
                flattenSubtasks(task.subtasks, 0, allRows, task.id);
                for (var i = 0; i < allRows.length; i++) {
                    sendPatch({ op: 'update', taskId: allRows[i].subtask.id, field: 'startDate', value: '' });
                    sendPatch({ op: 'update', taskId: allRows[i].subtask.id, field: 'endDate', value: '' });
                    sendPatch({ op: 'update', taskId: allRows[i].subtask.id, field: 'status', value: 'Not Started' });
                    sendPatch({ op: 'update', taskId: allRows[i].subtask.id, field: '_workingDays', value: 0 });
                }

                // Clear % CMPLT: zero out leaves only; parents get recomputed from children
                (function _clearLeafPct(list) {
                    if (!list) return;
                    for (var i = 0; i < list.length; i++) {
                        var it = list[i];
                        if (!it.subtasks || it.subtasks.length === 0) {
                            it.percentComplete = 0;
                        } else {
                            _clearLeafPct(it.subtasks);
                        }
                    }
                })([task]);
                // Recompute parent percents bottom-up (leaves are all 0 → parents become 0)
                if (task.subtasks && task.subtasks.length > 0) {
                    computePercentFromChildren(task);
                }
                // Broadcast percentComplete on every item in the tree
                (function _broadcastPct(list) {
                    if (!list) return;
                    for (var i = 0; i < list.length; i++) {
                        sendPatch({ op: 'update', taskId: list[i].id, field: 'percentComplete', value: list[i].percentComplete || 0 });
                        _broadcastPct(list[i].subtasks);
                    }
                })([task]);
            }
            saveData();
            $('#enable-startdate-dialog').hide();
            renderDetail();
            return;
        }

        var bulkIso = '';
        if (choice === 'B') {
            var bulkDisplay = $('#esd-bulk-date').val();
            bulkIso = toIsoDate(bulkDisplay);
            if (!bulkIso) {
                showToast('Please enter a valid date for Option B.');
                return;
            }
        }

        // Apply Option A or B to every task
        for (var t = 0; t < tasks.length; t++) {
            var task = tasks[t];
            task._startDateEnabled = true;
            sendPatch({ op: 'update', taskId: task.id, field: '_startDateEnabled', value: true });

            if (choice === 'B') {
                task.startDate = bulkIso;
                setStartDateOnAllSubtasks(task.subtasks, bulkIso);
                sendPatch({ op: 'update', taskId: task.id, field: 'startDate', value: bulkIso });
                var allRows = [];
                flattenSubtasks(task.subtasks, 0, allRows, task.id);
                for (var i = 0; i < allRows.length; i++) {
                    sendPatch({ op: 'update', taskId: allRows[i].subtask.id, field: 'startDate', value: allRows[i].subtask.startDate });
                }
            }
        }

        // For Option B: after start dates are set, recompute end dates from any
        // stored _workingDays values. Iterate so predecessor chains propagate.
        if (choice === 'B') {
            var _allFlat = [];
            (function _collectAll(list) {
                if (!list) return;
                for (var i = 0; i < list.length; i++) {
                    _allFlat.push(list[i]);
                    _collectAll(list[i].subtasks);
                }
            })(tasks);

            var _changedEndIds = {};
            var _maxPasses = _allFlat.length + 2;
            for (var _pass = 0; _pass < _maxPasses; _pass++) {
                var _any = false;
                for (var _i = 0; _i < _allFlat.length; _i++) {
                    var _it = _allFlat[_i];
                    // Skip parents with subtasks — their end dates roll up from children
                    if (_it.subtasks && _it.subtasks.length > 0) continue;
                    var _dur = getStoredDuration(_it);
                    if (_dur <= 0) continue;
                    var _newEnd = computeEndDateFromDuration(_it, _dur);
                    if (_newEnd && _newEnd !== _it.endDate) {
                        _it.endDate = _newEnd;
                        _changedEndIds[_it.id] = true;
                        _any = true;
                    }
                }
                if (!_any) break;
            }

            // Roll up parent end dates bottom-up
            (function _rollup(list) {
                if (!list) return;
                for (var i = 0; i < list.length; i++) {
                    var _t = list[i];
                    if (_t.subtasks && _t.subtasks.length > 0) {
                        _rollup(_t.subtasks);
                        var _maxEnd = getMaxSubtaskEndDate(_t.subtasks) || '';
                        if (_maxEnd !== (_t.endDate || '')) {
                            _t.endDate = _maxEnd;
                            _changedEndIds[_t.id] = true;
                        }
                    }
                }
            })(tasks);

            // Broadcast all changed end dates
            for (var _cid in _changedEndIds) {
                if (!_changedEndIds.hasOwnProperty(_cid)) continue;
                var _ct = findTaskById(parseInt(_cid), tasks);
                if (_ct) {
                    sendPatch({ op: 'update', taskId: _ct.id, field: 'endDate', value: _ct.endDate || '' });
                }
            }
        }

        saveData();
        $('#enable-startdate-dialog').hide();
        renderDetail();
    });

    // ========== Init ==========
    function isSuperUser() {
        return SUPER_USERS.indexOf(CURRENT_USER_ID) !== -1;
    }

    loadContacts();

    // Delete button is now visible for all users
    showTaskProjectPicker();

    function loadDefaultGroupProject() {
        PROJ_NAME = DEFAULT_GROUP_PROJECT;
        applyTitleBarColor(DEFAULT_GROUP_PROJECT);
        joinProjectRoom(DEFAULT_GROUP_PROJECT);

        $.ajax({
            url: '/api/load-group',
            method: 'GET',
            data: { project: DEFAULT_GROUP_PROJECT },
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok && resp.data) {
                    if (resp.data._taskData) {
                        tasks = resp.data._taskData.tasks || [];
                        taskIdCounter = resp.data._taskData.taskIdCounter || 0;
                    } else {
                        // Fallback to localStorage
                        loadData();
                    }
                    localStorage.setItem(getStorageKey(), JSON.stringify({
                        tasks: tasks,
                        taskIdCounter: taskIdCounter
                    }));
                    initAfterLoad();
                } else {
                    alert('The project "' + DEFAULT_GROUP_PROJECT + '" was not found. Please contact your administrator.');
                }
            },
            error: function () {
                alert('The project "' + DEFAULT_GROUP_PROJECT + '" could not be loaded. Please check your connection.');
            }
        });
    }

});
