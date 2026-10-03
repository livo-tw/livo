const actions = new Set(['acknowledge', 'create_subtask', 'add_item', 'update_item', 'delete_item', 'add_dependency', 'remove_dependency']);
export function taskWorkActivityDetail(detail: string, translate: (key: string) => string): string {
  return translate(`taskWork.actions.${actions.has(detail) ? detail : 'unknown'}`);
}
