#!/bin/sh
# Sourced by install.sh after files have been rewritten, before compose up.
# A restrictive extraction umask must not hide bind mounts from container users.
normalize_package_permissions() (
  cd "$1" 2>/dev/null || return 0

  # Prune runtime data before testing ownership; never follow symbolic links.
  # Only add read/traverse/execute bits, preserving existing write permissions.
  _files=$(
    find ./docker ./app \
      \( -path './docker/.env' -o -path './docker/.env.factory' \
         -o -path './docker/volumes/db/data' -o -path './docker/volumes/storage' \
         -o -path './backups' \) -prune -o \
      -user "$(id -u)" \
      \( -type d -exec chmod a+rx {} \; -o \
         -type f -exec sh -c '
           for file do
             case "$file" in *.sh) mode=a+rx ;; *) mode=a+r ;; esac
             chmod "$mode" "$file" 2>/dev/null && printf .
           done
         ' sh {} + \) 2>/dev/null | wc -c | tr -d '[:space:]'
  )

  # .env is excluded above. Its sole exception is to enforce owner-only mode;
  # do not read its contents, follow a symlink, or change another user's file.
  if [ -n "$(find ./docker/.env -type f ! -perm 0600 -print 2>/dev/null)" ]; then
    find ./docker/.env -type f -user "$(id -u)" \
      -exec chmod 600 {} \; 2>/dev/null || :
    # A new find is needed: the first traversal caches the pre-chmod mode.
    if [ -n "$(find ./docker/.env -type f -perm 0600 -print 2>/dev/null)" ]; then
      printf '%s\n' '  [!] 已將 docker/.env 權限設為 600（僅擁有者可讀寫）。'
    else
      printf '%s\n' '  [!] docker/.env 權限不是 600；請檔案擁有者在安裝目錄執行：chmod 600 docker/.env'
    fi
  fi

  for _kong in ./docker/volumes/api/kong.yml ./docker/volumes/api/kong-entrypoint.sh; do
    if [ -z "$(find "$_kong" -type f -perm -0004 -print 2>/dev/null)" ]; then
      case "$_kong" in *.sh) _mode=a+rx ;; *) _mode=a+r ;; esac
      printf '  [!] %s 仍無法供容器讀取；請檔案擁有者在安裝目錄執行：chmod %s "%s"\n' \
        "$_kong" "$_mode" "$_kong"
    fi
  done
  printf '  [OK] 程式檔權限已確認（%s 個檔案）\n' "${_files:-0}"
  return 0
)
