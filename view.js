$(document).ready(function () {

    // ========== Configuration ==========
    var DEFAULT_COLS = 6;
    var DEFAULT_ROWS = 50;

    // ========== State ==========
    var undoStack = [];
    var redoStack = [];
    var MAX_UNDO = 50;
    var isUndoRedoAction = false;

    var columns = [];       // [{id, name, description, locked, frozen, hidden, filterValue}]
    var cellData = {};      // "row-col" => {text, bold, italic, underline, strikethrough, bgColor, fontColor, indent}
    var selectedCell = null; // {row, col}
    var selectedColumn = null; // column index when entire column is selected
    var menuTargetCol = null;
    var menuTargetRow = null;
    var colIdCounter = 0;
    var frozenUpTo = -1;    // index up to which columns are frozen
    var totalRows = DEFAULT_ROWS;
    var rowClipboard = null; // {data: {col: cellData}, mode: 'cut'|'copy', sourceRow: number}
    var selectedRows = [];    // array of selected row indices
    var lastClickedRow = null; // for shift+click range selection
    var selectedRange = null;  // {r1, c1, r2, c2} — drag-selected cell range
    var isDraggingRange = false; // true while mouse is held down during range selection
    var rowAttachments = {};  // rowIndex => [{name, size, type, dataUrl}]
    var rowComments = {};     // rowIndex => [{text, time}]
    var rowNotes = {};        // rowIndex => string (notes/description text)
    var sidebarOpenRow = null;
    var collapsedRows = {};   // rowIndex => true if this parent row is collapsed
    var dragSourceColIndex = null; // column index being dragged for reorder
    var highlightParentRows = true; // toggle for parent task row highlighting

    // ========== Access Control ==========
    var SUPER_USER = ['gs6368','ab2135'];
    var DEFAULT_GROUP_PROJECT = 'INTLITServicesMigration';
    var isProtectedView = true; // starts in protected mode

    // ========== Persistence Configuration ==========
    var CURRENT_USER_ID = 'gs6368';
    var PROJ_NAME = '';
    var currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    var saveTimer = null;
    var SAVE_DEBOUNCE_MS = 1000;
    var isSavingToServer = false;
    var pendingSave = false;
    var preservedTaskData = null;  // _taskData from design.html, preserved across grid saves

    function getSaveKey() {
        return CURRENT_USER_ID + '_' + PROJ_NAME + '_' + currentDate;
    }

    // Display project name with underscores replaced by spaces
    function displayProjectName(name) {
        return (name || '').replace(/_/g, ' ');
    }

    // ========== WebSocket + Cell Patch System ==========
    var CLIENT_ID = 'c_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
        handleIncomingGridPatch(data);
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

    function sendCellPatch(key, cell) {
        if (!PROJ_NAME || isProtectedView) return;
        var patch = {
            op: 'updateCell',
            project: PROJ_NAME,
            user: CURRENT_USER_ID,
            clientId: CLIENT_ID,
            key: key,
            cell: JSON.parse(JSON.stringify(cell))
        };

        if (socket && socketConnected) {
            socket.emit('send_patch', patch, function (resp) {
                if (!resp || !resp.ok) {
                    console.warn('Cell patch failed:', resp && resp.error);
                }
            });
        } else {
            $.ajax({
                url: '/api/patch-task',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify(patch)
            });
        }
    }

    // Map task field names to grid column indices
    var TASK_FIELD_TO_COL = {
        name: 0, startDate: 1, endDate: 2, predecessor: 4,
        percentComplete: 5, status: 6, assignedTo: 7, cost: 8
    };

    function findTaskRowIndex(taskId) {
        // Walk preservedTaskData hierarchy to find the row index for a task ID
        if (!preservedTaskData || !preservedTaskData.tasks) return -1;
        var tid = String(taskId);
        var rowIdx = 0;
        var tasks = preservedTaskData.tasks;
        for (var ti = 0; ti < tasks.length; ti++) {
            var task = tasks[ti];
            if (!task.name || !task.name.trim()) continue;
            if (String(task.id) === tid) return rowIdx;
            rowIdx++;
            var subs = task.subtasks || [];
            for (var si = 0; si < subs.length; si++) {
                if (String(subs[si].id) === tid) return rowIdx;
                rowIdx++;
                var subsubs = subs[si].subtasks || [];
                for (var ssi = 0; ssi < subsubs.length; ssi++) {
                    if (String(subsubs[ssi].id) === tid) return rowIdx;
                    rowIdx++;
                    var subsubsubs = subsubs[ssi].subtasks || [];
                    for (var sssi = 0; sssi < subsubsubs.length; sssi++) {
                        if (String(subsubsubs[sssi].id) === tid) return rowIdx;
                        rowIdx++;
                    }
                }
            }
        }
        return -1;
    }

    function findTaskInPreserved(taskId) {
        if (!preservedTaskData || !preservedTaskData.tasks) return null;
        var tid = String(taskId);
        var tasks = preservedTaskData.tasks;
        for (var ti = 0; ti < tasks.length; ti++) {
            if (String(tasks[ti].id) === tid) return tasks[ti];
            var subs = tasks[ti].subtasks || [];
            for (var si = 0; si < subs.length; si++) {
                if (String(subs[si].id) === tid) return subs[si];
                var subsubs = subs[si].subtasks || [];
                for (var ssi = 0; ssi < subsubs.length; ssi++) {
                    if (String(subsubs[ssi].id) === tid) return subsubs[ssi];
                    var subsubsubs = subsubs[ssi].subtasks || [];
                    for (var sssi = 0; sssi < subsubsubs.length; sssi++) {
                        if (String(subsubsubs[sssi].id) === tid) return subsubsubs[sssi];
                    }
                }
            }
        }
        return null;
    }

    function flashRemoteCell($td) {
        if (!$td || !$td.length) return;
        $td.removeClass('remote-flash');
        void $td[0].offsetWidth;
        $td.addClass('remote-flash');
    }

    function handleIncomingGridPatch(data) {
        if (data.clientId === CLIENT_ID) return;

        if (data.op === 'updateCell') {
            var key = data.key;
            cellData[key] = data.cell ? JSON.parse(JSON.stringify(data.cell)) : {};
            saveToLocalStorage();
            var parts = key.split('-');
            var row = parseInt(parts[0]);
            var col = parseInt(parts[1]);
            var $td = $('td.cell[data-row="' + row + '"][data-col="' + col + '"]');
            if ($td.length && !$td.hasClass('editing')) {
                renderSingleCell($td, row, col);
                flashRemoteCell($td);
            }
            return;
        }

        // Handle task-level patches from design.html
        if (data.op === 'update') {
            var taskId = data.taskId;
            var field = data.field;
            var value = data.value;

            // Update preservedTaskData
            var taskObj = findTaskInPreserved(taskId);
            if (taskObj) taskObj[field] = value;

            // Map to grid cell
            var col = TASK_FIELD_TO_COL[field];
            if (col === undefined) return; // field not shown in grid (e.g. flagged, description)

            var row = findTaskRowIndex(taskId);
            if (row < 0) return;

            // Convert value to cell text
            var cellText = '';
            if (field === 'assignedTo') {
                cellText = Array.isArray(value) ? value.join(', ') : (value || '');
            } else if (field === 'predecessor') {
                if (value && preservedTaskData) {
                    var predArr = Array.isArray(value) ? value : (value ? [value] : []);
                    var predLabels = [];
                    for (var pi = 0; pi < predArr.length; pi++) {
                        var pl = buildPredecessorLabelFromTasks(predArr[pi], preservedTaskData.tasks);
                        if (pl) predLabels.push(pl);
                    }
                    cellText = predLabels.join(', ');
                }
            } else if (field === 'percentComplete' || field === 'cost') {
                cellText = value ? String(value) : '';
            } else {
                cellText = value || '';
            }

            var cellKey = row + '-' + col;
            if (!cellData[cellKey]) cellData[cellKey] = {};
            cellData[cellKey].text = cellText;
            saveToLocalStorage();

            var $td = $('td.cell[data-row="' + row + '"][data-col="' + col + '"]');
            if ($td.length && !$td.hasClass('editing')) {
                renderSingleCell($td, row, col);
                flashRemoteCell($td);
            }

            // If endDate changed, also re-render duration column (col 3)
            if (field === 'startDate' || field === 'endDate') {
                var $durTd = $('td.cell[data-row="' + row + '"][data-col="3"]');
                if ($durTd.length) {
                    renderSingleCell($durTd, row, 3);
                    flashRemoteCell($durTd);
                }
            }
            return;
        }

        // Structural changes (addTask, deleteTask, addSubtask, deleteSubtask)
        // require row insertion/removal — do a full reload from server
        if (data.op === 'addTask' || data.op === 'deleteTask' ||
            data.op === 'addSubtask' || data.op === 'deleteSubtask') {
            // Reload latest data from server to stay in sync
            if (PROJ_NAME) {
                $.ajax({
                    url: '/api/load-group',
                    method: 'GET',
                    data: { project: PROJ_NAME },
                    dataType: 'json',
                    timeout: 5000,
                    success: function (resp) {
                        if (resp && resp.ok && resp.data) {
                            loadState(resp.data);
                            initColorPickers();
                        }
                    }
                });
            }
        }
    }

    // Symbol styles definition
    var symbolStyles = {
        status: {
            label: 'OK / Warning / Problem',
            options: [
                { value: 'OK', icon: 'fa-check', cssClass: 'symbol-ok' },
                { value: 'Warning', icon: 'fa-exclamation', cssClass: 'symbol-warning' },
                { value: 'Problem', icon: 'fa-xmark', cssClass: 'symbol-problem' }
            ]
        }
    };

    // ========== Contacts ==========
    var avatarColors = [
        '#607D8B', '#E8A838', '#5C6BC0', '#26A69A', '#EF5350',
        '#AB47BC', '#42A5F5', '#66BB6A', '#FFA726', '#8D6E63',
        '#78909C', '#7E57C2', '#29B6F6', '#9CCC65', '#EC407A'
    ];

    var DEFAULT_CONTACTS = [
        {"id": "ab1234", "name": "Andy Bundy"},
        {"id": "jv8888", "name": "Jules Verne"},
        {"id": "ae3323", "name": "Albert Einstein"},
        {"id": "hl3333", "name": "Heidi Lamar"}
    ];

    var CONTACTS_STORAGE_KEY = 'task_manager_contacts';
    var wsContacts = [];
    var wsContactDropdownRow = null;
    var wsContactDropdownCol = null;

    function loadWsContacts() {
        var stored = localStorage.getItem(CONTACTS_STORAGE_KEY);
        if (stored) {
            try { wsContacts = JSON.parse(stored); } catch (e) { wsContacts = []; }
        }
        // Merge defaults
        $.each(DEFAULT_CONTACTS, function (i, dc) {
            if (!getWsContactById(dc.id)) {
                wsContacts.push({ id: dc.id, name: dc.name });
            }
        });
        // Try to load contacts.json
        $.ajax({
            url: 'contacts.json',
            dataType: 'json',
            async: false,
            success: function (data) {
                if (Array.isArray(data)) {
                    $.each(data, function (i, c) {
                        if (c.id && !getWsContactById(c.id)) {
                            wsContacts.push({ id: c.id, name: c.name });
                        }
                    });
                }
            },
            error: function () { /* ignore */ }
        });
        saveWsContacts();
    }

    function saveWsContacts() {
        localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(wsContacts));
    }

    function getWsContactById(id) {
        for (var i = 0; i < wsContacts.length; i++) {
            if (wsContacts[i].id === id) return wsContacts[i];
        }
        return null;
    }

    function getWsInitials(name) {
        if (!name) return '?';
        var parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return parts[0][0].toUpperCase();
    }

    function getWsAvatarColor(contactId) {
        var hash = 0;
        for (var i = 0; i < contactId.length; i++) {
            hash = contactId.charCodeAt(i) + ((hash << 5) - hash);
        }
        return avatarColors[Math.abs(hash) % avatarColors.length];
    }

    function renderContactsCell($td, text) {
        if (!text || !text.trim()) return;
        var ids = text.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
        if (ids.length === 0) return;
        var $wrap = $('<span class="contacts-avatars">');
        $.each(ids, function (i, id) {
            var contact = getWsContactById(id);
            var name = contact ? contact.name : id;
            var initials = contact ? getWsInitials(contact.name) : id.substring(0, 2).toUpperCase();
            var color = getWsAvatarColor(id);
            var $av = $('<span class="contacts-avatar">')
                .css('background-color', color)
                .text(initials)
                .attr('title', name);
            $wrap.append($av);
        });
        $td.append($('<span class="cell-content">').append($wrap));
    }

    function openWsContactDropdown(row, col) {
        closeWsPredDropdown();
        wsContactDropdownRow = row;
        wsContactDropdownCol = col;
        var key = row + '-' + col;
        var currentText = (cellData[key] && cellData[key].text) || '';
        var selectedIds = currentText ? currentText.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; }) : [];

        renderWsContactList('', selectedIds);

        // Position below the cell
        var $td = $('td.cell[data-row="' + row + '"][data-col="' + col + '"]');
        var rect = $td[0].getBoundingClientRect();
        var $dd = $('#ws-contact-dropdown');
        var top = rect.bottom + 2;
        var left = rect.left;
        // Keep in viewport
        if (top + 320 > window.innerHeight) {
            top = rect.top - 320;
            if (top < 0) top = 4;
        }
        if (left + 260 > window.innerWidth) {
            left = window.innerWidth - 264;
        }
        $dd.css({ top: top, left: left }).show();
        $('#ws-contact-filter').val('').focus();
    }

    function closeWsContactDropdown() {
        $('#ws-contact-dropdown').hide();
        wsContactDropdownRow = null;
        wsContactDropdownCol = null;
    }

    function getWsSelectedIds() {
        if (wsContactDropdownRow === null) return [];
        if (wsContactDropdownRow === 'sidebar') {
            // In sidebar mode, read from chips
            var ids = [];
            var $picker = $('#sidebar-field-' + wsContactDropdownCol);
            $picker.find('.sidebar-contact-chip').each(function () {
                ids.push($(this).attr('data-contact-id'));
            });
            return ids;
        }
        var key = wsContactDropdownRow + '-' + wsContactDropdownCol;
        var currentText = (cellData[key] && cellData[key].text) || '';
        return currentText ? currentText.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; }) : [];
    }

    function renderWsContactList(filter, selectedIds) {
        if (!selectedIds) selectedIds = getWsSelectedIds();
        var $list = $('#ws-contact-dropdown-list');
        $list.empty();
        var lf = (filter || '').toLowerCase();
        $.each(wsContacts, function (i, contact) {
            if (lf && contact.name.toLowerCase().indexOf(lf) === -1 && contact.id.toLowerCase().indexOf(lf) === -1) return;
            var isSelected = selectedIds.indexOf(contact.id) !== -1;
            var initials = getWsInitials(contact.name);
            var color = getWsAvatarColor(contact.id);
            var $item = $('<div class="ws-contact-item">')
                .attr('data-contact-id', contact.id)
                .toggleClass('selected', isSelected);
            var $cb = $('<span class="ws-contact-cb">').html(isSelected ? '<i class="fa fa-check"></i>' : '');
            var $avatar = $('<span class="ws-contact-avatar">').css('background-color', color).text(initials);
            var $info = $('<span class="ws-contact-info">')
                .append($('<span class="ws-contact-name">').text(contact.name))
                .append($('<span class="ws-contact-id">').text(contact.id));
            $item.append($cb).append($avatar).append($info);
            $list.append($item);
        });
    }

    // Contact dropdown: toggle selection (cell mode only, not sidebar mode)
    $(document).on('click', '.ws-contact-item', function () {
        if (wsContactDropdownRow === null) return;
        if (wsContactDropdownRow === 'sidebar') return; // handled by sidebar-specific handler
        var contactId = $(this).attr('data-contact-id');
        var key = wsContactDropdownRow + '-' + wsContactDropdownCol;
        if (!cellData[key]) cellData[key] = {};
        var currentText = cellData[key].text || '';
        var ids = currentText ? currentText.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; }) : [];
        var idx = ids.indexOf(contactId);
        if (idx >= 0) {
            ids.splice(idx, 1);
        } else {
            ids.push(contactId);
        }
        cellData[key].text = ids.join(', ');
        // Re-render cell
        var $td = $('td.cell[data-row="' + wsContactDropdownRow + '"][data-col="' + wsContactDropdownCol + '"]');
        $td.find('.cell-content').remove();
        renderContactsCell($td, cellData[key].text);
        // Update dropdown checkboxes
        renderWsContactList($('#ws-contact-filter').val(), ids);
        sendCellPatch(key, cellData[key]);
        scheduleSave();
    });

    // Contact dropdown: filter
    $(document).on('input', '#ws-contact-filter', function () {
        renderWsContactList($(this).val());
    });

    // Close contact dropdown on click outside
    $(document).on('mousedown', function (e) {
        if ($('#ws-contact-dropdown').is(':visible')) {
            if (!$(e.target).closest('#ws-contact-dropdown').length &&
                !$(e.target).closest('.ws-contact-item').length) {
                closeWsContactDropdown();
            }
        }
    });

    // Close contact dropdown on Escape
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && $('#ws-contact-dropdown').is(':visible')) {
            closeWsContactDropdown();
            e.stopImmediatePropagation();
        }
    });

    // Add new contact button
    $(document).on('click', '#ws-btn-add-new-contact', function (e) {
        e.preventDefault();
        $('#ws-new-contact-name').val('');
        $('#ws-new-contact-id').val('');
        $('#ws-add-contact-dialog').show();
        $('#ws-new-contact-name').focus();
    });

    $('#ws-add-contact-ok').on('click', function () {
        var name = $('#ws-new-contact-name').val().trim();
        var id = $('#ws-new-contact-id').val().trim();
        if (!name) { alert('Please enter a name.'); return; }
        if (!id) { alert('Please enter an ID.'); return; }
        if (getWsContactById(id)) { alert('A contact with ID "' + id + '" already exists.'); return; }
        wsContacts.push({ id: id, name: name });
        saveWsContacts();
        $('#ws-add-contact-dialog').hide();
        showToast('Contact "' + name + '" added');
        if (wsContactDropdownRow !== null) {
            renderWsContactList($('#ws-contact-filter').val());
        }
    });

    $('#ws-add-contact-cancel').on('click', function () {
        $('#ws-add-contact-dialog').hide();
    });

    // ========== Predecessor Dropdown (Grid) ==========
    var wsPredDropdownRow = null;
    var wsPredDropdownCol = null;

    function renderPredecessorCell($td, text) {
        if (!text || !text.trim()) return;
        var labels = text.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
        if (labels.length === 0) return;

        var $wrap = $('<span class="cell-content pred-cell-wrap">');
        var $label = $('<span class="pred-cell-label">').text(labels[0]);
        $wrap.append($label);

        if (labels.length > 1) {
            var tooltipText = labels.join('\n');
            var $badge = $('<span class="pred-overflow-badge">')
                .text('+' + (labels.length - 1))
                .attr('title', tooltipText);
            $wrap.append($badge);
        }

        $td.append($wrap);
    }

    function openWsPredDropdown(row, col) {
        wsPredDropdownRow = row;
        wsPredDropdownCol = col;
        var key = row + '-' + col;
        var currentText = (cellData[key] && cellData[key].text) || '';
        var selectedLabels = currentText ? currentText.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; }) : [];

        renderWsPredList('', selectedLabels);

        var $td = $('td.cell[data-row="' + row + '"][data-col="' + col + '"]');
        var rect = $td[0].getBoundingClientRect();
        var $dd = $('#ws-pred-dropdown');
        var top = rect.bottom + 2;
        var left = rect.left;
        if (top + 340 > window.innerHeight) {
            top = rect.top - 340;
            if (top < 0) top = 4;
        }
        if (left + 320 > window.innerWidth) {
            left = window.innerWidth - 324;
        }
        $dd.css({ top: top, left: left }).show();
        $('#ws-pred-filter').val('').focus();
    }

    function closeWsPredDropdown() {
        $('#ws-pred-dropdown').hide();
        wsPredDropdownRow = null;
        wsPredDropdownCol = null;
    }

    function getWsPredSelectedLabels() {
        if (wsPredDropdownRow === null) return [];
        if (wsPredDropdownRow === 'sidebar') {
            var labels = [];
            var $picker = $('#sidebar-field-' + wsPredDropdownCol);
            $picker.find('.sidebar-pred-chip').each(function () {
                labels.push($(this).attr('data-pred-label'));
            });
            return labels;
        }
        var key = wsPredDropdownRow + '-' + wsPredDropdownCol;
        var currentText = (cellData[key] && cellData[key].text) || '';
        return currentText ? currentText.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; }) : [];
    }

    function renderWsPredList(filter, selectedLabels) {
        if (!selectedLabels) selectedLabels = getWsPredSelectedLabels();
        var $list = $('#ws-pred-dropdown-list');
        $list.empty();
        var lf = (filter || '').toLowerCase();

        // Determine which row to exclude
        var excludeRow = (wsPredDropdownRow !== null && wsPredDropdownRow !== 'sidebar') ? wsPredDropdownRow : -1;
        if (wsPredDropdownRow === 'sidebar' && sidebarOpenRow !== null) {
            excludeRow = sidebarOpenRow;
        }

        var predOpts = getPredecessorOptions(excludeRow);
        predOpts.sort(function (a, b) {
            return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
        });
        var matched = 0;

        $.each(predOpts, function (i, opt) {
            if (lf && opt.label.toLowerCase().indexOf(lf) === -1) return;
            matched++;
            var isSelected = selectedLabels.indexOf(opt.label) !== -1;
            var $item = $('<div class="ws-pred-item">')
                .attr('data-pred-label', opt.label)
                .toggleClass('selected', isSelected);
            var $cb = $('<span class="ws-pred-cb">').html(isSelected ? '<i class="fa fa-check"></i>' : '');
            var $label = $('<span class="ws-pred-label">').text(opt.label);
            $item.append($cb).append($label);
            $list.append($item);
        });

        if (matched === 0) {
            $list.append('<div class="ws-pred-empty">No tasks found</div>');
        }
    }

    // Predecessor dropdown: toggle selection (cell mode)
    $(document).on('click', '.ws-pred-item', function () {
        if (wsPredDropdownRow === null) return;
        if (wsPredDropdownRow === 'sidebar') return; // handled by sidebar-specific handler
        var predLabel = $(this).attr('data-pred-label');
        var key = wsPredDropdownRow + '-' + wsPredDropdownCol;
        if (!cellData[key]) cellData[key] = {};
        var currentText = cellData[key].text || '';
        var labels = currentText ? currentText.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; }) : [];
        var idx = labels.indexOf(predLabel);
        if (idx >= 0) {
            labels.splice(idx, 1);
        } else {
            labels.push(predLabel);
        }
        cellData[key].text = labels.join(', ');
        // Re-render cell
        var $td = $('td.cell[data-row="' + wsPredDropdownRow + '"][data-col="' + wsPredDropdownCol + '"]');
        $td.find('.cell-content').remove();
        $td.find('.pred-cell-wrap').remove();
        renderPredecessorCell($td, cellData[key].text);
        // Update dropdown checkboxes
        renderWsPredList($('#ws-pred-filter').val(), labels);
        sendCellPatch(key, cellData[key]);
        scheduleSave();
    });

    // Predecessor dropdown: filter
    $(document).on('input', '#ws-pred-filter', function () {
        renderWsPredList($(this).val());
    });

    // Close predecessor dropdown on click outside
    $(document).on('mousedown', function (e) {
        if ($('#ws-pred-dropdown').is(':visible')) {
            if (!$(e.target).closest('#ws-pred-dropdown').length &&
                !$(e.target).closest('.ws-pred-item').length) {
                closeWsPredDropdown();
            }
        }
    });

    // Close predecessor dropdown on Escape
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && $('#ws-pred-dropdown').is(':visible')) {
            closeWsPredDropdown();
            e.stopImmediatePropagation();
        }
    });

    // ========== Initialization ==========
    function init() {
        loadWsContacts();
        showProjectPicker();
    }

    function loadDefaultGroupProject() {
        PROJ_NAME = DEFAULT_GROUP_PROJECT;
        currentDate = new Date().toISOString().slice(0, 10);
        $('#project-name-label').text(displayProjectName(DEFAULT_GROUP_PROJECT));
        joinProjectRoom(DEFAULT_GROUP_PROJECT);
        initProtectedView();

        $.ajax({
            url: '/api/load-group',
            method: 'GET',
            data: { project: DEFAULT_GROUP_PROJECT },
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok && resp.data) {
                    loadState(resp.data);
                    initColorPickers();

                } else {
                    alert('The project "' + DEFAULT_GROUP_PROJECT + '" was not found. Please contact your administrator.');
                }
                undoStack = [];
                redoStack = [];
                updateUndoRedoButtons();
            },
            error: function () {
                alert('The project "' + DEFAULT_GROUP_PROJECT + '" could not be loaded. Please check your connection.');
            }
        });
    }

    function isSuperUser() {
        return SUPER_USER.indexOf(CURRENT_USER_ID) !== -1;
    }

    function initProtectedView() {
        isProtectedView = true;
        $('body').addClass('protected-mode');
        $('#protected-view-bar').addClass('visible');

        // Hide status area until user takes action on the protected view bar
        $('#save-status').hide();

        // Hide "Enable Editing" button for all users (editing disabled from grid)
        $('#pv-enable-editing').hide();
    }

    function enableEditing() {
        isProtectedView = false;
        $('body').removeClass('protected-mode');
        $('#protected-view-bar').removeClass('visible');
        // Show "Editing Enabled" in the status area
        var $status = $('#save-status');
        $status.show();
        $status.removeClass('saving saved offline error protected').addClass('editing-enabled');
        $('#save-status-icon').attr('class', 'fa fa-lock-open');
        $('#save-status-text').text('Editing Enabled');
    }

    function reloadCurrentProject(callback) {
        $.ajax({
            url: '/api/load-group',
            method: 'GET',
            data: { project: PROJ_NAME },
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok && resp.data) {
                    loadState(resp.data);
                    initColorPickers();
                }
                undoStack = [];
                redoStack = [];
                updateUndoRedoButtons();
                if (callback) callback();
            },
            error: function () {
                if (callback) callback();
            }
        });
    }

    function showInfoDialog(title, message) {
        $('#info-dialog-title').text(title);
        $('#info-dialog-message').text(message);
        $('#info-dialog').show();
    }

    $('#info-dialog-ok').on('click', function () {
        $('#info-dialog').hide();
    });

    $('#pv-enable-editing').on('click', function () {
        reloadCurrentProject(function () {
            enableEditing();
            showInfoDialog(
                'Project Reloaded for Editing',
                'To ensure no unwanted changes are saved, this project has been reloaded from the source. You are now in editing mode.'
            );
        });
    });

    $('#pv-close').on('click', function () {
        // Close the bar but keep protected mode active
        $('#protected-view-bar').removeClass('visible');
        // Show protected mode message in the status area
        var $status = $('#save-status');
        $status.show();
        $status.removeClass('saving saved offline error editing-enabled').addClass('protected');
        $('#save-status-icon').attr('class', 'fa fa-lock');
        $('#save-status-text').text('Protected Mode. Save option is not available.');
    });

    function showProjectPicker() {
        var $picker = $('#project-picker');
        var $groupBody = $('#group-table-body');
        var $groupWrap = $('#group-table-wrap');
        var $groupEmpty = $('#group-empty');
        $groupBody.empty();
        $groupEmpty.hide();
        $groupWrap.show();
        $('#picker-new-row').hide();
        $picker.show();

        // Load group projects
        $.ajax({
            url: '/api/group-projects',
            method: 'GET',
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok && resp.projects && resp.projects.length > 0) {
                    $.each(resp.projects, function (i, proj) {
                        var $tr = $('<tr>');
                        var $nameLink = $('<span class="picker-project-link">').text(displayProjectName(proj.name));
                        $nameLink.on('click', function () {
                            selectGroupProject(proj.name);
                        });
                        $tr.append($('<td>').append($nameLink));
                        $tr.append($('<td>').text(proj.lastSaved));
                        $tr.append($('<td>').text(proj.entries));
                        $groupBody.append($tr);
                    });
                } else {
                    $groupWrap.hide();
                    $groupEmpty.show();
                }
            },
            error: function () {
                $groupWrap.hide();
                $groupEmpty.text('Could not load group projects.').show();
            }
        });

    }

    function selectGroupProject(name) {
        PROJ_NAME = name;
        currentDate = new Date().toISOString().slice(0, 10);
        joinProjectRoom(name);
        $('#project-picker').hide();
        $('#project-name-label').text(displayProjectName(name));
        initProtectedView();

        $.ajax({
            url: '/api/load-group',
            method: 'GET',
            data: { project: name },
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok && resp.data) {
                    loadState(resp.data);
                    initColorPickers();

                } else {
                    columns = [];
                    for (var i = 0; i < DEFAULT_COLS; i++) {
                        columns.push(createColumn(i === 0 ? 'Task Name' : 'Column' + (i + 1)));
                    }
                    renderAll();
                    initColorPickers();

                }
                undoStack = [];
                redoStack = [];
                updateUndoRedoButtons();
            },
            error: function () {

            }
        });
    }

    function createColumn(name) {
        return {
            id: colIdCounter++,
            name: name,
            description: '',
            type: 'text',
            locked: false,
            frozen: false,
            hidden: false,
            filterValue: ''
        };
    }

    // ========== Persistence ==========
    function collectState() {
        var colsCopy = columns.map(function (col, i) {
            var copy = $.extend({}, col);
            var $th = $('th[data-col-index="' + i + '"]');
            if ($th.length) {
                copy.width = $th.outerWidth();
            }
            if (col.dropdownOptions) {
                copy.dropdownOptions = col.dropdownOptions.slice();
            }
            return copy;
        });

        var state = {
            columns: colsCopy,
            cellData: $.extend(true, {}, cellData),
            totalRows: totalRows,
            frozenUpTo: frozenUpTo,
            collapsedRows: $.extend({}, collapsedRows),
            rowAttachments: $.extend(true, {}, rowAttachments),
            rowComments: $.extend(true, {}, rowComments),
            rowNotes: $.extend({}, rowNotes),
            colIdCounter: colIdCounter,
            createdBy: CURRENT_USER_ID
        };
        if (preservedTaskData) {
            state._taskData = buildTaskDataFromCells();
        }
        return state;
    }

    // Rebuild _taskData from current cellData so design.html sees grid edits
    function buildTaskDataFromCells() {
        var td = preservedTaskData;
        if (!td || !td.tasks) return JSON.parse(JSON.stringify(td));

        var rowIdx = 0;
        var updatedTasks = [];

        $.each(td.tasks, function (ti, task) {
            var t = $.extend(true, {}, task);
            syncTaskFromRow(t, rowIdx);
            rowIdx++;

            var updatedSubs = [];
            $.each(t.subtasks || [], function (si, sub) {
                var s = $.extend(true, {}, sub);
                syncTaskFromRow(s, rowIdx);
                rowIdx++;

                var updatedSubSubs = [];
                $.each(s.subtasks || [], function (ssi, subsub) {
                    var ss = $.extend(true, {}, subsub);
                    syncTaskFromRow(ss, rowIdx);
                    rowIdx++;

                    var updatedSubSubSubs = [];
                    $.each(ss.subtasks || [], function (sssi, subsubsub) {
                        var sss = $.extend(true, {}, subsubsub);
                        syncTaskFromRow(sss, rowIdx);
                        rowIdx++;
                        updatedSubSubSubs.push(sss);
                    });
                    ss.subtasks = updatedSubSubSubs;
                    updatedSubSubs.push(ss);
                });
                s.subtasks = updatedSubSubs;
                updatedSubs.push(s);
            });
            t.subtasks = updatedSubs;
            updatedTasks.push(t);
        });

        return { tasks: updatedTasks, taskIdCounter: td.taskIdCounter || 0 };
    }

    function syncTaskFromRow(taskObj, rowIdx) {
        var cell = function (col) {
            var d = cellData[rowIdx + '-' + col];
            return d ? (d.text || '') : '';
        };

        var name = cell(0);
        if (name) taskObj.name = name;

        var startDate = cell(1);
        taskObj.startDate = startDate || taskObj.startDate || '';

        var endDate = cell(2);
        taskObj.endDate = endDate || taskObj.endDate || '';

        // Col 3 is duration (auto-calculated), skip

        // Col 4: Predecessor — grid stores as comma-separated labels, _taskData stores as array of IDs
        var predCell = cell(4);
        if (!predCell) {
            taskObj.predecessor = [];
        } else {
            var predLabels = predCell.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            var predIds = [];
            for (var pli = 0; pli < predLabels.length; pli++) {
                var foundId = reversePredecessorLookup(predLabels[pli]);
                if (foundId !== null) predIds.push(foundId);
            }
            if (predIds.length > 0) {
                taskObj.predecessor = predIds;
            }
            // If no match found, keep existing value
        }

        var pct = cell(5);
        taskObj.percentComplete = pct || taskObj.percentComplete || '';

        var status = cell(6);
        if (status) taskObj.status = status;

        var assigned = cell(7);
        if (assigned) {
            taskObj.assignedTo = assigned.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        } else if (cellData[rowIdx + '-7'] !== undefined) {
            taskObj.assignedTo = [];
        }

        var cost = cell(8);
        taskObj.cost = cost || taskObj.cost || '';
    }

    // Reverse-lookup: match a predecessor label to a task ID
    // Uses current cellData to build labels (same source as the grid's dropdown),
    // then maps the matched row back to a task ID in preservedTaskData
    function reversePredecessorLookup(label) {
        if (!preservedTaskData || !preservedTaskData.tasks) return null;

        // Step 1: find which row in cellData matches this label
        var matchedRow = -1;
        for (var r = 0; r < totalRows; r++) {
            if (buildPredecessorLabel(r) === label) {
                matchedRow = r;
                break;
            }
        }
        if (matchedRow === -1) return null;

        // Step 2: map that row number to a task ID in preservedTaskData
        var rowIdx = 0;
        var foundId = null;
        $.each(preservedTaskData.tasks, function (ti, task) {
            if (rowIdx === matchedRow) { foundId = task.id; return false; }
            rowIdx++;
            $.each(task.subtasks || [], function (si, sub) {
                if (rowIdx === matchedRow) { foundId = sub.id; return false; }
                rowIdx++;
                $.each(sub.subtasks || [], function (ssi, subsub) {
                    if (rowIdx === matchedRow) { foundId = subsub.id; return false; }
                    rowIdx++;
                });
                if (foundId !== null) return false;
            });
            if (foundId !== null) return false;
        });
        return foundId;
    }


    function syncCellDataFromTaskData(tasksList) {
        // Walk _taskData hierarchy and update cellData text values,
        // preserving any existing formatting (bold, italic, bgColor, etc.)
        var rowIdx = 0;

        function updateCell(row, col, text) {
            var key = row + '-' + col;
            if (!cellData[key]) cellData[key] = {};
            cellData[key].text = text;
        }

        function syncRow(taskObj, row, indent) {
            // Col 0: Task Name
            var key0 = row + '-0';
            if (!cellData[key0]) cellData[key0] = {};
            cellData[key0].text = taskObj.name || '';
            if (indent > 0) cellData[key0].indent = indent;
            else delete cellData[key0].indent;

            // Col 1: Start Date
            updateCell(row, 1, taskObj.startDate || '');

            // Col 2: End Date
            updateCell(row, 2, taskObj.endDate || '');

            // Col 3: Duration (auto-calculated by grid, skip text update)

            // Col 4: Predecessor (stored as ID or array of IDs in _taskData, need labels for grid)
            var predVal = taskObj.predecessor;
            if (predVal && (Array.isArray(predVal) ? predVal.length > 0 : true)) {
                var predIds = Array.isArray(predVal) ? predVal : [predVal];
                var predLabels = [];
                for (var pIdx = 0; pIdx < predIds.length; pIdx++) {
                    var pLabel = buildPredecessorLabelFromTasks(predIds[pIdx], tasksList);
                    if (pLabel) predLabels.push(pLabel);
                }
                updateCell(row, 4, predLabels.join(', '));
            } else {
                updateCell(row, 4, '');
            }

            // Col 5: % Complete
            updateCell(row, 5, taskObj.percentComplete ? String(taskObj.percentComplete) : '');

            // Col 6: Status
            updateCell(row, 6, taskObj.status || '');

            // Col 7: Assigned To (IDs comma-separated)
            var assigned = taskObj.assignedTo || [];
            if (typeof assigned === 'string') assigned = [assigned];
            updateCell(row, 7, assigned.join(', '));

            // Col 8: Cost
            updateCell(row, 8, taskObj.cost ? String(taskObj.cost) : '');
        }

        $.each(tasksList, function (ti, task) {
            if (!task.name || !task.name.trim()) return;
            syncRow(task, rowIdx, 0);
            rowIdx++;

            $.each(task.subtasks || [], function (si, sub) {
                syncRow(sub, rowIdx, 1);
                rowIdx++;

                $.each(sub.subtasks || [], function (ssi, subsub) {
                    syncRow(subsub, rowIdx, 2);
                    rowIdx++;

                    $.each(subsub.subtasks || [], function (sssi, subsubsub) {
                        syncRow(subsubsub, rowIdx, 3);
                        rowIdx++;
                    });
                });
            });
        });

        // Update totalRows if task structure added/removed rows
        if (rowIdx > totalRows) totalRows = rowIdx;
    }

    function buildPredecessorLabelFromTasks(predId, tasksList) {
        // Build a readable label for a predecessor ID from the task hierarchy
        // Use String() comparison to handle number/string type mismatches
        var pid = String(predId);
        for (var ti = 0; ti < tasksList.length; ti++) {
            var task = tasksList[ti];
            if (String(task.id) === pid) return task.name || '';
            var subs = task.subtasks || [];
            for (var si = 0; si < subs.length; si++) {
                if (String(subs[si].id) === pid) {
                    return (task.name || '') + ' > ' + (subs[si].name || '');
                }
                var subsubs = subs[si].subtasks || [];
                for (var ssi = 0; ssi < subsubs.length; ssi++) {
                    if (String(subsubs[ssi].id) === pid) {
                        return (task.name || '') + ' > ' + (subs[si].name || '') + ' > ' + (subsubs[ssi].name || '');
                    }
                    var subsubsubs = subsubs[ssi].subtasks || [];
                    for (var sssi = 0; sssi < subsubsubs.length; sssi++) {
                        if (String(subsubsubs[sssi].id) === pid) {
                            return (task.name || '') + ' > ' + (subs[si].name || '') + ' > ' + (subsubs[ssi].name || '') + ' > ' + (subsubsubs[sssi].name || '');
                        }
                    }
                }
            }
        }
        return '';
    }

    function loadState(data) {
        if (!data) return;
        columns = data.columns || [];
        cellData = data.cellData || {};
        totalRows = data.totalRows || DEFAULT_ROWS;
        frozenUpTo = data.frozenUpTo !== undefined ? data.frozenUpTo : -1;
        collapsedRows = data.collapsedRows || {};
        rowAttachments = data.rowAttachments || {};
        rowComments = data.rowComments || {};
        rowNotes = data.rowNotes || {};
        colIdCounter = data.colIdCounter || 0;

        // Preserve _taskData so it survives grid saves
        if (data._taskData) {
            preservedTaskData = JSON.parse(JSON.stringify(data._taskData));
        }

        // Sync cellData text values from _taskData (design.html patches update
        // _taskData but not cellData, so cellData may be stale)
        if (data._taskData && data._taskData.tasks) {
            syncCellDataFromTaskData(data._taskData.tasks);
        }

        // Extract notes and attachments from _taskData as fallback
        if (data._taskData && data._taskData.tasks) {
            var hasNotes = data.rowNotes && Object.keys(data.rowNotes).length > 0;
            var hasAttachments = data.rowAttachments && Object.keys(data.rowAttachments).length > 0;
            var taskRowIdx = 0;
            $.each(data._taskData.tasks, function (ti, task) {
                var parentRowIdx = taskRowIdx;
                if (!hasNotes && task.description) {
                    rowNotes[parentRowIdx] = task.description;
                }
                if (!hasAttachments && task.attachments && task.attachments.length) {
                    rowAttachments[parentRowIdx] = task.attachments.slice();
                }
                taskRowIdx++;
                $.each(task.subtasks || [], function (si, sub) {
                    taskRowIdx++;
                    $.each(sub.subtasks || [], function () {
                        taskRowIdx++;
                    });
                });
            });
        }

        selectedCell = null;
        selectedRange = null;
        selectedRows = [];
        lastClickedRow = null;
        rowClipboard = null;
        sidebarOpenRow = null;

        renderAll();

        // Apply saved column widths after DOM exists
        $.each(columns, function (i, col) {
            if (col.width) {
                var $th = $('th[data-col-index="' + i + '"]');
                $th.css('width', col.width + 'px');
                $('td.cell[data-col="' + i + '"]').css('width', col.width + 'px');
            }
        });
    }

    function saveToLocalStorage() {
        try {
            var state = collectState();
            localStorage.setItem(getSaveKey(), JSON.stringify(state));
            return true;
        } catch (e) {
            console.warn('localStorage save failed:', e);
            return false;
        }
    }

    function loadFromLocalStorage() {
        try {
            var json = localStorage.getItem(getSaveKey());
            if (!json) return null;
            return JSON.parse(json);
        } catch (e) {
            console.warn('localStorage load failed:', e);
            return null;
        }
    }

    function saveToServer(callback) {
        // Group projects are saved via WebSocket patches from the task page
        if (callback) callback(true);
    }


    function scheduleSave() {
        pushUndo();
    }


    // ========== Undo / Redo ==========
    function pushUndo() {
        if (isUndoRedoAction) return;
        undoStack.push(collectState());
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack = [];
        updateUndoRedoButtons();
    }

    function undo() {
        if (undoStack.length === 0) return;
        redoStack.push(collectState());
        var prev = undoStack.pop();
        isUndoRedoAction = true;
        loadState(prev);
        isUndoRedoAction = false;
        updateUndoRedoButtons();
        // Save without pushing to undo stack
        saveToLocalStorage();
        saveToServer();
    }

    function redo() {
        if (redoStack.length === 0) return;
        undoStack.push(collectState());
        var next = redoStack.pop();
        isUndoRedoAction = true;
        loadState(next);
        isUndoRedoAction = false;
        updateUndoRedoButtons();
        // Save without pushing to undo stack
        saveToLocalStorage();
        saveToServer();
    }

    function updateUndoRedoButtons() {
        $('#btn-undo').prop('disabled', undoStack.length === 0);
        $('#btn-redo').prop('disabled', redoStack.length === 0);
    }

    // Ctrl+Z: undo; Ctrl+Y / Ctrl+Shift+Z: redo
    $(document).on('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'Z' && e.shiftKey))) {
            e.preventDefault();
            redo();
        }
    });

    // ========== Rendering ==========
    function renderAll() {
        renderHeaders();
        renderBody();
        updateFrozenPositions();
    }

    function renderHeaders() {
        var $row = $('#header-row');
        $row.find('th.col-header').remove();

        // Check if columns have saved widths from a loaded project
        var hasSavedWidths = columns.some(function (c) { return c.width; });

        // For new projects, calculate column width to fill the container
        // so the browser doesn't redistribute extra space to the row-number column
        var computedColWidth = 160;
        if (!hasSavedWidths) {
            var containerWidth = $('#spreadsheet-container')[0] ? $('#spreadsheet-container')[0].clientWidth : 0;
            if (containerWidth > 0) {
                var rowNumWidth = 55;
                var visibleCount = columns.filter(function (c) { return !c.hidden; }).length;
                if (visibleCount > 0) {
                    computedColWidth = Math.max(160, Math.floor((containerWidth - rowNumWidth) / visibleCount));
                }
            }
        }

        $.each(columns, function (i, col) {
            var classes = 'col-header';
            if (col.hidden) classes += ' col-hidden';
            if (col.frozen) classes += ' frozen';
            if (col.description) classes += ' has-description';
            if (col.locked) classes += ' locked';

            var $th = $('<th>')
                .addClass(classes)
                .attr('data-col-index', i)
                .attr('data-col-id', col.id);

            // Apply explicit width so table-layout:fixed doesn't redistribute space
            var colWidth = col.width || computedColWidth;
            $th.css('width', colWidth + 'px');

            var $content = $('<div class="col-header-content">')
                .append($('<span class="col-name">').text(col.name))
                .append($('<span class="col-menu-btn"><i class="fa fa-ellipsis-vertical"></i></span>'));

            if (i >= 1) $content.attr('draggable', 'true');

            $th.append($content);
            $th.append('<div class="col-resize-handle"></div>');
            $row.append($th);
        });
    }

    // Get indent level for a row (from column 0)
    function getRowIndent(r) {
        var key = r + '-0';
        return (cellData[key] && cellData[key].indent) || 0;
    }

    // Check if a row is a parent (next row has higher indent)
    function isParentRow(r) {
        if (r >= totalRows - 1) return false;
        var myIndent = getRowIndent(r);
        var nextIndent = getRowIndent(r + 1);
        return nextIndent > myIndent;
    }

    // Get all children row indices for a parent row
    function getChildRows(parentRow) {
        var parentIndent = getRowIndent(parentRow);
        var children = [];
        for (var r = parentRow + 1; r < totalRows; r++) {
            if (getRowIndent(r) > parentIndent) {
                children.push(r);
            } else {
                break;
            }
        }
        return children;
    }

    // Check if a row should be hidden because an ancestor is collapsed
    function isRowHiddenByCollapse(r) {
        // Walk backwards to find if any ancestor parent is collapsed
        var myIndent = getRowIndent(r);
        for (var p = r - 1; p >= 0; p--) {
            var pIndent = getRowIndent(p);
            if (pIndent < myIndent) {
                // p is a potential parent at a lower indent level
                if (collapsedRows[p]) return true;
                // Continue checking higher ancestors
                myIndent = pIndent;
            }
        }
        return false;
    }

    // Check if there's another visible sibling at the given indent level after row r
    function hasMoreSiblingsAtLevel(r, level) {
        for (var i = r + 1; i < totalRows; i++) {
            if (isRowHiddenByCollapse(i)) continue;
            var ind = getRowIndent(i);
            if (ind < level) return false;
            if (ind === level) return true;
        }
        return false;
    }

    // Build hierarchical label for a row (for predecessor column)
    function buildPredecessorLabel(r) {
        var name = (cellData[r + '-0'] && cellData[r + '-0'].text) || '';
        if (!name) return '';
        var indent = getRowIndent(r);
        if (indent === 0) return name;
        var parts = [name];
        var currentIndent = indent;
        for (var p = r - 1; p >= 0; p--) {
            var pIndent = getRowIndent(p);
            if (pIndent < currentIndent) {
                var pName = (cellData[p + '-0'] && cellData[p + '-0'].text) || '';
                if (pName) parts.unshift(pName);
                currentIndent = pIndent;
                if (currentIndent === 0) break;
            }
        }
        return parts.join(' > ');
    }

    // Find the parent task row (indent 0) for any given row
    function getParentTaskRow(r) {
        var indent = getRowIndent(r);
        if (indent === 0) return r;
        for (var p = r - 1; p >= 0; p--) {
            if (getRowIndent(p) === 0) return p;
        }
        return r; // fallback to self
    }

    // Get all predecessor options (excluding a specific row)
    function getPredecessorOptions(excludeRow) {
        var options = [];
        for (var r = 0; r < totalRows; r++) {
            if (r === excludeRow) continue;
            var label = buildPredecessorLabel(r);
            if (label) {
                options.push({ row: r, label: label });
            }
        }
        return options;
    }

    function renderBody() {
        var $body = $('#spreadsheet-body');
        $body.empty();

        // Pre-compute tree connector info for column 0
        var treeInfo = {};
        for (var ri = 0; ri < totalRows; ri++) {
            var ind = getRowIndent(ri);
            if (ind === 0) continue;
            treeInfo[ri] = [];
            for (var L = 1; L <= ind; L++) {
                var hasMore = hasMoreSiblingsAtLevel(ri, L);
                if (L === ind) {
                    treeInfo[ri].push(hasMore ? 'branch' : 'last');
                } else {
                    treeInfo[ri].push(hasMore ? 'vline' : 'spacer');
                }
            }
        }

        for (var r = 0; r < totalRows; r++) {
            var $tr = $('<tr>').attr('data-row', r);
            if (selectedRows.indexOf(r) !== -1) {
                $tr.addClass('row-selected');
            }
            var $rowNum = $('<td class="row-number">').text(r + 1);
            $rowNum.css('position', 'relative');
            var $expandBtn = $('<button class="row-expand-btn" title="Open row details">')
                .html('<i class="fa fa-up-right-and-down-left-from-center"></i>')
                .attr('data-expand-row', r);
            $rowNum.append($expandBtn);
            $tr.append($rowNum);

            // Check if row should be hidden by filter
            var showRow = true;
            $.each(columns, function (c, col) {
                if (col.filterValue) {
                    var key = r + '-' + c;
                    var text = (cellData[key] && cellData[key].text) || '';
                    var filterLower = col.filterValue.toLowerCase();
                    if ((col.type || 'text') === 'contacts') {
                        // Match against contact names and IDs
                        var contactIds = text.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
                        var matched = false;
                        for (var ci2 = 0; ci2 < contactIds.length; ci2++) {
                            var contact = getWsContactById(contactIds[ci2]);
                            if (contact && contact.name.toLowerCase().indexOf(filterLower) !== -1) { matched = true; break; }
                            if (contactIds[ci2].toLowerCase().indexOf(filterLower) !== -1) { matched = true; break; }
                        }
                        if (!matched) { showRow = false; return false; }
                    } else if (text.toLowerCase().indexOf(filterLower) === -1) {
                        showRow = false;
                        return false;
                    }
                }
            });

            // Check if row is hidden by a collapsed parent
            if (showRow && isRowHiddenByCollapse(r)) {
                showRow = false;
            }

            if (!showRow) {
                $tr.hide();
            }

            var rowIsParent = isParentRow(r);
            var rowIndent = getRowIndent(r);
            if (rowIndent === 0 && highlightParentRows) {
                $tr.addClass('parent-row-highlight');
            }

            for (var c = 0; c < columns.length; c++) {
                var col = columns[c];
                var key = r + '-' + c;
                var data = cellData[key] || {};
                var classes = 'cell';
                if (col.hidden) classes += ' col-hidden';
                if (col.frozen) classes += ' frozen';
                if (col.locked) classes += ' locked';
                var indentLevel = data.indent || 0;
                classes += ' indent-' + indentLevel;

                var $td = $('<td>')
                    .addClass(classes)
                    .attr('data-row', r)
                    .attr('data-col', c);

                var styles = {};
                if (data.bold) styles['font-weight'] = 'bold';
                if (data.italic) styles['font-style'] = 'italic';
                if (data.underline) styles['text-decoration'] = 'underline';
                if (data.strikethrough) {
                    styles['text-decoration'] = (styles['text-decoration'] || '') + ' line-through';
                }
                if (data.bgColor) styles['background-color'] = data.bgColor;
                if (data.fontColor) styles['color'] = data.fontColor;

                // Alignment: column 0 always left, checkbox always center, others use data or default center
                var colType = col.type || 'text';
                if (c === 0) {
                    styles['text-align'] = 'left';
                } else if (colType === 'checkbox' || colType === 'symbols') {
                    styles['text-align'] = 'center';
                } else if (data.align) {
                    styles['text-align'] = data.align;
                } else if (colType === 'percent' || colType === 'cost') {
                    styles['text-align'] = 'right';
                } else if (colType === 'predecessor') {
                    styles['text-align'] = 'left';
                }

                // Wrap text
                if (data.wrapText) {
                    $td.addClass('wrap-text');
                }

                $td.css(styles);

                // For column 0: wrap tree connectors + toggle + content in a flex div
                if (c === 0) {
                    var $flexWrap = $('<div class="cell-flex-wrap">');
                    var connectors = treeInfo[r];
                    if (connectors) {
                        for (var ci2 = 0; ci2 < connectors.length; ci2++) {
                            var type = connectors[ci2];
                            if (type === 'branch') {
                                $flexWrap.append($('<span class="tree-connector has-more">'));
                            } else if (type === 'last') {
                                $flexWrap.append($('<span class="tree-connector">'));
                            } else if (type === 'vline') {
                                $flexWrap.append($('<span class="tree-vline">'));
                            } else {
                                $flexWrap.append($('<span class="tree-spacer">'));
                            }
                        }
                    }
                    if (rowIsParent) {
                        var isCollapsed = !!collapsedRows[r];
                        var arrowIcon = isCollapsed ? 'fa-caret-right' : 'fa-caret-down';
                        $flexWrap.append($('<span class="row-toggle" data-toggle-row="' + r + '">')
                            .html('<i class="fa ' + arrowIcon + '"></i>'));
                    }
                    var $cellContent = $('<span class="cell-content">').text(data.text || '');
                    if (indentLevel === 0) $cellContent.css('font-weight', 'bold');
                    else if (indentLevel >= 2) $cellContent.css('font-style', 'italic');
                    $flexWrap.append($cellContent);
                    $td.append($flexWrap);
                } else if (colType === 'checkbox') {
                    var checked = data.text === 'true' || data.text === '1';
                    var cbIcon = checked ? 'fa-square-check' : 'fa-square';
                    var cbColor = checked ? '#2a5db0' : '#ccc';
                    $td.append($('<span class="cell-content" style="cursor:pointer;color:' + cbColor + ';font-size:16px;"><i class="fa-regular ' + cbIcon + '"></i></span>'));
                } else if (colType === 'symbols' && data.text) {
                    var symInfo = getSymbolInfo(col, data.text);
                    if (symInfo) {
                        $td.append($('<span class="cell-content">').append(buildSymbolIcon(symInfo)));
                    } else {
                        $td.append($('<span class="cell-content">').text(data.text));
                    }
                } else if (colType === 'percent') {
                    var pctText = (data.text !== undefined && data.text !== '') ? data.text + '%' : '';
                    var $pctSpan = $('<span class="cell-content percent-value">').text(pctText);
                    $td.append($pctSpan);
                } else if (colType === 'duration') {
                    var durationText = '';
                    if (col.durationStartCol !== undefined && col.durationEndCol !== undefined &&
                        col.durationStartCol !== '' && col.durationEndCol !== '') {
                        var startColIdx = -1, endColIdx = -1;
                        for (var ci = 0; ci < columns.length; ci++) {
                            if (columns[ci].id === col.durationStartCol) startColIdx = ci;
                            if (columns[ci].id === col.durationEndCol) endColIdx = ci;
                        }
                        if (startColIdx >= 0 && endColIdx >= 0) {
                            var startDateStr = (cellData[r + '-' + startColIdx] && cellData[r + '-' + startColIdx].text) || '';
                            var endDateStr = (cellData[r + '-' + endColIdx] && cellData[r + '-' + endColIdx].text) || '';
                            if (startDateStr && endDateStr) {
                                var startDate = new Date(startDateStr + 'T00:00:00');
                                var endDate = new Date(endDateStr + 'T00:00:00');
                                if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
                                    var diffDays = Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
                                    durationText = diffDays + 'd';
                                }
                            }
                        }
                    }
                    $td.css('text-align', 'right');
                    var $dSpan = $('<span class="cell-content duration-value">').text(durationText);
                    $td.append($dSpan);
                } else if (colType === 'cost') {
                    $td.css('text-align', 'right');
                    var costText = (data.text !== undefined && data.text !== '') ? '$' + data.text : '';
                    var $costSpan = $('<span class="cell-content">').text(costText);
                    $td.append($costSpan);
                } else if (colType === 'date') {
                    var displayDate = data.text ? formatDateDisplay(data.text) : '';
                    var $span = $('<span class="cell-content date-cell-display">').text(displayDate);
                    if (!displayDate) $span.attr('data-placeholder', 'MM/DD/YY');
                    $td.append($span);
                } else if (colType === 'contacts') {
                    renderContactsCell($td, data.text);
                } else if (colType === 'dropdown' && data.text) {
                    var ddColor = getDropdownColor(col, data.text);
                    if (ddColor) {
                        // Determine text color based on background brightness
                        var textColor = isLightColor(ddColor) ? '#333' : '#fff';
                        var $pill = $('<span class="dropdown-pill">').text(data.text)
                            .css({ 'background-color': ddColor, 'color': textColor });
                        $td.append($('<span class="cell-content">').append($pill));
                    } else {
                        var $span = $('<span class="cell-content">').text(data.text);
                        $td.append($span);
                    }
                } else if (colType === 'predecessor') {
                    renderPredecessorCell($td, data.text);
                } else {
                    var $span = $('<span class="cell-content">').text(data.text || '');
                    $td.append($span);
                }

                if (selectedCell && selectedCell.row === r && selectedCell.col === c) {
                    $td.addClass('selected');
                }
                if (selectedRange) {
                    var sr1 = Math.min(selectedRange.r1, selectedRange.r2);
                    var sr2 = Math.max(selectedRange.r1, selectedRange.r2);
                    var sc1 = Math.min(selectedRange.c1, selectedRange.c2);
                    var sc2 = Math.max(selectedRange.c1, selectedRange.c2);
                    if (r >= sr1 && r <= sr2 && c >= sc1 && c <= sc2) {
                        $td.addClass('range-selected');
                    }
                }

                $tr.append($td);
            }
            $body.append($tr);
        }

        // Add empty padding rows below the last data row for visual breathing room
        var visibleColCount = 0;
        $.each(columns, function (ci, col) { if (!col.hidden) visibleColCount++; });
        for (var p = 0; p < 5; p++) {
            var $padRow = $('<tr class="padding-row">');
            $padRow.append($('<td class="row-number" style="border:none;">&nbsp;</td>'));
            for (var pc = 0; pc < visibleColCount; pc++) {
                $padRow.append($('<td style="border:none;">&nbsp;</td>'));
            }
            $body.append($padRow);
        }
    }

    function renderSingleCell($td, row, col) {
        var key = row + '-' + col;
        var data = cellData[key] || {};
        var colObj = columns[col];
        if (!colObj) return;
        var colType = colObj.type || 'text';

        // For column 0, tree connectors depend on context — do full re-render
        if (col === 0) {
            renderBody();
            return;
        }

        $td.empty();
        $td.removeAttr('style');
        $td.removeClass('wrap-text');

        // Apply formatting styles
        var styles = {};
        if (data.bold) styles['font-weight'] = 'bold';
        if (data.italic) styles['font-style'] = 'italic';
        if (data.underline) styles['text-decoration'] = 'underline';
        if (data.strikethrough) {
            styles['text-decoration'] = (styles['text-decoration'] || '') + ' line-through';
        }
        if (data.bgColor) styles['background-color'] = data.bgColor;
        if (data.fontColor) styles['color'] = data.fontColor;

        // Alignment
        if (colType === 'checkbox' || colType === 'symbols') {
            styles['text-align'] = 'center';
        } else if (data.align) {
            styles['text-align'] = data.align;
        } else if (colType === 'percent' || colType === 'cost') {
            styles['text-align'] = 'right';
        } else if (colType === 'predecessor') {
            styles['text-align'] = 'left';
        }

        if (data.wrapText) $td.addClass('wrap-text');
        $td.css(styles);

        // Render content by type
        if (colType === 'checkbox') {
            var checked = data.text === 'true' || data.text === '1';
            var cbIcon = checked ? 'fa-square-check' : 'fa-square';
            var cbColor = checked ? '#2a5db0' : '#ccc';
            $td.append($('<span class="cell-content" style="cursor:pointer;color:' + cbColor + ';font-size:16px;"><i class="fa-regular ' + cbIcon + '"></i></span>'));
        } else if (colType === 'symbols' && data.text) {
            var symInfo = getSymbolInfo(colObj, data.text);
            if (symInfo) {
                $td.append($('<span class="cell-content">').append(buildSymbolIcon(symInfo)));
            } else {
                $td.append($('<span class="cell-content">').text(data.text));
            }
        } else if (colType === 'percent') {
            var pctText = (data.text !== undefined && data.text !== '') ? data.text + '%' : '';
            $td.append($('<span class="cell-content percent-value">').text(pctText));
        } else if (colType === 'duration') {
            $td.css('text-align', 'right');
            var durationText = '';
            if (colObj.durationStartCol !== undefined && colObj.durationEndCol !== undefined &&
                colObj.durationStartCol !== '' && colObj.durationEndCol !== '') {
                var startColIdx = -1, endColIdx = -1;
                for (var ci = 0; ci < columns.length; ci++) {
                    if (columns[ci].id === colObj.durationStartCol) startColIdx = ci;
                    if (columns[ci].id === colObj.durationEndCol) endColIdx = ci;
                }
                if (startColIdx >= 0 && endColIdx >= 0) {
                    var startDateStr = (cellData[row + '-' + startColIdx] && cellData[row + '-' + startColIdx].text) || '';
                    var endDateStr = (cellData[row + '-' + endColIdx] && cellData[row + '-' + endColIdx].text) || '';
                    if (startDateStr && endDateStr) {
                        var startDate = new Date(startDateStr + 'T00:00:00');
                        var endDate = new Date(endDateStr + 'T00:00:00');
                        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
                            durationText = (Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1) + 'd';
                        }
                    }
                }
            }
            $td.append($('<span class="cell-content duration-value">').text(durationText));
        } else if (colType === 'cost') {
            $td.css('text-align', 'right');
            var costText = (data.text !== undefined && data.text !== '') ? '$' + data.text : '';
            $td.append($('<span class="cell-content">').text(costText));
        } else if (colType === 'date') {
            var displayDate = data.text ? formatDateDisplay(data.text) : '';
            var $span = $('<span class="cell-content date-cell-display">').text(displayDate);
            if (!displayDate) $span.attr('data-placeholder', 'MM/DD/YY');
            $td.append($span);
        } else if (colType === 'contacts') {
            renderContactsCell($td, data.text);
        } else if (colType === 'predecessor') {
            renderPredecessorCell($td, data.text);
        } else if (colType === 'dropdown' && data.text) {
            var ddColor = getDropdownColor(colObj, data.text);
            if (ddColor) {
                var textColor = isLightColor(ddColor) ? '#333' : '#fff';
                $td.append($('<span class="cell-content">').append($('<span class="dropdown-pill">').text(data.text).css({'background-color': ddColor, 'color': textColor})));
            } else {
                $td.append($('<span class="cell-content">').text(data.text));
            }
        } else {
            $td.append($('<span class="cell-content">').text(data.text || ''));
        }
    }

    // Format date from yyyy-mm-dd to MM/DD/YY
    function formatDateDisplay(dateStr) {
        if (!dateStr) return '';
        var parts = dateStr.split('-');
        if (parts.length !== 3) return dateStr;
        var yy = parts[0].slice(-2);
        var mm = parts[1];
        var dd = parts[2];
        return mm + '/' + dd + '/' + yy;
    }

    // Parse user-typed date (MM/DD/YY or MM/DD/YYYY) to YYYY-MM-DD
    function parseDateInput(str) {
        if (!str) return '';
        str = str.trim();
        // Accept MM/DD/YY or MM/DD/YYYY with / or - separators
        var m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (!m) return '';
        var mm = ('0' + m[1]).slice(-2);
        var dd = ('0' + m[2]).slice(-2);
        var yy = m[3];
        if (yy.length === 2) yy = '20' + yy;
        return yy + '-' + mm + '-' + dd;
    }

    // Finish editing a date cell: parse input, save, and sync duration
    function finishDateEdit(row, col, rawVal, fallback) {
        var parsed = parseDateInput(rawVal);
        if (!parsed && rawVal.trim() !== '') {
            // Invalid format — revert to previous value
            finishEditing(row, col, fallback);
            return;
        }
        var key = row + '-' + col;
        if (!cellData[key]) cellData[key] = {};
        cellData[key].text = parsed;
        renderBody();
        selectCell(row, col);
        sendCellPatch(key, cellData[key]);
        // Re-patch the duration column if start or end date changed
        for (var ci = 0; ci < columns.length; ci++) {
            if (columns[ci].type === 'duration') {
                var durKey = row + '-' + ci;
                sendCellPatch(durKey, cellData[durKey] || {});
                break;
            }
        }
        scheduleSave();
    }

    function updateFrozenPositions() {
        var leftOffset = 50; // row number width
        $.each(columns, function (i, col) {
            if (col.frozen) {
                var $th = $('th[data-col-index="' + i + '"]');
                var $tds = $('td.cell[data-col="' + i + '"]');
                $th.css('left', leftOffset + 'px');
                $tds.css('left', leftOffset + 'px');
                leftOffset += $th.outerWidth() || 160;
            }
        });
    }

    // ========== Row Selection (click on row numbers) ==========
    $(document).on('click', 'td.row-number', function (e) {
        e.stopPropagation();
        var $tr = $(this).closest('tr');
        var rowIndex = parseInt($tr.attr('data-row'));

        if (e.shiftKey && lastClickedRow !== null) {
            // Shift+click: select range from lastClickedRow to this row
            var from = Math.min(lastClickedRow, rowIndex);
            var to = Math.max(lastClickedRow, rowIndex);
            selectedRows = [];
            for (var r = from; r <= to; r++) {
                selectedRows.push(r);
            }
        } else {
            // Normal click: select just this row
            selectedRows = [rowIndex];
            lastClickedRow = rowIndex;
        }

        // Clear single-cell and range selection
        selectedCell = null;
        selectedRange = null;
        renderBody();
    });

    // ========== Cell Selection & Editing ==========
    $(document).on('mousedown', 'td.cell', function (e) {
        if (e.which !== 1) return; // left button only
        if ($(this).hasClass('editing')) return;
        var row = parseInt($(this).attr('data-row'));
        var col = parseInt($(this).attr('data-col'));

        // Checkbox columns: single click toggles
        var colType = columns[col] && columns[col].type;
        if (colType === 'checkbox' && !columns[col].locked) {
            var key = row + '-' + col;
            if (!cellData[key]) cellData[key] = {};
            var current = cellData[key].text || 'false';
            cellData[key].text = (current === 'true') ? 'false' : 'true';
            selectCell(row, col);
            renderBody();
            sendCellPatch(key, cellData[key]);
            scheduleSave();
            return;
        }

        // Contacts columns: single click opens the contact picker
        if (colType === 'contacts' && !columns[col].locked) {
            selectCell(row, col);
            openWsContactDropdown(row, col);
            return;
        }

        // Predecessor columns: single click opens the predecessor picker
        if (colType === 'predecessor' && !columns[col].locked) {
            selectCell(row, col);
            closeWsContactDropdown();
            openWsPredDropdown(row, col);
            return;
        }

        // Start range selection
        e.preventDefault(); // prevent text selection while dragging
        selectedRange = { r1: row, c1: col, r2: row, c2: col };
        isDraggingRange = true;
        selectCell(row, col);
    });

    $(document).on('mousemove', 'td.cell', function (e) {
        if (!isDraggingRange || !selectedRange) return;
        var row = parseInt($(this).attr('data-row'));
        var col = parseInt($(this).attr('data-col'));
        if (row === selectedRange.r2 && col === selectedRange.c2) return; // no change
        selectedRange.r2 = row;
        selectedRange.c2 = col;
        applyRangeHighlight();
    });

    $(document).on('mouseup', function (e) {
        if (!isDraggingRange) return;
        isDraggingRange = false;
        if (!selectedRange) return;
        // If drag ended on the same cell it started, it's a single-cell select — clear range
        if (selectedRange.r1 === selectedRange.r2 && selectedRange.c1 === selectedRange.c2) {
            selectedRange = null;
        }
    });

    function applyRangeHighlight() {
        $('.cell.range-selected').removeClass('range-selected');
        if (!selectedRange) return;
        var r1 = Math.min(selectedRange.r1, selectedRange.r2);
        var r2 = Math.max(selectedRange.r1, selectedRange.r2);
        var c1 = Math.min(selectedRange.c1, selectedRange.c2);
        var c2 = Math.max(selectedRange.c1, selectedRange.c2);
        for (var r = r1; r <= r2; r++) {
            for (var c = c1; c <= c2; c++) {
                $('td.cell[data-row="' + r + '"][data-col="' + c + '"]').addClass('range-selected');
            }
        }
    }

    $(document).on('dblclick', 'td.cell', function (e) {
        var row = parseInt($(this).attr('data-row'));
        var col = parseInt($(this).attr('data-col'));
        if (columns[col].locked) return;
        startEditing(row, col);
    });

    function selectCell(row, col) {
        // Clear row and column selection when clicking a cell
        selectedRows = [];
        lastClickedRow = null;
        selectedColumn = null;
        $('th.col-header').removeClass('selected');

        $('.cell.selected').removeClass('selected');
        $('.cell.col-highlight').removeClass('col-highlight');
        $('.cell.range-selected').removeClass('range-selected');
        selectedCell = { row: row, col: col };
        $('td.cell[data-row="' + row + '"][data-col="' + col + '"]').addClass('selected');
        updateToolbarState();
    }

    function startEditing(row, col) {
        var $td = $('td.cell[data-row="' + row + '"][data-col="' + col + '"]');
        if ($td.hasClass('editing')) return;

        var colObj = columns[col];
        var colType = colObj.type || 'text';
        var key = row + '-' + col;
        var data = cellData[key] || {};
        var currentText = data.text || '';

        // Duration: auto-calculated, no editing
        if (colType === 'duration') {
            return;
        }

        // Checkbox: just toggle, no editor needed
        if (colType === 'checkbox') {
            if (!cellData[key]) cellData[key] = {};
            cellData[key].text = (currentText === 'true') ? 'false' : 'true';
            renderBody();
            scheduleSave();
            if (row < totalRows - 1) {
                selectCell(row + 1, col);
            }
            return;
        }

        // Predecessor: open floating multi-select picker (no inline editor)
        if (colType === 'predecessor') {
            closeWsContactDropdown();
            openWsPredDropdown(row, col);
            return;
        }

        // Date: inline text input with MM/DD/YY format
        if (colType === 'date') {
            $td.addClass('editing');
            $td.empty();
            var dateHandled = false;
            var $dateInput = $('<input type="text" class="cell-editor" placeholder="MM/DD/YY" style="text-align:center;">')
                .val(currentText ? formatDateDisplay(currentText) : '')
                .on('keydown', function (e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        dateHandled = true;
                        finishDateEdit(row, col, $(this).val(), currentText);
                        if (row < totalRows - 1) selectCell(row + 1, col);
                    } else if (e.key === 'Escape') {
                        e.stopPropagation();
                        dateHandled = true;
                        finishEditing(row, col, currentText);
                        selectCell(row, col);
                    } else if (e.key === 'Tab') {
                        e.preventDefault();
                        e.stopPropagation();
                        dateHandled = true;
                        finishDateEdit(row, col, $(this).val(), currentText);
                        var nextCol = e.shiftKey ? col - 1 : col + 1;
                        if (nextCol >= 0 && nextCol < columns.length) selectCell(row, nextCol);
                    } else if (e.key === 'Backspace' || e.key === 'Delete' ||
                               e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
                               e.ctrlKey || e.metaKey) {
                        return;
                    } else {
                        var val = $(this).val();
                        if (!/^\d$/.test(e.key)) { e.preventDefault(); return; }
                        if (val.length === 2 || val.length === 5) {
                            $(this).val(val + '/');
                        }
                        if (val.length >= 8) { e.preventDefault(); }
                    }
                })
                .on('blur', function () {
                    if (!dateHandled) {
                        finishDateEdit(row, col, $(this).val(), currentText);
                    }
                });
            $td.append($dateInput);
            $dateInput.focus().select();
            return;
        }

        // Contacts: open floating contact picker, no inline editor
        if (colType === 'contacts') {
            openWsContactDropdown(row, col);
            return;
        }

        $td.addClass('editing');
        $td.empty();

        var handledByKey = false;

        // Dropdown: use a <select>
        if (colType === 'dropdown') {
            var opts = colObj.dropdownOptions || [];
            var $sel = $('<select class="cell-editor">')
                .append($('<option value="">').text('— Select —'));
            $.each(opts, function (i, opt) {
                var v = (typeof opt === 'string') ? opt : opt.value;
                $sel.append($('<option>').val(v).text(v));
            });
            $sel.val(currentText);

            $sel.on('change', function () {
                handledByKey = true;
                finishEditing(row, col, $(this).val());
                if (row < totalRows - 1) {
                    selectCell(row + 1, col);
                }
            }).on('keydown', function (e) {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    handledByKey = true;
                    finishEditing(row, col, currentText);
                    selectCell(row, col);
                }
            }).on('blur', function () {
                if (!handledByKey) {
                    finishEditing(row, col, $(this).val());
                }
            });

            $td.append($sel);
            $sel.focus();
            return;
        }

        // Symbols: use a <select> with symbol options
        if (colType === 'symbols') {
            var symStyle = symbolStyles[colObj.symbolStyle || 'status'];
            var symOpts = symStyle ? symStyle.options : [];
            var $sel = $('<select class="cell-editor">')
                .append($('<option value="">').text('— Select —'));
            $.each(symOpts, function (i, opt) {
                $sel.append($('<option>').val(opt.value).text(opt.value));
            });
            $sel.val(currentText);

            $sel.on('change', function () {
                handledByKey = true;
                finishEditing(row, col, $(this).val());
                if (row < totalRows - 1) {
                    selectCell(row + 1, col);
                }
            }).on('keydown', function (e) {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    handledByKey = true;
                    finishEditing(row, col, currentText);
                    selectCell(row, col);
                }
            }).on('blur', function () {
                if (!handledByKey) {
                    finishEditing(row, col, $(this).val());
                }
            });

            $td.append($sel);
            $sel.focus();
            return;
        }


        // Percent: numeric-only input
        if (colType === 'percent') {
            var $pctInput = $('<input type="text" class="cell-editor">')
                .val(currentText)
                .on('keydown', function (e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        handledByKey = true;
                        var num = $(this).val().replace(/[^0-9.\-]/g, '');
                        finishEditing(row, col, num);
                        if (row < totalRows - 1) selectCell(row + 1, col);
                    } else if (e.key === 'Escape') {
                        e.stopPropagation();
                        handledByKey = true;
                        finishEditing(row, col, currentText);
                        selectCell(row, col);
                    } else if (e.key === 'Tab') {
                        e.preventDefault();
                        e.stopPropagation();
                        handledByKey = true;
                        var num = $(this).val().replace(/[^0-9.\-]/g, '');
                        finishEditing(row, col, num);
                        var nextCol = e.shiftKey ? col - 1 : col + 1;
                        if (nextCol >= 0 && nextCol < columns.length) selectCell(row, nextCol);
                    }
                })
                .on('input', function () {
                    // Strip non-numeric characters as user types
                    var v = $(this).val();
                    var cleaned = v.replace(/[^0-9.\-]/g, '');
                    if (v !== cleaned) $(this).val(cleaned);
                })
                .on('blur', function () {
                    if (!handledByKey) {
                        var num = $(this).val().replace(/[^0-9.\-]/g, '');
                        finishEditing(row, col, num);
                    }
                });

            $td.append($pctInput);
            $pctInput.focus().select();
            return;
        }

        // Cost: numeric-only input, right-aligned
        if (colType === 'cost') {
            var $costInput = $('<input type="text" class="cell-editor" style="text-align:right;">')
                .val(currentText)
                .on('keydown', function (e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        handledByKey = true;
                        var num = $(this).val().replace(/[^0-9]/g, '');
                        finishEditing(row, col, num);
                        if (row < totalRows - 1) selectCell(row + 1, col);
                    } else if (e.key === 'Escape') {
                        e.stopPropagation();
                        handledByKey = true;
                        finishEditing(row, col, currentText);
                        selectCell(row, col);
                    } else if (e.key === 'Tab') {
                        e.preventDefault();
                        e.stopPropagation();
                        handledByKey = true;
                        var num = $(this).val().replace(/[^0-9]/g, '');
                        finishEditing(row, col, num);
                        var nextCol = e.shiftKey ? col - 1 : col + 1;
                        if (nextCol >= 0 && nextCol < columns.length) selectCell(row, nextCol);
                    }
                })
                .on('input', function () {
                    var v = $(this).val();
                    var cleaned = v.replace(/[^0-9]/g, '');
                    if (v !== cleaned) $(this).val(cleaned);
                })
                .on('blur', function () {
                    if (!handledByKey) {
                        var num = $(this).val().replace(/[^0-9]/g, '');
                        finishEditing(row, col, num);
                    }
                });

            $td.append($costInput);
            $costInput.focus().select();
            return;
        }

        // Text/Number: standard text input
        var $input = $('<input type="text" class="cell-editor">')
            .val(currentText)
            .on('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    handledByKey = true;
                    finishEditing(row, col, $(this).val());
                    if (row < totalRows - 1) {
                        selectCell(row + 1, col);
                    }
                } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    handledByKey = true;
                    finishEditing(row, col, currentText);
                    selectCell(row, col);
                } else if (e.key === 'Tab') {
                    e.preventDefault();
                    e.stopPropagation();
                    handledByKey = true;
                    finishEditing(row, col, $(this).val());
                    var nextCol = e.shiftKey ? col - 1 : col + 1;
                    if (nextCol >= 0 && nextCol < columns.length) {
                        selectCell(row, nextCol);
                    }
                }
            })
            .on('blur', function () {
                if (!handledByKey) {
                    finishEditing(row, col, $(this).val());
                }
            });

        $td.append($input);
        $input.focus().select();
    }

    function finishEditing(row, col, value) {
        var $td = $('td.cell[data-row="' + row + '"][data-col="' + col + '"]');
        if (!$td.hasClass('editing')) return;
        $td.removeClass('editing');

        var key = row + '-' + col;
        if (!cellData[key]) cellData[key] = {};
        cellData[key].text = value;

        // Re-render just this cell content
        $td.empty();
        var data = cellData[key];
        var styles = {};
        if (data.bold) styles['font-weight'] = 'bold';
        if (data.italic) styles['font-style'] = 'italic';
        var td_text = '';
        if (data.underline) td_text = 'underline';
        if (data.strikethrough) td_text += ' line-through';
        if (td_text) styles['text-decoration'] = td_text.trim();
        if (data.bgColor) styles['background-color'] = data.bgColor;
        if (data.fontColor) styles['color'] = data.fontColor;

        $td.css(styles);

        // Render special types after editing
        var colObj = columns[col];
        if (colObj && colObj.type === 'percent') {
            var pctDisplay = (value !== undefined && value !== '') ? value + '%' : '';
            $td.append($('<span class="cell-content percent-value">').text(pctDisplay));
            sendCellPatch(key, cellData[key]);
            scheduleSave();
            return;
        }
        if (colObj && colObj.type === 'cost') {
            var costDisplay = (value !== undefined && value !== '') ? '$' + value : '';
            $td.css('text-align', 'right');
            $td.append($('<span class="cell-content">').text(costDisplay));
            sendCellPatch(key, cellData[key]);
            scheduleSave();
            return;
        }
        if (colObj && colObj.type === 'contacts') {
            renderContactsCell($td, value);
            sendCellPatch(key, cellData[key]);
            scheduleSave();
            return;
        }
        if (colObj && colObj.type === 'predecessor') {
            renderPredecessorCell($td, value);
            sendCellPatch(key, cellData[key]);
            scheduleSave();
            return;
        }
        if (colObj && colObj.type === 'symbols' && value) {
            var symInfo = getSymbolInfo(colObj, value);
            if (symInfo) {
                $td.append($('<span class="cell-content">').append(buildSymbolIcon(symInfo)));
            } else {
                $td.append($('<span class="cell-content">').text(value));
            }
        } else if (colObj && colObj.type === 'dropdown' && value) {
            var ddColor = getDropdownColor(colObj, value);
            if (ddColor) {
                var textColor = isLightColor(ddColor) ? '#333' : '#fff';
                var $pill = $('<span class="dropdown-pill">').text(value)
                    .css({ 'background-color': ddColor, 'color': textColor });
                $td.append($pill);
            } else {
                $td.append($('<span class="cell-content">').text(value));
            }
        } else {
            $td.append($('<span class="cell-content">').text(value));
        }
        sendCellPatch(key, cellData[key]);
        scheduleSave();
    }

    // ========== Keyboard Navigation ==========
    $(document).on('keydown', function (e) {
        if ($(e.target).closest('#row-sidebar').length > 0) return;
        if (!selectedCell) return;
        if ($('.editing').length > 0) return;
        if ($('.dialog-overlay:visible').length > 0) return;

        var row = selectedCell.row;
        var col = selectedCell.col;

        switch (e.key) {
            case 'ArrowUp':
                e.preventDefault();
                if (row > 0) selectCell(row - 1, col);
                break;
            case 'ArrowDown':
                e.preventDefault();
                if (row < totalRows - 1) selectCell(row + 1, col);
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (col > 0) selectCell(row, col - 1);
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (col < columns.length - 1) selectCell(row, col + 1);
                break;
            case 'Enter':
            case 'F2':
                e.preventDefault();
                if (!columns[col].locked) startEditing(row, col);
                break;
            case 'Delete':
                e.preventDefault();
                if (!columns[col].locked && (columns[col].type || 'text') !== 'duration') {
                    var key = row + '-' + col;
                    if (cellData[key]) cellData[key].text = '';
                    renderBody();
                    sendCellPatch(key, cellData[key] || {});
                    scheduleSave();
                }
                break;
        }
    });

    // Also start editing on any printable key
    $(document).on('keypress', function (e) {
        if ($(e.target).closest('#row-sidebar').length > 0) return;
        if (!selectedCell) return;
        if ($('.editing').length > 0) return;
        if ($('.dialog-overlay:visible').length > 0) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        var col = selectedCell.col;
        if (columns[col].locked) return;
        var selColType = columns[col].type || 'text';
        if (selColType === 'duration' || selColType === 'contacts') return;

        var typedChar = String.fromCharCode(e.which);

        var key = selectedCell.row + '-' + col;
        if (!cellData[key]) cellData[key] = {};
        cellData[key].text = '';
        renderBody();
        startEditing(selectedCell.row, col);

        // Seed the first character into the editor
        var $editor = $('td.cell.editing .cell-editor');
        $editor.val(typedChar);
        // Move cursor to end
        $editor[0].setSelectionRange(typedChar.length, typedChar.length);

        e.preventDefault();
    });

    // ========== Toolbar: Formatting Buttons ==========
    function getCellData(row, col) {
        var key = row + '-' + col;
        if (!cellData[key]) cellData[key] = {};
        return cellData[key];
    }

    // Helper: get normalized range bounds, or null if no range
    function getSelectedRangeBounds() {
        if (!selectedRange) return null;
        return {
            r1: Math.min(selectedRange.r1, selectedRange.r2),
            r2: Math.max(selectedRange.r1, selectedRange.r2),
            c1: Math.min(selectedRange.c1, selectedRange.c2),
            c2: Math.max(selectedRange.c1, selectedRange.c2)
        };
    }

    // Helper: iterate over range cells, calling fn(row, col, key, data) for each
    function forEachSelectedCell(fn) {
        var bounds = getSelectedRangeBounds();
        if (bounds) {
            for (var r = bounds.r1; r <= bounds.r2; r++) {
                for (var c = bounds.c1; c <= bounds.c2; c++) {
                    var key = r + '-' + c;
                    var data = getCellData(r, c);
                    fn(r, c, key, data);
                }
            }
            return true;
        }
        if (selectedCell) {
            var key = selectedCell.row + '-' + selectedCell.col;
            var data = getCellData(selectedCell.row, selectedCell.col);
            fn(selectedCell.row, selectedCell.col, key, data);
            return true;
        }
        return false;
    }

    function toggleFormat(prop) {
        if (!selectedCell && !selectedRange) return;
        // Determine toggle value from the anchor cell
        var anchor = selectedCell || { row: selectedRange.r1, col: selectedRange.c1 };
        var anchorData = getCellData(anchor.row, anchor.col);
        var newVal = !anchorData[prop];
        forEachSelectedCell(function (r, c, key, data) {
            data[prop] = newVal;
            sendCellPatch(key, data);
        });
        renderBody();
        updateToolbarState();
        scheduleSave();
    }

    function updateToolbarState() {
        var $alignBtns = $('#btn-align-left, #btn-align-center, #btn-align-right');
        var $wrapBtn = $('#btn-wrap-text');

        if (selectedColumn !== null) {
            // Column selected: enable alignment buttons
            $('#btn-bold, #btn-italic, #btn-underline, #btn-strikethrough').removeClass('active');
            $alignBtns.removeClass('active disabled');
            $wrapBtn.removeClass('active disabled');
            var scColType = columns[selectedColumn] && columns[selectedColumn].type || 'text';
            if (selectedColumn === 0 || scColType === 'checkbox' || scColType === 'symbols') {
                $alignBtns.addClass('disabled');
                $wrapBtn.addClass('disabled');
            }
            return;
        }

        if (!selectedCell) {
            $('#btn-bold, #btn-italic, #btn-underline, #btn-strikethrough').removeClass('active');
            $alignBtns.removeClass('active disabled');
            $wrapBtn.removeClass('active disabled');
            return;
        }

        var data = getCellData(selectedCell.row, selectedCell.col);
        var col = selectedCell.col;
        var colType = columns[col] && columns[col].type || 'text';

        $('#btn-bold').toggleClass('active', !!data.bold);
        $('#btn-italic').toggleClass('active', !!data.italic);
        $('#btn-underline').toggleClass('active', !!data.underline);
        $('#btn-strikethrough').toggleClass('active', !!data.strikethrough);

        // Keep color indicators and Spectrum pickers showing the last-used color,
        // not the selected cell's color, so users can apply the same color to multiple cells
        $('#bg-color-indicator').css('background-color', lastBgColor);
        $('#font-color-indicator').css('background-color', lastFontColor);

        // Alignment state
        var align = data.align || 'center';
        $alignBtns.removeClass('active disabled');
        $wrapBtn.removeClass('active disabled');

        // Disable rules
        if (col === 0) {
            // First column: alignment disabled
            $alignBtns.addClass('disabled');
            $wrapBtn.addClass('disabled');
        } else if (colType === 'checkbox' || colType === 'symbols') {
            // Checkbox/Symbols: always center, disabled
            $alignBtns.addClass('disabled');
            $wrapBtn.addClass('disabled');
        } else {
            // Show active alignment
            if (align === 'left') $('#btn-align-left').addClass('active');
            else if (align === 'right') $('#btn-align-right').addClass('active');
            else $('#btn-align-center').addClass('active');

            // Wrap text only for text type
            if (colType === 'text') {
                $wrapBtn.toggleClass('active', !!data.wrapText);
            } else {
                $wrapBtn.addClass('disabled');
            }
        }
    }

    $('#btn-projects').on('click', function () { showProjectPicker(); });
    $('#btn-undo').on('click', function () { undo(); });
    $('#btn-redo').on('click', function () { redo(); });

    $('#btn-bold').on('click', function () { toggleFormat('bold'); });
    $('#btn-italic').on('click', function () { toggleFormat('italic'); });
    $('#btn-underline').on('click', function () { toggleFormat('underline'); });
    $('#btn-strikethrough').on('click', function () { toggleFormat('strikethrough'); });

    // ========== Toolbar: Alignment & Wrap ==========
    function setAlignment(align) {
        // Column-wide alignment
        if (selectedColumn !== null) {
            if (selectedColumn === 0) return;
            var colType = columns[selectedColumn] && columns[selectedColumn].type || 'text';
            if (colType === 'checkbox' || colType === 'symbols') return;
            for (var r = 0; r < totalRows; r++) {
                var data = getCellData(r, selectedColumn);
                data.align = align;
                sendCellPatch(r + '-' + selectedColumn, data);
            }
            renderBody();
            $('td.cell[data-col="' + selectedColumn + '"]').addClass('col-highlight');
            updateToolbarState();
            scheduleSave();
            return;
        }

        if (!selectedCell && !selectedRange) return;
        forEachSelectedCell(function (r, c, key, data) {
            if (c === 0) return;
            var ct = columns[c] && columns[c].type || 'text';
            if (ct === 'checkbox' || ct === 'symbols') return;
            data.align = align;
            sendCellPatch(key, data);
        });
        renderBody();
        updateToolbarState();
        scheduleSave();
    }

    $('#btn-align-left').on('click', function () { setAlignment('left'); });
    $('#btn-align-center').on('click', function () { setAlignment('center'); });
    $('#btn-align-right').on('click', function () { setAlignment('right'); });

    $('#btn-wrap-text').on('click', function () {
        if (!selectedCell && !selectedRange) return;
        var anchor = selectedCell || { row: selectedRange.r1, col: selectedRange.c1 };
        var anchorData = getCellData(anchor.row, anchor.col);
        var newVal = !anchorData.wrapText;
        forEachSelectedCell(function (r, c, key, data) {
            if (c === 0) return;
            var ct = columns[c] && columns[c].type || 'text';
            if (ct !== 'text') return;
            data.wrapText = newVal;
            sendCellPatch(key, data);
        });
        renderBody();
        updateToolbarState();
        scheduleSave();
    });

    // ========== Toolbar: Highlight Parent Task ==========
    $('#btn-highlight-parent').addClass('active');
    $('#btn-highlight-parent').on('click', function () {
        highlightParentRows = !highlightParentRows;
        $(this).toggleClass('active', highlightParentRows);
        renderBody();
    });

    // ========== Toolbar: Collapse/Expand All Parent Tasks ==========
    $('#btn-collapse-parents').on('click', function () {
        var allCollapsed = $(this).hasClass('active');
        if (!allCollapsed) {
            // Collapse all parent rows (indent 0 that have children)
            for (var r = 0; r < totalRows; r++) {
                if (getRowIndent(r) === 0 && isParentRow(r)) {
                    collapsedRows[r] = true;
                }
            }
            $(this).addClass('active');
        } else {
            // Expand all
            collapsedRows = {};
            $(this).removeClass('active');
        }
        renderBody();
        scheduleSave();
    });

    // ========== Toolbar: Indent / Outdent ==========
    // Works on selected rows (column 0 only), or falls back to single selected cell

    // ========== Toolbar: Color Pickers ==========
    function initColorPickers() {
        $('#bg-color-picker').spectrum({
            color: '#ffffff',
            showPalette: true,
            showSelectionPalette: true,
            preferredFormat: 'hex',
            chooseText: 'Apply',
            cancelText: 'Cancel',
            palette: [
                ['#ffffff', '#f2f2f2', '#d9d9d9', '#bfbfbf', '#a6a6a6', '#808080'],
                ['#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#0000ff'],
                ['#9900ff', '#ff00ff', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3'],
                ['#cfe2f3', '#d9d2e9', '#ead1dc', '#ea9999', '#f9cb9c', '#ffe599'],
                ['#b6d7a8', '#a2c4c9', '#9fc5e8', '#b4a7d6', '#d5a6bd', '#e06666']
            ],
            change: function (color) {
                lastBgColor = color.toHexString();
                if (!selectedCell && !selectedRange) return;
                forEachSelectedCell(function (r, c, key, data) {
                    data.bgColor = lastBgColor;
                    sendCellPatch(key, data);
                });
                $('#bg-color-indicator').css('background-color', lastBgColor);
                renderBody();
                scheduleSave();
            }
        });

        $('#font-color-picker').spectrum({
            color: '#000000',
            showPalette: true,
            showSelectionPalette: true,
            preferredFormat: 'hex',
            chooseText: 'Apply',
            cancelText: 'Cancel',
            palette: [
                ['#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff'],
                ['#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#0000ff'],
                ['#9900ff', '#ff00ff', '#cc0000', '#e69138', '#f1c232', '#6aa84f'],
                ['#45818e', '#3c78d8', '#674ea7', '#a64d79', '#85200c', '#783f04']
            ],
            change: function (color) {
                lastFontColor = color.toHexString();
                if (!selectedCell && !selectedRange) return;
                forEachSelectedCell(function (r, c, key, data) {
                    data.fontColor = lastFontColor;
                    sendCellPatch(key, data);
                });
                $('#font-color-indicator').css('background-color', lastFontColor);
                renderBody();
                scheduleSave();
            }
        });
    }

    // Last-used colors for direct apply
    var lastBgColor = '#ffffff';
    var lastFontColor = '#000000';

    // Paint button: directly applies last-used background color (no palette)
    $('#btn-bg-color').on('click', function (e) {
        e.stopPropagation();
        if (!selectedCell && !selectedRange) return;
        forEachSelectedCell(function (r, c, key, data) {
            data.bgColor = lastBgColor;
            sendCellPatch(key, data);
        });
        $('#bg-color-indicator').css('background-color', lastBgColor);
        renderBody();
        scheduleSave();
    });

    // Font button: directly applies last-used font color (no palette)
    $('#btn-font-color').on('click', function (e) {
        e.stopPropagation();
        if (!selectedCell && !selectedRange) return;
        forEachSelectedCell(function (r, c, key, data) {
            data.fontColor = lastFontColor;
            sendCellPatch(key, data);
        });
        $('#font-color-indicator').css('background-color', lastFontColor);
        renderBody();
        scheduleSave();
    });

    // ========== Column Header: Three-Dot Menu ==========
    // Click on column header to select entire column
    $(document).on('click', 'th.col-header', function (e) {
        if ($(e.target).closest('.col-menu-btn').length) return;
        if ($(e.target).closest('.col-resize-handle').length) return;
        var colIndex = parseInt($(this).attr('data-col-index'));
        selectedColumn = colIndex;
        selectedCell = null;
        selectedRange = null;
        selectedRows = [];
        $('th.col-header').removeClass('selected');
        $(this).addClass('selected');
        $('.cell.selected').removeClass('selected');
        $('.cell.range-selected').removeClass('range-selected');
        $('td.cell.col-highlight').removeClass('col-highlight');
        $('td.cell[data-col="' + colIndex + '"]').addClass('col-highlight');
        updateToolbarState();
    });

    $(document).on('click', '.col-menu-btn', function (e) {
        e.stopPropagation();
        var $th = $(this).closest('th');
        var colIndex = parseInt($th.attr('data-col-index'));
        menuTargetCol = colIndex;

        var col = columns[colIndex];
        // Update lock text
        var $lockItem = $('[data-action="lock-column"]');
        if (col.locked) {
            $lockItem.html('<i class="fa fa-lock-open"></i> Unlock Column');
        } else {
            $lockItem.html('<i class="fa fa-lock"></i> Lock Column');
        }

        // Update freeze text
        var $freezeItem = $('[data-action="freeze-column"]');
        if (col.frozen) {
            $freezeItem.html('<i class="fa fa-snowflake"></i> Unfreeze Column');
        } else {
            $freezeItem.html('<i class="fa fa-snowflake"></i> Freeze Column');
        }

        // Highlight column header
        $('th.col-header').removeClass('selected');
        $th.addClass('selected');
        $('.col-menu-btn').removeClass('active');
        $(this).addClass('active');

        // Position menu
        var rect = this.getBoundingClientRect();
        var $menu = $('#column-context-menu');
        $menu.css({
            top: rect.bottom + 4,
            left: rect.left - 180
        }).show();
    });

    // Hide context menus on click outside
    $(document).on('click', function (e) {
        $('#column-context-menu').hide();
        $('#row-context-menu').hide();
        if (!$(e.target).closest('th.col-header').length) {
            $('th.col-header').removeClass('selected');
            selectedColumn = null;
            $('td.cell.col-highlight').removeClass('col-highlight');
        }
        $('.col-menu-btn').removeClass('active');
        $('#spreadsheet tbody tr').removeClass('row-selected');
    });

    // ========== Column Menu Actions ==========
    $(document).on('click', '.menu-item', function () {
        var action = $(this).attr('data-action');
        var colIndex = menuTargetCol;
        if (colIndex === null) return;

        $('#column-context-menu').hide();
        $('th.col-header').removeClass('selected');

        switch (action) {
            case 'insert-left':
                if (isProtectedView) { showToast('Protected View: Inserting columns is disabled.'); return; }
                insertColumn(colIndex);
                break;
            case 'insert-right':
                if (isProtectedView) { showToast('Protected View: Inserting columns is disabled.'); return; }
                insertColumn(colIndex + 1);
                break;
            case 'delete-column':
                if (isProtectedView) { showToast('Protected View: Deleting columns is disabled.'); return; }
                deleteColumn(colIndex);
                break;
            case 'rename-column':
                openRenameDialog(colIndex);
                break;
            case 'add-description':
                openDescriptionDialog(colIndex);
                break;
            case 'filter':
                openFilterDialog(colIndex);
                break;
            case 'sort-rows':
                openSortDialog(colIndex);
                break;
            case 'lock-column':
                toggleLockColumn(colIndex);
                break;
            case 'freeze-column':
                toggleFreezeColumn(colIndex);
                break;
            case 'hide-column':
                hideColumn(colIndex);
                break;
            case 'column-properties':
                openColumnProperties(colIndex);
                break;
        }
    });

    // ========== Column Properties ==========
    var colpropsDropdownValues = []; // temp array: [{value, color}]
    var defaultDDColors = ['#d9c4f0', '#f5c4c4', '#c4daf5', '#c4f5d2', '#f5eac4', '#f0c4e8', '#c4f5f0', '#f5d4c4'];

    // Normalize old string-based options to {value, color} objects
    function normalizeDropdownOptions(opts) {
        if (!opts || !opts.length) return [];
        return opts.map(function (opt, i) {
            if (typeof opt === 'string') {
                return { value: opt, color: defaultDDColors[i % defaultDDColors.length] };
            }
            return { value: opt.value, color: opt.color || defaultDDColors[i % defaultDDColors.length] };
        });
    }

    // Look up color for a dropdown value
    function getDropdownColor(col, value) {
        var opts = col.dropdownOptions || [];
        for (var i = 0; i < opts.length; i++) {
            var opt = opts[i];
            var v = (typeof opt === 'string') ? opt : opt.value;
            var c = (typeof opt === 'string') ? null : opt.color;
            if (v === value && c) return c;
        }
        return null;
    }

    // Look up symbol info for a value
    function getSymbolInfo(col, value) {
        var style = symbolStyles[col.symbolStyle || 'status'];
        if (!style) return null;
        for (var i = 0; i < style.options.length; i++) {
            if (style.options[i].value === value) return style.options[i];
        }
        return null;
    }

    // Build symbol icon HTML
    function buildSymbolIcon(info) {
        return $('<span class="symbol-icon ' + info.cssClass + '"><i class="fa ' + info.icon + '"></i></span>');
    }

    function populateDurationDateCols(colIndex) {
        var $start = $('#duration-start-col');
        var $end = $('#duration-end-col');
        $start.empty().append($('<option value="">').text('— Select —'));
        $end.empty().append($('<option value="">').text('— Select —'));
        $.each(columns, function (i, c) {
            if (c.type === 'date' && i !== colIndex) {
                $start.append($('<option>').val(c.id).text(c.name));
                $end.append($('<option>').val(c.id).text(c.name));
            }
        });
    }

    function openColumnProperties(colIndex) {
        var col = columns[colIndex];
        $('#colprops-name').val(col.name);
        $('#colprops-description').val(col.description || '');
        $('#colprops-type').val(col.type || 'text');

        // Load dropdown options into temp array (normalized)
        colpropsDropdownValues = normalizeDropdownOptions(col.dropdownOptions || []);
        toggleDropdownSection(col.type || 'text');
        renderDropdownValues();

        // Load symbol style
        $('#symbols-style-select').val(col.symbolStyle || 'status');

        // Populate duration date column dropdowns
        populateDurationDateCols(colIndex);
        if (col.durationStartCol !== undefined) $('#duration-start-col').val(col.durationStartCol);
        if (col.durationEndCol !== undefined) $('#duration-end-col').val(col.durationEndCol);

        $('#colprops-dialog').show();
        $('#colprops-name').focus().select();

        $('#colprops-apply').off('click').on('click', function () {
            var newName = $('#colprops-name').val().trim();
            if (newName) col.name = newName;
            col.description = $('#colprops-description').val().trim();
            col.type = $('#colprops-type').val();

            // Save dropdown values if type is dropdown
            if (col.type === 'dropdown') {
                col.dropdownOptions = [];
                $('#dropdown-values-list .dropdown-value-item').each(function () {
                    var v = $(this).find('input[data-dd-index]').val().trim();
                    var c = $(this).find('.dd-color').css('background-color');
                    if (v) col.dropdownOptions.push({ value: v, color: rgbToHex(c) });
                });
            }

            // Save symbol style if type is symbols
            if (col.type === 'symbols') {
                col.symbolStyle = $('#symbols-style-select').val() || 'status';
            }

            // Save duration config if type is duration
            if (col.type === 'duration') {
                var startVal = $('#duration-start-col').val();
                var endVal = $('#duration-end-col').val();
                col.durationStartCol = startVal ? parseInt(startVal) : '';
                col.durationEndCol = endVal ? parseInt(endVal) : '';
            }

            // Destroy any spectrum pickers left in the dropdown list
            $('#dropdown-values-list .dd-color-input').spectrum('destroy');

            renderHeaders();
            renderBody();
            scheduleSave();
            $('#colprops-dialog').hide();
        });
        $('#colprops-cancel').off('click').on('click', function () {
            $('#dropdown-values-list .dd-color-input').spectrum('destroy');
            $('#colprops-dialog').hide();
        });
    }

    // Convert rgb(r,g,b) to hex
    function rgbToHex(rgb) {
        if (!rgb) return '#cccccc';
        if (rgb.charAt(0) === '#') return rgb;
        var parts = rgb.match(/\d+/g);
        if (!parts || parts.length < 3) return '#cccccc';
        return '#' + ((1 << 24) + (parseInt(parts[0]) << 16) + (parseInt(parts[1]) << 8) + parseInt(parts[2]))
            .toString(16).slice(1);
    }

    // Check if a hex color is light (for choosing text color)
    function isLightColor(hex) {
        if (!hex) return true;
        hex = hex.replace('#', '');
        var r = parseInt(hex.substr(0, 2), 16);
        var g = parseInt(hex.substr(2, 2), 16);
        var b = parseInt(hex.substr(4, 2), 16);
        var brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness > 160;
    }

    // Show/hide dropdown values section based on selected type
    function toggleDropdownSection(type) {
        if (type === 'dropdown') {
            $('#dropdown-values-section').show();
        } else {
            $('#dropdown-values-section').hide();
        }
        if (type === 'symbols') {
            $('#symbols-style-section').show();
        } else {
            $('#symbols-style-section').hide();
        }
        if (type === 'duration') {
            $('#duration-config-section').show();
        } else {
            $('#duration-config-section').hide();
        }
    }

    $('#colprops-type').on('change', function () {
        var newType = $(this).val();
        toggleDropdownSection(newType);
        if (newType === 'duration' && menuTargetCol !== null) {
            populateDurationDateCols(menuTargetCol);
        }
        if (newType === 'percent') {
            var curName = $('#colprops-name').val().trim();
            if (!curName || /^Column\d+$/.test(curName)) {
                $('#colprops-name').val('% Complete');
            }
        }
    });

    // Render the list of dropdown value entries
    function renderDropdownValues() {
        // Destroy existing spectrum pickers first
        $('#dropdown-values-list .dd-color-input').spectrum('destroy');
        var $list = $('#dropdown-values-list');
        $list.empty();

        $.each(colpropsDropdownValues, function (i, opt) {
            var color = opt.color || defaultDDColors[i % defaultDDColors.length];
            var $item = $('<div class="dropdown-value-item">').attr('data-dd-index', i);
            var $drag = $('<span class="dd-drag"><i class="fa fa-grip-vertical"></i></span>');
            var $colorDot = $('<span class="dd-color dd-color-clickable">').css('background-color', color);
            var $colorInput = $('<input type="text" class="dd-color-input">').val(color);
            var $textInput = $('<input type="text">').val(opt.value).attr('data-dd-index', i);
            var $removeBtn = $('<button class="dd-remove" title="Delete"><i class="fa fa-trash"></i></button>').attr('data-dd-index', i);

            $item.append($drag).append($colorDot).append($colorInput).append($textInput).append($removeBtn);
            $list.append($item);

            // Initialize spectrum on the hidden color input
            $colorInput.spectrum({
                color: color,
                showPalette: true,
                preferredFormat: 'hex',
                palette: [
                    ['#f5c4c4', '#f5d4c4', '#f5eac4', '#c4f5d2', '#c4daf5', '#d9c4f0', '#f0c4e8', '#e0e0e0'],
                    ['#ff0000', '#ff9900', '#ffcc00', '#00cc44', '#3c78d8', '#9900ff', '#ff00ff', '#999999'],
                    ['#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#674ea7', '#a64d79', '#666666']
                ],
                change: function (newColor) {
                    var hex = newColor.toHexString();
                    var idx = parseInt($item.attr('data-dd-index'));
                    colpropsDropdownValues[idx].color = hex;
                    $colorDot.css('background-color', hex);
                }
            });

            // Click on color dot opens the spectrum picker
            $colorDot.on('click', function (e) {
                e.stopPropagation();
                $colorInput.spectrum('toggle');
            });
        });
    }

    // Add a new dropdown value
    $('#dropdown-add-btn').on('click', function () {
        addDropdownValue();
    });

    $('#dropdown-new-value').on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            addDropdownValue();
        }
    });

    function addDropdownValue() {
        var val = $('#dropdown-new-value').val().trim();
        if (!val) return;
        var color = defaultDDColors[colpropsDropdownValues.length % defaultDDColors.length];
        colpropsDropdownValues.push({ value: val, color: color });
        renderDropdownValues();
        $('#dropdown-new-value').val('').focus();
    }

    // Remove a dropdown value
    $(document).on('click', '.dd-remove', function () {
        var idx = parseInt($(this).attr('data-dd-index'));
        // Destroy spectrum for this item before removing
        $(this).closest('.dropdown-value-item').find('.dd-color-input').spectrum('destroy');
        colpropsDropdownValues.splice(idx, 1);
        renderDropdownValues();
    });

    // Update temp array when user edits a value inline
    $(document).on('input', '.dropdown-value-item input[data-dd-index]', function () {
        var idx = parseInt($(this).attr('data-dd-index'));
        colpropsDropdownValues[idx].value = $(this).val();
    });

    // Enter key in column properties name field
    $(document).on('keydown', '#colprops-name', function (e) {
        if (e.key === 'Enter') $('#colprops-apply').click();
        if (e.key === 'Escape') $('#colprops-cancel').click();
    });

    // ========== Row Context Menu ==========
    $(document).on('contextmenu', 'td.row-number', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var $tr = $(this).closest('tr');
        var rowIndex = parseInt($tr.attr('data-row'));
        menuTargetRow = rowIndex;

        // If right-clicked row is already part of a multi-selection, keep it;
        // otherwise select just this row
        if (selectedRows.indexOf(rowIndex) === -1) {
            selectedRows = [rowIndex];
            lastClickedRow = rowIndex;
            $('#spreadsheet tbody tr').removeClass('row-selected');
            $tr.addClass('row-selected');
        }

        // Update delete label based on selection count
        var count = selectedRows.length;
        if (count > 1) {
            $('#delete-row-label').text('Delete ' + count + ' Rows');
        } else {
            $('#delete-row-label').text('Delete Row');
        }

        // Enable/disable paste
        if (rowClipboard) {
            $('[data-row-action="paste"]').removeClass('disabled');
        } else {
            $('[data-row-action="paste"]').addClass('disabled');
        }

        // Position and show menu
        var $menu = $('#row-context-menu');
        var menuHeight = 240;
        var top = e.clientY;
        var left = e.clientX;
        // Keep menu within viewport
        if (top + menuHeight > $(window).height()) {
            top = $(window).height() - menuHeight - 10;
        }
        $menu.css({ top: top, left: left }).show();

        // Hide column menu if open
        $('#column-context-menu').hide();
    });

    // ========== Row Menu Actions ==========
    $(document).on('click', '[data-row-action]', function () {
        var action = $(this).attr('data-row-action');
        var rowIndex = menuTargetRow;
        if (rowIndex === null) return;

        $('#row-context-menu').hide();
        $('#spreadsheet tbody tr').removeClass('row-selected');

        switch (action) {
            case 'insert-above':
                if (isProtectedView) { showToast('Protected View: Inserting rows is disabled.'); return; }
                insertRow(rowIndex);
                break;
            case 'insert-below':
                if (isProtectedView) { showToast('Protected View: Inserting rows is disabled.'); return; }
                insertRow(rowIndex + 1);
                break;
            case 'cut':
                if (isProtectedView) { showToast('Protected View: Cutting rows is disabled.'); return; }
                cutRow(rowIndex);
                break;
            case 'copy':
                copyRow(rowIndex);
                break;
            case 'paste':
                if (isProtectedView) { showToast('Protected View: Pasting rows is disabled.'); return; }
                pasteRow(rowIndex);
                break;
            case 'delete':
                if (isProtectedView) { showToast('Protected View: Deleting rows is disabled.'); return; }
                if (selectedRows.length > 1) {
                    deleteRows(selectedRows);
                } else {
                    deleteRows([rowIndex]);
                }
                break;
        }
    });

    // ========== Row Operations ==========
    function shiftRowData(fromRow, direction) {
        var newCellData = {};
        $.each(cellData, function (key, val) {
            var parts = key.split('-');
            var r = parseInt(parts[0]);
            var c = parseInt(parts[1]);
            if (direction === 'insert') {
                if (r >= fromRow) {
                    newCellData[(r + 1) + '-' + c] = val;
                } else {
                    newCellData[key] = val;
                }
            } else if (direction === 'delete') {
                if (r === fromRow) {
                    // skip deleted row
                } else if (r > fromRow) {
                    newCellData[(r - 1) + '-' + c] = val;
                } else {
                    newCellData[key] = val;
                }
            }
        });
        cellData = newCellData;
    }

    function insertRow(atRow) {
        shiftRowData(atRow, 'insert');
        totalRows++;
        if (selectedCell && selectedCell.row >= atRow) {
            selectedCell.row++;
        }
        renderBody();
        scheduleSave();
    }

    function cutRow(rowIndex) {
        // Store row data in clipboard
        var rowData = {};
        for (var c = 0; c < columns.length; c++) {
            var key = rowIndex + '-' + c;
            if (cellData[key]) {
                rowData[c] = $.extend({}, cellData[key]);
            }
        }
        rowClipboard = { data: rowData, mode: 'cut', sourceRow: rowIndex };

        // Clear the source row
        for (var c = 0; c < columns.length; c++) {
            delete cellData[rowIndex + '-' + c];
        }
        renderBody();
        scheduleSave();
        showToast('Row ' + (rowIndex + 1) + ' cut to clipboard');
    }

    function copyRow(rowIndex) {
        var rowData = {};
        for (var c = 0; c < columns.length; c++) {
            var key = rowIndex + '-' + c;
            if (cellData[key]) {
                rowData[c] = $.extend({}, cellData[key]);
            }
        }
        rowClipboard = { data: rowData, mode: 'copy', sourceRow: rowIndex };
        showToast('Row ' + (rowIndex + 1) + ' copied to clipboard');
    }

    function pasteRow(rowIndex) {
        if (!rowClipboard) return;

        // Paste clipboard data into target row
        for (var c = 0; c < columns.length; c++) {
            var key = rowIndex + '-' + c;
            if (rowClipboard.data[c]) {
                cellData[key] = $.extend({}, rowClipboard.data[c]);
            } else {
                delete cellData[key];
            }
        }

        // If it was a cut, clear the clipboard (one-time paste)
        if (rowClipboard.mode === 'cut') {
            rowClipboard = null;
        }

        renderBody();
        scheduleSave();
        showToast('Pasted into row ' + (rowIndex + 1));
    }

    function deleteRows(rowIndices) {
        if (!rowIndices || rowIndices.length === 0) return;
        if (totalRows - rowIndices.length < 1) {
            alert('Cannot delete all rows.');
            return;
        }

        // Sort descending so we delete from bottom up (indices stay valid)
        var sorted = rowIndices.slice().sort(function (a, b) { return b - a; });
        for (var i = 0; i < sorted.length; i++) {
            shiftRowData(sorted[i], 'delete');
            totalRows--;
            // Clean up attachments, comments, collapsed state
            delete rowAttachments[sorted[i]];
            delete rowComments[sorted[i]];
            delete rowNotes[sorted[i]];
            delete collapsedRows[sorted[i]];
        }

        selectedCell = null;
        selectedRows = [];
        lastClickedRow = null;
        renderBody();
        scheduleSave();
        if (sorted.length === 1) {
            showToast('Deleted row ' + (sorted[0] + 1));
        } else {
            showToast('Deleted ' + sorted.length + ' rows');
        }
    }

    // ========== Column Operations ==========
    function shiftCellData(fromCol, direction) {
        // Shift cell data when inserting/deleting columns
        var newCellData = {};
        $.each(cellData, function (key, val) {
            var parts = key.split('-');
            var r = parseInt(parts[0]);
            var c = parseInt(parts[1]);
            if (direction === 'insert') {
                if (c >= fromCol) {
                    newCellData[r + '-' + (c + 1)] = val;
                } else {
                    newCellData[key] = val;
                }
            } else if (direction === 'delete') {
                if (c === fromCol) {
                    // Skip deleted column
                } else if (c > fromCol) {
                    newCellData[r + '-' + (c - 1)] = val;
                } else {
                    newCellData[key] = val;
                }
            }
        });
        cellData = newCellData;
    }

    function insertColumn(atIndex) {
        var newName = 'Column' + (columns.length + 1);
        var newCol = createColumn(newName);
        shiftCellData(atIndex, 'insert');
        columns.splice(atIndex, 0, newCol);
        renderAll();
        scheduleSave();
    }

    function deleteColumn(colIndex) {
        if (columns.length <= 1) {
            alert('Cannot delete the last column.');
            return;
        }
        shiftCellData(colIndex, 'delete');
        columns.splice(colIndex, 1);
        if (selectedCell && selectedCell.col === colIndex) {
            selectedCell = null;
        } else if (selectedCell && selectedCell.col > colIndex) {
            selectedCell.col--;
        }
        renderAll();
        scheduleSave();
    }

    // ========== Rename Dialog ==========
    function openRenameDialog(colIndex) {
        var col = columns[colIndex];
        $('#rename-input').val(col.name);
        $('#rename-dialog').show();
        $('#rename-input').focus().select();

        $('#rename-ok').off('click').on('click', function () {
            var newName = $('#rename-input').val().trim();
            if (newName) {
                col.name = newName;
                renderHeaders();
                scheduleSave();
            }
            $('#rename-dialog').hide();
        });
        $('#rename-cancel').off('click').on('click', function () {
            $('#rename-dialog').hide();
        });
    }

    // Enter key in rename dialog
    $(document).on('keydown', '#rename-input', function (e) {
        if (e.key === 'Enter') $('#rename-ok').click();
        if (e.key === 'Escape') $('#rename-cancel').click();
    });

    // ========== Description Dialog ==========
    function openDescriptionDialog(colIndex) {
        var col = columns[colIndex];
        $('#description-input').val(col.description || '');
        $('#description-dialog').show();
        $('#description-input').focus();

        $('#description-ok').off('click').on('click', function () {
            col.description = $('#description-input').val().trim();
            renderHeaders();
            scheduleSave();
            $('#description-dialog').hide();
        });
        $('#description-cancel').off('click').on('click', function () {
            $('#description-dialog').hide();
        });
    }

    // ========== Sort Dialog ==========
    function openSortDialog(colIndex) {
        $('input[name="sort-order"][value="asc"]').prop('checked', true);
        $('#sort-dialog').show();

        $('#sort-ok').off('click').on('click', function () {
            var order = $('input[name="sort-order"]:checked').val();
            sortRows(colIndex, order);
            scheduleSave();
            $('#sort-dialog').hide();
        });
        $('#sort-cancel').off('click').on('click', function () {
            $('#sort-dialog').hide();
        });
    }

    function sortRows(colIndex, order) {
        // Build a tree structure from flat rows based on indent levels
        function buildTree(startRow, endRow, parentIndent) {
            var nodes = [];
            var r = startRow;
            while (r < endRow) {
                var indent = getRowIndent(r);
                if (indent <= parentIndent && r > startRow) break;
                if (indent === parentIndent + 1 || (parentIndent === -1 && indent === 0)) {
                    // Find the extent of this node's children
                    var childStart = r + 1;
                    var childEnd = childStart;
                    while (childEnd < endRow && getRowIndent(childEnd) > indent) {
                        childEnd++;
                    }
                    var node = { row: r, children: [] };
                    if (childEnd > childStart) {
                        node.children = buildTree(childStart, childEnd, indent);
                    }
                    nodes.push(node);
                    r = childEnd;
                } else {
                    r++;
                }
            }
            return nodes;
        }

        var col = columns[colIndex];
        var colType = (col && col.type) || 'text';

        // For duration columns, resolve linked start/end date column indices
        var durStartColIdx = -1, durEndColIdx = -1;
        if (colType === 'duration' && col.durationStartCol !== undefined && col.durationEndCol !== undefined &&
            col.durationStartCol !== '' && col.durationEndCol !== '') {
            for (var ci = 0; ci < columns.length; ci++) {
                if (columns[ci].id === col.durationStartCol) durStartColIdx = ci;
                if (columns[ci].id === col.durationEndCol) durEndColIdx = ci;
            }
        }

        function getDurationDays(row) {
            if (durStartColIdx < 0 || durEndColIdx < 0) return null;
            var startStr = (cellData[row + '-' + durStartColIdx] && cellData[row + '-' + durStartColIdx].text) || '';
            var endStr = (cellData[row + '-' + durEndColIdx] && cellData[row + '-' + durEndColIdx].text) || '';
            if (!startStr || !endStr) return null;
            var s = new Date(startStr);
            var e = new Date(endStr);
            if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
            return Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
        }

        function getSortValue(row) {
            if (colType === 'duration') {
                return getDurationDays(row);
            }
            return (cellData[row + '-' + colIndex] && cellData[row + '-' + colIndex].text) || '';
        }

        function sortCompare(a, b) {
            var va = getSortValue(a.row);
            var vb = getSortValue(b.row);

            // Empty/null values go first in ascending, last in descending
            var emptyA = (va === '' || va === null);
            var emptyB = (vb === '' || vb === null);
            if (emptyA && !emptyB) return order === 'asc' ? -1 : 1;
            if (!emptyA && emptyB) return order === 'asc' ? 1 : -1;
            if (emptyA && emptyB) return 0;

            // Date columns: stored as YYYY-MM-DD, compare as strings (lexicographic = chronological)
            if (colType === 'date') {
                if (va < vb) return order === 'asc' ? -1 : 1;
                if (va > vb) return order === 'asc' ? 1 : -1;
                return 0;
            }

            // Duration columns: already numeric from getDurationDays
            if (colType === 'duration') {
                return order === 'asc' ? va - vb : vb - va;
            }

            var la = String(va).toLowerCase();
            var lb = String(vb).toLowerCase();
            // Try numeric comparison for percent, cost, and other numeric values
            var na = parseFloat(la);
            var nb = parseFloat(lb);
            if (!isNaN(na) && !isNaN(nb)) {
                return order === 'asc' ? na - nb : nb - na;
            }
            if (la < lb) return order === 'asc' ? -1 : 1;
            if (la > lb) return order === 'asc' ? 1 : -1;
            return 0;
        }

        function sortTree(nodes) {
            nodes.sort(sortCompare);
            $.each(nodes, function (i, node) {
                if (node.children.length > 0) {
                    sortTree(node.children);
                }
            });
        }

        function flattenTree(nodes, result) {
            $.each(nodes, function (i, node) {
                result.push(node.row);
                flattenTree(node.children, result);
            });
        }

        // Build tree, sort each level, flatten back
        var tree = buildTree(0, totalRows, -1);
        sortTree(tree);
        var sortedRows = [];
        flattenTree(tree, sortedRows);

        // Remap cell data using sorted order
        var newCellData = {};
        $.each(sortedRows, function (newRow, origRow) {
            for (var c = 0; c < columns.length; c++) {
                var oldKey = origRow + '-' + c;
                var newKey = newRow + '-' + c;
                if (cellData[oldKey]) {
                    newCellData[newKey] = $.extend({}, cellData[oldKey]);
                }
            }
        });
        cellData = newCellData;
        renderBody();
    }

    // ========== Filter Dialog ==========
    function openFilterDialog(colIndex) {
        var col = columns[colIndex];
        $('#filter-input').val(col.filterValue || '');
        $('#filter-dialog').show();
        $('#filter-input').focus();

        $('#filter-ok').off('click').on('click', function () {
            col.filterValue = $('#filter-input').val().trim();
            renderBody();
            scheduleSave();
            $('#filter-dialog').hide();
        });
        $('#filter-cancel').off('click').on('click', function () {
            $('#filter-dialog').hide();
        });
    }

    // ========== Lock / Freeze / Hide ==========
    function toggleLockColumn(colIndex) {
        columns[colIndex].locked = !columns[colIndex].locked;
        renderAll();
        scheduleSave();
    }

    function toggleFreezeColumn(colIndex) {
        columns[colIndex].frozen = !columns[colIndex].frozen;
        renderAll();
        scheduleSave();
    }

    function hideColumn(colIndex) {
        columns[colIndex].hidden = true;
        if (selectedCell && selectedCell.col === colIndex) {
            selectedCell = null;
        }
        renderAll();
        scheduleSave();

        // Show a small toast notification
        showToast('Column "' + columns[colIndex].name + '" hidden. Right-click row numbers to unhide.');
    }

    // Right-click on header row-number area to unhide columns
    $(document).on('contextmenu', '.row-number-header', function (e) {
        e.preventDefault();
        var hiddenCols = [];
        $.each(columns, function (i, col) {
            if (col.hidden) hiddenCols.push(i);
        });
        if (hiddenCols.length === 0) return;

        if (confirm('Unhide all hidden columns?')) {
            $.each(columns, function (i, col) {
                col.hidden = false;
            });
            renderAll();
            scheduleSave();
        }
    });

    // ========== Column Resize ==========
    var resizing = false;
    var resizeCol = null;
    var resizeStartX = 0;
    var resizeStartWidth = 0;

    $(document).on('mousedown', '.col-resize-handle', function (e) {
        e.preventDefault();
        e.stopPropagation();
        resizing = true;
        var $th = $(this).parent();
        resizeCol = $th;
        resizeStartX = e.pageX;
        resizeStartWidth = $th.outerWidth();

        // Lock every column's current width so they don't shift during resize
        $('#header-row th.col-header').each(function () {
            var w = $(this).outerWidth();
            $(this).css('width', w + 'px');
            var ci = parseInt($(this).attr('data-col-index'));
            $('td.cell[data-col="' + ci + '"]').css('width', w + 'px');
        });

        $('body').css('cursor', 'col-resize');
    });

    $(document).on('mousemove', function (e) {
        if (!resizing) return;
        var diff = e.pageX - resizeStartX;
        var newWidth = Math.max(10, resizeStartWidth + diff);
        resizeCol.css('width', newWidth + 'px');
        var colIndex = parseInt(resizeCol.attr('data-col-index'));
        $('td.cell[data-col="' + colIndex + '"]').css('width', newWidth + 'px');
    });

    $(document).on('mouseup', function () {
        if (resizing) {
            // Persist all column widths to the column objects
            $('#header-row th.col-header').each(function () {
                var ci = parseInt($(this).attr('data-col-index'));
                columns[ci].width = $(this).outerWidth();
            });
            resizing = false;
            resizeCol = null;
            $('body').css('cursor', '');
            scheduleSave();
        }
    });

    // ========== Column Drag Reorder ==========
    $('<div id="col-drop-indicator">').appendTo('body');

    var dropTargetInsertIdx = null;

    $(document).on('dragstart', '.col-header-content', function (e) {
        var $th = $(this).closest('th.col-header');
        var colIndex = parseInt($th.attr('data-col-index'));
        if (colIndex < 1) {
            e.preventDefault();
            return;
        }
        dragSourceColIndex = colIndex;
        $th.addClass('col-dragging');
        e.originalEvent.dataTransfer.effectAllowed = 'move';
        e.originalEvent.dataTransfer.setData('text/plain', '' + colIndex);
    });

    $(document).on('dragover', 'th.col-header', function (e) {
        if (dragSourceColIndex === null) return;
        e.preventDefault();
        e.originalEvent.dataTransfer.dropEffect = 'move';

        var $th = $(this);
        var rect = $th[0].getBoundingClientRect();
        var mouseX = e.originalEvent.clientX;
        var midpoint = rect.left + rect.width / 2;
        var targetCol = parseInt($th.attr('data-col-index'));

        // Determine insert position based on which half the cursor is in
        if (mouseX < midpoint) {
            dropTargetInsertIdx = targetCol;
        } else {
            dropTargetInsertIdx = targetCol + 1;
        }

        // Clamp to minimum of 2
        if (dropTargetInsertIdx < 1) dropTargetInsertIdx = 1;

        // Position the indicator
        var indicatorX;
        if (mouseX < midpoint) {
            indicatorX = rect.left;
        } else {
            indicatorX = rect.right;
        }

        var $indicator = $('#col-drop-indicator');
        $indicator.css({
            display: 'block',
            left: indicatorX - 1 + 'px',
            top: rect.top + 'px',
            height: (window.innerHeight - rect.top) + 'px'
        });
    });

    $(document).on('dragenter', 'th.col-header', function (e) {
        if (dragSourceColIndex === null) return;
        e.preventDefault();
    });

    $(document).on('dragleave', '#header-row', function (e) {
        // Hide indicator only when cursor truly leaves the header row
        var headerRow = document.getElementById('header-row');
        if (headerRow && !headerRow.contains(e.relatedTarget)) {
            $('#col-drop-indicator').css('display', 'none');
        }
    });

    $(document).on('drop', 'th.col-header', function (e) {
        e.preventDefault();
        if (dragSourceColIndex === null || dropTargetInsertIdx === null) return;
        reorderColumn(dragSourceColIndex, dropTargetInsertIdx);
        // Cleanup
        dragSourceColIndex = null;
        dropTargetInsertIdx = null;
        $('th.col-header').removeClass('col-dragging');
        $('#col-drop-indicator').css('display', 'none');
    });

    $(document).on('dragend', '.col-header-content', function () {
        dragSourceColIndex = null;
        dropTargetInsertIdx = null;
        $('th.col-header').removeClass('col-dragging');
        $('#col-drop-indicator').css('display', 'none');
    });

    function reorderColumn(fromIdx, toIdx) {
        // Validate
        if (fromIdx < 1) return;
        if (toIdx < 1) toIdx = 1;

        // Compute the actual insertion index after removal
        var insertAt = (toIdx > fromIdx) ? toIdx - 1 : toIdx;
        if (insertAt === fromIdx) return;

        // Capture column widths from DOM before splice
        $('#header-row th.col-header').each(function () {
            var ci = parseInt($(this).attr('data-col-index'));
            columns[ci].width = $(this).outerWidth();
        });

        // Splice the column
        var movedCol = columns.splice(fromIdx, 1)[0];
        columns.splice(insertAt, 0, movedCol);

        // Build old-to-new index mapping
        // After splice, each column's new index is its position in the array.
        // We need to figure out where each old index ended up.
        var totalCols = columns.length;
        var oldToNew = {};
        // Reconstruct: before splice, positions were 0..N-1
        // After removing fromIdx and inserting at insertAt, the mapping is:
        if (fromIdx < insertAt) {
            for (var i = 0; i < totalCols; i++) {
                if (i < fromIdx) {
                    oldToNew[i] = i;
                } else if (i === fromIdx) {
                    oldToNew[i] = insertAt;
                } else if (i <= insertAt) {
                    oldToNew[i] = i - 1;
                } else {
                    oldToNew[i] = i;
                }
            }
        } else {
            for (var i = 0; i < totalCols; i++) {
                if (i < insertAt) {
                    oldToNew[i] = i;
                } else if (i === fromIdx) {
                    oldToNew[i] = insertAt;
                } else if (i < fromIdx) {
                    oldToNew[i] = i + 1;
                } else {
                    oldToNew[i] = i;
                }
            }
        }

        // Remap cellData keys
        var newCellData = {};
        $.each(cellData, function (key, val) {
            var parts = key.split('-');
            var r = parseInt(parts[0]);
            var c = parseInt(parts[1]);
            var newC = (oldToNew[c] !== undefined) ? oldToNew[c] : c;
            newCellData[r + '-' + newC] = val;
        });
        cellData = newCellData;

        // Clear transient state
        selectedCell = null;
        selectedColumn = null;
        menuTargetCol = null;
        rowClipboard = null;
        if (sidebarOpenRow !== null) closeSidebar();

        renderAll();
        scheduleSave();
    }

    // ========== Toast Notification ==========
    function showToast(msg) {
        var $toast = $('<div>')
            .css({
                position: 'fixed',
                bottom: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: '#2a5db0',
                color: '#fff',
                padding: '10px 20px',
                borderRadius: '6px',
                fontSize: '13px',
                zIndex: 3000,
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
            })
            .text(msg)
            .appendTo('body');

        setTimeout(function () {
            $toast.fadeOut(400, function () { $toast.remove(); });
        }, 3000);
    }

    // ========== Row Collapse/Expand Toggle ==========
    $(document).on('click', '.row-toggle', function (e) {
        e.stopPropagation();
        var rowIndex = parseInt($(this).attr('data-toggle-row'));
        if (collapsedRows[rowIndex]) {
            delete collapsedRows[rowIndex];
        } else {
            collapsedRows[rowIndex] = true;
        }
        renderBody();
        scheduleSave();
    });

    // ========== Row Details Sidebar ==========
    $(document).on('click', '.row-expand-btn', function (e) {
        e.stopPropagation();
        var rowIndex = parseInt($(this).attr('data-expand-row'));
        openSidebar(rowIndex);
    });

    function openSidebar(rowIndex) {
        sidebarOpenRow = rowIndex;
        var sidebarTitleText = buildPredecessorLabel(rowIndex) || 'Row ' + (rowIndex + 1);
        $('#sidebar-title').html('<i class="fa fa-bookmark sidebar-title-icon"></i> ' + $('<span>').text(sidebarTitleText).html());

        // Reset to Details tab
        $('.sidebar-tab').removeClass('active');
        $('.sidebar-tab[data-tab="details"]').addClass('active');
        $('.sidebar-tab-content').removeClass('active');
        $('.sidebar-tab-content[data-tab-content="details"]').addClass('active');

        // Build detail fields for each visible column
        var $fields = $('#sidebar-fields');
        $fields.empty();

        $.each(columns, function (c, col) {
            if (col.hidden) return;
            var key = rowIndex + '-' + c;
            var data = cellData[key] || {};
            var colType = col.type || 'text';

            var $group = $('<div class="sidebar-field">');
            $group.append($('<label>').text(col.name));

            var fieldId = 'sidebar-field-' + c;

            if (colType === 'checkbox') {
                var $cb = $('<input type="checkbox">')
                    .attr('id', fieldId)
                    .attr('data-sidebar-col', c)
                    .prop('checked', data.text === 'true' || data.text === '1');
                $group.append($cb);
            } else if (colType === 'date') {
                var $date = $('<input type="date">')
                    .attr('id', fieldId)
                    .attr('data-sidebar-col', c)
                    .val(data.text || '');
                $group.append($date);
            } else if (colType === 'symbols') {
                var symStyle = symbolStyles[col.symbolStyle || 'status'];
                var symOpts = symStyle ? symStyle.options : [];
                var $sel = $('<select>')
                    .attr('id', fieldId)
                    .attr('data-sidebar-col', c);
                $sel.append($('<option value="">').text('— Select —'));
                $.each(symOpts, function (i, opt) {
                    $sel.append($('<option>').val(opt.value).text(opt.value));
                });
                $sel.val(data.text || '');
                $group.append($sel);
            } else if (colType === 'percent') {
                var $pctIn = $('<input type="text">')
                    .attr('id', fieldId)
                    .attr('data-sidebar-col', c)
                    .val(data.text || '')
                    .attr('placeholder', 'Number only');
                $group.append($pctIn);
            } else if (colType === 'duration') {
                // Show calculated duration as read-only text
                var durText = '';
                if (col.durationStartCol !== undefined && col.durationEndCol !== undefined &&
                    col.durationStartCol !== '' && col.durationEndCol !== '') {
                    var sIdx = -1, eIdx = -1;
                    for (var ci = 0; ci < columns.length; ci++) {
                        if (columns[ci].id === col.durationStartCol) sIdx = ci;
                        if (columns[ci].id === col.durationEndCol) eIdx = ci;
                    }
                    if (sIdx >= 0 && eIdx >= 0) {
                        var sDateStr = (cellData[rowIndex + '-' + sIdx] && cellData[rowIndex + '-' + sIdx].text) || '';
                        var eDateStr = (cellData[rowIndex + '-' + eIdx] && cellData[rowIndex + '-' + eIdx].text) || '';
                        if (sDateStr && eDateStr) {
                            var sDate = new Date(sDateStr);
                            var eDate = new Date(eDateStr);
                            if (!isNaN(sDate.getTime()) && !isNaN(eDate.getTime())) {
                                durText = (Math.round((eDate - sDate) / (1000 * 60 * 60 * 24)) + 1) + 'd';
                            }
                        }
                    }
                }
                var $durInput = $('<input type="text">')
                    .attr('id', fieldId)
                    .attr('data-sidebar-col', c)
                    .val(durText)
                    .prop('disabled', true)
                    .css({ background: '#f5f5f5', color: '#999' });
                $group.append($durInput);
            } else if (colType === 'contacts') {
                var currentIds = (data.text || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
                var $picker = $('<div class="sidebar-contact-picker">')
                    .attr('id', fieldId)
                    .attr('data-sidebar-col', c);
                // Render chips for current contacts
                $.each(currentIds, function (i, cid) {
                    var contact = getWsContactById(cid);
                    if (!contact) return;
                    var initials = getWsInitials(contact.name);
                    var color = getWsAvatarColor(cid);
                    var $chip = $('<span class="sidebar-contact-chip">').attr('data-contact-id', cid);
                    $chip.append($('<span class="sc-avatar">').css('background-color', color).text(initials));
                    $chip.append($('<span>').text(contact.name));
                    $chip.append($('<span class="sc-remove">').html('&times;'));
                    $picker.append($chip);
                });
                // Add button to open dropdown
                var $addBtn = $('<button type="button" class="sidebar-contact-add-btn" title="Add contact">')
                    .html('<i class="fa fa-plus"></i>')
                    .attr('data-sidebar-contact-col', c);
                $picker.append($addBtn);
                $group.append($picker);
            } else if (colType === 'dropdown') {
                var $sel = $('<select>')
                    .attr('id', fieldId)
                    .attr('data-sidebar-col', c);
                $sel.append($('<option value="">').text('— Select —'));
                // If the column has dropdown options defined, use them
                var opts = col.dropdownOptions || [];
                var optValues = [];
                $.each(opts, function (i, opt) {
                    var v = (typeof opt === 'string') ? opt : opt.value;
                    optValues.push(v);
                    $sel.append($('<option>').val(v).text(v));
                });
                // If current value exists but not in options, add it
                if (data.text && optValues.indexOf(data.text) === -1) {
                    $sel.append($('<option>').val(data.text).text(data.text));
                }
                $sel.val(data.text || '');
                $group.append($sel);
            } else if (colType === 'predecessor') {
                var currentLabels = (data.text || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
                var $picker = $('<div class="sidebar-pred-picker">')
                    .attr('id', fieldId)
                    .attr('data-sidebar-col', c);
                // Render chips for current predecessors
                $.each(currentLabels, function (i, lbl) {
                    var $chip = $('<span class="sidebar-pred-chip">').attr('data-pred-label', lbl);
                    $chip.append($('<span>').text(lbl));
                    $chip.append($('<span class="sp-remove">').html('&times;'));
                    $picker.append($chip);
                });
                // Add button to open dropdown
                var $addBtn = $('<button type="button" class="sidebar-pred-add-btn" title="Add predecessor">')
                    .html('<i class="fa fa-plus"></i>')
                    .attr('data-sidebar-pred-col', c);
                $picker.append($addBtn);
                $group.append($picker);
            } else {
                // text or number
                var inputType = (colType === 'number') ? 'text' : 'text';
                var $input = $('<input type="text">')
                    .attr('id', fieldId)
                    .attr('data-sidebar-col', c)
                    .val(data.text || '');
                $group.append($input);
            }

            $fields.append($group);
        });

        // Render notes (always show parent task's notes)
        var notesParentRow = getParentTaskRow(rowIndex);
        $('#sidebar-notes').val(rowNotes[notesParentRow] || '').attr('data-notes-row', notesParentRow);

        // Render attachments (always show parent task's attachments)
        var attachParentRow = getParentTaskRow(rowIndex);
        renderSidebarAttachments(attachParentRow);

        // Render comments (always show parent task's comments)
        var commentsParentRow = getParentTaskRow(rowIndex);
        renderSidebarComments(commentsParentRow);

        // Show Admin Comments section only for super users
        if (isSuperUser()) {
            $('#sidebar-admin-comments').show();
        } else {
            $('#sidebar-admin-comments').hide();
        }

        // Open the panel
        $('#row-sidebar').addClass('open');
        $('body').addClass('sidebar-open');
    }

    function closeSidebar() {
        closeWsContactDropdown();
        closeWsPredDropdown();
        $('#row-sidebar').removeClass('open');
        $('body').removeClass('sidebar-open');
        sidebarOpenRow = null;
    }

    $('#sidebar-close').on('click', function () {
        closeSidebar();
    });

    // Sidebar tab switching
    $(document).on('click', '.sidebar-tab', function () {
        var tab = $(this).attr('data-tab');
        $('.sidebar-tab').removeClass('active');
        $(this).addClass('active');
        $('.sidebar-tab-content').removeClass('active');
        $('.sidebar-tab-content[data-tab-content="' + tab + '"]').addClass('active');
        if (tab === 'logs') loadLogsForCurrentRow();
    });

    // Get task ID for a given row index from preservedTaskData
    function getTaskIdForRow(rowIndex) {
        if (!preservedTaskData || !preservedTaskData.tasks) return null;
        var rowIdx = 0;
        var foundId = null;
        $.each(preservedTaskData.tasks, function (ti, task) {
            if (!task.name || !task.name.trim()) return true;
            if (rowIdx === rowIndex) { foundId = task.id; return false; }
            rowIdx++;
            $.each(task.subtasks || [], function (si, sub) {
                if (rowIdx === rowIndex) { foundId = sub.id; return false; }
                rowIdx++;
                $.each(sub.subtasks || [], function (ssi, subsub) {
                    if (rowIdx === rowIndex) { foundId = subsub.id; return false; }
                    rowIdx++;
                    $.each(subsub.subtasks || [], function (sssi, subsubsub) {
                        if (rowIdx === rowIndex) { foundId = subsubsub.id; return false; }
                        rowIdx++;
                    });
                    if (foundId !== null) return false;
                });
                if (foundId !== null) return false;
            });
            if (foundId !== null) return false;
        });
        return foundId;
    }

    function formatLogOperation(entry) {
        var op = entry.op;
        var d = entry.details || {};
        if (op === 'update') {
            return {
                operation: 'Updated',
                field: d.field || '',
                value: formatLogValue(d.field, d.value)
            };
        } else if (op === 'addSubtask') {
            var subName = (d.subtask && d.subtask.name) ? d.subtask.name : '';
            return {
                operation: 'Added Subtask',
                field: '',
                value: subName || '(new subtask)'
            };
        } else if (op === 'deleteSubtask') {
            return {
                operation: 'Deleted Subtask',
                field: '',
                value: 'ID: ' + (d.taskId || '')
            };
        } else if (op === 'deleteTask') {
            return {
                operation: 'Deleted Task',
                field: '',
                value: 'ID: ' + (d.taskId || '')
            };
        } else if (op === 'addTask') {
            var tName = (d.task && d.task.name) ? d.task.name : '';
            return {
                operation: 'Added Task',
                field: '',
                value: tName || '(new task)'
            };
        } else if (op === 'reorderSubtask') {
            return {
                operation: 'Reordered',
                field: 'position',
                value: d.direction === 'up' ? 'Moved Up' : 'Moved Down'
            };
        } else {
            return {
                operation: op || 'Unknown',
                field: d.field || '',
                value: d.value != null ? String(d.value) : ''
            };
        }
    }

    function formatLogValue(field, value) {
        if (value == null || value === '') return '(empty)';
        if (Array.isArray(value)) {
            if (value.length === 0) return '(none)';
            return value.join(', ');
        }
        return String(value);
    }

    function loadLogsForCurrentRow() {
        var $section = $('.sidebar-logs-section');
        if (sidebarOpenRow === null) {
            $section.html('<p class="sidebar-logs-placeholder"><i class="fa fa-clock-rotate-left"></i> No row selected.</p>');
            return;
        }
        var taskId = getTaskIdForRow(sidebarOpenRow);
        if (!taskId) {
            $section.html('<p class="sidebar-logs-placeholder"><i class="fa fa-clock-rotate-left"></i> No task data for this row.</p>');
            return;
        }
        $section.html('<p class="sidebar-logs-loading"><i class="fa fa-spinner fa-spin"></i> Loading logs...</p>');
        $.ajax({
            url: '/api/task-logs',
            method: 'GET',
            data: { project: PROJ_NAME, taskId: taskId },
            dataType: 'json',
            success: function (resp) {
                if (!resp.ok || !resp.logs || resp.logs.length === 0) {
                    $section.html('<p class="sidebar-logs-placeholder"><i class="fa fa-clock-rotate-left"></i> No logs found for this task.</p>');
                    return;
                }
                var html = '<table class="logs-table"><thead><tr>' +
                    '<th>Timestamp</th><th>User</th><th>Operation</th><th>Field</th><th>Value</th>' +
                    '</tr></thead><tbody>';
                $.each(resp.logs, function (i, entry) {
                    var info = formatLogOperation(entry);
                    var opClass = '';
                    if (entry.op === 'update') opClass = 'log-op-update';
                    else if (entry.op === 'addSubtask' || entry.op === 'addTask') opClass = 'log-op-add';
                    else if (entry.op === 'deleteSubtask' || entry.op === 'deleteTask') opClass = 'log-op-delete';
                    else if (entry.op === 'reorderSubtask') opClass = 'log-op-reorder';
                    html += '<tr>' +
                        '<td class="log-ts">' + $('<span>').text(entry.timestamp || '').html() + '</td>' +
                        '<td>' + $('<span>').text(entry.user || '').html() + '</td>' +
                        '<td><span class="log-op-badge ' + opClass + '">' + $('<span>').text(info.operation).html() + '</span></td>' +
                        '<td>' + $('<span>').text(info.field).html() + '</td>' +
                        '<td class="log-value">' + $('<span>').text(info.value).html() + '</td>' +
                        '</tr>';
                });
                html += '</tbody></table>';
                $section.html(html);
            },
            error: function () {
                $section.html('<p class="sidebar-logs-placeholder"><i class="fa fa-triangle-exclamation"></i> Failed to load logs.</p>');
            }
        });
    }

    // Save notes on input (always saves to parent task row)
    $('#sidebar-notes').on('input', function () {
        if (sidebarOpenRow === null) return;
        var parentRow = parseInt($(this).attr('data-notes-row'));
        if (isNaN(parentRow)) parentRow = getParentTaskRow(sidebarOpenRow);
        var val = $(this).val();
        if (val) {
            rowNotes[parentRow] = val;
        } else {
            delete rowNotes[parentRow];
        }
        scheduleSave();
    });

    // Apply changes from sidebar back to cellData
    $('#sidebar-apply').on('click', function () {
        if (sidebarOpenRow === null) return;
        var rowIndex = sidebarOpenRow;

        $('#sidebar-fields').find('[data-sidebar-col]').each(function () {
            var c = parseInt($(this).attr('data-sidebar-col'));
            var key = rowIndex + '-' + c;
            if (!cellData[key]) cellData[key] = {};

            var colType = columns[c].type || 'text';
            if (colType === 'checkbox') {
                cellData[key].text = $(this).is(':checked') ? 'true' : 'false';
            } else if (colType === 'contacts') {
                // Collect contact IDs from chips inside the picker
                var ids = [];
                $(this).find('.sidebar-contact-chip').each(function () {
                    ids.push($(this).attr('data-contact-id'));
                });
                cellData[key].text = ids.join(', ');
            } else if (colType === 'predecessor') {
                // Collect predecessor labels from chips inside the picker
                var predLabels = [];
                $(this).find('.sidebar-pred-chip').each(function () {
                    predLabels.push($(this).attr('data-pred-label'));
                });
                cellData[key].text = predLabels.join(', ');
            } else {
                cellData[key].text = $(this).val();
            }
        });

        renderBody();

        // Update sidebar title
        var updatedTitle = buildPredecessorLabel(rowIndex) || 'Row ' + (rowIndex + 1);
        $('#sidebar-title').html('<i class="fa fa-bookmark sidebar-title-icon"></i> ' + $('<span>').text(updatedTitle).html());

        showToast('Row ' + (rowIndex + 1) + ' updated.');
        scheduleSave();
    });

    // ========== Sidebar: Contact Picker Events ==========
    // Remove contact chip from sidebar picker
    $(document).on('click', '.sidebar-contact-chip .sc-remove', function (e) {
        e.stopPropagation();
        $(this).closest('.sidebar-contact-chip').remove();
    });

    // Open contact dropdown from sidebar add button
    $(document).on('click', '.sidebar-contact-add-btn', function (e) {
        e.stopPropagation();
        var colIdx = parseInt($(this).attr('data-sidebar-contact-col'));
        var $picker = $(this).closest('.sidebar-contact-picker');

        // Collect currently selected IDs from chips
        var currentIds = [];
        $picker.find('.sidebar-contact-chip').each(function () {
            currentIds.push($(this).attr('data-contact-id'));
        });

        // Build a simple dropdown inline
        var $dd = $('#ws-contact-dropdown');
        var rect = this.getBoundingClientRect();
        var top = rect.bottom + 2;
        var left = rect.left;
        if (top + 320 > window.innerHeight) {
            top = rect.top - 320;
            if (top < 0) top = 4;
        }
        if (left + 260 > window.innerWidth) {
            left = window.innerWidth - 264;
        }

        // Store reference for sidebar mode
        wsContactDropdownRow = 'sidebar';
        wsContactDropdownCol = colIdx;

        renderWsContactList('', currentIds);
        $dd.css({ top: top, left: left }).show();
        $('#ws-contact-filter').val('').focus();

        // Override click handler for sidebar mode
        $dd.off('click.sidebar').on('click.sidebar', '.ws-contact-item', function (ev) {
            ev.stopPropagation();
            var cid = $(this).attr('data-contact-id');
            var alreadyExists = false;
            $picker.find('.sidebar-contact-chip').each(function () {
                if ($(this).attr('data-contact-id') === cid) alreadyExists = true;
            });
            if (alreadyExists) {
                // Remove it
                $picker.find('.sidebar-contact-chip[data-contact-id="' + cid + '"]').remove();
            } else {
                // Add chip
                var contact = getWsContactById(cid);
                if (!contact) return;
                var initials = getWsInitials(contact.name);
                var color = getWsAvatarColor(cid);
                var $chip = $('<span class="sidebar-contact-chip">').attr('data-contact-id', cid);
                $chip.append($('<span class="sc-avatar">').css('background-color', color).text(initials));
                $chip.append($('<span>').text(contact.name));
                $chip.append($('<span class="sc-remove">').html('&times;'));
                $picker.find('.sidebar-contact-add-btn').before($chip);
            }
            // Update checkbox state
            var updatedIds = [];
            $picker.find('.sidebar-contact-chip').each(function () {
                updatedIds.push($(this).attr('data-contact-id'));
            });
            renderWsContactList($('#ws-contact-filter').val(), updatedIds);
        });
    });

    // ========== Sidebar: Predecessor Picker Events ==========
    // Remove predecessor chip from sidebar picker
    $(document).on('click', '.sidebar-pred-chip .sp-remove', function (e) {
        e.stopPropagation();
        $(this).closest('.sidebar-pred-chip').remove();
    });

    // Open predecessor dropdown from sidebar add button
    $(document).on('click', '.sidebar-pred-add-btn', function (e) {
        e.stopPropagation();
        var colIdx = parseInt($(this).attr('data-sidebar-pred-col'));
        var $picker = $(this).closest('.sidebar-pred-picker');

        // Collect currently selected labels from chips
        var currentLabels = [];
        $picker.find('.sidebar-pred-chip').each(function () {
            currentLabels.push($(this).attr('data-pred-label'));
        });

        var $dd = $('#ws-pred-dropdown');
        var rect = this.getBoundingClientRect();
        var top = rect.bottom + 2;
        var left = rect.left;
        if (top + 340 > window.innerHeight) {
            top = rect.top - 340;
            if (top < 0) top = 4;
        }
        if (left + 320 > window.innerWidth) {
            left = window.innerWidth - 324;
        }

        // Store reference for sidebar mode
        wsPredDropdownRow = 'sidebar';
        wsPredDropdownCol = colIdx;

        renderWsPredList('', currentLabels);
        $dd.css({ top: top, left: left }).show();
        $('#ws-pred-filter').val('').focus();

        // Override click handler for sidebar mode
        $dd.off('click.sidebar').on('click.sidebar', '.ws-pred-item', function (ev) {
            ev.stopPropagation();
            var lbl = $(this).attr('data-pred-label');
            var alreadyExists = false;
            $picker.find('.sidebar-pred-chip').each(function () {
                if ($(this).attr('data-pred-label') === lbl) alreadyExists = true;
            });
            if (alreadyExists) {
                $picker.find('.sidebar-pred-chip[data-pred-label="' + lbl.replace(/"/g, '\\"') + '"]').remove();
            } else {
                var $chip = $('<span class="sidebar-pred-chip">').attr('data-pred-label', lbl);
                $chip.append($('<span>').text(lbl));
                $chip.append($('<span class="sp-remove">').html('&times;'));
                $picker.find('.sidebar-pred-add-btn').before($chip);
            }
            // Update checkbox state
            var updatedLabels = [];
            $picker.find('.sidebar-pred-chip').each(function () {
                updatedLabels.push($(this).attr('data-pred-label'));
            });
            renderWsPredList($('#ws-pred-filter').val(), updatedLabels);
        });
    });

    // ========== Sidebar: Attachments ==========
    function renderSidebarAttachments(rowIndex) {
        var attachments = rowAttachments[rowIndex] || [];
        var $list = $('#attachment-list');
        $list.empty();

        if (attachments.length === 0) {
            $('.attachments-placeholder').show();
        } else {
            $('.attachments-placeholder').hide();
            $.each(attachments, function (i, att) {
                var icon = getFileIcon(att.type);
                var sizeStr = formatFileSize(att.size);
                var isUploaded = !!att.storedName;
                var $item = $('<div class="attachment-item">').attr('data-att-index', i);
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

    function getFileIcon(mimeType) {
        if (!mimeType) return 'fa-file';
        if (mimeType.indexOf('image') !== -1) return 'fa-file-image';
        if (mimeType.indexOf('pdf') !== -1) return 'fa-file-pdf';
        if (mimeType.indexOf('word') !== -1 || mimeType.indexOf('document') !== -1) return 'fa-file-word';
        if (mimeType.indexOf('sheet') !== -1 || mimeType.indexOf('excel') !== -1) return 'fa-file-excel';
        if (mimeType.indexOf('text') !== -1 || mimeType.indexOf('csv') !== -1) return 'fa-file-lines';
        return 'fa-file';
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function uploadSidebarFile(file, rowIndex) {
        if (!rowAttachments[rowIndex]) rowAttachments[rowIndex] = [];

        var attIndex = rowAttachments[rowIndex].length;
        rowAttachments[rowIndex].push({
            name: file.name,
            size: file.size,
            type: file.type,
            storedName: '',
            uploading: true
        });

        // Hide placeholder, show progress row
        $('.attachments-placeholder').hide();
        var icon = getFileIcon(file.type);
        var $item = $('<div class="attachment-item uploading">').attr('data-att-index', attIndex);
        $item.append('<i class="fa ' + icon + '"></i>');
        $item.append($('<span class="att-name">').text(file.name));
        $item.append($('<span class="att-size">').text(formatFileSize(file.size)));
        var $progress = $('<div class="att-progress"><div class="att-progress-bar"></div></div>');
        $item.append($progress);
        $('#attachment-list').append($item);

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
                        rowAttachments[rowIndex][attIndex].storedName = resp.storedName;
                        rowAttachments[rowIndex][attIndex].uploading = false;
                        scheduleSave();
                        if (sidebarOpenRow === rowIndex) {
                            renderSidebarAttachments(rowIndex);
                        }
                        return;
                    }
                } catch (e) { /* fall through */ }
            }
            rowAttachments[rowIndex].splice(attIndex, 1);
            if (sidebarOpenRow === rowIndex) {
                renderSidebarAttachments(rowIndex);
            }
            showToast('Upload failed for "' + file.name + '"');
        };

        xhr.onerror = function () {
            rowAttachments[rowIndex].splice(attIndex, 1);
            if (sidebarOpenRow === rowIndex) {
                renderSidebarAttachments(rowIndex);
            }
            showToast('Upload failed for "' + file.name + '"');
        };

        xhr.send(formData);
    }

    function processSidebarFiles(files) {
        if (sidebarOpenRow === null) return;
        if (!files || files.length === 0) return;
        var parentRow = getParentTaskRow(sidebarOpenRow);
        var allowed = /^(image\/|application\/pdf|application\/msword|application\/vnd\.openxmlformats|application\/vnd\.ms-excel|text\/)/;
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (!allowed.test(file.type) && !file.name.match(/\.(csv|txt|doc|docx|xls|xlsx|pdf)$/i)) {
                showToast('File "' + file.name + '" is not an allowed type.');
                continue;
            }
            uploadSidebarFile(file, parentRow);
        }
    }

    // File input handler
    $('#sidebar-file-input').on('change', function () {
        processSidebarFiles(this.files);
        $(this).val('');
    });

    // Remove attachment (also deletes from server, always targets parent row)
    $(document).on('click', '.att-remove', function () {
        if (sidebarOpenRow === null) return;
        var parentRow = getParentTaskRow(sidebarOpenRow);
        var $item = $(this).closest('.attachment-item');
        var idx = parseInt($item.attr('data-att-index'));
        if (!rowAttachments[parentRow] || idx >= rowAttachments[parentRow].length) return;

        var att = rowAttachments[parentRow][idx];
        if (att.storedName) {
            $.ajax({
                url: '/api/delete-file',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ project: PROJ_NAME, storedName: att.storedName })
            });
        }
        rowAttachments[parentRow].splice(idx, 1);
        renderSidebarAttachments(parentRow);
        scheduleSave();
    });

    // Drag and drop on attachments area
    $('#sidebar-attachments').on('dragover', function (e) {
        e.preventDefault();
        $(this).css('border-color', '#2a5db0');
    }).on('dragleave', function () {
        $(this).css('border-color', '');
    }).on('drop', function (e) {
        e.preventDefault();
        $(this).css('border-color', '');
        processSidebarFiles(e.originalEvent.dataTransfer.files);
    });

    // ========== Sidebar: Comments ==========
    function renderSidebarComments(rowIndex) {
        var comments = rowComments[rowIndex] || [];
        var $list = $('#sidebar-comments-list');
        $list.empty();

        if (comments.length === 0) {
            $list.append('<div style="color:#aaa; font-size:12px; padding:8px 0;">No comments yet.</div>');
        } else {
            $.each(comments, function (i, c) {
                var $entry = $('<div class="comment-entry">')
                    .append($('<div class="comment-time">').text(c.time))
                    .append($('<div class="comment-text">').text(c.text));
                $list.append($entry);
            });
        }

        // Scroll to bottom
        $list.scrollTop($list[0].scrollHeight);
    }

    $('#sidebar-add-comment').on('click', function () {
        addComment();
    });

    $('#sidebar-comment-input').on('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            addComment();
        }
    });

    function addComment() {
        if (sidebarOpenRow === null) return;
        var text = $('#sidebar-comment-input').val().trim();
        if (!text) return;

        var parentRow = getParentTaskRow(sidebarOpenRow);
        if (!rowComments[parentRow]) {
            rowComments[parentRow] = [];
        }

        var now = new Date();
        var timeStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        var comment = { text: CURRENT_USER_ID + ': ' + text, time: timeStr };
        rowComments[parentRow].push(comment);
        $('#sidebar-comment-input').val('');
        renderSidebarComments(parentRow);
        scheduleSave();

        // Save comment to server (bypasses protected view since comments are always allowed for super users)
        if (PROJ_NAME && socket && socketConnected) {
            socket.emit('send_patch', {
                op: 'updateComment',
                project: PROJ_NAME,
                user: CURRENT_USER_ID,
                clientId: CLIENT_ID,
                rowKey: parentRow,
                comment: comment
            });
        }
    }

    // ========== Close dialogs on Escape ==========
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape') {
            // Don't close the project picker via Escape if no project is loaded
            if (PROJ_NAME === '' && $('#project-picker').is(':visible')) return;
            $('.dialog-overlay').hide();
            $('#column-context-menu').hide();
            $('#row-context-menu').hide();
            $('#spreadsheet tbody tr').removeClass('row-selected');
            if (sidebarOpenRow !== null) closeSidebar();
        }
    });

    // ========== Export to Excel ==========
    $('#btn-export-excel').on('click', function () {
        if (!PROJ_NAME) {
            showToast('No project open to export.');
            return;
        }
        exportToExcel();
    });

    function exportToExcel() {
        if (typeof ExcelJS === 'undefined') {
            showToast('Excel library not loaded. Check your connection.');
            return;
        }

        // Determine which columns are visible
        var visibleCols = [];
        for (var c = 0; c < columns.length; c++) {
            if (!columns[c].hidden) {
                visibleCols.push(c);
            }
        }
        if (visibleCols.length === 0) {
            showToast('No visible columns to export.');
            return;
        }

        // Find last row with data
        var lastDataRow = 0;
        for (var r = 0; r < totalRows; r++) {
            for (var ci = 0; ci < visibleCols.length; ci++) {
                var key = r + '-' + visibleCols[ci];
                if (cellData[key] && cellData[key].text && cellData[key].text.trim()) {
                    lastDataRow = r;
                    break;
                }
            }
        }

        var wb = new ExcelJS.Workbook();
        var sheetName = (PROJ_NAME || 'Sheet1').substring(0, 31);
        var ws = wb.addWorksheet(sheetName);

        // Indent prefix for hierarchy (3 spaces per level)
        var INDENT_STR = '   ';

        // Set up columns with widths
        var excelCols = [];
        for (var ci = 0; ci < visibleCols.length; ci++) {
            var colName = columns[visibleCols[ci]].name || 'Column' + (ci + 1);
            excelCols.push({ header: colName, key: 'col' + ci, width: Math.max(colName.length + 2, 14) });
        }
        ws.columns = excelCols;

        // Style header row
        var headerExcelRow = ws.getRow(1);
        headerExcelRow.eachCell(function (cell) {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });
        headerExcelRow.height = 22;

        // Data rows
        for (var r = 0; r <= lastDataRow; r++) {
            var rowValues = {};
            var indent = getRowIndent(r);
            for (var ci = 0; ci < visibleCols.length; ci++) {
                var colIdx = visibleCols[ci];
                var col = columns[colIdx];
                var colType = col.type || 'text';
                var key = r + '-' + colIdx;
                var data = cellData[key] || {};
                var val = data.text || '';
                var cellVal = '';

                if (colType === 'contacts' && val) {
                    // Export contact IDs
                    var ids = val.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
                    cellVal = ids.join(', ');
                } else if (colType === 'checkbox') {
                    cellVal = val === 'true' || val === '1' ? 'Yes' : (val ? 'No' : '');
                } else if (colType === 'symbols') {
                    cellVal = val;
                } else if (colType === 'percent') {
                    cellVal = (val !== '' && val !== undefined) ? parseFloat(val) : '';
                } else if (colType === 'cost') {
                    cellVal = (val !== '' && val !== undefined) ? parseFloat(val) : '';
                } else if (colType === 'duration') {
                    var durationText = '';
                    if (col.durationStartCol !== undefined && col.durationEndCol !== undefined &&
                        col.durationStartCol !== '' && col.durationEndCol !== '') {
                        var startColIdx = -1, endColIdx = -1;
                        for (var si = 0; si < columns.length; si++) {
                            if (columns[si].id === col.durationStartCol) startColIdx = si;
                            if (columns[si].id === col.durationEndCol) endColIdx = si;
                        }
                        if (startColIdx >= 0 && endColIdx >= 0) {
                            var startDateStr = (cellData[r + '-' + startColIdx] && cellData[r + '-' + startColIdx].text) || '';
                            var endDateStr = (cellData[r + '-' + endColIdx] && cellData[r + '-' + endColIdx].text) || '';
                            if (startDateStr && endDateStr) {
                                var sd = new Date(startDateStr);
                                var ed = new Date(endDateStr);
                                if (!isNaN(sd.getTime()) && !isNaN(ed.getTime())) {
                                    durationText = (Math.round((ed - sd) / (1000 * 60 * 60 * 24)) + 1) + 'd';
                                }
                            }
                        }
                    }
                    cellVal = durationText;
                } else if (colType === 'date') {
                    cellVal = val ? formatDateDisplay(val) : '';
                } else if (colType === 'predecessor') {
                    cellVal = val;
                } else {
                    // For the first column (Task Name), prepend indent spaces
                    if (colIdx === 0 && indent > 0 && val) {
                        var prefix = '';
                        for (var ind = 0; ind < indent; ind++) prefix += INDENT_STR;
                        cellVal = prefix + val;
                    } else {
                        cellVal = val;
                    }
                }

                rowValues['col' + ci] = cellVal;

                // Track column width
                var cellLen = String(cellVal || '').length + 2;
                if (cellLen > ws.getColumn(ci + 1).width) {
                    ws.getColumn(ci + 1).width = Math.min(cellLen, 50);
                }
            }

            var excelRow = ws.addRow(rowValues);

            // Apply styling based on indent
            if (indent === 0) {
                // Parent task: light grey background on entire row, bold dark blue on Task Name cell only
                excelRow.eachCell({ includeEmpty: true }, function (cell) {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
                });
                excelRow.getCell(1).font = { bold: true, color: { argb: 'FF1F3864' }, size: 11 };
            } else if (indent >= 2) {
                // Sub-subtask (indent 2+): italic on Task Name cell only
                excelRow.getCell(1).font = { italic: true, size: 11 };
            }
        }

        // Apply column-level alignment for specific types
        for (var ci = 0; ci < visibleCols.length; ci++) {
            var colType = columns[visibleCols[ci]].type || 'text';
            if (colType === 'duration') {
                ws.getColumn(ci + 1).eachCell(function (cell, rowNum) {
                    if (rowNum > 1) cell.alignment = { horizontal: 'right' };
                });
            } else if (colType === 'dropdown' && columns[visibleCols[ci]].name === 'Status') {
                ws.getColumn(ci + 1).eachCell(function (cell, rowNum) {
                    if (rowNum > 1) cell.alignment = { horizontal: 'center' };
                });
            }
        }

        // Generate and download
        var fileName = PROJ_NAME + '.xlsx';
        wb.xlsx.writeBuffer().then(function (buffer) {
            var blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            saveAs(blob, fileName);
            showToast('Exported to ' + fileName);
        }).catch(function (err) {
            console.error('Export failed:', err);
            showToast('Export failed. See console for details.');
        });
    }

    // ========== Project Picker Events ==========
    $('#picker-new-group-btn').on('click', function () {
        window.open('http://localhost:5000/design.html', '_blank');
    });


    // ========== Start ==========
    init();

});
