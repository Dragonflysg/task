"""Clone a group project JSON file, clearing specified column values.

Usage:
    python cloneproject.py <source_file> <destination_file>

Both files are relative to the GROUP/ directory.
Example:
    python cloneproject.py INTL_to_ITServices_Migration.JSON INTL_to_ITServices_Execution.JSON
"""
import sys
import os
import json
import copy

# Columns whose cell values should be cleared in the clone
CLEAR_COLUMNS = {
    'Start Date',
    'End Date',
    'WorkDays',
    '% Complete',
    'Status',
    'Cost',
    'Comments',
}

def main():
    if len(sys.argv) != 3:
        print('Usage: python cloneproject.py <source_file> <destination_file>')
        sys.exit(1)

    source_name = sys.argv[1]
    dest_name = sys.argv[2]

    group_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'GROUP')
    source_path = os.path.join(group_dir, source_name)
    dest_path = os.path.join(group_dir, dest_name)

    if not os.path.exists(source_path):
        print(f'Error: Source file not found: {source_path}')
        sys.exit(1)

    if os.path.exists(dest_path):
        print(f'Error: Destination file already exists: {dest_path}')
        sys.exit(1)

    with open(source_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Find column indices to clear
    columns = data.get('columns', [])
    clear_indices = set()
    for i, col in enumerate(columns):
        if col.get('name') in CLEAR_COLUMNS:
            clear_indices.add(i)

    if not clear_indices:
        print('Warning: No matching columns found to clear.')

    # Clear cell values for those columns
    cell_data = data.get('cellData', {})
    for key in list(cell_data.keys()):
        parts = key.split('-')
        if len(parts) == 2:
            col_index = int(parts[1])
            if col_index in clear_indices:
                # Keep the cell entry (preserves indent, formatting) but clear text
                cell_data[key]['text'] = ''

    # Reset version to 0 for the new project
    data['_version'] = 0

    with open(dest_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f'Cloned successfully: {dest_name}')
    print(f'  Cleared columns: {", ".join(sorted(CLEAR_COLUMNS & {c["name"] for c in columns}))}')
    print(f'  Location: {dest_path}')


if __name__ == '__main__':
    main()
