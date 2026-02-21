$(document).ready(function () {

    // ========== State ==========
    var CURRENT_USER_ID = 'ps1234';
    var SUPER_USERS = ['ab1234', 'ps1234'];
    var DEFAULT_GROUP_PROJECT = 'INTLITServicesMigration';
    var PROJ_NAME = '';
    var requests = [];

    // ========== Init ==========
    function init() {
        // Detect project from URL param or use default
        var params = new URLSearchParams(window.location.search);
        PROJ_NAME = params.get('project') || DEFAULT_GROUP_PROJECT;

        $('#project-name-label').text(PROJ_NAME);

        loadRequests();
    }

    function isSuperUser() {
        return SUPER_USERS.indexOf(CURRENT_USER_ID) !== -1;
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
                    // Sort newest first
                    requests.sort(function (a, b) {
                        return b.id - a.id;
                    });
                    renderRequests(false);
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

        $.ajax({
            url: '/api/change-requests',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                project: PROJ_NAME,
                user: CURRENT_USER_ID,
                text: text
            }),
            success: function (resp) {
                if (resp.ok) {
                    $('#request-text').val('');
                    // Prepend new request to top
                    requests.unshift(resp.request);
                    renderRequests(false);
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

    function submitReply(requestId) {
        var $textarea = $('.reply-form[data-id="' + requestId + '"] textarea');
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
                    // Update local data and re-render the card
                    var req = findRequest(requestId);
                    if (req) {
                        req.replies.push({
                            user: CURRENT_USER_ID,
                            timestamp: new Date().toLocaleString(),
                            text: text
                        });
                        renderRequests(false, requestId);
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

    function updateStatus(requestId, newStatus) {
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
                        renderRequests(false, requestId);
                    }
                    showToast('Status updated');
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

    // ========== Rendering ==========
    function renderRequests(expandFirst, keepExpandedId) {
        var $list = $('#requests-list');

        // Track which cards are currently expanded
        var expandedIds = {};
        if (keepExpandedId) {
            expandedIds[keepExpandedId] = true;
        }
        $list.find('.request-card.expanded').each(function () {
            expandedIds[$(this).data('id')] = true;
        });

        $list.empty();

        var filterMine = $('#filter-my-items').is(':checked');
        var filtered = requests;
        if (filterMine) {
            filtered = requests.filter(function (r) {
                return r.user === CURRENT_USER_ID;
            });
        }

        if (filtered.length === 0) {
            $('#empty-state').show();
            return;
        }
        $('#empty-state').hide();

        for (var i = 0; i < filtered.length; i++) {
            var req = filtered[i];
            var isExpanded = false;

            if (expandFirst && i === 0) {
                isExpanded = true;
            } else if (expandedIds[req.id]) {
                isExpanded = true;
            }

            $list.append(buildCard(req, isExpanded));
        }
    }

    function buildCard(req, expanded) {
        var statusClass = getStatusClass(req.status);
        var titleText = req.text.length > 80 ? req.text.substring(0, 80) + '...' : req.text;
        // Replace newlines in title preview
        titleText = titleText.replace(/\n/g, ' ');

        var $card = $('<div class="request-card" data-id="' + req.id + '">');
        if (expanded) $card.addClass('expanded');

        // Header
        var $header = $('<div class="request-card-header">');
        $header.append('<i class="fa fa-chevron-right card-expand-icon"></i>');
        $header.append('<span class="card-title-text">' + escapeHtml(titleText) + '</span>');

        var $meta = $('<div class="card-meta">');
        $meta.append('<span class="status-badge ' + statusClass + '">' + escapeHtml(req.status) + '</span>');
        $meta.append('<span class="card-submitter"><i class="fa fa-user"></i> ' + escapeHtml(req.user) + '</span>');
        $meta.append('<span class="card-date"><i class="fa fa-clock"></i> ' + escapeHtml(req.timestamp) + '</span>');
        $header.append($meta);
        $card.append($header);

        // Body
        var $body = $('<div class="request-card-body">');

        // Full text
        $body.append('<div class="request-full-text">' + escapeHtml(req.text) + '</div>');

        // Info row with status at far right
        var $info = $('<div class="request-info-row">');
        $info.append('<span><i class="fa fa-user"></i> Submitted by: <strong>' + escapeHtml(req.user) + '</strong></span>');
        $info.append('<span><i class="fa fa-calendar"></i> Submitted: ' + escapeHtml(req.timestamp) + '</span>');

        // Status dropdown (super users only) — inline at far right
        if (isSuperUser()) {
            var $statusInline = $('<span class="status-inline">');
            $statusInline.append('<label>Status</label>');
            var $select = $('<select class="status-select" data-id="' + req.id + '">');
            var statuses = ['Open', 'In Review', 'Approved', 'Not Viable', 'Done'];
            for (var s = 0; s < statuses.length; s++) {
                var sel = statuses[s] === req.status ? ' selected' : '';
                $select.append('<option value="' + statuses[s] + '"' + sel + '>' + statuses[s] + '</option>');
            }
            $statusInline.append($select);
            $info.append($statusInline);
        }

        $body.append($info);

        // Replies
        var $repliesSection = $('<div class="replies-section">');
        if (req.replies && req.replies.length > 0) {
            $repliesSection.append('<div class="replies-title"><i class="fa fa-comments"></i> Replies (' + req.replies.length + ')</div>');
            for (var r = 0; r < req.replies.length; r++) {
                var reply = req.replies[r];
                var $reply = $('<div class="reply-item">');
                $reply.append('<div class="reply-meta"><strong>' + escapeHtml(reply.user) + '</strong><span>' + escapeHtml(reply.timestamp) + '</span></div>');
                $reply.append('<div class="reply-text">' + escapeHtml(reply.text) + '</div>');
                $repliesSection.append($reply);
            }
        }

        // Reply form (super users only)
        if (isSuperUser()) {
            var $form = $('<div class="reply-form" data-id="' + req.id + '">');
            $form.append('<textarea placeholder="Write a reply..." rows="2"></textarea>');
            $form.append('<button class="btn-reply" data-id="' + req.id + '"><i class="fa fa-reply"></i> Reply</button>');
            $repliesSection.append($form);
        }

        $body.append($repliesSection);
        $card.append($body);

        return $card;
    }

    function getStatusClass(status) {
        switch (status) {
            case 'Open':      return 'status-open';
            case 'In Review': return 'status-in-review';
            case 'Approved':  return 'status-approved';
            case 'Not Viable': return 'status-not-viable';
            case 'Done':      return 'status-done';
            default:          return 'status-open';
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

    // ========== Toast ==========
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

    // Submit on Ctrl+Enter
    $('#request-text').on('keydown', function (e) {
        if (e.ctrlKey && e.key === 'Enter') {
            submitRequest();
        }
    });

    // Filter: show only my items
    $('#filter-my-items').on('change', function () {
        renderRequests(false);
    });

    // Toggle card expand/collapse
    $(document).on('click', '.request-card-header', function () {
        var $card = $(this).closest('.request-card');
        $card.toggleClass('expanded');
    });

    // Status change
    $(document).on('change', '.status-select', function () {
        var requestId = $(this).data('id');
        var newStatus = $(this).val();
        updateStatus(requestId, newStatus);
    });

    // Reply button
    $(document).on('click', '.btn-reply', function () {
        var requestId = $(this).data('id');
        submitReply(requestId);
    });

    // Reply on Ctrl+Enter
    $(document).on('keydown', '.reply-form textarea', function (e) {
        if (e.ctrlKey && e.key === 'Enter') {
            var requestId = $(this).closest('.reply-form').data('id');
            submitReply(requestId);
        }
    });

    // ========== Start ==========
    init();
});
