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
    var rowAttachments = {};  // rowIndex => [{name, size, type, dataUrl}]
    var rowComments = {};     // rowIndex => [{text, time}]
    var sidebarOpenRow = null;
    var collapsedRows = {};   // rowIndex => true if this parent row is collapsed
    var dragSourceColIndex = null; // column index being dragged for reorder

    // ========== Persistence Configuration ==========
    var CURRENT_USER_ID = 'ab1234';
    var PROJ_NAME = '';
    var currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    var saveTimer = null;
    var SAVE_DEBOUNCE_MS = 1000;
    var isSavingToServer = false;
    var pendingSave = false;

    function getSaveKey() {
        return CURRENT_USER_ID + '_' + PROJ_NAME + '_' + currentDate;
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

    // ========== Initialization ==========
    function init() {
        loadWsContacts();
        showProjectPicker();
    }

    function showProjectPicker() {
        var $picker = $('#project-picker');
        var $tbody = $('#picker-table-body');
        var $empty = $('#picker-empty');
        var $tableWrap = $('#picker-table-wrap');
        var $groupBody = $('#group-table-body');
        var $groupWrap = $('#group-table-wrap');
        var $groupEmpty = $('#group-empty');
        $tbody.empty();
        $groupBody.empty();
        $empty.hide();
        $groupEmpty.hide();
        $tableWrap.show();
        $groupWrap.show();
        $('#picker-new-row').hide();
        $('#picker-new-btn').show();
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
                        var $nameLink = $('<span class="picker-project-link">').text(proj.name);
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

        // Load personal projects
        $.ajax({
            url: '/api/projects',
            method: 'GET',
            data: { user: CURRENT_USER_ID },
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok && resp.projects && resp.projects.length > 0) {
                    $.each(resp.projects, function (i, proj) {
                        var $tr = $('<tr>');
                        var $nameLink = $('<span class="picker-project-link">').text(proj.name);
                        $nameLink.on('click', function () {
                            selectProject(proj.name);
                        });
                        $tr.append($('<td>').append($nameLink));
                        $tr.append($('<td>').text(proj.lastSaved));
                        $tr.append($('<td>').text(proj.entries));
                        $tbody.append($tr);
                    });
                } else {
                    $tableWrap.hide();
                    $empty.show();
                }
            },
            error: function () {
                $tableWrap.hide();
                $empty.text('Could not load projects. Check server connection.').show();
            }
        });
    }

    function selectProject(name) {
        PROJ_NAME = name;
        currentDate = new Date().toISOString().slice(0, 10);
        $('#project-picker').hide();
        $('#worksheet-subtitle').text(name);
        loadProject();
    }

    function selectGroupProject(name) {
        PROJ_NAME = name;
        currentDate = new Date().toISOString().slice(0, 10);
        $('#project-picker').hide();
        $('#worksheet-subtitle').text(name);

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
                    updateSaveStatus('saved');
                } else {
                    columns = [];
                    for (var i = 0; i < DEFAULT_COLS; i++) {
                        columns.push(createColumn(i === 0 ? 'Task Name' : 'Column' + (i + 1)));
                    }
                    renderAll();
                    initColorPickers();
                    updateSaveStatus('saved');
                }
                undoStack = [];
                redoStack = [];
                updateUndoRedoButtons();
            },
            error: function () {
                updateSaveStatus('offline');
            }
        });
    }

    function loadProject() {
        loadFromServer(function (serverData) {
            if (serverData) {
                loadState(serverData);
                try {
                    localStorage.setItem(getSaveKey(), JSON.stringify(serverData));
                } catch (e) { /* ignore */ }
                initColorPickers();
                updateSaveStatus('saved');
            } else {
                var localData = loadFromLocalStorage();
                if (localData) {
                    loadState(localData);
                    initColorPickers();
                    updateSaveStatus('offline');
                } else {
                    for (var i = 0; i < DEFAULT_COLS; i++) {
                        columns.push(createColumn(i === 0 ? 'Task Name' : 'Column' + (i + 1)));
                    }
                    renderAll();
                    initColorPickers();
                    updateSaveStatus('saved');
                }
            }
            // Capture initial state so undo can return to it
            undoStack = [];
            redoStack = [];
            updateUndoRedoButtons();
        });
    }

    function createNewProject(name) {
        PROJ_NAME = name;
        currentDate = new Date().toISOString().slice(0, 10);
        $('#project-picker').hide();
        $('#worksheet-subtitle').text(name);

        // Reset state for a blank worksheet
        columns = [];
        cellData = {};
        totalRows = DEFAULT_ROWS;
        frozenUpTo = -1;
        collapsedRows = {};
        rowAttachments = {};
        rowComments = {};
        colIdCounter = 0;
        selectedCell = null;
        selectedRows = [];
        lastClickedRow = null;
        rowClipboard = null;
        sidebarOpenRow = null;

        for (var i = 0; i < DEFAULT_COLS; i++) {
            columns.push(createColumn(i === 0 ? 'Task Name' : 'Column' + (i + 1)));
        }
        renderAll();
        initColorPickers();
        // Reset undo/redo stacks for new project
        undoStack = [];
        redoStack = [];
        updateUndoRedoButtons();
        updateSaveStatus('saving');
        saveToServer(function () {
            updateSaveStatus('saved');
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

        return {
            columns: colsCopy,
            cellData: $.extend(true, {}, cellData),
            totalRows: totalRows,
            frozenUpTo: frozenUpTo,
            collapsedRows: $.extend({}, collapsedRows),
            rowAttachments: $.extend(true, {}, rowAttachments),
            rowComments: $.extend(true, {}, rowComments),
            colIdCounter: colIdCounter,
            createdBy: CURRENT_USER_ID
        };
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
        colIdCounter = data.colIdCounter || 0;

        selectedCell = null;
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
        if (isSavingToServer) {
            pendingSave = true;
            return;
        }
        isSavingToServer = true;
        var state = collectState();

        $.ajax({
            url: '/api/save',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                userId: CURRENT_USER_ID,
                projectName: PROJ_NAME,
                date: currentDate,
                data: state
            }),
            timeout: 10000,
            success: function (resp) {
                isSavingToServer = false;
                if (resp && resp.ok) {
                    updateSaveStatus('saved');
                } else {
                    updateSaveStatus('offline');
                }
                if (pendingSave) {
                    pendingSave = false;
                    saveToServer();
                }
                if (callback) callback(true);
            },
            error: function () {
                isSavingToServer = false;
                updateSaveStatus('offline');
                if (pendingSave) {
                    pendingSave = false;
                    saveToServer();
                }
                if (callback) callback(false);
            }
        });
    }

    function loadFromServer(callback) {
        $.ajax({
            url: '/api/load',
            method: 'GET',
            data: { user: CURRENT_USER_ID, project: PROJ_NAME },
            dataType: 'json',
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok && resp.data) {
                    callback(resp.data);
                } else {
                    callback(null);
                }
            },
            error: function () {
                callback(null);
            }
        });
    }

    function updateSaveStatus(state) {
        var $status = $('#save-status');
        var $icon = $('#save-status-icon');
        var $text = $('#save-status-text');
        $status.removeClass('saving saved offline error');
        switch (state) {
            case 'saving':
                $status.addClass('saving');
                $icon.attr('class', 'fa fa-spinner');
                $text.text('Saving...');
                break;
            case 'saved':
                $status.addClass('saved');
                $icon.attr('class', 'fa fa-check-circle');
                $text.text('All changes saved');
                break;
            case 'offline':
                $status.addClass('offline');
                $icon.attr('class', 'fa fa-exclamation-triangle');
                $text.text('Saved locally (offline)');
                break;
            case 'error':
                $status.addClass('error');
                $icon.attr('class', 'fa fa-times-circle');
                $text.text('Save failed');
                break;
        }
    }

    function scheduleSave() {
        pushUndo();
        updateSaveStatus('saving');
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        saveTimer = setTimeout(function () {
            saveTimer = null;
            saveToLocalStorage();
            saveToServer();
        }, SAVE_DEBOUNCE_MS);
    }

    function saveNow() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        updateSaveStatus('saving');
        saveToLocalStorage();
        saveToServer();
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

    // Ctrl+S: immediate save; Ctrl+Z: undo; Ctrl+Y / Ctrl+Shift+Z: redo
    $(document).on('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveNow();
        }
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
                                var startDate = new Date(startDateStr);
                                var endDate = new Date(endDateStr);
                                if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
                                    var diffDays = Math.round((endDate - startDate) / (1000 * 60 * 60 * 24));
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
                    $td.css('position', 'relative');
                    var displayDate = data.text ? formatDateDisplay(data.text) : '';
                    var $span = $('<span class="cell-content">').text(displayDate);
                    var $calIcon = $('<button class="date-cell-icon" data-date-row="' + r + '" data-date-col="' + c + '">')
                        .html('<i class="fa fa-calendar-days"></i>');
                    var $hiddenInput = $('<input type="date" class="date-cell-hidden-input" data-date-row="' + r + '" data-date-col="' + c + '">')
                        .val(data.text || '');
                    $td.append($span).append($calIcon).append($hiddenInput);
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
                } else {
                    var $span = $('<span class="cell-content">').text(data.text || '');
                    $td.append($span);
                }

                if (selectedCell && selectedCell.row === r && selectedCell.col === c) {
                    $td.addClass('selected');
                }

                $tr.append($td);
            }
            $body.append($tr);
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

    // Calendar icon click: open hidden date input
    $(document).on('click', '.date-cell-icon', function (e) {
        e.stopPropagation();
        var row = parseInt($(this).attr('data-date-row'));
        var col = parseInt($(this).attr('data-date-col'));
        var $hidden = $(this).siblings('.date-cell-hidden-input');
        // Make it visible momentarily for the picker to open
        $hidden.css({ opacity: 0, pointerEvents: 'auto', position: 'absolute', width: 'auto', height: 'auto' });
        $hidden[0].showPicker();
    });

    // When a date is picked from the hidden input
    $(document).on('change', '.date-cell-hidden-input', function () {
        var row = parseInt($(this).attr('data-date-row'));
        var col = parseInt($(this).attr('data-date-col'));
        var val = $(this).val();
        var key = row + '-' + col;
        if (!cellData[key]) cellData[key] = {};
        cellData[key].text = val;
        renderBody();
        selectCell(row, col);
        scheduleSave();
    });

    // Re-hide the date input on blur
    $(document).on('blur', '.date-cell-hidden-input', function () {
        $(this).css({ opacity: 0, pointerEvents: 'none', width: 0, height: 0 });
    });

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

        // Clear single-cell selection
        selectedCell = null;
        renderBody();
    });

    // ========== Cell Selection & Editing ==========
    $(document).on('click', 'td.cell', function (e) {
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
            scheduleSave();
            return;
        }

        // Contacts columns: single click opens the contact picker
        if (colType === 'contacts' && !columns[col].locked) {
            selectCell(row, col);
            openWsContactDropdown(row, col);
            return;
        }

        selectCell(row, col);
    });

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

        // Date: trigger the hidden date picker in the cell instead of inline editing
        if (colType === 'date') {
            $td.removeClass('editing');
            var $hidden = $td.find('.date-cell-hidden-input');
            if ($hidden.length) {
                $hidden.css({ opacity: 0, pointerEvents: 'auto', position: 'absolute', width: 'auto', height: 'auto' });
                $hidden[0].showPicker();
            }
            return;
        }

        // Contacts: open floating contact picker, no inline editor
        if (colType === 'contacts') {
            $td.removeClass('editing');
            openWsContactDropdown(row, col);
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
            scheduleSave();
            return;
        }
        if (colObj && colObj.type === 'cost') {
            var costDisplay = (value !== undefined && value !== '') ? '$' + value : '';
            $td.css('text-align', 'right');
            $td.append($('<span class="cell-content">').text(costDisplay));
            scheduleSave();
            return;
        }
        if (colObj && colObj.type === 'contacts') {
            renderContactsCell($td, value);
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

    function toggleFormat(prop) {
        if (!selectedCell) return;
        var data = getCellData(selectedCell.row, selectedCell.col);
        data[prop] = !data[prop];
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
    $('#btn-save').on('click', function () { saveNow(); });
    $('#btn-delete-project').on('click', function () {
        if (!PROJ_NAME) return;
        $('#delete-project-name').text(PROJ_NAME);
        $('#delete-project-dialog').show();
    });
    $('#delete-project-cancel').on('click', function () {
        $('#delete-project-dialog').hide();
    });
    $('#delete-project-confirm').on('click', function () {
        $('#delete-project-dialog').hide();
        $.ajax({
            url: '/api/delete',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ userId: CURRENT_USER_ID, projectName: PROJ_NAME }),
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok) {
                    showToast('Project "' + PROJ_NAME + '" deleted.');
                    // Clear all in-memory state
                    PROJ_NAME = '';
                    columns = [];
                    cellData = {};
                    totalRows = DEFAULT_ROWS;
                    frozenUpTo = -1;
                    collapsedRows = {};
                    rowAttachments = {};
                    rowComments = {};
                    colIdCounter = 0;
                    selectedCell = null;
                    selectedRows = [];
                    lastClickedRow = null;
                    rowClipboard = null;
                    sidebarOpenRow = null;
                    undoStack = [];
                    redoStack = [];
                    $('#worksheet-subtitle').text('');
                    $('#spreadsheet-body').empty();
                    $('#header-row').find('th.col-header').remove();
                    showProjectPicker();
                } else {
                    showToast('Failed to delete project.');
                }
            },
            error: function () {
                showToast('Failed to delete project. Check server connection.');
            }
        });
    });
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
            }
            renderBody();
            // Re-highlight the column after re-render
            $('td.cell[data-col="' + selectedColumn + '"]').addClass('col-highlight');
            updateToolbarState();
            scheduleSave();
            return;
        }

        if (!selectedCell) return;
        if (selectedCell.col === 0) return;
        var colType = columns[selectedCell.col] && columns[selectedCell.col].type || 'text';
        if (colType === 'checkbox' || colType === 'symbols') return;

        var data = getCellData(selectedCell.row, selectedCell.col);
        data.align = align;
        renderBody();
        updateToolbarState();
        scheduleSave();
    }

    $('#btn-align-left').on('click', function () { setAlignment('left'); });
    $('#btn-align-center').on('click', function () { setAlignment('center'); });
    $('#btn-align-right').on('click', function () { setAlignment('right'); });

    $('#btn-wrap-text').on('click', function () {
        if (!selectedCell) return;
        if (selectedCell.col === 0) return;
        var colType = columns[selectedCell.col] && columns[selectedCell.col].type || 'text';
        if (colType !== 'text') return;

        var data = getCellData(selectedCell.row, selectedCell.col);
        data.wrapText = !data.wrapText;
        renderBody();
        updateToolbarState();
        scheduleSave();
    });

    // ========== Toolbar: Indent / Outdent ==========
    // Works on selected rows (column 0 only), or falls back to single selected cell
    $('#btn-indent').on('click', function () {
        var rows = getIndentTargetRows();
        if (rows.length === 0) return;
        $.each(rows, function (i, r) {
            var data = getCellData(r, 0);
            if (!data.indent) data.indent = 0;
            if (data.indent < 5) data.indent++;
        });
        renderBody();
        scheduleSave();
    });

    $('#btn-outdent').on('click', function () {
        var rows = getIndentTargetRows();
        if (rows.length === 0) return;
        $.each(rows, function (i, r) {
            var data = getCellData(r, 0);
            if (!data.indent) data.indent = 0;
            if (data.indent > 0) data.indent--;
        });
        renderBody();
        scheduleSave();
    });

    function getIndentTargetRows() {
        if (selectedRows.length > 0) {
            return selectedRows;
        } else if (selectedCell) {
            return [selectedCell.row];
        }
        return [];
    }

    // ========== Toolbar: Color Pickers ==========
    function initColorPickers() {
        $('#bg-color-picker').spectrum({
            color: '#ffffff',
            showPalette: true,
            showSelectionPalette: true,
            preferredFormat: 'hex',
            palette: [
                ['#ffffff', '#f2f2f2', '#d9d9d9', '#bfbfbf', '#a6a6a6', '#808080'],
                ['#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#0000ff'],
                ['#9900ff', '#ff00ff', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3'],
                ['#cfe2f3', '#d9d2e9', '#ead1dc', '#ea9999', '#f9cb9c', '#ffe599'],
                ['#b6d7a8', '#a2c4c9', '#9fc5e8', '#b4a7d6', '#d5a6bd', '#e06666']
            ],
            change: function (color) {
                if (!selectedCell) return;
                var data = getCellData(selectedCell.row, selectedCell.col);
                data.bgColor = color.toHexString();
                $('#bg-color-indicator').css('background-color', data.bgColor);
                renderBody();
                scheduleSave();
            }
        });

        $('#font-color-picker').spectrum({
            color: '#000000',
            showPalette: true,
            showSelectionPalette: true,
            preferredFormat: 'hex',
            palette: [
                ['#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff'],
                ['#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#0000ff'],
                ['#9900ff', '#ff00ff', '#cc0000', '#e69138', '#f1c232', '#6aa84f'],
                ['#45818e', '#3c78d8', '#674ea7', '#a64d79', '#85200c', '#783f04']
            ],
            change: function (color) {
                if (!selectedCell) return;
                var data = getCellData(selectedCell.row, selectedCell.col);
                data.fontColor = color.toHexString();
                $('#font-color-indicator').css('background-color', data.fontColor);
                renderBody();
                scheduleSave();
            }
        });
    }

    $('#btn-bg-color').on('click', function (e) {
        e.stopPropagation();
        $('#bg-color-picker').spectrum('toggle');
    });

    $('#btn-font-color').on('click', function (e) {
        e.stopPropagation();
        $('#font-color-picker').spectrum('toggle');
    });

    // ========== Column Header: Three-Dot Menu ==========
    // Click on column header to select entire column
    $(document).on('click', 'th.col-header', function (e) {
        if ($(e.target).closest('.col-menu-btn').length) return;
        if ($(e.target).closest('.col-resize-handle').length) return;
        var colIndex = parseInt($(this).attr('data-col-index'));
        selectedColumn = colIndex;
        selectedCell = null;
        selectedRows = [];
        $('th.col-header').removeClass('selected');
        $(this).addClass('selected');
        $('.cell.selected').removeClass('selected');
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
                insertColumn(colIndex);
                break;
            case 'insert-right':
                insertColumn(colIndex + 1);
                break;
            case 'delete-column':
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
                insertRow(rowIndex);
                break;
            case 'insert-below':
                insertRow(rowIndex + 1);
                break;
            case 'cut':
                cutRow(rowIndex);
                break;
            case 'copy':
                copyRow(rowIndex);
                break;
            case 'paste':
                pasteRow(rowIndex);
                break;
            case 'delete':
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
        // Collect row data
        var rows = [];
        for (var r = 0; r < totalRows; r++) {
            var key = r + '-' + colIndex;
            var text = (cellData[key] && cellData[key].text) || '';
            rows.push({ origRow: r, sortVal: text });
        }

        rows.sort(function (a, b) {
            var va = a.sortVal.toLowerCase();
            var vb = b.sortVal.toLowerCase();
            // Try numeric comparison
            var na = parseFloat(va);
            var nb = parseFloat(vb);
            if (!isNaN(na) && !isNaN(nb)) {
                return order === 'asc' ? na - nb : nb - na;
            }
            if (va < vb) return order === 'asc' ? -1 : 1;
            if (va > vb) return order === 'asc' ? 1 : -1;
            return 0;
        });

        // Remap cell data
        var newCellData = {};
        $.each(rows, function (newRow, info) {
            for (var c = 0; c < columns.length; c++) {
                var oldKey = info.origRow + '-' + c;
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
        var firstCellText = (cellData[rowIndex + '-0'] && cellData[rowIndex + '-0'].text) || 'Row ' + (rowIndex + 1);
        $('#sidebar-title').text(firstCellText || 'Row ' + (rowIndex + 1));

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
                                durText = Math.round((eDate - sDate) / (1000 * 60 * 60 * 24)) + 'd';
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

        // Render attachments
        renderSidebarAttachments(rowIndex);

        // Render comments
        renderSidebarComments(rowIndex);

        // Open the panel
        $('#row-sidebar').addClass('open');
        $('body').addClass('sidebar-open');
    }

    function closeSidebar() {
        closeWsContactDropdown();
        $('#row-sidebar').removeClass('open');
        $('body').removeClass('sidebar-open');
        sidebarOpenRow = null;
    }

    $('#sidebar-close').on('click', function () {
        closeSidebar();
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
            } else {
                cellData[key].text = $(this).val();
            }
        });

        renderBody();

        // Update sidebar title
        var firstCellText = (cellData[rowIndex + '-0'] && cellData[rowIndex + '-0'].text) || 'Row ' + (rowIndex + 1);
        $('#sidebar-title').text(firstCellText || 'Row ' + (rowIndex + 1));

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
                var $item = $('<div class="attachment-item">')
                    .append('<i class="fa ' + icon + '"></i>')
                    .append($('<span class="att-name">').text(att.name))
                    .append($('<span class="att-size">').text(sizeStr))
                    .append($('<span class="att-remove" title="Remove"><i class="fa fa-xmark"></i></span>')
                        .attr('data-att-index', i));
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

    // File input handler
    $('#sidebar-file-input').on('change', function () {
        if (sidebarOpenRow === null) return;
        var files = this.files;
        if (!files || files.length === 0) return;

        if (!rowAttachments[sidebarOpenRow]) {
            rowAttachments[sidebarOpenRow] = [];
        }

        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            // Validate file type
            var allowed = /^(image\/|application\/pdf|application\/msword|application\/vnd\.openxmlformats|application\/vnd\.ms-excel|text\/)/;
            if (!allowed.test(file.type) && !file.name.match(/\.(csv|txt|doc|docx|xls|xlsx|pdf)$/i)) {
                showToast('File "' + file.name + '" is not an allowed type.');
                continue;
            }

            rowAttachments[sidebarOpenRow].push({
                name: file.name,
                size: file.size,
                type: file.type
            });
        }

        renderSidebarAttachments(sidebarOpenRow);
        scheduleSave();
        // Reset input so same file can be re-selected
        $(this).val('');
    });

    // Remove attachment
    $(document).on('click', '.att-remove', function () {
        if (sidebarOpenRow === null) return;
        var idx = parseInt($(this).attr('data-att-index'));
        if (rowAttachments[sidebarOpenRow]) {
            rowAttachments[sidebarOpenRow].splice(idx, 1);
            renderSidebarAttachments(sidebarOpenRow);
            scheduleSave();
        }
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
        if (sidebarOpenRow === null) return;
        var files = e.originalEvent.dataTransfer.files;
        if (!files || files.length === 0) return;

        if (!rowAttachments[sidebarOpenRow]) {
            rowAttachments[sidebarOpenRow] = [];
        }

        var allowed = /^(image\/|application\/pdf|application\/msword|application\/vnd\.openxmlformats|application\/vnd\.ms-excel|text\/)/;
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (!allowed.test(file.type) && !file.name.match(/\.(csv|txt|doc|docx|xls|xlsx|pdf)$/i)) {
                showToast('File "' + file.name + '" is not an allowed type.');
                continue;
            }
            rowAttachments[sidebarOpenRow].push({
                name: file.name,
                size: file.size,
                type: file.type
            });
        }
        renderSidebarAttachments(sidebarOpenRow);
        scheduleSave();
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

        if (!rowComments[sidebarOpenRow]) {
            rowComments[sidebarOpenRow] = [];
        }

        var now = new Date();
        var timeStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        rowComments[sidebarOpenRow].push({ text: text, time: timeStr });
        $('#sidebar-comment-input').val('');
        renderSidebarComments(sidebarOpenRow);
        scheduleSave();
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

    // ========== Project Picker Events ==========
    $('#picker-new-group-btn').on('click', function () {
        window.open('http://localhost:5000/task.html', '_blank');
    });

    $('#picker-new-btn').on('click', function () {
        $('#picker-new-btn').hide();
        $('#picker-new-row').show();
        $('#picker-new-name').val('').focus();
    });

    $('#picker-create-btn').on('click', function () {
        var name = $('#picker-new-name').val().trim();
        if (!name) return;
        createNewProject(name);
    });

    $('#picker-new-name').on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $('#picker-create-btn').click();
        }
    });

    // ========== Start ==========
    init();

});
