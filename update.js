$(document).ready(function () {

    // ========== State ==========
    var CURRENT_USER_ID = 'ab1234';
    var SUPER_USERS = ['ab1234', 'ps1234'];
    var DEFAULT_GROUP_PROJECT = 'INTLITServicesMigration';
    var STORAGE_KEY = 'task_manager_data';
    var CONTACTS_STORAGE_KEY = 'task_manager_contacts';
    var PROJ_NAME = '';
    var tasks = [];
    var taskIdCounter = 0;
    var contacts = [];
    var draggedId = null;
    var openModalTaskId = null; // currently open detail modal task id
    var undoStack = [];  // each entry: { taskId, oldStatus, newStatus, oldPercent, newPercent, label }
    var redoStack = [];
    var boardState = 'initial'; // 'initial' | 'picker-open' | 'my-tasks' | 'no-tasks' | 'all-tasks'

    var COL_DISPLAY_NAMES = {
        'not-started': 'Not Started',
        'in-progress': 'In Progress',
        'done': 'Done'
    };

    // Avatar color palette (same as task.js)
    var avatarColors = [
        '#607D8B', '#E8A838', '#5C6BC0', '#26A69A', '#EF5350',
        '#AB47BC', '#42A5F5', '#66BB6A', '#FFA726', '#8D6E63',
        '#78909C', '#7E57C2', '#29B6F6', '#9CCC65', '#EC407A'
    ];

    // Status → Column mapping
    var STATUS_TO_COL = {
        'Not Started': 'not-started',
        'In Progress': 'in-progress',
        'Completed':   'done',
        'On Hold':     'done',
        'Cancelled':   'done'
    };

    // Default status when dropping into a column
    var COL_DEFAULT_STATUS = {
        'not-started': 'Not Started',
        'in-progress': 'In Progress',
        'done':        'Completed'
    };

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
            socket.emit('send_patch', patch, function (resp) {
                if (!(resp && resp.ok)) {
                    showToast('Save failed: ' + ((resp && resp.error) || 'Unknown'), true);
                }
            });
        } else {
            $.ajax({
                url: '/api/patch-task',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify(patch),
                success: function (resp) {
                    if (!(resp && resp.ok)) {
                        showToast('Save failed: ' + ((resp && resp.error) || 'Unknown'), true);
                    }
                },
                error: function () {
                    showToast('Failed to save change to server', true);
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
            socket.emit('join_project', { project: socketRoom });
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
            socket.emit('leave_project', { project: socketRoom });
        }
        socketRoom = project;
        if (socketConnected) {
            socket.emit('join_project', { project: project });
        }
    }

    // ========== Helpers ==========
    function isSuperUser() {
        return SUPER_USERS.indexOf(CURRENT_USER_ID) !== -1;
    }

    function findTaskById(id, list) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return list[i];
            var found = findTaskById(id, list[i].subtasks || []);
            if (found) return found;
        }
        return null;
    }

    function findParentOf(id, list, parent) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return { parent: parent, list: list, index: i };
            var found = findParentOf(id, list[i].subtasks || [], list[i]);
            if (found) return found;
        }
        return null;
    }

    // Recompute % Complete for all ancestors of a changed task
    function recomputeAncestorPercent(taskId) {
        var info = findParentOf(taskId, tasks, null);
        if (!info || !info.parent) return;
        var parent = info.parent;
        // Recompute this parent's % as average of its direct children
        computePercentFromChildren(parent);
        saveData();
        sendPatch({ op: 'update', taskId: parent.id, field: 'percentComplete', value: parent.percentComplete });
        // Recurse up to grandparent, etc.
        recomputeAncestorPercent(parent.id);
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

    function ensureAssignedArray(task) {
        if (!task.assignedTo) {
            task.assignedTo = [];
        } else if (typeof task.assignedTo === 'string') {
            task.assignedTo = task.assignedTo ? [task.assignedTo] : [];
        }
    }

    function ensurePredecessorArray(task) {
        if (!task.predecessor) {
            task.predecessor = [];
        } else if (!Array.isArray(task.predecessor)) {
            task.predecessor = [task.predecessor];
        }
    }

    function escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function showToast(msg, isError) {
        var $toast = $('<div class="toast">' + escapeHtml(msg) + '</div>');
        if (isError) $toast.addClass('toast-error');
        $('body').append($toast);
        setTimeout(function () {
            $toast.fadeOut(300, function () { $toast.remove(); });
        }, 2500);
    }

    function displayProjectName(name) {
        return (name || '').replace(/_/g, ' ');
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
        var hash = 0;
        for (var i = 0; i < contactId.length; i++) {
            hash = contactId.charCodeAt(i) + ((hash << 5) - hash);
        }
        return avatarColors[Math.abs(hash) % avatarColors.length];
    }

    function statusClass(status) {
        return 'status-' + status.toLowerCase().replace(/\s+/g, '-');
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

    function calcDuration(startIso, endIso) {
        if (!startIso || !endIso) return '';
        var s = new Date(startIso + 'T00:00:00');
        var e = new Date(endIso + 'T00:00:00');
        if (isNaN(s.getTime()) || isNaN(e.getTime())) return '';
        var diff = Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
        return diff + 'd';
    }

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

    // ========== Contacts ==========
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
        var stored = localStorage.getItem(CONTACTS_STORAGE_KEY);
        if (stored) {
            try { contacts = JSON.parse(stored); } catch (e) { contacts = []; }
        }
        mergeContacts(DEFAULT_CONTACTS);
        $.ajax({
            url: 'contacts.json',
            dataType: 'json',
            async: false,
            success: function (data) { mergeContacts(data); },
            error: function () { /* ignore */ }
        });
        saveContacts();
    }

    // ========== Leaf Node Extraction ==========
    function getLeafNodes() {
        var leaves = [];
        function walk(node, path) {
            var currentPath = path.concat(node.name || '(unnamed)');
            if (!node.subtasks || node.subtasks.length === 0) {
                // This is a leaf node
                leaves.push({
                    task: node,
                    breadcrumb: currentPath
                });
            } else {
                for (var i = 0; i < node.subtasks.length; i++) {
                    walk(node.subtasks[i], currentPath);
                }
            }
        }
        for (var t = 0; t < tasks.length; t++) {
            if (!tasks[t].name || !tasks[t].name.trim()) continue;
            walk(tasks[t], []);
        }
        return leaves;
    }

    // ========== Filtering ==========
    function getFilteredLeaves() {
        var allLeaves = getLeafNodes();
        var filterMine = $('#filter-my-items').is(':checked');
        var searchText = $.trim($('#search-input').val()).toLowerCase();

        return allLeaves.map(function (leaf) {
            ensureAssignedArray(leaf.task);
            var isAssigned = leaf.task.assignedTo.indexOf(CURRENT_USER_ID) !== -1;
            var isSuper = isSuperUser();

            // Search filter
            if (searchText) {
                var breadcrumbText = leaf.breadcrumb.join(' ').toLowerCase();
                var taskName = (leaf.task.name || '').toLowerCase();
                if (breadcrumbText.indexOf(searchText) === -1 && taskName.indexOf(searchText) === -1) {
                    return null; // filtered out
                }
            }

            // "Show only my assigned tasks" filter
            if (filterMine && !isAssigned) return null;

            return {
                task: leaf.task,
                breadcrumb: leaf.breadcrumb,
                isAssigned: isAssigned,
                canDrag: isAssigned,
                canEdit: isAssigned,
                readOnly: !isAssigned
            };
        }).filter(function (item) { return item !== null; });
    }

    // ========== Rendering ==========
    function renderBoard() {
        var filtered = getFilteredLeaves();

        var cols = { 'not-started': [], 'in-progress': [], 'done': [] };
        var doneCounts = { 'Completed': 0, 'On Hold': 0, 'Cancelled': 0 };

        for (var i = 0; i < filtered.length; i++) {
            var item = filtered[i];
            var status = item.task.status || 'Not Started';
            var col = STATUS_TO_COL[status] || 'not-started';
            cols[col].push(item);
            if (col === 'done') {
                doneCounts[status] = (doneCounts[status] || 0) + 1;
            }
        }

        // Update counts
        $('#count-not-started').text(cols['not-started'].length);
        $('#count-in-progress').text(cols['in-progress'].length);
        $('#count-done').text(cols['done'].length);

        // Update done sub-counts
        $('#done-sub-counts').text(
            'Completed: ' + doneCounts['Completed'] +
            ' | On-Hold: ' + doneCounts['On Hold'] +
            ' | Cancelled: ' + doneCounts['Cancelled']
        );

        // Render each column
        renderColumn('not-started', cols['not-started']);
        renderColumn('in-progress', cols['in-progress']);
        renderColumn('done', cols['done']);

        // Show/hide states
        var total = filtered.length;
        var filterMine = $('#filter-my-items').is(':checked');
        var hasNonAssigned = false;
        for (var j = 0; j < filtered.length; j++) {
            if (filtered[j].readOnly) { hasNonAssigned = true; break; }
        }

        if (total === 0 && filterMine) {
            // Checkbox checked, no assigned tasks
            $('#kanban-board').hide();
            $('#empty-state').hide();
            $('#no-tasks-state').show();
            $('#kanban-protected-bar').hide();
            boardState = 'no-tasks';
        } else if (total === 0) {
            $('#kanban-board').hide();
            $('#no-tasks-state').hide();
            $('#empty-state').show();
            $('#kanban-protected-bar').hide();
        } else {
            $('#empty-state').hide();
            $('#no-tasks-state').hide();
            $('#kanban-board').show();
            // Show protected bar when viewing non-assigned tasks
            if (!filterMine && hasNonAssigned) {
                $('#kanban-protected-bar').show();
                boardState = 'all-tasks';
            } else {
                $('#kanban-protected-bar').hide();
                boardState = 'my-tasks';
            }
        }
    }

    function renderColumn(colKey, items) {
        var $body = $('.kanban-col-body[data-col="' + colKey + '"]');
        $body.empty();

        if (items.length === 0) {
            $body.append(
                '<div class="kanban-col-empty">' +
                    '<i class="fa fa-layer-group"></i>' +
                    '<span>No items</span>' +
                '</div>'
            );
            return;
        }

        for (var i = 0; i < items.length; i++) {
            $body.append(buildKanbanCard(items[i], colKey));
        }
    }

    function buildBreadcrumbHtml(breadcrumb, forModal) {
        if (!breadcrumb || breadcrumb.length === 0) return '';
        var html = '';
        var sepClass = forModal ? '' : 'breadcrumb-sep';
        var sepIcon = '<span class="' + sepClass + '"><i class="fa fa-angle-right" style="font-size:' + (forModal ? '12' : '9') + 'px;color:#b0b8c4;margin:0 3px;"></i></span>';

        for (var i = 0; i < breadcrumb.length; i++) {
            if (i > 0) html += sepIcon;
            if (i === breadcrumb.length - 1) {
                html += '<span class="breadcrumb-leaf">' + escapeHtml(breadcrumb[i]) + '</span>';
            } else {
                html += '<span class="breadcrumb-ancestor">' + escapeHtml(breadcrumb[i]) + '</span>';
            }
        }
        return html;
    }

    function buildKanbanCard(item, colKey) {
        var task = item.task;
        var $card = $('<div class="kanban-card" data-id="' + task.id + '">');

        if (item.readOnly) {
            $card.addClass('read-only');
        } else if (item.canDrag) {
            $card.addClass('draggable');
            $card.attr('draggable', 'true');
        }

        // Breadcrumb title
        $card.append('<div class="kanban-card-title">' + buildBreadcrumbHtml(item.breadcrumb, false) + '</div>');

        // Details row: progress bar, due date, flag
        var $details = $('<div class="kanban-card-details">');

        // Progress bar
        var pct = task.percentComplete || 0;
        var fillClass = pct >= 80 ? 'high' : pct >= 40 ? 'mid' : '';
        $details.append(
            '<div class="kanban-card-progress">' +
                '<div class="kanban-card-progress-bar"><div class="kanban-card-progress-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>' +
                '<span>' + pct + '%</span>' +
            '</div>'
        );

        // Due date
        if (task.endDate) {
            $details.append(
                '<span class="kanban-card-date"><i class="fa fa-calendar"></i> ' + escapeHtml(toDisplayDate(task.endDate)) + '</span>'
            );
        }

        // Flagged
        if (task.flagged) {
            $details.append('<span class="kanban-card-flag"><i class="fa fa-flag"></i></span>');
        }

        $card.append($details);

        // Footer: status badge + assignee avatars
        var $footer = $('<div class="kanban-card-footer">');

        // Status badge or dropdown (done column gets a select for those who can edit)
        if (colKey === 'done' && item.canEdit) {
            var status = task.status || 'Completed';
            var selectClass = statusClass(status);
            var $select = $('<select class="done-status-select ' + selectClass + '" data-id="' + task.id + '">');
            ['Completed', 'On Hold', 'Cancelled'].forEach(function (s) {
                $select.append('<option value="' + s + '"' + (s === status ? ' selected' : '') + '>' + s + '</option>');
            });
            $footer.append($select);
        } else {
            var sc = statusClass(task.status || 'Not Started');
            $footer.append('<span class="status-badge ' + sc + '">' + escapeHtml(task.status || 'Not Started') + '</span>');
        }

        // Assignee avatars
        ensureAssignedArray(task);
        if (task.assignedTo.length > 0) {
            var $avatars = $('<div class="kanban-card-assignees">');
            var maxShow = 4;
            for (var a = 0; a < Math.min(task.assignedTo.length, maxShow); a++) {
                var contact = getContactById(task.assignedTo[a]);
                var initials = contact ? getInitials(contact.name) : '?';
                var color = getAvatarColor(task.assignedTo[a]);
                $avatars.append(
                    '<div class="kanban-card-avatar" style="background:' + color + '" title="' + escapeHtml(contact ? contact.name : task.assignedTo[a]) + '">' + initials + '</div>'
                );
            }
            if (task.assignedTo.length > maxShow) {
                $avatars.append(
                    '<div class="kanban-card-avatar" style="background:#999" title="' + (task.assignedTo.length - maxShow) + ' more">+' + (task.assignedTo.length - maxShow) + '</div>'
                );
            }
            $footer.append($avatars);
        }

        $card.append($footer);
        return $card;
    }

    // ========== Drag & Drop ==========
    function initDragEvents() {
        $(document).on('dragstart', '.kanban-card.draggable', function (e) {
            draggedId = $(this).data('id');
            $(this).addClass('dragging');
            e.originalEvent.dataTransfer.effectAllowed = 'move';
            e.originalEvent.dataTransfer.setData('text/plain', String(draggedId));
        });

        $(document).on('dragend', '.kanban-card.draggable', function () {
            $(this).removeClass('dragging');
            $('.kanban-col-body').removeClass('drag-over');
            draggedId = null;
        });

        $(document).on('dragover', '.kanban-col-body', function (e) {
            e.preventDefault();
            e.originalEvent.dataTransfer.dropEffect = 'move';
            $(this).addClass('drag-over');
        });

        $(document).on('dragleave', '.kanban-col-body', function (e) {
            if (!this.contains(e.relatedTarget)) {
                $(this).removeClass('drag-over');
            }
        });

        $(document).on('drop', '.kanban-col-body', function (e) {
            e.preventDefault();
            $(this).removeClass('drag-over');

            if (!draggedId) return;

            var targetCol = $(this).data('col');
            var task = findTaskById(draggedId, tasks);
            if (!task) return;

            var currentCol = STATUS_TO_COL[task.status] || 'not-started';
            if (currentCol === targetCol) return;

            var newStatus = COL_DEFAULT_STATUS[targetCol];

            // Record undo entry before changing state
            var oldStatus = task.status || 'Not Started';
            var oldPercent = task.percentComplete || 0;
            var breadcrumb = findBreadcrumb(task.id);
            var label = breadcrumb.join(' > ');

            task.status = newStatus;

            // Also set percentComplete based on status
            if (newStatus === 'Completed') {
                task.percentComplete = 100;
            } else if (newStatus === 'Not Started') {
                task.percentComplete = 0;
            }

            var newPercent = task.percentComplete;

            undoStack.push({
                taskId: task.id,
                oldStatus: oldStatus,
                newStatus: newStatus,
                oldPercent: oldPercent,
                newPercent: newPercent,
                label: label
            });
            redoStack = [];
            updateUndoRedoButtons();

            saveData();
            sendPatch({ op: 'update', taskId: task.id, field: 'status', value: newStatus });
            if (newStatus === 'Completed' || newStatus === 'Not Started') {
                sendPatch({ op: 'update', taskId: task.id, field: 'percentComplete', value: task.percentComplete });
            }
            recomputeAncestorPercent(task.id);
            var droppedTaskId = draggedId;
            renderBoard();
            // Highlight the dropped card
            highlightCard(droppedTaskId);
        });
    }

    // ========== Detail Modal ==========
    function openModal(taskId) {
        var task = findTaskById(taskId, tasks);
        if (!task) return;

        openModalTaskId = taskId;
        ensureAssignedArray(task);
        ensurePredecessorArray(task);

        // Determine permissions -- unified: only assigned users can edit
        var canEdit = task.assignedTo.indexOf(CURRENT_USER_ID) !== -1;
        var readonlyAttr = canEdit ? '' : ' disabled';

        // Find breadcrumb for this leaf
        var breadcrumb = findBreadcrumb(task.id);

        var $body = $('#modal-body');
        $body.empty();

        // Task name / breadcrumb + view-only label
        var protectedLabel = '';
        if (!canEdit) {
            protectedLabel = ' <span class="modal-protected-label"><i class="fa fa-shield-halved"></i> VIEW ONLY: This task is assigned to others</span>';
        }
        $body.append('<div class="modal-task-label"><i class="fa fa-bookmark"></i> Task Name' + protectedLabel + '</div>');
        $body.append('<div class="modal-task-name">' + buildBreadcrumbHtml(breadcrumb, true) + '</div>');

        // Fields grid
        var $fields = $('<div class="modal-fields">');

        // Start Date
        var $startGroup = $('<div class="modal-field-group">');
        $startGroup.append('<div class="modal-field-label">Start Date</div>');
        var $startWrap = $('<div class="modal-date-wrap">');
        var $startInput = $('<input type="text" class="modal-input" data-field="startDate" data-id="' + task.id + '" placeholder="mm/dd/yyyy"' + readonlyAttr + '>').val(toDisplayDate(task.startDate));
        if (canEdit) setupDateAutoFormat($startInput);
        var $startHidden = $('<input type="date" class="date-hidden-picker" tabindex="-1">').val(task.startDate);
        var $startBtn = $('<button type="button" class="date-picker-btn" tabindex="-1"><i class="fa fa-calendar-days"></i></button>');
        if (!canEdit) $startBtn.prop('disabled', true);
        $startWrap.append($startInput).append($startHidden).append($startBtn);
        $startGroup.append($startWrap);
        $fields.append($startGroup);

        // End Date
        var $endGroup = $('<div class="modal-field-group">');
        $endGroup.append('<div class="modal-field-label">End Date</div>');
        var $endWrap = $('<div class="modal-date-wrap">');
        var $endInput = $('<input type="text" class="modal-input" data-field="endDate" data-id="' + task.id + '" placeholder="mm/dd/yyyy"' + readonlyAttr + '>').val(toDisplayDate(task.endDate));
        if (canEdit) setupDateAutoFormat($endInput);
        var $endHidden = $('<input type="date" class="date-hidden-picker" tabindex="-1">').val(task.endDate);
        var $endBtn = $('<button type="button" class="date-picker-btn" tabindex="-1"><i class="fa fa-calendar-days"></i></button>');
        if (!canEdit) $endBtn.prop('disabled', true);
        $endWrap.append($endInput).append($endHidden).append($endBtn);
        $endGroup.append($endWrap);
        $fields.append($endGroup);

        // Duration (readonly, computed)
        var $durGroup = $('<div class="modal-field-group">');
        $durGroup.append('<div class="modal-field-label">Duration</div>');
        $durGroup.append('<input type="text" class="modal-input" data-field="duration" data-id="' + task.id + '" value="' + escapeHtml(calcDuration(task.startDate, task.endDate)) + '" placeholder="e.g. 30"' + readonlyAttr + '>');
        $fields.append($durGroup);

        // Status
        var $statusGroup = $('<div class="modal-field-group">');
        $statusGroup.append('<div class="modal-field-label">Status</div>');
        var $statusSelect = $('<select class="modal-input" data-field="status" data-id="' + task.id + '"' + readonlyAttr + '>');
        ['Not Started', 'In Progress', 'Completed', 'On Hold', 'Cancelled'].forEach(function (s) {
            $statusSelect.append('<option value="' + s + '"' + (s === task.status ? ' selected' : '') + '>' + s + '</option>');
        });
        $statusGroup.append($statusSelect);
        $fields.append($statusGroup);

        // % Complete
        var $pctGroup = $('<div class="modal-field-group">');
        $pctGroup.append('<div class="modal-field-label">% Complete</div>');
        $pctGroup.append('<input type="number" class="modal-input" data-field="percentComplete" data-id="' + task.id + '" min="0" max="100" value="' + (task.percentComplete || 0) + '"' + readonlyAttr + '>');
        $fields.append($pctGroup);

        // Cost
        var $costGroup = $('<div class="modal-field-group">');
        $costGroup.append('<div class="modal-field-label">Cost</div>');
        var $costWrap = $('<div class="modal-cost-wrap">');
        $costWrap.append('<i class="fa fa-dollar-sign cost-icon"></i>');
        $costWrap.append('<input type="text" class="modal-input" data-field="cost" data-id="' + task.id + '" placeholder="0" value="' + escapeHtml(String(task.cost || '')) + '"' + readonlyAttr + '>');
        $costGroup.append($costWrap);
        $fields.append($costGroup);

        // Predecessor (full width)
        var $predGroup = $('<div class="modal-field-group modal-field-full">');
        $predGroup.append('<div class="modal-field-label">Predecessor</div>');
        var $predPicker = buildPredPickerWidget(task.id, task.predecessor, canEdit);
        $predGroup.append($predPicker);
        $fields.append($predGroup);

        // Assigned To (full width)
        var $assignGroup = $('<div class="modal-field-group modal-field-full">');
        $assignGroup.append('<div class="modal-field-label">Assigned To</div>');
        var $contactPicker = buildContactPickerWidget(task.id, task.assignedTo, canEdit);
        $assignGroup.append($contactPicker);
        $fields.append($assignGroup);

        $body.append($fields);

        // Notes & Attachments section
        var $notesSection = $('<div class="modal-notes-section">');
        $notesSection.append('<div class="modal-notes-section-title"><i class="fa fa-file-lines"></i> Notes and Attachments</div>');

        var $grid = $('<div class="modal-notes-grid">');

        // Notes
        var $notesCol = $('<div class="modal-notes-col">');
        var $notesHeader = $('<div class="modal-att-header">');
        $notesHeader.append('<label>Notes</label>');
        if (canEdit) {
            $notesHeader.append('<button class="btn-modal-add-att btn-notes-edit" data-id="' + task.id + '"><i class="fa fa-pen"></i> Edit</button>');
        }
        $notesCol.append($notesHeader);
        $notesCol.append('<textarea class="modal-input modal-notes-textarea" data-field="description" data-id="' + task.id + '" placeholder="Add notes..." rows="4" readonly>' + escapeHtml(task.description || '') + '</textarea>');
        $grid.append($notesCol);

        // Attachments
        var $attCol = $('<div class="modal-notes-col">');
        var $attHeader = $('<div class="modal-att-header">');
        $attHeader.append('<label>Attachments</label>');
        if (canEdit) {
            $attHeader.append(
                '<label class="btn-modal-add-att"><i class="fa fa-plus"></i> Add' +
                '<input type="file" id="modal-attach-input" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv">' +
                '</label>'
            );
        }
        $attCol.append($attHeader);

        var $attArea = $('<div class="modal-att-area" id="modal-att-area">');
        var attachments = task.attachments || [];
        if (attachments.length === 0) {
            $attArea.append(
                '<div class="modal-att-placeholder">' +
                    '<i class="fa fa-cloud-arrow-up"></i>' +
                    '<p>Drop files here</p>' +
                '</div>'
            );
        } else {
            renderModalAttachments($attArea, task, canEdit);
        }
        $attCol.append($attArea);
        $grid.append($attCol);

        $notesSection.append($grid);
        $body.append($notesSection);

        // Close button at bottom-right
        var $closeRow = $('<div class="modal-close-row">');
        $closeRow.append('<button class="btn-modal-close"><i class="fa fa-xmark"></i> Close</button>');
        $body.append($closeRow);

        $('#modal-overlay').addClass('visible');
    }

    function renderModalAttachments($area, task, canEdit) {
        $area.empty();
        var attachments = task.attachments || [];
        if (attachments.length === 0) {
            $area.append(
                '<div class="modal-att-placeholder">' +
                    '<i class="fa fa-cloud-arrow-up"></i>' +
                    '<p>Drop files here</p>' +
                '</div>'
            );
            return;
        }
        $.each(attachments, function (i, att) {
            var icon = getTaskFileIcon(att.type);
            var sizeStr = formatTaskFileSize(att.size);
            var $item = $('<div class="modal-att-item">').attr('data-att-index', i);
            $item.append('<i class="fa ' + icon + '"></i>');
            if (att.storedName) {
                var safeProjName = PROJ_NAME.replace(/[^A-Za-z0-9_\-]/g, '');
                $item.append('<a class="att-name" target="_blank" href="/api/files/' + safeProjName + '/' + att.storedName + '">' + escapeHtml(att.name) + '</a>');
            } else {
                $item.append('<span class="att-name">' + escapeHtml(att.name) + '</span>');
            }
            $item.append('<span class="att-size">' + sizeStr + '</span>');
            if (canEdit) {
                $item.append('<span class="att-remove" title="Remove" data-task-id="' + task.id + '"><i class="fa fa-xmark"></i></span>');
            }
            $area.append($item);
        });
    }

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
        if (!bytes) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function findBreadcrumb(taskId) {
        var leaves = getLeafNodes();
        for (var i = 0; i < leaves.length; i++) {
            if (leaves[i].task.id === taskId) return leaves[i].breadcrumb;
        }
        // Fallback: just return the task name
        var task = findTaskById(taskId, tasks);
        return task ? [task.name || '(unnamed)'] : ['(unknown)'];
    }

    function closeModal() {
        // Save notes if textarea was being edited
        var $textarea = $('#modal-body .modal-notes-textarea');
        if ($textarea.length && openModalTaskId) {
            var task = findTaskById(openModalTaskId, tasks);
            if (task) {
                var val = $textarea.val();
                if (val !== (task.description || '')) {
                    task.description = val;
                    saveData();
                    sendPatch({ op: 'update', taskId: task.id, field: 'description', value: val });
                }
            }
        }
        $('#modal-overlay').removeClass('visible');
        closeContactDropdown();
        closePredecessorDropdown();
        openModalTaskId = null;
    }

    // ========== Contact Picker Widget (for modal) ==========
    var activePickerTarget = null;
    var activePickerEl = null;

    function buildContactPickerWidget(taskId, assignedArr, canEdit) {
        var $picker = $('<div class="contact-picker">')
            .attr('data-target', 'modal')
            .attr('data-task-id', taskId);
        var $area = $('<div class="cp-chips-area">');
        var $input = $('<input type="text" class="cp-filter-input">').attr('placeholder', assignedArr.length > 0 ? '' : 'Select...');
        if (!canEdit) $input.prop('disabled', true);
        $area.append($input);
        $picker.append($area);
        if (canEdit) {
            $picker.append($('<button type="button" class="cp-dropdown-btn" tabindex="-1">').html('<i class="fa fa-caret-down"></i>'));
        }

        $.each(assignedArr, function (i, contactId) {
            var contact = getContactById(contactId);
            if (!contact) return;
            var initials = getInitials(contact.name);
            var color = getAvatarColor(contact.id);
            var $chip = $('<span class="cp-chip">').attr('data-contact-id', contact.id);
            $chip.append($('<span class="cp-avatar-sm">').css('background', color).text(initials));
            $chip.append($('<span class="cp-chip-name">').text(contact.name));
            if (canEdit) $chip.append($('<span class="cp-chip-remove">').html('&times;'));
            $input.before($chip);
        });

        return $picker;
    }

    function buildPickerChips($picker, assignedArr) {
        var $area = $picker.find('.cp-chips-area');
        $area.find('.cp-chip').remove();
        var $input = $area.find('.cp-filter-input');

        $.each(assignedArr, function (i, contactId) {
            var contact = getContactById(contactId);
            if (!contact) return;
            var initials = getInitials(contact.name);
            var color = getAvatarColor(contact.id);
            var $chip = $('<span class="cp-chip">').attr('data-contact-id', contact.id);
            $chip.append($('<span class="cp-avatar-sm">').css('background', color).text(initials));
            $chip.append($('<span class="cp-chip-name">').text(contact.name));
            $chip.append($('<span class="cp-chip-remove">').html('&times;'));
            $input.before($chip);
        });

        $input.attr('placeholder', assignedArr.length > 0 ? '' : 'Select...');
    }

    function openContactDropdown($picker) {
        var $dropdown = $('#contact-dropdown');
        activePickerEl = $picker[0];
        activePickerTarget = { taskId: parseInt($picker.attr('data-task-id')) };

        $picker.addClass('cp-open');
        renderContactDropdownList('');
        positionDropdown($picker, $dropdown, 300);
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

    function positionDropdown($picker, $dropdown, width) {
        var rect = $picker[0].getBoundingClientRect();
        var top = rect.bottom + 2;
        var left = rect.left;
        if (left + width > window.innerWidth) left = window.innerWidth - width - 10;
        if (top + 340 > window.innerHeight) top = rect.top - 342;
        $dropdown.css({ top: top + 'px', left: left + 'px' });
    }

    function getModalAssignedArray() {
        if (!activePickerTarget) return [];
        var task = findTaskById(activePickerTarget.taskId, tasks);
        if (!task) return [];
        ensureAssignedArray(task);
        return task.assignedTo;
    }

    function setModalAssignedArray(arr) {
        if (!activePickerTarget) return;
        var task = findTaskById(activePickerTarget.taskId, tasks);
        if (task) {
            task.assignedTo = arr;
            saveData();
            sendPatch({ op: 'update', taskId: task.id, field: 'assignedTo', value: arr.slice() });
        }
    }

    function renderContactDropdownList(filterText) {
        var $list = $('#contact-dropdown-list');
        $list.empty();

        var assigned = getModalAssignedArray();
        var filter = (filterText || '').toLowerCase();

        var matched = 0;
        $.each(contacts, function (i, contact) {
            if (filter && contact.name.toLowerCase().indexOf(filter) === -1 && contact.id.toLowerCase().indexOf(filter) === -1) return;
            matched++;
            var isSelected = assigned.indexOf(contact.id) !== -1;
            var initials = getInitials(contact.name);
            var color = getAvatarColor(contact.id);

            var $item = $('<div class="contact-dropdown-item">').attr('data-contact-id', contact.id).toggleClass('selected', isSelected);
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

    // Contact picker events
    $(document).on('click', '.cp-dropdown-btn', function (e) {
        e.stopPropagation();
        var $picker = $(this).closest('.contact-picker');
        if (activePickerEl === $picker[0]) {
            closeContactDropdown();
        } else {
            closeContactDropdown();
            closePredecessorDropdown();
            openContactDropdown($picker);
        }
    });

    $(document).on('click', '.cp-chips-area', function (e) {
        if ($(e.target).hasClass('cp-chip-remove') || $(e.target).closest('.cp-chip-remove').length) return;
        var $picker = $(this).closest('.contact-picker');
        if ($picker.find('.cp-filter-input').is(':disabled')) return;
        if (activePickerEl !== $picker[0]) {
            closeContactDropdown();
            closePredecessorDropdown();
            openContactDropdown($picker);
        } else {
            $picker.find('.cp-filter-input').focus();
        }
    });

    $(document).on('input', '.cp-filter-input', function () {
        if (!activePickerEl) return;
        renderContactDropdownList($(this).val());
    });

    $(document).on('click', '.contact-dropdown-item', function (e) {
        e.stopPropagation();
        var contactId = $(this).attr('data-contact-id');
        var assigned = getModalAssignedArray();
        var idx = assigned.indexOf(contactId);
        if (idx !== -1) {
            assigned.splice(idx, 1);
        } else {
            assigned.push(contactId);
        }
        setModalAssignedArray(assigned);
        renderContactDropdownList($(activePickerEl).find('.cp-filter-input').val());
        buildPickerChips($(activePickerEl), assigned);
        renderBoard();
    });

    $(document).on('click', '.cp-chip-remove', function (e) {
        e.stopPropagation();
        var $chip = $(this).closest('.cp-chip');
        var contactId = $chip.attr('data-contact-id');
        var $picker = $chip.closest('.contact-picker');
        var taskId = parseInt($picker.attr('data-task-id'));
        var task = findTaskById(taskId, tasks);
        if (!task) return;
        ensureAssignedArray(task);
        var idx = task.assignedTo.indexOf(contactId);
        if (idx !== -1) task.assignedTo.splice(idx, 1);
        saveData();
        sendPatch({ op: 'update', taskId: task.id, field: 'assignedTo', value: task.assignedTo.slice() });
        buildPickerChips($picker, task.assignedTo);
        if (activePickerEl === $picker[0]) {
            renderContactDropdownList($picker.find('.cp-filter-input').val());
        }
        renderBoard();
    });

    $(document).on('keydown', '.cp-filter-input', function (e) {
        if (e.key === 'Backspace' && $(this).val() === '') {
            var $picker = $(this).closest('.contact-picker');
            var $lastChip = $picker.find('.cp-chip').last();
            if ($lastChip.length) $lastChip.find('.cp-chip-remove').click();
        }
        if (e.key === 'Escape') closeContactDropdown();
    });

    // Add new contact
    $(document).on('click', '#btn-add-new-contact', function (e) {
        e.preventDefault();
        e.stopPropagation();
        $('#add-contact-dialog').show();
        $('#new-contact-name').val('').focus();
        $('#new-contact-id').val('');
    });

    $('#add-contact-cancel').on('click', function () { $('#add-contact-dialog').hide(); });

    $('#add-contact-ok').on('click', function () {
        var name = $('#new-contact-name').val().trim();
        var id = $('#new-contact-id').val().trim();
        if (!name) { alert('Please enter a name.'); return; }
        if (!id) { alert('Please enter an ID.'); return; }
        if (getContactById(id)) { alert('A contact with ID "' + id + '" already exists.'); return; }
        contacts.push({ id: id, name: name });
        saveContacts();
        $('#add-contact-dialog').hide();
        showToast('Contact "' + name + '" added');
        if (activePickerEl) {
            renderContactDropdownList($(activePickerEl).find('.cp-filter-input').val());
        }
    });

    $('#new-contact-id').on('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('#add-contact-ok').click(); }
    });

    // Close contact dropdown on outside click
    $(document).on('mousedown', function (e) {
        if (!activePickerEl) return;
        var $target = $(e.target);
        if ($target.closest('#contact-dropdown').length || $target.closest('.contact-picker').length) return;
        closeContactDropdown();
    });

    // ========== Predecessor Picker Widget (for modal) ==========
    var activePredPickerTarget = null;
    var activePredPickerEl = null;

    function buildPredPickerWidget(taskId, predArray, canEdit) {
        var $picker = $('<div class="predecessor-picker">')
            .attr('data-target', 'modal')
            .attr('data-task-id', taskId);
        var $area = $('<div class="pp-chips-area">');
        var $input = $('<input type="text" class="pp-filter-input">').attr('placeholder', predArray.length > 0 ? '' : 'Select...');
        if (!canEdit) $input.prop('disabled', true);
        $area.append($input);
        $picker.append($area);
        if (canEdit) {
            $picker.append($('<button type="button" class="pp-dropdown-btn" tabindex="-1">').html('<i class="fa fa-caret-down"></i>'));
        }

        $.each(predArray, function (i, predId) {
            var label = buildPredecessorLabel(predId);
            if (!label) return;
            var $chip = $('<span class="pp-chip">').attr('data-pred-id', predId);
            $chip.append($('<span class="pp-chip-label">').text(label));
            if (canEdit) $chip.append($('<span class="pp-chip-remove">').html('&times;'));
            $input.before($chip);
        });

        return $picker;
    }

    function buildPredecessorLabel(predId) {
        if (!predId) return '';
        // Check top-level tasks
        for (var ti = 0; ti < tasks.length; ti++) {
            if (String(tasks[ti].id) === String(predId)) return tasks[ti].name || '';
        }
        // Check subtasks
        var allRows = [];
        $.each(tasks, function (ti, t) {
            flattenSubtasksForPred(t.subtasks, 0, allRows, t.id);
        });
        for (var i = 0; i < allRows.length; i++) {
            var pRow = allRows[i];
            if (String(pRow.subtask.id) === String(predId)) {
                return buildSubtaskPath(pRow);
            }
        }
        return '';
    }

    function flattenSubtasksForPred(subtasks, depth, result, parentId) {
        if (!subtasks) return;
        $.each(subtasks, function (i, st) {
            result.push({ subtask: st, depth: depth, parentId: parentId });
            if (st.subtasks && st.subtasks.length > 0) {
                flattenSubtasksForPred(st.subtasks, depth + 1, result, st.id);
            }
        });
    }

    function buildSubtaskPath(pRow) {
        var parentObj = findTaskById(pRow.parentId, tasks);
        var parentName = parentObj ? (parentObj.name || '(unnamed)') : '(unnamed)';
        if (pRow.depth === 0) {
            return parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
        } else if (pRow.depth === 1) {
            var gpInfo = findParentOf(pRow.parentId, tasks, null);
            var gpName = (gpInfo && gpInfo.parent) ? (gpInfo.parent.name || '(unnamed)') : '(unnamed)';
            return gpName + ' > ' + parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
        } else {
            var gpInfo = findParentOf(pRow.parentId, tasks, null);
            var gpName = (gpInfo && gpInfo.parent) ? (gpInfo.parent.name || '(unnamed)') : '(unnamed)';
            var ggpInfo = gpInfo && gpInfo.parent ? findParentOf(gpInfo.parent.id, tasks, null) : null;
            var ggpName = (ggpInfo && ggpInfo.parent) ? (ggpInfo.parent.name || '(unnamed)') : '(unnamed)';
            return ggpName + ' > ' + gpName + ' > ' + parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
        }
    }

    function buildPredecessorChips($picker, predArray) {
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

        $input.attr('placeholder', predArray.length > 0 ? '' : 'Select...');
    }

    function openPredecessorDropdown($picker) {
        var $dropdown = $('#predecessor-dropdown');
        activePredPickerEl = $picker[0];
        activePredPickerTarget = { taskId: parseInt($picker.attr('data-task-id')) };

        $picker.addClass('pp-open');
        $('#pred-search-filter').val('');
        renderPredDropdownList('');
        positionDropdown($picker, $dropdown, 340);
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

    function getModalPredArray() {
        if (!activePredPickerTarget) return [];
        var task = findTaskById(activePredPickerTarget.taskId, tasks);
        if (!task) return [];
        ensurePredecessorArray(task);
        return task.predecessor;
    }

    function setModalPredArray(arr) {
        if (!activePredPickerTarget) return;
        var task = findTaskById(activePredPickerTarget.taskId, tasks);
        if (task) {
            task.predecessor = arr;
            saveData();
            sendPatch({ op: 'update', taskId: task.id, field: 'predecessor', value: arr.slice() });
        }
    }

    function renderPredDropdownList(filterText) {
        var $list = $('#pred-dropdown-list');
        $list.empty();

        var selectedPreds = getModalPredArray();
        var filter = (filterText || '').toLowerCase();
        var selfId = activePredPickerTarget ? activePredPickerTarget.taskId : null;

        var allGlobalRows = [];
        $.each(tasks, function (ti, t) {
            if (t.name && t.name.trim()) {
                allGlobalRows.push({ subtask: t, depth: -1, parentId: null });
            }
            flattenSubtasksForPred(t.subtasks, 0, allGlobalRows, t.id);
        });

        var labeledRows = [];
        $.each(allGlobalRows, function (pi, pRow) {
            if (pRow.subtask.id === selfId) return;
            var label;
            if (pRow.depth === -1) {
                label = pRow.subtask.name;
            } else {
                label = buildSubtaskPath(pRow);
            }
            if (filter && label.toLowerCase().indexOf(filter) === -1) return;
            labeledRows.push({ pRow: pRow, label: label });
        });

        labeledRows.sort(function (a, b) {
            return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
        });

        $.each(labeledRows, function (i, item) {
            var isSelected = false;
            for (var s = 0; s < selectedPreds.length; s++) {
                if (String(selectedPreds[s]) === String(item.pRow.subtask.id)) { isSelected = true; break; }
            }
            var $item = $('<div class="pred-dropdown-item">').attr('data-pred-id', item.pRow.subtask.id).toggleClass('selected', isSelected);
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
        if ($picker.find('.pp-filter-input').is(':disabled')) return;
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

    $(document).on('click', '#pred-search-filter', function (e) { e.stopPropagation(); });

    $(document).on('click', '.pred-dropdown-item', function (e) {
        e.stopPropagation();
        var predId = parseInt($(this).attr('data-pred-id'));
        var preds = getModalPredArray();
        var idx = -1;
        for (var i = 0; i < preds.length; i++) {
            if (String(preds[i]) === String(predId)) { idx = i; break; }
        }
        if (idx !== -1) preds.splice(idx, 1);
        else preds.push(predId);
        setModalPredArray(preds);

        var filterVal = $('#pred-search-filter').val() || $(activePredPickerEl).find('.pp-filter-input').val();
        renderPredDropdownList(filterVal);
        buildPredecessorChips($(activePredPickerEl), preds);
    });

    $(document).on('click', '.pp-chip-remove', function (e) {
        e.stopPropagation();
        var $chip = $(this).closest('.pp-chip');
        var predId = parseInt($chip.attr('data-pred-id'));
        var $picker = $chip.closest('.predecessor-picker');
        var taskId = parseInt($picker.attr('data-task-id'));
        var task = findTaskById(taskId, tasks);
        if (!task) return;
        ensurePredecessorArray(task);

        var idx = -1;
        for (var i = 0; i < task.predecessor.length; i++) {
            if (String(task.predecessor[i]) === String(predId)) { idx = i; break; }
        }
        if (idx !== -1) task.predecessor.splice(idx, 1);

        saveData();
        sendPatch({ op: 'update', taskId: task.id, field: 'predecessor', value: task.predecessor.slice() });
        buildPredecessorChips($picker, task.predecessor);

        if (activePredPickerEl === $picker[0]) {
            renderPredDropdownList($picker.find('.pp-filter-input').val());
        }
    });

    $(document).on('keydown', '.pp-filter-input', function (e) {
        if (e.key === 'Backspace' && $(this).val() === '') {
            var $picker = $(this).closest('.predecessor-picker');
            var $lastChip = $picker.find('.pp-chip').last();
            if ($lastChip.length) $lastChip.find('.pp-chip-remove').click();
        }
        if (e.key === 'Escape') closePredecessorDropdown();
    });

    // Close predecessor dropdown on outside click
    $(document).on('mousedown', function (e) {
        if (!activePredPickerEl) return;
        var $target = $(e.target);
        if ($target.closest('#predecessor-dropdown').length || $target.closest('.predecessor-picker').length) return;
        closePredecessorDropdown();
    });

    // ========== Modal Field Events ==========

    // Date picker button in modal
    $(document).on('click', '#modal-body .date-picker-btn', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var $hidden = $(this).siblings('.date-hidden-picker');
        var $text = $(this).siblings('input[type="text"]');
        var iso = toIsoDate($text.val());
        if (iso) $hidden.val(iso);
        $hidden.css({ opacity: 0, pointerEvents: 'auto', width: 'auto', height: 'auto' });
        $hidden[0].showPicker();
    });

    $(document).on('change', '#modal-body .date-hidden-picker', function () {
        var iso = $(this).val();
        $(this).siblings('input[type="text"]').val(toDisplayDate(iso)).trigger('change');
    });

    $(document).on('blur', '#modal-body .date-hidden-picker', function () {
        $(this).css({ opacity: 0, pointerEvents: 'none', width: 0, height: 0 });
    });

    // All modal field changes
    $(document).on('input change blur', '#modal-body .modal-input', function (e) {
        var $el = $(this);
        var field = $el.attr('data-field');
        var taskId = parseInt($el.attr('data-id'));
        if (!field || !taskId) return;

        var task = findTaskById(taskId, tasks);
        if (!task) return;

        var val = $el.val();

        if ($el.is('select') && e.type !== 'change') return;
        if ((field === 'description' || field === 'cost') && e.type !== 'input') return;

        if (field === 'startDate' || field === 'endDate') {
            if (e.type !== 'change' && e.type !== 'blur') return;
            var iso = toIsoDate(val);
            if (iso === task[field]) return;
            task[field] = iso;
            // Update duration display
            $('#modal-body .modal-input[data-field="duration"]').val(calcDuration(task.startDate, task.endDate));
            saveData();
            sendPatch({ op: 'update', taskId: task.id, field: field, value: iso });
            return;
        }

        if (field === 'duration') {
            if (e.type !== 'change' && e.type !== 'blur') return;
            var rawDur = val.replace(/[^0-9]/g, '');
            if (!rawDur) return;
            var days = parseInt(rawDur);
            if (isNaN(days) || days < 0) return;
            if (!task.startDate) {
                alert('Indicate the Start Date first.');
                $el.val(calcDuration(task.startDate, task.endDate));
                return;
            }
            var start = new Date(task.startDate + 'T00:00:00');
            var end = new Date(start.getTime() + (days - 1) * 24 * 60 * 60 * 1000);
            var endIso = end.getFullYear() + '-' + String(end.getMonth() + 1).padStart(2, '0') + '-' + String(end.getDate()).padStart(2, '0');
            task.endDate = endIso;
            $('#modal-body .modal-input[data-field="endDate"]').val(toDisplayDate(endIso));
            $el.val(days + 'd');
            saveData();
            sendPatch({ op: 'update', taskId: task.id, field: 'endDate', value: endIso });
            return;
        }

        if (field === 'percentComplete') {
            var pctVal = parseInt(val) || 0;
            if (pctVal > 100) {
                alert('The maximum percent completion should only be 100%');
                $el.val(task.percentComplete);
                return;
            }
            if (pctVal < 0) pctVal = 0;
            task.percentComplete = pctVal;
            saveData();
            sendPatchDebounced('pct-' + taskId, function () {
                var t = findTaskById(taskId, tasks);
                return t ? { op: 'update', taskId: taskId, field: 'percentComplete', value: t.percentComplete } : null;
            });
            recomputeAncestorPercent(task.id);
            renderBoard();
            return;
        }

        if (field === 'status') {
            task.status = val;
            if (val === 'Completed') {
                task.percentComplete = 100;
                $('#modal-body .modal-input[data-field="percentComplete"]').val(100);
            } else if (val === 'Not Started') {
                task.percentComplete = 0;
                $('#modal-body .modal-input[data-field="percentComplete"]').val(0);
            }
            saveData();
            sendPatch({ op: 'update', taskId: task.id, field: 'status', value: val });
            if (val === 'Completed' || val === 'Not Started') {
                sendPatch({ op: 'update', taskId: task.id, field: 'percentComplete', value: task.percentComplete });
            }
            recomputeAncestorPercent(task.id);
            renderBoard();
            return;
        }

        if (field === 'cost') {
            task.cost = val;
            saveData();
            sendPatchDebounced('cost-' + taskId, function () {
                var t = findTaskById(taskId, tasks);
                return t ? { op: 'update', taskId: taskId, field: 'cost', value: t.cost } : null;
            });
            return;
        }

        if (field === 'description') {
            task.description = val;
            saveData();
            sendPatchDebounced('desc-' + taskId, function () {
                var t = findTaskById(taskId, tasks);
                return t ? { op: 'update', taskId: taskId, field: 'description', value: t.description } : null;
            });
            return;
        }
    });

    // Done-column status dropdown change (on card)
    $(document).on('change', '.done-status-select', function (e) {
        e.stopPropagation();
        var taskId = parseInt($(this).data('id'));
        var newStatus = $(this).val();
        var task = findTaskById(taskId, tasks);
        if (!task) return;

        task.status = newStatus;
        if (newStatus === 'Completed') {
            task.percentComplete = 100;
        }
        saveData();
        sendPatch({ op: 'update', taskId: task.id, field: 'status', value: newStatus });
        if (newStatus === 'Completed') {
            sendPatch({ op: 'update', taskId: task.id, field: 'percentComplete', value: 100 });
        }
        recomputeAncestorPercent(task.id);
        renderBoard();
    });

    // Click kanban card → open modal (but not if clicking the done-status dropdown)
    $(document).on('click', '.kanban-card', function (e) {
        if ($(e.target).closest('.done-status-select').length) return;
        var taskId = parseInt($(this).data('id'));
        openModal(taskId);
    });

    // Close modal
    $('#modal-close').on('click', function () { closeModal(); });
    $(document).on('click', '.btn-modal-close', function () { closeModal(); });
    $('#modal-overlay').on('click', function (e) {
        if (e.target === this) closeModal();
    });
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape') closeModal();
    });

    // Notes Edit / Save toggle
    $(document).on('click', '.btn-notes-edit', function () {
        var $btn = $(this);
        var taskId = parseInt($btn.attr('data-id'));
        var $textarea = $('#modal-body .modal-notes-textarea[data-id="' + taskId + '"]');
        var isEditing = $btn.hasClass('notes-editing');

        if (isEditing) {
            // Switch back to read-only
            $textarea.attr('readonly', true);
            $btn.removeClass('notes-editing');
            $btn.html('<i class="fa fa-pen"></i> Edit');
        } else {
            // Enable editing
            $textarea.removeAttr('readonly');
            $textarea.focus();
            $btn.addClass('notes-editing');
            $btn.html('<i class="fa fa-floppy-disk"></i> Save');
        }
    });

    // Attachment events in modal
    $(document).on('change', '#modal-attach-input', function () {
        var taskId = openModalTaskId;
        var task = findTaskById(taskId, tasks);
        if (!task) return;
        processModalFiles(this.files, task);
        $(this).val('');
    });

    $(document).on('click', '.modal-att-item .att-remove', function () {
        var taskId = parseInt($(this).attr('data-task-id'));
        var task = findTaskById(taskId, tasks);
        if (!task) return;
        var $item = $(this).closest('.modal-att-item');
        var idx = parseInt($item.attr('data-att-index'));
        if (!task.attachments || idx >= task.attachments.length) return;

        var att = task.attachments[idx];
        if (att.storedName) {
            $.ajax({
                url: '/api/delete-file',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ project: PROJ_NAME, storedName: att.storedName })
            });
        }
        task.attachments.splice(idx, 1);
        saveData();
        sendPatch({ op: 'update', taskId: task.id, field: 'attachments', value: task.attachments.slice() });
        var canEdit = isSuperUser() || task.assignedTo.indexOf(CURRENT_USER_ID) !== -1;
        renderModalAttachments($('#modal-att-area'), task, canEdit);
    });

    // Drag & drop on modal attachment area
    $(document).on('dragover', '#modal-att-area', function (e) {
        e.preventDefault();
        $(this).addClass('drag-over');
    });
    $(document).on('dragleave', '#modal-att-area', function () {
        $(this).removeClass('drag-over');
    });
    $(document).on('drop', '#modal-att-area', function (e) {
        e.preventDefault();
        $(this).removeClass('drag-over');
        var taskId = openModalTaskId;
        var task = findTaskById(taskId, tasks);
        if (!task) return;
        processModalFiles(e.originalEvent.dataTransfer.files, task);
    });

    function processModalFiles(files, task) {
        if (!files || files.length === 0) return;
        var allowed = /^(image\/|application\/pdf|application\/msword|application\/vnd\.openxmlformats|application\/vnd\.ms-excel|text\/)/;
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (!allowed.test(file.type) && !file.name.match(/\.(csv|txt|doc|docx|xls|xlsx|pdf)$/i)) {
                showToast('File "' + file.name + '" is not an allowed type.', true);
                continue;
            }
            uploadModalFile(file, task);
        }
    }

    function uploadModalFile(file, task) {
        if (!task.attachments) task.attachments = [];
        var attIndex = task.attachments.length;
        task.attachments.push({
            name: file.name,
            size: file.size,
            type: file.type,
            storedName: '',
            uploading: true
        });

        var formData = new FormData();
        formData.append('file', file);
        formData.append('project', PROJ_NAME);

        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload', true);

        xhr.onload = function () {
            if (xhr.status === 200) {
                try {
                    var resp = JSON.parse(xhr.responseText);
                    if (resp.ok) {
                        task.attachments[attIndex].storedName = resp.storedName;
                        task.attachments[attIndex].uploading = false;
                        saveData();
                        sendPatch({ op: 'update', taskId: task.id, field: 'attachments', value: task.attachments.slice() });
                        if (openModalTaskId === task.id) {
                            var canEdit = isSuperUser() || task.assignedTo.indexOf(CURRENT_USER_ID) !== -1;
                            renderModalAttachments($('#modal-att-area'), task, canEdit);
                        }
                        return;
                    }
                } catch (e) { /* fall through */ }
            }
            task.attachments.splice(attIndex, 1);
            showToast('Upload failed for "' + file.name + '"', true);
        };

        xhr.onerror = function () {
            task.attachments.splice(attIndex, 1);
            showToast('Upload failed for "' + file.name + '"', true);
        };

        xhr.send(formData);
    }

    // ========== Undo/Redo System ==========
    function highlightCard(taskId) {
        var $card = $('.kanban-card[data-id="' + taskId + '"]');
        if ($card.length) {
            $card.addClass('card-just-dropped');
            setTimeout(function () {
                $card.removeClass('card-just-dropped');
            }, 5000);
        }
    }

    function updateUndoRedoButtons() {
        $('#btn-undo').prop('disabled', undoStack.length === 0);
        $('#btn-redo').prop('disabled', redoStack.length === 0);
        $('#btn-move-history').prop('disabled', undoStack.length === 0);
    }

    function performUndo() {
        if (undoStack.length === 0) return;
        var entry = undoStack.pop();
        var task = findTaskById(entry.taskId, tasks);
        if (!task) { updateUndoRedoButtons(); return; }
        // Safety: only allow undo for tasks the user owns
        ensureAssignedArray(task);
        if (task.assignedTo.indexOf(CURRENT_USER_ID) === -1) {
            undoStack.push(entry); // put it back
            showToast('Cannot undo: task is not assigned to you', true);
            return;
        }

        task.status = entry.oldStatus;
        task.percentComplete = entry.oldPercent;

        redoStack.push({
            taskId: entry.taskId,
            oldStatus: entry.oldStatus,
            newStatus: entry.newStatus,
            oldPercent: entry.oldPercent,
            newPercent: entry.newPercent,
            label: entry.label
        });

        saveData();
        sendPatch({ op: 'update', taskId: task.id, field: 'status', value: entry.oldStatus });
        if (entry.oldPercent !== entry.newPercent) {
            sendPatch({ op: 'update', taskId: task.id, field: 'percentComplete', value: entry.oldPercent });
        }
        recomputeAncestorPercent(entry.taskId);
        renderBoard();
        highlightCard(entry.taskId);

        var fromCol = COL_DISPLAY_NAMES[STATUS_TO_COL[entry.newStatus] || 'not-started'] || entry.newStatus;
        var toCol = COL_DISPLAY_NAMES[STATUS_TO_COL[entry.oldStatus] || 'not-started'] || entry.oldStatus;
        showToast('Undo: moved back to ' + toCol);
        updateUndoRedoButtons();
    }

    function performRedo() {
        if (redoStack.length === 0) return;
        var entry = redoStack.pop();
        var task = findTaskById(entry.taskId, tasks);
        if (!task) { updateUndoRedoButtons(); return; }
        // Safety: only allow redo for tasks the user owns
        ensureAssignedArray(task);
        if (task.assignedTo.indexOf(CURRENT_USER_ID) === -1) {
            redoStack.push(entry); // put it back
            showToast('Cannot redo: task is not assigned to you', true);
            return;
        }

        task.status = entry.newStatus;
        task.percentComplete = entry.newPercent;

        undoStack.push({
            taskId: entry.taskId,
            oldStatus: entry.oldStatus,
            newStatus: entry.newStatus,
            oldPercent: entry.oldPercent,
            newPercent: entry.newPercent,
            label: entry.label
        });

        saveData();
        sendPatch({ op: 'update', taskId: task.id, field: 'status', value: entry.newStatus });
        if (entry.oldPercent !== entry.newPercent) {
            sendPatch({ op: 'update', taskId: task.id, field: 'percentComplete', value: entry.newPercent });
        }
        recomputeAncestorPercent(entry.taskId);
        renderBoard();
        highlightCard(entry.taskId);

        var toCol = COL_DISPLAY_NAMES[STATUS_TO_COL[entry.newStatus] || 'not-started'] || entry.newStatus;
        showToast('Redo: moved to ' + toCol);
        updateUndoRedoButtons();
    }

    var HISTORY_COL_COLORS = {
        'Not Started': '#6ab0ff',
        'In Progress': '#e8a838',
        'Done': '#b07ae8'
    };

    function colSpan(colName) {
        var color = HISTORY_COL_COLORS[colName] || '#c0d0e8';
        return '<span style="color:' + color + ';font-weight:600;">' + escapeHtml(colName) + '</span>';
    }

    function renderMoveHistoryDropdown() {
        var $dropdown = $('#move-history-dropdown');
        $dropdown.empty();
        if (undoStack.length === 0) {
            $dropdown.append('<div class="move-history-empty">No move history</div>');
            return;
        }
        for (var i = undoStack.length - 1; i >= 0; i--) {
            var entry = undoStack[i];
            var fromCol = COL_DISPLAY_NAMES[STATUS_TO_COL[entry.oldStatus] || 'not-started'] || entry.oldStatus;
            var toCol = COL_DISPLAY_NAMES[STATUS_TO_COL[entry.newStatus] || 'not-started'] || entry.newStatus;
            var html = escapeHtml(entry.label) + ' <i>moved from</i> ' + colSpan(fromCol) + ' <i>to</i> ' + colSpan(toCol);
            var plainText = entry.label + ' moved from ' + fromCol + ' to ' + toCol;
            var $item = $('<div class="move-history-item">').html(html).attr('data-undo-index', i).attr('title', plainText);
            $dropdown.append($item);
        }
    }

    // Undo button
    $('#btn-undo').on('click', function () { performUndo(); });

    // Redo button
    $('#btn-redo').on('click', function () { performRedo(); });

    // History dropdown toggle
    $('#btn-move-history').on('click', function (e) {
        e.stopPropagation();
        var $dropdown = $('#move-history-dropdown');
        if ($dropdown.is(':visible')) {
            $dropdown.hide();
        } else {
            renderMoveHistoryDropdown();
            $dropdown.show();
        }
    });

    // Click a history item to undo back to that point
    $(document).on('click', '.move-history-item', function (e) {
        e.stopPropagation();
        var targetIndex = parseInt($(this).attr('data-undo-index'));
        // Undo all entries from top of stack down to and including targetIndex
        var count = undoStack.length - targetIndex;
        for (var i = 0; i < count; i++) {
            if (undoStack.length === 0) break;
            var entry = undoStack.pop();
            var task = findTaskById(entry.taskId, tasks);
            if (!task) continue;

            task.status = entry.oldStatus;
            task.percentComplete = entry.oldPercent;

            redoStack.push({
                taskId: entry.taskId,
                oldStatus: entry.oldStatus,
                newStatus: entry.newStatus,
                oldPercent: entry.oldPercent,
                newPercent: entry.newPercent,
                label: entry.label
            });

            saveData();
            sendPatch({ op: 'update', taskId: task.id, field: 'status', value: entry.oldStatus });
            if (entry.oldPercent !== entry.newPercent) {
                sendPatch({ op: 'update', taskId: task.id, field: 'percentComplete', value: entry.oldPercent });
            }
        }
        renderBoard();
        showToast('Undid ' + count + ' move' + (count > 1 ? 's' : ''));
        updateUndoRedoButtons();
        $('#move-history-dropdown').hide();
    });

    // Close history dropdown on outside click
    $(document).on('mousedown', function (e) {
        if (!$(e.target).closest('#undo-redo-toolbar').length) {
            $('#move-history-dropdown').hide();
        }
    });

    // Keyboard shortcuts: Ctrl+Z for undo, Ctrl+Y for redo
    $(document).on('keydown', function (e) {
        if (openModalTaskId) return; // don't interfere when modal is open
        if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
            e.preventDefault();
            performUndo();
        } else if (e.ctrlKey && e.key === 'y') {
            e.preventDefault();
            performRedo();
        }
    });

    // ========== Filter Events ==========
    $('#filter-my-items').on('change', function () {
        renderBoard();
    });
    $('#search-input').on('input', function () { renderBoard(); });

    // ========== WebSocket Incoming Patch ==========
    var COL_TO_TASK_FIELD = {
        0: 'name', 1: 'startDate', 2: 'endDate',
        4: 'predecessor', 5: 'percentComplete', 6: 'status',
        7: 'assignedTo', 8: 'cost'
    };

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

    function applyCellPatchToTasks(data) {
        var key = data.key;
        if (!key) return null;
        var parts = key.split('-');
        var row = parseInt(parts[0]);
        var col = parseInt(parts[1]);
        var field = COL_TO_TASK_FIELD[col];
        if (!field) return null;

        var task = findTaskByRowIndex(row);
        if (!task) return null;

        var cellText = (data.cell && data.cell.text) || '';

        if (field === 'assignedTo') {
            task.assignedTo = cellText ? cellText.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
        } else if (field === 'percentComplete') {
            task.percentComplete = parseInt(cellText) || 0;
        } else if (field === 'cost') {
            task.cost = cellText;
        } else {
            task[field] = cellText;
        }

        saveData();
        return task.id;
    }

    function findTaskByRowIndex(rowIdx) {
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

    function flashRemoteChange($el) {
        if (!$el || !$el.length) return;
        $el.removeClass('remote-flash');
        void $el[0].offsetWidth;
        $el.addClass('remote-flash');
    }

    function handleIncomingPatch(data) {
        if (data.clientId === CLIENT_ID) return;

        // Handle grid cell patches
        if (data.op === 'updateCell') {
            var affectedId = applyCellPatchToTasks(data);
            renderBoard();
            // If the modal is open for this task, refresh and flash
            if (affectedId && openModalTaskId === affectedId) {
                var colField = COL_TO_TASK_FIELD[data.col];
                refreshModalField(affectedId, colField);
            }
            return;
        }

        // Check if this affects the currently open modal task
        var affectsModal = false;
        if (data.op === 'update' && data.taskId === openModalTaskId) {
            affectsModal = true;
        }
        if ((data.op === 'deleteTask' || data.op === 'deleteSubtask') && data.taskId === openModalTaskId) {
            // The task being viewed was deleted
            closeModal();
        }

        applyPatchLocally(data);
        renderBoard();

        // If modal is open and the patched task matches, flash the changed field
        if (affectsModal && data.op === 'update') {
            refreshModalField(data.taskId, data.field);
        }
    }

    function refreshModalField(taskId, field) {
        if (!field || openModalTaskId !== taskId) return;
        var task = findTaskById(taskId, tasks);
        if (!task) return;

        var $el = $('#modal-body .modal-input[data-field="' + field + '"]');
        if ($el.length && !$el.is(':focus')) {
            if (field === 'startDate' || field === 'endDate') {
                $el.val(toDisplayDate(task[field]));
                // Also update duration
                $('#modal-body .modal-input[data-field="duration"]').val(calcDuration(task.startDate, task.endDate));
            } else if (field === 'percentComplete') {
                $el.val(task.percentComplete);
            } else if (field === 'status') {
                $el.val(task.status);
            } else if (field === 'cost') {
                $el.val(task.cost);
            } else if (field === 'description') {
                $el.val(task.description);
            }
            flashRemoteChange($el);
        }

        // For assignedTo, rebuild the picker chips
        if (field === 'assignedTo') {
            var $picker = $('#modal-body .contact-picker');
            if ($picker.length) {
                ensureAssignedArray(task);
                buildPickerChips($picker, task.assignedTo);
                flashRemoteChange($picker);
            }
        }

        // For predecessor, rebuild the chips
        if (field === 'predecessor') {
            var $predPicker = $('#modal-body .predecessor-picker');
            if ($predPicker.length) {
                ensurePredecessorArray(task);
                buildPredecessorChips($predPicker, task.predecessor);
                flashRemoteChange($predPicker);
            }
        }
    }

    // ========== Project Picker ==========
    function showProjectPicker() {
        var $picker = $('#kb-project-picker');
        var $tbody = $('#kb-picker-body');
        var $wrap = $('#kb-picker-table-wrap');
        var $empty = $('#kb-picker-empty');
        $tbody.empty();
        $empty.hide();
        $wrap.show();
        $('#kb-picker-new-row').hide();
        $('#kb-picker-new-btn').show();
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
                        var $link = $('<span class="kb-picker-link">').text(displayProjectName(proj.name));
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
        $('#kb-project-picker').hide();
        $('#project-name-label').text(displayProjectName(name));
        joinProjectRoom(name);

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
                    localStorage.setItem(getStorageKey(), JSON.stringify({
                        tasks: tasks,
                        taskIdCounter: taskIdCounter
                    }));
                } else {
                    loadData();
                }
                postLoadTransition();
            },
            error: function () {
                loadData();
                postLoadTransition();
            }
        });
    }

    function createGroupProject(name) {
        PROJ_NAME = name;
        $('#kb-project-picker').hide();
        $('#project-name-label').text(displayProjectName(name));
        joinProjectRoom(name);
        tasks = [];
        taskIdCounter = 0;
        postLoadTransition();
    }

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
                        loadData();
                    }
                    localStorage.setItem(getStorageKey(), JSON.stringify({
                        tasks: tasks,
                        taskIdCounter: taskIdCounter
                    }));
                    postLoadTransition();
                } else {
                    alert('The project "' + DEFAULT_GROUP_PROJECT + '" was not found.');
                }
            },
            error: function () {
                alert('The project "' + DEFAULT_GROUP_PROJECT + '" could not be loaded.');
            }
        });
    }

    $('#kb-picker-new-btn').on('click', function () {
        $(this).hide();
        $('#kb-picker-new-row').show();
        $('#kb-picker-new-name').val('').focus();
    });

    $('#kb-picker-create-btn').on('click', function () {
        var name = $('#kb-picker-new-name').val().trim();
        if (!name) { alert('Please enter a project name.'); return; }
        var safeName = name.replace(/\s+/g, '_');
        createGroupProject(safeName);
    });

    $('#kb-picker-new-name').on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $('#kb-picker-create-btn').click();
        }
    });

    // ========== Post-Load Logic ==========
    function postLoadTransition() {
        // Ensure checkbox is checked by default
        $('#filter-my-items').prop('checked', true);
        // Show filter bar
        $('#filter-bar').show();
        // Check if current user has any assigned leaf tasks
        var allLeaves = getLeafNodes();
        var hasAssigned = false;
        for (var i = 0; i < allLeaves.length; i++) {
            ensureAssignedArray(allLeaves[i].task);
            if (allLeaves[i].task.assignedTo.indexOf(CURRENT_USER_ID) !== -1) {
                hasAssigned = true;
                break;
            }
        }
        if (hasAssigned) {
            renderBoard();
            boardState = 'my-tasks';
        } else {
            $('#kanban-board').hide();
            $('#empty-state').hide();
            $('#no-tasks-state').show();
            boardState = 'no-tasks';
        }
    }

    // ========== Init ==========
    initDragEvents();
    loadContacts();

    // All users (including super users) see the project picker first
    $('#filter-bar').hide();
    $('#kanban-board').hide();
    $('#empty-state').show();
    boardState = 'initial';
    showProjectPicker();

});
