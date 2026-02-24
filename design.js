$(document).ready(function () {

    // ========== State ==========
    var CURRENT_USER_ID = 'jv8888';
    var SUPER_USERS = ['ab1234', 'ps1234'];
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
            if (task) task[data.field] = data.value;
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

        // Notify when all subtasks are complete but parent status is not yet "Completed"
        if (task.percentComplete === 100 && task.subtasks && task.subtasks.length > 0 && task.status !== 'Completed') {
            var taskName = (task.name && task.name.trim()) ? task.name.trim() : '(unnamed)';
            showAllCompleteNotice(taskName);
        }
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
                'All the subtasks of "' + taskName + '" have been completed. Please check if this is correct then set the Status to "Completed" so it gets reported correctly as all completed.'
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
                $('#subtask-body input[data-field="percentComplete"][data-id="' + st.id + '"]').val(st.percentComplete);
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
                $('#subtask-body input[data-field="cost"][data-id="' + st.id + '"]').val(st.cost);
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

    function buildPredecessorChips($picker, predArray, taskId) {
        var $area = $picker.find('.pp-chips-area');
        $area.find('.pp-chip').remove();
        var $input = $area.find('.pp-filter-input');

        $.each(predArray, function (i, predId) {
            var label = buildPredecessorLabel(predId);
            if (!label) return;
            var $chip = $('<span class="pp-chip">').attr('data-pred-id', predId);
            $chip.append($('<span class="pp-chip-label">').text(label));
            $chip.append($('<span class="pp-chip-remove">').html('&times;'));
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
            var $chip = $('<span class="pp-chip">').attr('data-pred-id', predId);
            $chip.append($('<span class="pp-chip-label">').text(label));
            $chip.append($('<span class="pp-chip-remove">').html('&times;'));
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

        var filterVal = $('#pred-search-filter').val() || $(activePredPickerEl).find('.pp-filter-input').val();
        renderPredDropdownList(filterVal);

        var $picker = $(activePredPickerEl);
        buildPredecessorChips($picker, preds);
    });

    $(document).on('click', '.pp-chip-remove', function (e) {
        e.stopPropagation();
        var $chip = $(this).closest('.pp-chip');
        var predId = parseInt($chip.attr('data-pred-id'));
        var $picker = $chip.closest('.predecessor-picker');

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
        buildPredecessorChips($picker, taskObj.predecessor);

        if (activePredPickerEl === $picker[0]) {
            var filterVal = $picker.find('.pp-filter-input').val();
            renderPredDropdownList(filterVal);
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

    // Collect the maximum end date from all subtasks (recursive)
    function getMaxSubtaskEndDate(subtasks) {
        var maxIso = '';
        for (var i = 0; i < subtasks.length; i++) {
            var st = subtasks[i];
            if (st.endDate && st.endDate > maxIso) {
                maxIso = st.endDate;
            }
            if (st.subtasks && st.subtasks.length > 0) {
                var childMax = getMaxSubtaskEndDate(st.subtasks);
                if (childMax && childMax > maxIso) {
                    maxIso = childMax;
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
            $duration.prop('readonly', true).css({background: '#f7f9fc', color: '#666', cursor: 'default'});
        } else {
            newEndDate = task.endDate || '';
            $endDate.val(toDisplayDate(newEndDate));
            $endDate.prop('disabled', false);
            $endBtn.prop('disabled', false).css('pointer-events', '');
            $endHidden.prop('disabled', false);
            $duration.prop('readonly', false).css({background: '#fff', color: '#333', cursor: ''});
        }
        $duration.val(calcDuration(task.startDate, task.endDate));

        // Only save if the end date actually changed
        if (newEndDate !== oldEndDate) {
            saveData();
            sendPatch({op: 'update', taskId: task.id, field: 'endDate', value: newEndDate});
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

        // Collapse Notes and Attachments card
        $('#btn-toggle-desc-docs').addClass('collapsed');
        $('#desc-docs-body').addClass('collapsed');
        $('#btn-toggle-desc-docs').closest('.desc-docs-header').addClass('no-border');

        // Fill header fields
        $('#detail-task-name').val(task.name);
        $('#detail-start-date').val(toDisplayDate(task.startDate));
        $('#detail-end-date').val(toDisplayDate(task.endDate));
        $('#detail-duration').val(calcDuration(task.startDate, task.endDate));
        $('#detail-status').val(task.status);
        $('#detail-percent').val(task.percentComplete);
        if (task.subtasks && task.subtasks.length > 0) {
            $('#detail-percent').prop('readonly', true).addClass('pct-auto');
        } else {
            $('#detail-percent').prop('readonly', false).removeClass('pct-auto');
        }
        $('#detail-cost').val(task.cost);
        if (task.subtasks && task.subtasks.length > 0) {
            $('#detail-cost').prop('readonly', true).addClass('pct-auto');
        } else {
            $('#detail-cost').prop('readonly', false).removeClass('pct-auto');
        }
        $('#btn-flag-task').toggleClass('flagged', task.flagged);

        // Build header predecessor chips
        ensurePredecessorArray(task);
        var $predPicker = $('#detail-predecessor-picker');
        $predPicker.attr('data-target', 'header');
        buildPredecessorChips($predPicker, task.predecessor, task.id);

        // Build header assigned picker chips
        var $headerPicker = $('#detail-assigned-picker');
        buildPickerChips($headerPicker, task.assignedTo);

        // Populate description and attachments
        $('#detail-description').val(task.description || '');
        renderTaskAttachments(task);

        if (task.name && task.name.trim() !== '') {
            $('#btn-add-subtask').show();
        } else {
            $('#btn-add-subtask').hide();
        }

        renderSubtaskTable(task);

        // Sync parent END DATE based on subtasks
        syncParentEndDate(task);
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

        $.each(allRows, function (idx, row) {
            var st = row.subtask;
            var depth = row.depth;
            var isLast = row.isLast;

            ensureAssignedArray(st);

            var $tr = $('<tr>').attr('data-subtask-id', st.id);

            // Task Name cell with tree connector
            var $nameCell = $('<td>');
            var depthClass = 'tree-cell depth-' + depth;
            var $treeCell = $('<div>').addClass(depthClass);

            // Reorder arrows (visible on hover)
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

            if (depth > 0) {
                var connectorClass = 'tree-connector';
                if (!isLast) connectorClass += ' has-more';
                $treeCell.append($('<span>').addClass(connectorClass));
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

            // Start Date
            var $startWrap = $('<div class="subtask-date-wrap">');
            var $startInput = $('<input type="text" placeholder="mm/dd/yyyy">').val(toDisplayDate(st.startDate)).attr('data-field', 'startDate').attr('data-id', st.id);
            setupDateAutoFormat($startInput);
            var $startHidden = $('<input type="date" class="date-hidden-picker" tabindex="-1">').val(st.startDate);
            var $startBtn = $('<button type="button" class="date-picker-btn" tabindex="-1">').html('<i class="fa fa-calendar-days"></i>');
            $startWrap.append($startInput).append($startHidden).append($startBtn);
            $tr.append($('<td>').append($startWrap));

            // End Date
            var $endWrap = $('<div class="subtask-date-wrap">');
            var $endInput = $('<input type="text" placeholder="mm/dd/yyyy">').val(toDisplayDate(st.endDate)).attr('data-field', 'endDate').attr('data-id', st.id);
            setupDateAutoFormat($endInput);
            var $endHidden = $('<input type="date" class="date-hidden-picker" tabindex="-1">').val(st.endDate);
            var $endBtn = $('<button type="button" class="date-picker-btn" tabindex="-1">').html('<i class="fa fa-calendar-days"></i>');
            $endWrap.append($endInput).append($endHidden).append($endBtn);
            $tr.append($('<td>').append($endWrap));

            // Duration — editable if no children, readonly if has children
            var durText = calcDuration(st.startDate, st.endDate);
            var hasChildren = st.subtasks && st.subtasks.length > 0;
            var $durInput = $('<input type="text">').val(durText)
                .attr('data-field', 'duration')
                .attr('data-id', st.id)
                .css({ textAlign: 'right' });
            if (hasChildren) {
                $durInput.prop('readonly', true).css({ background: '#f7f9fc', color: '#666', cursor: 'default' });
            } else {
                $durInput.attr('placeholder', 'e.g. 30');
            }
            $tr.append($('<td>').append($durInput));

            // Predecessor — chip picker
            ensurePredecessorArray(st);
            var $predTd = $('<td>');
            var $subtaskPredPicker = buildSubtaskPredPicker(st.id, st.predecessor);
            $predTd.append($subtaskPredPicker);
            $tr.append($predTd);

            // % Complete
            var $pctInput = $('<input type="text">').val(st.percentComplete).attr('data-field', 'percentComplete').attr('data-id', st.id).css('text-align', 'center');
            if (hasChildren) {
                $pctInput.prop('readonly', true).addClass('pct-auto');
            }
            $tr.append($('<td>').append($pctInput));

            // Status
            var $select = $('<select>').attr('data-field', 'status').attr('data-id', st.id);
            ['Not Started', 'In Progress', 'Completed', 'On Hold', 'Cancelled'].forEach(function (s) {
                $select.append($('<option>').val(s).text(s).prop('selected', s === st.status));
            });
            $tr.append($('<td>').append($select));

            // Assigned To — contact picker
            var $assignedTd = $('<td>');
            var $subtaskPicker = buildSubtaskPicker(st.id, st.assignedTo);
            $assignedTd.append($subtaskPicker);
            $tr.append($assignedTd);

            // Cost
            var $costTd = $('<td>');
            var $costWrap = $('<div class="subtask-cost-wrap">');
            $costWrap.append($('<i class="fa fa-dollar-sign cost-icon-sub">'));
            var $costInput = $('<input type="text" placeholder="0">').val(st.cost).attr('data-field', 'cost').attr('data-id', st.id);
            if (hasChildren) {
                $costInput.prop('readonly', true).addClass('pct-auto');
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
    }

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
        if (!task.startDate) {
            alert('Indicate the Start Date first.');
            $(this).val(calcDuration(task.startDate, task.endDate));
            return;
        }
        var iso = addWorkingDays(task.startDate, days);
        task.endDate = iso;
        $('#detail-end-date').val(toDisplayDate(iso));
        $(this).val(days + 'd');
        saveData();
        sendPatch({op: 'update', taskId: task.id, field: 'endDate', value: iso});
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

    // Delete task
    $('#btn-delete-task').on('click', function () {
        if (!selectedTaskId) return;
        var task = findTaskById(selectedTaskId, tasks);
        var name = (task && task.name) ? '"' + task.name + '"' : 'this task';
        if (!confirm('Delete ' + name + ' and all its subtasks?')) return;

        var deletedId = selectedTaskId;
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].id === selectedTaskId) {
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
        var sub = createTaskObj('');
        sub._pendingAdd = true;
        sub._parentId = task.id;
        task.subtasks.push(sub);
        recomputePercentComplete();
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
        var child = createTaskObj('');
        child._pendingAdd = true;
        child._parentId = parentSubId;
        parentSub.subtasks.push(child);
        recomputePercentComplete();
        recomputeCost();
        renderDetail();
        setTimeout(function () {
            var $inputs = $('#subtask-body input[data-field="name"]');
            $inputs.last().focus();
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
            if (!sub.startDate) {
                alert('Indicate the Start Date first.');
                $(this).val(calcDuration(sub.startDate, sub.endDate));
                return;
            }
            var iso = addWorkingDays(sub.startDate, days);
            sub.endDate = iso;
            $(this).closest('tr').find('input[data-field="endDate"]').val(toDisplayDate(iso));
            $(this).val(days + 'd');
            saveData();
            sendPatch({op: 'update', taskId: sub.id, field: 'endDate', value: iso});
            syncParentEndDate(findTaskById(selectedTaskId, tasks));
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
        } else if (field === 'startDate' || field === 'endDate') {
            var iso = toIsoDate(val);
            if (iso === sub[field]) return;
            sub[field] = iso;
            // Update duration cell in the same row
            var $row = $(this).closest('tr');
            $row.find('input[data-field="duration"]').val(calcDuration(sub.startDate, sub.endDate));
            // If end date changed, sync parent task end date
            if (field === 'endDate') {
                var parentTask = findTaskById(selectedTaskId, tasks);
                syncParentEndDate(parentTask);
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
        }

        if (field === 'cost') {
            recomputeCost();
        }

        if (field === 'status') {
            recomputePercentComplete();
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
        $tbody.empty();
        $empty.hide();
        $wrap.show();
        $picker.show();

        $.ajax({
            url: '/api/group-projects',
            method: 'GET',
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok && resp.projects && resp.projects.length > 0) {
                    $.each(resp.projects, function (i, proj) {
                        var $tr = $('<tr>');
                        var $link = $('<span class="task-picker-link">').text(displayProjectName(proj.name));
                        $link.on('click', function () {
                            openGroupProject(proj.name);
                        });
                        $tr.append($('<td>').append($link));
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
                $wrap.hide();
                $empty.text('Could not load projects. Check server.').show();
            }
        });
    }

    function openGroupProject(name) {
        PROJ_NAME = name;
        $('#task-project-picker').hide();
        $('#project-name-label').text(displayProjectName(name));
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
        $('#project-name-label').text(displayProjectName(name));
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

    // ========== Init ==========
    function isSuperUser() {
        return SUPER_USERS.indexOf(CURRENT_USER_ID) !== -1;
    }

    loadContacts();

    if (!isSuperUser()) {
        $('#btn-delete-task').hide();
    }
    showTaskProjectPicker();

    function loadDefaultGroupProject() {
        PROJ_NAME = DEFAULT_GROUP_PROJECT;
        $('#project-name-label').text(displayProjectName(DEFAULT_GROUP_PROJECT));
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
