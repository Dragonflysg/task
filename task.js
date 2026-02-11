$(document).ready(function () {

    // ========== State ==========
    var CURRENT_USER_ID = 'gs6368';
    var STORAGE_KEY = 'task_manager_data';
    var CONTACTS_STORAGE_KEY = 'task_manager_contacts';
    var PROJ_NAME = '';
    var tasks = [];
    var taskIdCounter = 0;
    var selectedTaskId = null;
    var contacts = [];
    var isDirty = false;

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
        markDirty();
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
        return ++taskIdCounter;
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
            predecessor: '',   // task ID of predecessor
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

    function clearPredecessorRefs(deletedId, list) {
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].predecessor) === String(deletedId)) {
                list[i].predecessor = '';
            }
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

    function statusClass(status) {
        return 'status-' + status.toLowerCase().replace(/\s+/g, '-');
    }

    function showToast(msg) {
        var $toast = $('<div class="toast">').text(msg).appendTo('body');
        setTimeout(function () {
            $toast.fadeOut(400, function () { $toast.remove(); });
        }, 2500);
    }

    function markDirty() {
        isDirty = true;
        $('#btn-save-all').prop('disabled', false);
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
        $picker.append($('<button type="button" class="cp-dropdown-btn">').html('<i class="fa fa-caret-down"></i>'));

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
        if (activePickerTarget.type === 'header') {
            var task = findTaskById(selectedTaskId, tasks);
            if (task) task.assignedTo = arr;
        } else {
            var sub = findTaskById(activePickerTarget.id, tasks);
            if (sub) sub.assignedTo = arr;
        }
        saveData();
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

    function renderTaskList() {
        var $list = $('#task-list');
        $list.empty();

        var filterMine = $('#filter-my-tasks').is(':checked');

        if (tasks.length === 0) {
            $list.append('<div style="padding:20px 16px;color:#999;font-size:13px;text-align:center;">No tasks yet.<br>Click "New Task" to get started.</div>');
            return;
        }

        var visibleCount = 0;
        $.each(tasks, function (i, task) {
            if (filterMine && !isUserAssignedInTree(task)) return;
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

        if (filterMine && visibleCount === 0) {
            $list.append('<div style="padding:20px 16px;color:#999;font-size:13px;text-align:center;">No tasks assigned to you.</div>');
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

    // Calculate duration in days between two ISO date strings
    function calcDuration(startIso, endIso) {
        if (!startIso || !endIso) return '';
        var s = new Date(startIso + 'T00:00:00');
        var e = new Date(endIso + 'T00:00:00');
        if (isNaN(s.getTime()) || isNaN(e.getTime())) return '';
        var diff = Math.round((e - s) / (1000 * 60 * 60 * 24));
        return diff + 'd';
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

        // Fill header fields
        $('#detail-task-name').val(task.name);
        $('#detail-start-date').val(toDisplayDate(task.startDate));
        $('#detail-end-date').val(toDisplayDate(task.endDate));
        $('#detail-duration').val(calcDuration(task.startDate, task.endDate));
        $('#detail-status').val(task.status);
        $('#detail-percent').val(task.percentComplete);
        $('#detail-cost').val(task.cost);
        $('#btn-flag-task').toggleClass('flagged', task.flagged);

        // Build header assigned picker chips
        var $headerPicker = $('#detail-assigned-picker');
        buildPickerChips($headerPicker, task.assignedTo);

        if (task.name && task.name.trim() !== '') {
            $('#btn-add-subtask').show();
        } else {
            $('#btn-add-subtask').hide();
        }

        renderSubtaskTable(task);
    }

    // ========== Render Subtask Table ==========
    function renderSubtaskTable(parentTask) {
        var $body = $('#subtask-body');
        $body.empty();

        var allRows = [];
        flattenSubtasks(parentTask.subtasks, 0, allRows, parentTask.id);

        // Build global list of all subtasks across all tasks for predecessor dropdown
        var allGlobalRows = [];
        $.each(tasks, function (ti, t) {
            flattenSubtasks(t.subtasks, 0, allGlobalRows, t.id);
        });

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

            if (depth > 0) {
                var connectorClass = 'tree-connector';
                if (!isLast) connectorClass += ' has-more';
                $treeCell.append($('<span>').addClass(connectorClass));
            }

            var $nameWrap = $('<span class="tree-cell-name">');
            var $nameInput = $('<input type="text">')
                .attr('placeholder', depth === 0 ? 'Subtask name...' : 'Sub-subtask name...')
                .val(st.name)
                .attr('data-field', 'name')
                .attr('data-id', st.id);
            $nameWrap.append($nameInput);
            $treeCell.append($nameWrap);
            $nameCell.append($treeCell);
            $tr.append($nameCell);

            // Start Date
            var $startWrap = $('<div class="subtask-date-wrap">');
            var $startInput = $('<input type="text" placeholder="mm/dd/yyyy">').val(toDisplayDate(st.startDate)).attr('data-field', 'startDate').attr('data-id', st.id);
            setupDateAutoFormat($startInput);
            var $startHidden = $('<input type="date" class="date-hidden-picker">').val(st.startDate);
            var $startBtn = $('<button type="button" class="date-picker-btn">').html('<i class="fa fa-calendar-days"></i>');
            $startWrap.append($startInput).append($startHidden).append($startBtn);
            $tr.append($('<td>').append($startWrap));

            // End Date
            var $endWrap = $('<div class="subtask-date-wrap">');
            var $endInput = $('<input type="text" placeholder="mm/dd/yyyy">').val(toDisplayDate(st.endDate)).attr('data-field', 'endDate').attr('data-id', st.id);
            setupDateAutoFormat($endInput);
            var $endHidden = $('<input type="date" class="date-hidden-picker">').val(st.endDate);
            var $endBtn = $('<button type="button" class="date-picker-btn">').html('<i class="fa fa-calendar-days"></i>');
            $endWrap.append($endInput).append($endHidden).append($endBtn);
            $tr.append($('<td>').append($endWrap));

            // Duration (read-only, auto-calculated)
            var durText = calcDuration(st.startDate, st.endDate);
            var $durInput = $('<input type="text" readonly>').val(durText)
                .css({ background: '#f7f9fc', color: '#666', textAlign: 'right', cursor: 'default' });
            $tr.append($('<td>').append($durInput));

            // Predecessor
            var $predTd = $('<td>');
            var $predSelect = $('<select>').attr('data-field', 'predecessor').attr('data-id', st.id);
            $predSelect.append($('<option>').val('').text(''));
            $.each(allGlobalRows, function (pi, pRow) {
                if (pRow.subtask.id === st.id) return; // skip self
                var parentObj = findTaskById(pRow.parentId, tasks);
                var parentName = parentObj ? (parentObj.name || '(unnamed)') : '(unnamed)';
                var label;
                if (pRow.depth === 1) {
                    // Sub-subtask: show full path TaskName > Subtask > SubSubtask
                    var gpInfo = findParentOf(pRow.parentId, tasks, null);
                    var gpName = (gpInfo && gpInfo.parent) ? (gpInfo.parent.name || '(unnamed)') : '(unnamed)';
                    label = gpName + ' > ' + parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
                } else {
                    label = parentName + ' > ' + (pRow.subtask.name || '(unnamed)');
                }
                $predSelect.append(
                    $('<option>').val(pRow.subtask.id).text(label)
                        .prop('selected', String(st.predecessor) === String(pRow.subtask.id))
                );
            });
            $predTd.append($predSelect);
            $tr.append($predTd);

            // % Complete
            $tr.append($('<td>').append(
                $('<input type="number" min="0" max="100">').val(st.percentComplete).attr('data-field', 'percentComplete').attr('data-id', st.id)
            ));

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
            $tr.append($('<td>').append(
                $('<input type="number" min="0" step="1" placeholder="0">').val(st.cost).attr('data-field', 'cost').attr('data-id', st.id)
            ));

            // Actions
            var $actions = $('<td>');
            var $actWrap = $('<div class="row-actions">');

            if (depth < 1 && st.name && st.name.trim() !== '') {
                $actWrap.append(
                    $('<button class="row-action-btn btn-add-child" title="Add sub-subtask">')
                        .attr('data-add-child', st.id)
                        .html('<i class="fa fa-plus"></i>')
                );
            }

            $actWrap.append(
                $('<button class="row-action-btn btn-delete" title="Delete">')
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
            result.push({ subtask: st, depth: depth, isLast: isLast, parentId: parentId });
            if (st.subtasks && st.subtasks.length > 0 && depth < 1) {
                flattenSubtasks(st.subtasks, depth + 1, result, st.id);
            }
        });
    }

    // ========== Event Handlers ==========

    // Create new task
    $('#btn-new-task').on('click', function () {
        var task = createTaskObj('');
        tasks.push(task);
        selectedTaskId = task.id;
        saveData();
        renderTaskList();
        renderDetail();
        setTimeout(function () { $('#detail-task-name').focus(); }, 50);
    });

    // Select task from sidebar
    $(document).on('click', '.task-item', function () {
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

    // Update parent task header fields
    $('#detail-task-name').on('input', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        task.name = $(this).val();
        if (task.name && task.name.trim() !== '') {
            $('#btn-add-subtask').show();
        } else {
            $('#btn-add-subtask').hide();
        }
        saveData();
        renderTaskList();
    });

    $('#detail-start-date').on('change blur', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        var iso = toIsoDate($(this).val());
        if (iso === task.startDate) return;
        task.startDate = iso;
        $('#detail-duration').val(calcDuration(task.startDate, task.endDate));
        saveData();
        renderTaskList();
    });

    $('#detail-end-date').on('change blur', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        var iso = toIsoDate($(this).val());
        if (iso === task.endDate) return;
        task.endDate = iso;
        $('#detail-duration').val(calcDuration(task.startDate, task.endDate));
        saveData();
    });

    // Setup auto-format for header date inputs
    setupDateAutoFormat($('#detail-start-date'));
    setupDateAutoFormat($('#detail-end-date'));

    $('#detail-status').on('change', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        task.status = $(this).val();
        saveData();
        renderTaskList();
    });

    $('#detail-percent').on('input', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        task.percentComplete = parseInt($(this).val()) || 0;
        saveData();
    });

    $('#detail-cost').on('input', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        task.cost = $(this).val();
        saveData();
    });

    // Flag toggle
    $('#btn-flag-task').on('click', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        task.flagged = !task.flagged;
        $(this).toggleClass('flagged', task.flagged);
        saveData();
        renderTaskList();
    });

    // Delete task
    $('#btn-delete-task').on('click', function () {
        if (!selectedTaskId) return;
        var task = findTaskById(selectedTaskId, tasks);
        var name = (task && task.name) ? '"' + task.name + '"' : 'this task';
        if (!confirm('Delete ' + name + ' and all its subtasks?')) return;

        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].id === selectedTaskId) {
                tasks.splice(i, 1);
                break;
            }
        }
        selectedTaskId = tasks.length > 0 ? tasks[0].id : null;
        saveData();
        renderTaskList();
        renderDetail();
        showToast('Task deleted');
    });

    // Add subtask
    $('#btn-add-subtask').on('click', function () {
        var task = findTaskById(selectedTaskId, tasks);
        if (!task) return;
        var sub = createTaskObj('');
        task.subtasks.push(sub);
        saveData();
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
        parentSub.subtasks.push(child);
        saveData();
        renderDetail();
        setTimeout(function () {
            var $inputs = $('#subtask-body input[data-field="name"]');
            $inputs.last().focus();
        }, 50);
    });

    // Delete subtask
    $(document).on('click', '[data-delete-subtask]', function () {
        var subId = parseInt($(this).attr('data-delete-subtask'));
        var info = findParentOf(subId, tasks, null);
        if (!info) return;
        clearPredecessorRefs(subId, tasks);
        info.list[info.index].subtasks = [];
        info.list.splice(info.index, 1);
        saveData();
        renderDetail();
        showToast('Subtask deleted');
    });

    // Inline edit subtask fields (excluding assignedTo which uses the picker)
    $(document).on('input change blur', '#subtask-body input[data-field], #subtask-body select[data-field]', function (e) {
        var id = parseInt($(this).attr('data-id'));
        var field = $(this).attr('data-field');
        var val = $(this).val();
        var sub = findTaskById(id, tasks);
        if (!sub) return;

        if (field === 'percentComplete') {
            sub[field] = parseInt(val) || 0;
        } else if (field === 'predecessor') {
            sub[field] = val ? parseInt(val) : '';
        } else if (field === 'startDate' || field === 'endDate') {
            var iso = toIsoDate(val);
            if (iso === sub[field]) return;
            sub[field] = iso;
            // Update duration cell in the same row
            var $row = $(this).closest('tr');
            $row.find('input[readonly]').val(calcDuration(sub.startDate, sub.endDate));
        } else {
            sub[field] = val;
        }

        saveData();

        if (field === 'name' && e.type === 'input') {
            renderTaskList();
            // Show/hide the add-child button based on name content
            var $row = $(this).closest('tr');
            var $actWrap = $row.find('.row-actions');
            var hasAddBtn = $actWrap.find('.btn-add-child').length > 0;
            var nameNotEmpty = val && val.trim() !== '';
            // Only show add-child for depth-0 subtasks
            var depthClass = $row.find('.tree-cell').attr('class') || '';
            var isDepth0 = depthClass.indexOf('depth-0') !== -1;
            if (nameNotEmpty && isDepth0 && !hasAddBtn) {
                $actWrap.prepend(
                    $('<button class="row-action-btn btn-add-child" title="Add sub-subtask">')
                        .attr('data-add-child', id)
                        .html('<i class="fa fa-plus"></i>')
                );
            } else if (!nameNotEmpty && hasAddBtn) {
                $actWrap.find('.btn-add-child').remove();
            }
        }
    });

    // ========== Save All ==========
    function buildPredecessorLabel(predId) {
        if (!predId) return '';
        // Build global rows to find the predecessor
        var globalRows = [];
        $.each(tasks, function (ti, t) {
            flattenSubtasks(t.subtasks, 0, globalRows, t.id);
        });
        for (var i = 0; i < globalRows.length; i++) {
            var pRow = globalRows[i];
            if (String(pRow.subtask.id) === String(predId)) {
                var parentObj = findTaskById(pRow.parentId, tasks);
                var parentName = parentObj ? (parentObj.name || '(unnamed)') : '(unnamed)';
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

        // Col 4: Predecessor (readable label)
        if (taskObj.predecessor) {
            var predLabel = buildPredecessorLabel(taskObj.predecessor);
            if (predLabel) cellData[rowIdx + '-4'] = { text: predLabel };
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
            { id: 3, name: 'Duration', type: 'duration', width: 100, description: '', filterValue: '', frozen: false, hidden: false, locked: false, durationStartCol: 1, durationEndCol: 2 },
            { id: 4, name: 'Predecessor', type: 'text', width: 180, description: '', filterValue: '', frozen: false, hidden: false, locked: false },
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
        var rowIdx = 0;

        $.each(tasks, function (ti, task) {
            // Parent task row (indent 0)
            addSaveRow(cellData, rowIdx, 0, task);
            rowIdx++;

            // Subtasks (indent 1)
            $.each(task.subtasks || [], function (si, sub) {
                addSaveRow(cellData, rowIdx, 1, sub);
                rowIdx++;

                // Sub-subtasks (indent 2)
                $.each(sub.subtasks || [], function (ssi, subsub) {
                    addSaveRow(cellData, rowIdx, 2, subsub);
                    rowIdx++;
                });
            });
        });

        return {
            columns: columns,
            cellData: cellData,
            totalRows: rowIdx,
            frozenUpTo: -1,
            collapsedRows: {},
            rowAttachments: {},
            rowComments: {},
            colIdCounter: 9,
            createdBy: CURRENT_USER_ID,
            _taskData: {
                tasks: tasks,
                taskIdCounter: taskIdCounter
            }
        };
    }

    $('#btn-save-all').on('click', function () {
        if (!isDirty) return;
        var $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i>');

        var payload = {
            project: PROJ_NAME,
            data: buildSaveData()
        };

        $.ajax({
            url: '/api/save-tasks',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(payload),
            success: function (resp) {
                if (resp.ok) {
                    isDirty = false;
                    $btn.prop('disabled', true);
                    showToast('Saved successfully: ' + resp.filename);
                } else {
                    showToast('Save failed: ' + (resp.error || 'Unknown error'));
                    $btn.prop('disabled', false);
                }
            },
            error: function () {
                showToast('Save failed: server error');
                $btn.prop('disabled', false);
            },
            complete: function () {
                $btn.html('<i class="fa fa-floppy-disk"></i>');
            }
        });
    });

    // ========== Delete Project ==========
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
            url: '/api/delete-group',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ projectName: PROJ_NAME }),
            timeout: 5000,
            success: function (resp) {
                if (resp && resp.ok) {
                    showToast('Project "' + PROJ_NAME + '" deleted.');
                    localStorage.removeItem(getStorageKey());
                    PROJ_NAME = '';
                    tasks = [];
                    taskIdCounter = 0;
                    selectedTaskId = null;
                    isDirty = false;
                    $('#btn-save-all').prop('disabled', true);
                    $('#page-subtitle').text('Task Management');
                    renderTaskList();
                    renderDetail();
                    showTaskProjectPicker();
                } else {
                    showToast('Failed to delete project.');
                }
            },
            error: function () {
                showToast('Failed to delete project. Check server connection.');
            }
        });
    });

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
    });

    $(document).on('mousemove', function (e) {
        if (!sidebarResizing) return;
        var diff = e.clientX - sidebarStartX;
        var newW = Math.max(200, Math.min(500, sidebarStartW + diff));
        $('#sidebar').css('width', newW + 'px');
    });

    $(document).on('mouseup', function () {
        if (sidebarResizing) {
            sidebarResizing = false;
            $('#sidebar-resize-handle').removeClass('dragging');
            $('body').css('cursor', '');
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
        $('#task-picker-new-row').hide();
        $('#task-picker-new-btn').show();
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
                        var $link = $('<span class="task-picker-link">').text(proj.name);
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
        $('#page-subtitle').text(name);

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
        $('#page-subtitle').text(name);
        tasks = [];
        taskIdCounter = 0;
        selectedTaskId = null;
        isDirty = false;
        initAfterLoad();
    }

    function initAfterLoad() {
        selectedTaskId = null;
        if (tasks.length > 0) {
            selectedTaskId = tasks[0].id;
        }
        isDirty = false;
        $('#btn-save-all').prop('disabled', true);
        renderTaskList();
        renderDetail();
    }

    $('#task-picker-new-btn').on('click', function () {
        $(this).hide();
        $('#task-picker-new-row').show();
        $('#task-picker-new-name').val('').focus();
    });

    $('#task-picker-create-btn').on('click', function () {
        var name = $('#task-picker-new-name').val().trim();
        if (!name) { alert('Please enter a project name.'); return; }
        createGroupProject(name);
    });

    $('#task-picker-new-name').on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $('#task-picker-create-btn').click();
        }
    });

    // ========== Init ==========
    loadContacts();
    showTaskProjectPicker();

});
