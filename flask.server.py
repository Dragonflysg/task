import sys, os

import controllers_server as pj

# register http routes
pj.app.add_url_rule('/', view_func=pj.index, methods=['GET'])
pj.app.add_url_rule('/<path:filename>', view_func=pj.static_files, methods=['GET'])
pj.app.add_url_rule('/api/group-projects', view_func=pj.group_projects, methods=['GET'])
pj.app.add_url_rule('/api/load-group', view_func=pj.load_group, methods=['GET'])
pj.app.add_url_rule('/api/project-version', view_func=pj.project_version, methods=['GET'])
pj.app.add_url_rule('/api/upload', view_func=pj.upload_file, methods=['POST'])
pj.app.add_url_rule('/api/files/<project>/<path:filename>', view_func=pj.serve_file, methods=['GET'])
pj.app.add_url_rule('/api/delete-file', view_func=pj.delete_file, methods=['POST'])
pj.app.add_url_rule('/api/change-requests', view_func=pj.get_change_requests, methods=['GET'])
pj.app.add_url_rule('/api/change-requests', endpoint='create_change_request', view_func=pj.create_change_request, methods=['POST'])
pj.app.add_url_rule('/api/change-requests/reply', view_func=pj.reply_change_request, methods=['POST'])
pj.app.add_url_rule('/api/change-requests/status', view_func=pj.update_change_request_status, methods=['POST'])
pj.app.add_url_rule('/api/change-requests/delete', view_func=pj.delete_change_request, methods=['POST'])
pj.app.add_url_rule('/api/task-logs', view_func=pj.get_task_logs, methods=['GET'])
pj.app.add_url_rule('/api/patch-task', view_func=pj.patch_task, methods=['POST'])

if __name__ == '__main__':
    #pj.socketio.run(pj.app, host='0.0.0.0', port=9886, certfile="chain.pem", keyfile="key.pem")
    pj.socketio.run(pj.app, host='0.0.0.0', port=5000)
