$(document).ready(function () {

    // ========== State ==========
    var CURRENT_USER_ID = 'ss1234';
    var SUPER_USERS = ['ab1234', 'ps1234'];
    var DEFAULT_GROUP_PROJECT = 'INTLITServicesMigration';
    var PROJ_NAME = '';
    var requests = [];
    var draggedId = null;
    var attachedFiles = []; // screenshot files (max 3)

    // Status mapping from old statuses to new ones
    var STATUS_MAP = {
        'In Review': 'In Progress',
        'Approved':  'Closed',
        'Done':      'Closed',
        'Not Viable':'Non-Viable'
    };

    // Column assignment: status → column key
    var STATUS_TO_COL = {
        'Open':        'open',
        'In Progress': 'in-progress',
        'Closed':      'done',
        'Non-Viable':  'done'
    };

    // Default status when dropping into a column
    var COL_DEFAULT_STATUS = {
        'open':        'Open',
        'in-progress': 'In Progress',
        'done':        'Closed'
    };

    // ========== Init ==========
    function init() {
        var params = new URLSearchParams(window.location.search);
        PROJ_NAME = params.get('project') || DEFAULT_GROUP_PROJECT;
        $('#project-name-label').text(PROJ_NAME);
        loadRequests();
    }

    function isSuperUser() {
        return SUPER_USERS.indexOf(CURRENT_USER_ID) !== -1;
    }

    // Normalize old statuses to new ones
    function normalizeStatus(status) {
        return STATUS_MAP[status] || status;
    }

    // ========== API ==========
    function loadRequests() {
        $.ajax({
            url: '/api/change-requests',
            method: 'GET',
            data: { project: PROJ_NAME },
            success: function (resp) {
                if (resp.ok) {
                    requests = resp.requests || [];
                    // Normalize any old statuses
                    for (var i = 0; i < requests.length; i++) {
                        requests[i].status = normalizeStatus(requests[i].status);
                    }
                    // Sort newest first
                    requests.sort(function (a, b) {
                        return b.id - a.id;
                    });
                    renderBoard();
                } else {
                    showToast('Failed to load requests', true);
                }
            },
            error: function () {
                showToast('Server error loading requests', true);
            }
        });
    }

    function submitRequest() {
        var text = $.trim($('#request-text').val());
        if (!text) {
            showToast('Please enter a description', true);
            return;
        }

        var formData = new FormData();
        formData.append('project', PROJ_NAME);
        formData.append('user', CURRENT_USER_ID);
        formData.append('text', text);
        for (var i = 0; i < attachedFiles.length; i++) {
            formData.append('screenshots', attachedFiles[i]);
        }

        $.ajax({
            url: '/api/change-requests',
            method: 'POST',
            data: formData,
            processData: false,
            contentType: false,
            success: function (resp) {
                if (resp.ok) {
                    $('#request-text').val('');
                    clearAttachments();
                    resp.request.status = normalizeStatus(resp.request.status);
                    requests.unshift(resp.request);
                    renderBoard();
                    showToast('Request submitted');
                } else {
                    showToast('Failed to submit: ' + (resp.error || ''), true);
                }
            },
            error: function () {
                showToast('Server error submitting request', true);
            }
        });
    }

    // ========== Screenshot Attachments ==========
    function renderAttachmentPreviews() {
        var $preview = $('#screenshot-preview');
        $preview.empty();
        for (var i = 0; i < attachedFiles.length; i++) {
            (function (idx, file) {
                var $thumb = $('<div class="screenshot-thumb">');
                var $img = $('<img>');
                var reader = new FileReader();
                reader.onload = function (e) {
                    $img.attr('src', e.target.result);
                };
                reader.readAsDataURL(file);
                $thumb.append($img);
                var $remove = $('<button class="remove-thumb" data-idx="' + idx + '"><i class="fa fa-xmark"></i></button>');
                $thumb.append($remove);
                $preview.append($thumb);
            })(i, attachedFiles[i]);
        }
        // Update hint visibility
        if (attachedFiles.length >= 3) {
            $('#attach-hint').text('Max 3 reached');
        } else {
            $('#attach-hint').text('Up to 3 images');
        }
    }

    function clearAttachments() {
        attachedFiles = [];
        $('#screenshot-input').val('');
        renderAttachmentPreviews();
    }

    function submitReply(requestId) {
        var $textarea = $('.modal-reply-form[data-id="' + requestId + '"] textarea');
        var text = $.trim($textarea.val());
        if (!text) return;

        $.ajax({
            url: '/api/change-requests/reply',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                project: PROJ_NAME,
                requestId: requestId,
                user: CURRENT_USER_ID,
                text: text
            }),
            success: function (resp) {
                if (resp.ok) {
                    $textarea.val('');
                    var req = findRequest(requestId);
                    if (req) {
                        req.replies.push({
                            user: CURRENT_USER_ID,
                            timestamp: new Date().toLocaleString(),
                            text: text
                        });
                        renderBoard();
                        openModal(requestId);
                    }
                    showToast('Reply added');
                } else {
                    showToast('Failed to reply', true);
                }
            },
            error: function () {
                showToast('Server error adding reply', true);
            }
        });
    }

    function updateStatus(requestId, newStatus, onSuccess) {
        $.ajax({
            url: '/api/change-requests/status',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                project: PROJ_NAME,
                requestId: requestId,
                status: newStatus
            }),
            success: function (resp) {
                if (resp.ok) {
                    var req = findRequest(requestId);
                    if (req) {
                        req.status = newStatus;
                        renderBoard();
                    }
                    showToast('Status updated');
                    if (onSuccess) onSuccess();
                } else {
                    showToast('Failed to update status', true);
                }
            },
            error: function () {
                showToast('Server error updating status', true);
            }
        });
    }

    function findRequest(id) {
        for (var i = 0; i < requests.length; i++) {
            if (requests[i].id === id) return requests[i];
        }
        return null;
    }

    // ========== Filtering ==========
    function getFilteredRequests() {
        var filterMine = $('#filter-my-items').is(':checked');
        var searchText = $.trim($('#search-input').val()).toLowerCase();

        return requests.filter(function (r) {
            if (filterMine && r.user !== CURRENT_USER_ID) return false;
            if (searchText && r.text.toLowerCase().indexOf(searchText) === -1 &&
                r.user.toLowerCase().indexOf(searchText) === -1) return false;
            return true;
        });
    }

    // ========== Rendering ==========
    function renderBoard() {
        var filtered = getFilteredRequests();

        var cols = { 'open': [], 'in-progress': [], 'done': [] };

        for (var i = 0; i < filtered.length; i++) {
            var req = filtered[i];
            var col = STATUS_TO_COL[req.status] || 'open';
            cols[col].push(req);
        }

        // Update counts
        $('#count-open').text(cols['open'].length);
        $('#count-in-progress').text(cols['in-progress'].length);
        $('#count-done').text(cols['done'].length);

        // Render each column
        renderColumn('open', cols['open']);
        renderColumn('in-progress', cols['in-progress']);
        renderColumn('done', cols['done']);

        // Show/hide empty state
        if (filtered.length === 0) {
            $('#empty-state').show();
            $('#kanban-board').hide();
        } else {
            $('#empty-state').hide();
            $('#kanban-board').show();
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

    function buildKanbanCard(req, colKey) {
        var titleText = req.text.length > 100 ? req.text.substring(0, 100) + '...' : req.text;
        titleText = titleText.replace(/\n/g, ' ');

        var canDrag = isSuperUser();
        var $card = $('<div class="kanban-card" data-id="' + req.id + '">');
        if (canDrag) {
            $card.addClass('draggable');
            $card.attr('draggable', 'true');
        } else {
            $card.addClass('read-only');
        }

        // Title
        $card.append('<div class="kanban-card-title">' + escapeHtml(titleText) + '</div>');

        // Footer row
        var $footer = $('<div class="kanban-card-footer">');

        // Status badge or dropdown (done column gets a select for super users)
        if (colKey === 'done' && canDrag) {
            var selectClass = req.status === 'Non-Viable' ? 'status-non-viable' : 'status-closed';
            var $select = $('<select class="done-status-select ' + selectClass + '" data-id="' + req.id + '">');
            var closedSel = req.status === 'Closed' ? ' selected' : '';
            var nvSel = req.status === 'Non-Viable' ? ' selected' : '';
            $select.append('<option value="Closed"' + closedSel + '>Closed</option>');
            $select.append('<option value="Non-Viable"' + nvSel + '>Non-Viable</option>');
            $footer.append($select);
        } else {
            var statusClass = getStatusClass(req.status);
            $footer.append('<span class="status-badge ' + statusClass + '">' + escapeHtml(req.status) + '</span>');
        }

        // Reply count chip
        if (req.replies && req.replies.length > 0) {
            $footer.append(
                '<span class="kanban-card-replies">' +
                    '<i class="fa fa-comment"></i> ' + req.replies.length +
                '</span>'
            );
        }

        // Meta (submitter + date)
        var $meta = $('<span class="kanban-card-meta">');
        $meta.append('<span><i class="fa fa-user"></i> ' + escapeHtml(req.user) + '</span>');
        // Show short date
        var shortDate = req.timestamp || '';
        if (shortDate.length > 16) shortDate = shortDate.substring(0, 16);
        $meta.append('<span><i class="fa fa-clock"></i> ' + escapeHtml(shortDate) + '</span>');
        $footer.append($meta);

        $card.append($footer);
        return $card;
    }

    function getStatusClass(status) {
        switch (status) {
            case 'Open':        return 'status-open';
            case 'In Progress': return 'status-in-progress';
            case 'Closed':      return 'status-closed';
            case 'Non-Viable':  return 'status-non-viable';
            default:            return 'status-open';
        }
    }

    // ========== Modal ==========
    function openModal(requestId) {
        var req = findRequest(requestId);
        if (!req) return;

        var $body = $('#modal-body');
        $body.empty();

        // Status row
        var $statusRow = $('<div class="modal-status-row">');
        var statusClass = getStatusClass(req.status);
        $statusRow.append('<span class="status-badge ' + statusClass + '">' + escapeHtml(req.status) + '</span>');
        $body.append($statusRow);

        // Full text
        $body.append('<div class="modal-full-text">' + escapeHtml(req.text) + '</div>');

        // Screenshots
        if (req.screenshots && req.screenshots.length > 0) {
            var $ssRow = $('<div class="modal-screenshots">');
            for (var s = 0; s < req.screenshots.length; s++) {
                var $link = $('<a class="modal-screenshot-item" href="' + escapeHtml(req.screenshots[s]) + '" target="_blank">');
                $link.append('<img src="' + escapeHtml(req.screenshots[s]) + '">');
                $ssRow.append($link);
            }
            $body.append($ssRow);
        }

        // Info row
        var $info = $('<div class="modal-info-row">');
        $info.append('<span><i class="fa fa-user"></i> Submitted by: <strong>' + escapeHtml(req.user) + '</strong></span>');
        $info.append('<span><i class="fa fa-calendar"></i> ' + escapeHtml(req.timestamp) + '</span>');

        // Status control for super users on done column items
        var col = STATUS_TO_COL[req.status] || 'open';
        if (isSuperUser() && col === 'done') {
            var $statusInline = $('<span class="modal-status-inline">');
            $statusInline.append('<label>Status</label>');
            var $select = $('<select class="modal-status-select" data-id="' + req.id + '">');
            var closedSel = req.status === 'Closed' ? ' selected' : '';
            var nvSel = req.status === 'Non-Viable' ? ' selected' : '';
            $select.append('<option value="Closed"' + closedSel + '>Closed</option>');
            $select.append('<option value="Non-Viable"' + nvSel + '>Non-Viable</option>');
            $statusInline.append($select);
            $info.append($statusInline);
        }

        $body.append($info);

        // Replies
        var $repliesSection = $('<div class="modal-replies-section">');
        if (req.replies && req.replies.length > 0) {
            $repliesSection.append('<div class="modal-replies-title"><i class="fa fa-comments"></i> Replies (' + req.replies.length + ')</div>');
            for (var r = 0; r < req.replies.length; r++) {
                var reply = req.replies[r];
                var $reply = $('<div class="modal-reply-item">');
                $reply.append('<div class="modal-reply-meta"><strong>' + escapeHtml(reply.user) + '</strong><span>' + escapeHtml(reply.timestamp) + '</span></div>');
                $reply.append('<div class="modal-reply-text">' + escapeHtml(reply.text) + '</div>');
                $repliesSection.append($reply);
            }
        }

        // Reply form (super users only)
        if (isSuperUser()) {
            var $form = $('<div class="modal-reply-form" data-id="' + req.id + '">');
            $form.append('<textarea placeholder="Write a reply..." rows="2"></textarea>');
            $form.append('<button class="btn-reply" data-id="' + req.id + '"><i class="fa fa-reply"></i> Reply</button>');
            $repliesSection.append($form);
        }

        $body.append($repliesSection);

        $('#modal-overlay').addClass('visible');
    }

    function closeModal() {
        $('#modal-overlay').removeClass('visible');
    }

    // ========== Drag & Drop ==========
    function initDragEvents() {
        // Dragstart
        $(document).on('dragstart', '.kanban-card.draggable', function (e) {
            draggedId = $(this).data('id');
            $(this).addClass('dragging');
            e.originalEvent.dataTransfer.effectAllowed = 'move';
            e.originalEvent.dataTransfer.setData('text/plain', draggedId);
        });

        // Dragend
        $(document).on('dragend', '.kanban-card.draggable', function () {
            $(this).removeClass('dragging');
            $('.kanban-col-body').removeClass('drag-over');
            draggedId = null;
        });

        // Dragover on column body
        $(document).on('dragover', '.kanban-col-body', function (e) {
            e.preventDefault();
            e.originalEvent.dataTransfer.dropEffect = 'move';
            $(this).addClass('drag-over');
        });

        // Dragleave
        $(document).on('dragleave', '.kanban-col-body', function (e) {
            // Only remove if actually leaving the element
            if (!this.contains(e.relatedTarget)) {
                $(this).removeClass('drag-over');
            }
        });

        // Drop
        $(document).on('drop', '.kanban-col-body', function (e) {
            e.preventDefault();
            $(this).removeClass('drag-over');

            if (!draggedId) return;

            var targetCol = $(this).data('col');
            var req = findRequest(draggedId);
            if (!req) return;

            var currentCol = STATUS_TO_COL[req.status] || 'open';
            if (currentCol === targetCol) return; // same column, do nothing

            var newStatus = COL_DEFAULT_STATUS[targetCol];
            var droppedId = draggedId;
            updateStatus(req.id, newStatus, function () {
                highlightCard(droppedId);
            });
        });
    }

    function highlightCard(requestId) {
        var $card = $('.kanban-card[data-id="' + requestId + '"]');
        if ($card.length) {
            $card.addClass('card-just-dropped');
            setTimeout(function () {
                $card.removeClass('card-just-dropped');
            }, 5000);
        }
    }

    // ========== Utility ==========
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

    // ========== Events ==========

    // Submit button
    $('#btn-submit').on('click', function () {
        submitRequest();
    });

    // Attach screenshot button
    $('#btn-attach').on('click', function () {
        if (attachedFiles.length >= 3) {
            showToast('Maximum 3 screenshots allowed', true);
            return;
        }
        $('#screenshot-input').trigger('click');
    });

    // File input change
    $('#screenshot-input').on('change', function () {
        var files = this.files;
        if (!files || files.length === 0) return;
        var remaining = 3 - attachedFiles.length;
        var added = 0;
        for (var i = 0; i < files.length && added < remaining; i++) {
            if (files[i].type.indexOf('image/') === 0) {
                attachedFiles.push(files[i]);
                added++;
            }
        }
        if (added < files.length && remaining <= 0) {
            showToast('Maximum 3 screenshots allowed', true);
        }
        // Reset input so same file can be re-selected
        $(this).val('');
        renderAttachmentPreviews();
    });

    // Remove screenshot thumbnail
    $(document).on('click', '.remove-thumb', function (e) {
        e.stopPropagation();
        var idx = $(this).data('idx');
        attachedFiles.splice(idx, 1);
        renderAttachmentPreviews();
    });

    // Submit on Ctrl+Enter
    $('#request-text').on('keydown', function (e) {
        if (e.ctrlKey && e.key === 'Enter') {
            submitRequest();
        }
    });

    // Filter: show only my items
    $('#filter-my-items').on('change', function () {
        renderBoard();
    });

    // Search input
    $('#search-input').on('input', function () {
        renderBoard();
    });

    // Click kanban card → open modal (but not if clicking the done-status dropdown)
    $(document).on('click', '.kanban-card', function (e) {
        if ($(e.target).closest('.done-status-select').length) return;
        var requestId = $(this).data('id');
        openModal(requestId);
    });

    // Done-column status dropdown change (on card)
    $(document).on('change', '.done-status-select', function (e) {
        e.stopPropagation();
        var requestId = $(this).data('id');
        var newStatus = $(this).val();
        updateStatus(requestId, newStatus);
    });

    // Modal status dropdown change
    $(document).on('change', '.modal-status-select', function () {
        var requestId = $(this).data('id');
        var newStatus = $(this).val();
        updateStatus(requestId, newStatus);
        // Re-open modal to reflect change
        setTimeout(function () { openModal(requestId); }, 100);
    });

    // Close modal
    $('#modal-close').on('click', function () {
        closeModal();
    });

    $('#modal-overlay').on('click', function (e) {
        if (e.target === this) closeModal();
    });

    $(document).on('keydown', function (e) {
        if (e.key === 'Escape') closeModal();
    });

    // Reply button (in modal)
    $(document).on('click', '.modal-reply-form .btn-reply', function () {
        var requestId = $(this).data('id');
        submitReply(requestId);
    });

    // Reply on Ctrl+Enter (in modal)
    $(document).on('keydown', '.modal-reply-form textarea', function (e) {
        if (e.ctrlKey && e.key === 'Enter') {
            var requestId = $(this).closest('.modal-reply-form').data('id');
            submitReply(requestId);
        }
    });

    // Init drag & drop
    initDragEvents();

    // ========== Start ==========
    init();
});
